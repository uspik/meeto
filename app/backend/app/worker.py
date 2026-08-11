"""Разбор аутбокса и напоминания.

Одна задача — один цикл в секунду: этого хватает для MVP и не требует брокера.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from sqlalchemy import func, select

from .config import settings
from .db import SessionLocal
from .models import Event, EventStatus, Outbox, Participant, RsvpStatus, User
from .services.notify import enqueue, render

log = logging.getLogger("meeto.worker")

REMINDERS = (24 * 60, 120)  # за сутки и за два часа
MAX_ATTEMPTS = 5


async def send_due(bot: Bot) -> None:
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(Outbox, User)
            .join(User, User.id == Outbox.user_id)
            .where(Outbox.state == "scheduled", Outbox.scheduled_at <= now)
            .limit(30)
        )).all()

        for item, user in rows:
            if user.is_bot_blocked:
                item.state = "cancelled"
                continue
            try:
                await bot.send_message(user.tg_id, render(item.type, item.payload))
                item.state, item.sent_at = "sent", datetime.now(timezone.utc)
            except TelegramRetryAfter as exc:
                item.scheduled_at = now + timedelta(seconds=exc.retry_after)
            except TelegramForbiddenError:
                user.is_bot_blocked = True
                item.state = "cancelled"
            except Exception as exc:  # noqa: BLE001
                item.attempts += 1
                item.last_error = str(exc)[:500]
                if item.attempts >= MAX_ATTEMPTS:
                    item.state = "failed"
                else:
                    item.scheduled_at = now + timedelta(seconds=30 * 2 ** item.attempts)
            await asyncio.sleep(0.05)  # 30 сообщений в секунду — лимит Bot API
        await db.commit()


async def plan_reminders() -> None:
    """Ставим напоминания на ближайшие сутки. Дедупликация — по dedup_key."""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(Event, Participant)
            .join(Participant, Participant.event_id == Event.id)
            .where(Participant.status == RsvpStatus.going,
                   Event.status.in_([EventStatus.published, EventStatus.confirmed]),
                   Event.starts_at > now, Event.starts_at < now + timedelta(days=2))
        )).all()

        for ev, pt in rows:
            for lead in REMINDERS:
                when = ev.starts_at - timedelta(minutes=lead)
                if when <= now or when > now + timedelta(days=1):
                    continue
                await enqueue(
                    db, pt.user_id, "event.reminder",
                    {"title": ev.title,
                     "when": f"{ev.starts_at:%d.%m в %H:%M}",
                     "place": f"\n\U0001f4cd {ev.place}" if ev.place else "",
                     "event_id": str(ev.id)},
                    scheduled_at=when, dedup_key=f"reminder:{ev.id}:{pt.user_id}:{lead}",
                )
                try:
                    await db.commit()
                except Exception:  # дубликат по dedup_key — так и задумано
                    await db.rollback()


async def resolve_quorum() -> None:
    """Дедлайн кворума прошёл — подтверждаем или отменяем."""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        evs = (await db.execute(
            select(Event).where(
                Event.status == EventStatus.published,
                Event.quorum_min.isnot(None),
                Event.quorum_deadline.isnot(None),
                Event.quorum_deadline <= now,
                Event.quorum_resolved_at.is_(None),
            )
        )).scalars().all()

        for ev in evs:
            ok = ev.going_count >= (ev.quorum_min or 0)
            ev.quorum_resolved_at = now
            parts = (await db.execute(
                select(Participant).where(Participant.event_id == ev.id)
            )).scalars().all()
            if ok:
                ev.status = EventStatus.confirmed
                for pt in parts:
                    if pt.status is RsvpStatus.going:
                        await enqueue(db, pt.user_id, "quorum.reached",
                                      {"title": ev.title, "going": ev.going_count,
                                       "quorum": ev.quorum_min, "event_id": str(ev.id)},
                                      dedup_key=f"quorum-ok:{ev.id}:{pt.user_id}")
            elif ev.auto_cancel_on_quorum_fail:
                ev.status = EventStatus.cancelled
                ev.cancel_reason = f"Не набрался кворум ({ev.going_count} из {ev.quorum_min})"
                for pt in parts:
                    await enqueue(db, pt.user_id, "quorum.failed",
                                  {"title": ev.title, "event_id": str(ev.id)},
                                  dedup_key=f"quorum-fail:{ev.id}:{pt.user_id}")
        await db.commit()


async def close_past() -> None:
    """Прошедшие мероприятия помечаем завершёнными.

    Статус нужен явный: по нему закрывается смена ответа и редактирование,
    а в интерфейсе появляется отметка «Завершено» рядом с ответом участника.
    """
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        evs = (await db.execute(
            select(Event).where(
                Event.status.in_([EventStatus.published, EventStatus.confirmed]),
                func.coalesce(Event.ends_at, Event.starts_at) < now,
            )
        )).scalars().all()
        for ev in evs:
            ev.status = EventStatus.completed
        if evs:
            log.info("завершено мероприятий: %s", len(evs))
        await db.commit()


async def main() -> None:
    logging.basicConfig(level=settings.log_level)
    bot = Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    log.info("воркер запущен")
    tick = 0
    while True:
        try:
            await send_due(bot)
            if tick % 60 == 0:  # раз в минуту
                await plan_reminders()
                await resolve_quorum()
                await close_past()
        except Exception:  # noqa: BLE001
            log.exception("сбой в цикле воркера")
        tick += 1
        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
