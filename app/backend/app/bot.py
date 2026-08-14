"""Бот: вход в mini-app, deep-link'и и быстрые команды."""

import asyncio
import logging
from contextlib import suppress
from uuid import UUID
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery, ChatMemberUpdated, InlineKeyboardButton, InlineKeyboardMarkup,
    Message, WebAppInfo,
)
from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import Event, EventStatus, Participant, RsvpStatus, User
from .services import chats
from .services import events as svc

log = logging.getLogger("meeto.bot")
dp = Dispatcher()


GROUP_CHATS = {ChatType.GROUP, ChatType.SUPERGROUP}


def open_kb(payload: str = "") -> InlineKeyboardMarkup:
    url = settings.webapp_url + (f"?start={payload}" if payload else "")
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Открыть Meeto", web_app=WebAppInfo(url=url))]]
    )


def chat_kb(group_id: str) -> InlineKeyboardMarkup:
    """Клавиатура приветствия в групповом чате.

    Кнопка web_app в групповых чатах запрещена — Telegram отвечает
    BUTTON_TYPE_INVALID. Поэтому наружу ведём обычной ссылкой на бота.
    """
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Я в деле", callback_data=f"join:{group_id}"),
        InlineKeyboardButton(text="Открыть Meeto",
                             url=f"https://t.me/{settings.bot_username}?startapp"),
    ]])


def kb_for(message: Message, payload: str = "") -> InlineKeyboardMarkup:
    """В личке — кнопка mini-app, в чате — ссылка: web_app там запрещён."""
    if message.chat.type in GROUP_CHATS:
        return InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="Открыть Meeto",
                                 url=f"https://t.me/{settings.bot_username}?startapp"),
        ]])
    return open_kb(payload)


@dp.message(CommandStart(deep_link=True))
async def start_deeplink(message: Message, command: CommandStart):
    payload = command.args or ""
    hint = "Открываю приглашение в группу." if payload.startswith("g_") else "Открываю мероприятие."
    await message.answer(hint, reply_markup=open_kb(payload))


@dp.message(CommandStart())
async def start(message: Message):
    await message.answer(
        "Привет! Meeto помогает собирать людей на мероприятия: "
        "календарь, приглашения, лимит мест и кворум.\n\n"
        "Открывайте приложение — всё внутри.",
        reply_markup=open_kb(),
    )


WELCOME = (
    "Готово: завёл группу <b>{title}</b> в Meeto — мероприятия этого чата "
    "будут жить в ней, а анонсы, правки и напоминания я пришлю сюда.\n\n"
    "Нажмите «Я в деле», чтобы попасть в состав группы: список участников "
    "чата Telegram боту не отдаёт, поэтому иначе я вас не увижу."
)


@dp.my_chat_member()
async def bot_membership(update: ChatMemberUpdated, bot: Bot):
    """Бота добавили в чат или убрали из него."""
    if update.chat.type not in GROUP_CHATS:
        return
    status_now = update.new_chat_member.status
    chat_id = update.chat.id

    if status_now in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
        async with SessionLocal() as db:
            if await chats.unlink_chat(db, chat_id=chat_id):
                await db.commit()
        return

    if status_now not in (ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR):
        return

    # Владелец чата — владелец группы. Список участников Bot API не отдаёт,
    # а администраторов отдаёт: среди них и ищем создателя.
    owner = update.from_user
    with suppress(TelegramBadRequest):
        for admin in await bot.get_chat_administrators(chat_id):
            if admin.status == ChatMemberStatus.CREATOR:
                owner = admin.user
                break

    async with SessionLocal() as db:
        group = await chats.link_chat(
            db, chat_id=chat_id,
            title=update.chat.title or "Группа",
            owner={"id": owner.id, "first_name": owner.first_name,
                   "last_name": owner.last_name, "username": owner.username},
        )
        group_id = str(group.id)
        title = group.title
        await db.commit()

    with suppress(TelegramBadRequest):
        await bot.send_message(chat_id, WELCOME.format(title=title),
                               reply_markup=chat_kb(group_id))


