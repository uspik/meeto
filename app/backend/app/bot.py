"""Бот: вход в mini-app, deep-link'и и быстрые команды."""

import asyncio
import logging
from contextlib import suppress
from uuid import UUID
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo,
)
from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import Event, EventStatus, Participant, RsvpStatus, User
from .services import events as svc

log = logging.getLogger("meeto.bot")
dp = Dispatcher()


def open_kb(payload: str = "") -> InlineKeyboardMarkup:
    url = settings.webapp_url + (f"?start={payload}" if payload else "")
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Открыть Meeto", web_app=WebAppInfo(url=url))]]
    )


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
    await message.answer(await _agenda(message.from_user.id, 1), reply_markup=open_kb())


@dp.message(Command("week"))
async def week(message: Message):
    await message.answer(await _agenda(message.from_user.id, 7), reply_markup=open_kb())


@dp.message(Command("new"))
async def new_event(message: Message):
    await message.answer("Создаём мероприятие в приложении:", reply_markup=open_kb("new"))


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

    async with SessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.tg_id == call.from_user.id)
        )).scalar_one_or_none()
        if user is None:
            await call.answer("Сначала откройте приложение", show_alert=True)
            return

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
    # убираем кнопки и дописываем итог; если текст не редактируется
    # (слишком старое сообщение), ответа во всплывашке достаточно
    with suppress(TelegramBadRequest, AttributeError, TypeError):
        await call.message.edit_text(
            f"{call.message.html_text}\n\n<b>{note}</b> · идут {seats}",
            reply_markup=None,
        )


@dp.message(F.text)
async def fallback(message: Message):
    await message.answer("Всё управление — в приложении.", reply_markup=open_kb())


async def main() -> None:
    logging.basicConfig(level=settings.log_level)
    bot = Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.delete_webhook(drop_pending_updates=True)
    log.info("бот запущен")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
