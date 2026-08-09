"""Бот: вход в mini-app, deep-link'и и быстрые команды."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo,
)
from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import Event, EventStatus, Participant, RsvpStatus, User

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