@dp.callback_query(F.data.startswith("join:"))
async def join_from_chat(call: CallbackQuery):
    """Кнопка «Я в деле» под приветствием бота."""
    if call.message is None or call.message.chat.type not in GROUP_CHATS:
        await call.answer("Кнопка работает только в чате группы")
        return
    async with SessionLocal() as db:
        result = await chats.join_chat_group(
            db, chat_id=call.message.chat.id,
            tg={"id": call.from_user.id, "first_name": call.from_user.first_name,
                "last_name": call.from_user.last_name, "username": call.from_user.username},
        )
        if result is None:
            await call.answer("Группа этого чата не найдена", show_alert=True)
            return
        group, added = result
        await db.commit()
    await call.answer(
        f"Вы в группе «{group.title}»" if added else "Вы и так в группе"
    )


@dp.message(F.new_chat_title)
async def chat_renamed(message: Message):
    async with SessionLocal() as db:
        if await chats.rename_chat_group(db, chat_id=message.chat.id,
                                         title=message.new_chat_title or ""):
            await db.commit()


@dp.message(F.left_chat_member)
async def member_left(message: Message):
    """Вышел из чата — выходит и из группы.

    Служебное сообщение приходит боту всегда, в отличие от обновления
    chat_member, которое требует прав администратора.
    """
    left = message.left_chat_member
    if left is None or left.is_bot:
        return
    async with SessionLocal() as db:
        if await chats.leave_chat_group(db, chat_id=message.chat.id, tg_id=left.id):
            await db.commit()


@dp.chat_member()
async def member_changed(update: ChatMemberUpdated):
    """То же самое, но по событию chat_member: в супергруппах выход через
    «покинуть чат» служебным сообщением не сопровождается."""
    if update.chat.type not in GROUP_CHATS or update.new_chat_member.user.is_bot:
        return
    if update.new_chat_member.status not in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
        return
    async with SessionLocal() as db:
        if await chats.leave_chat_group(db, chat_id=update.chat.id,
                                        tg_id=update.new_chat_member.user.id):
            await db.commit()


async def _agenda(tg_id: int, days: int) -> str:
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        user = (await db.execute(select(User).where(User.tg_id == tg_id))).scalar_one_or_none()
        if user is None:
            return "Сначала откройте приложение — я вас ещё не знаю."
        rows = (await db.execute(
            select(Event, Participant)
            .join(Participant, Participant.event_id == Event.id)
            .where(Participant.user_id == user.id,
                   Participant.status.in_([RsvpStatus.going, RsvpStatus.maybe]),
                   Event.status != EventStatus.cancelled,
                   Event.starts_at >= now, Event.starts_at < now + timedelta(days=days))
            .order_by(Event.starts_at)
        )).all()
    if not rows:
        return "Ничего не запланировано." if days == 1 else "На неделю пусто."
    lines = [f"• <b>{ev.title}</b> — {ev.starts_at:%d.%m %H:%M}"
             + (f", {ev.place}" if ev.place else "") for ev, _ in rows]
    return "\n".join(lines)


@dp.message(Command("today"))
async def today(message: Message):
    await message.answer(await _agenda(message.from_user.id, 1), reply_markup=kb_for(message))


@dp.message(Command("week"))
async def week(message: Message):
    await message.answer(await _agenda(message.from_user.id, 7), reply_markup=kb_for(message))


@dp.message(Command("new"))
async def new_event(message: Message):
    await message.answer("Создаём мероприятие в приложении:", reply_markup=kb_for(message, "new"))


# Хвост сообщения в чате со счётчиком идущих: по нему же его и находим,
# чтобы при следующем ответе переписать, а не приписать второй раз.
COUNTER = "\n\n\U0001f465 идут: "

ANSWER_TEXT = {
    RsvpStatus.going: "Отметил: идёте",
    RsvpStatus.maybe: "Отметил: под вопросом",
    RsvpStatus.declined: "Отметил: не идёте",
}


@dp.callback_query(F.data.startswith("rsvp:"))
async def answer_from_chat(call: CallbackQuery):
    """Ответ прямо из уведомления, не открывая приложение."""
    try:
        _, event_id, status_raw = (call.data or "").split(":", 2)
        wanted = RsvpStatus(status_raw)
    except ValueError:
        await call.answer("Не понял кнопку")
        return

    in_chat = call.message is not None and call.message.chat.type in GROUP_CHATS

    async with SessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.tg_id == call.from_user.id)
        )).scalar_one_or_none()
        if user is None:
            if not in_chat:
                await call.answer("Сначала откройте приложение", show_alert=True)
                return
            # анонс в чате видят и те, кого в Meeto ещё нет: ответ по кнопке
            # и есть их первое действие, заводим человека прямо здесь
            user = await chats.upsert_user(db, {
                "id": call.from_user.id, "first_name": call.from_user.first_name,
                "last_name": call.from_user.last_name, "username": call.from_user.username,
            })

        # строку события блокируем: иначе два одновременных «иду» на последнее
        # место дадут овербукинг
        ev = (await db.execute(
            select(Event).where(Event.id == UUID(event_id)).with_for_update()
        )).scalar_one_or_none()
        if ev is None:
            await call.answer("Мероприятие не найдено", show_alert=True)
            return
        if ev.status is EventStatus.cancelled:
            await call.answer("Мероприятие отменено", show_alert=True)
            return
        # прошедшее не переигрываем: то же правило, что и в приложении
        finished = ev.ends_at or ev.starts_at
        if finished.replace(tzinfo=finished.tzinfo or timezone.utc) < datetime.now(timezone.utc):
            await call.answer("Мероприятие уже прошло", show_alert=True)
            return
        if ev.creator_id == user.id:
            await call.answer("Вы организатор — вы всегда идёте", show_alert=True)
            return

        part = (await db.execute(
            select(Participant).where(
                Participant.event_id == ev.id, Participant.user_id == user.id
            )
        )).scalar_one_or_none()
        if part is None:
            part = Participant(event_id=ev.id, user_id=user.id)
            db.add(part)
            await db.flush()

        was = part.status
        now = await svc.set_rsvp(db, ev, part, wanted)
        if was is RsvpStatus.going and now is not RsvpStatus.going:
            await svc.promote_waitlist(db, ev)
        await db.commit()

        title = ev.title
        seats = f"{ev.going_count}" + (f"/{ev.capacity_max}" if ev.capacity_max else "")

    if now is RsvpStatus.waitlisted:
        note = "Мест нет — вы в очереди"
    else:
        note = ANSWER_TEXT.get(now, "Ответ сохранён")

    await call.answer(note)

    with suppress(TelegramBadRequest, AttributeError, TypeError):
        if in_chat:
            # В чате анонс общий: убрать кнопки после первого ответа значит
            # лишить остальных возможности ответить. Поэтому не трогаем
            # клавиатуру, а только обновляем счётчик последней строкой.
            body = call.message.html_text.split(COUNTER)[0].rstrip()
            await call.message.edit_text(
                f"{body}{COUNTER}{seats}", reply_markup=call.message.reply_markup,
            )
        else:
            # в личке кнопки уже не нужны — отвечает один человек
            await call.message.edit_text(
                f"{call.message.html_text}\n\n<b>{note}</b> · идут {seats}",
                reply_markup=None,
            )


@dp.message(F.text, F.chat.type == ChatType.PRIVATE)
async def fallback(message: Message):
    """Только в личке: в общем чате бот на каждую реплику не отвечает."""
    await message.answer("Всё управление — в приложении.", reply_markup=open_kb())


async def main() -> None:
    logging.basicConfig(level=settings.log_level)
    bot = Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.delete_webhook(drop_pending_updates=True)
    # Явный список типов: без my_chat_member бот не узнает, что его добавили
    # в чат, а без chat_member — что участник оттуда вышел. Второе приходит
    # только если бот администратор чата, это нормально.
    updates = dp.resolve_used_update_types()
    log.info("бот запущен, слушаем: %s", ", ".join(updates))
    await dp.start_polling(bot, allowed_updates=updates)


if __name__ == "__main__":
    asyncio.run(main())
