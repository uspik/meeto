"""Транзакционный аутбокс: запись кладём в ту же транзакцию, что и действие."""

from datetime import datetime, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Outbox

# Тексты собираются здесь, чтобы бот и воркер не расходились
TEMPLATES = {
    "event.invited": "\U0001f4c5 Вас пригласили: <b>{title}</b>\n{when}{place}",
    "event.updated": "✏️ Изменилось мероприятие <b>{title}</b>\n{when}{place}",
    "event.cancelled": "\U0001f7e0 Отменено: <b>{title}</b>\n{reason}",
    "event.reminder": "⏰ Скоро: <b>{title}</b>\n{when}{place}",
    "capacity.full": "\U0001f6ab Мест больше нет: <b>{title}</b> — все {capacity} заняты",
    "waitlist.promoted": "\U0001f389 Место освободилось: <b>{title}</b>\n{when}",
    "quorum.reached": "✅ Кворум набран: <b>{title}</b> — {going}/{quorum}",
    "quorum.failed": "\U0001f7e0 Кворум не набран, мероприятие отменено: <b>{title}</b>",
    "event.removed": "\u274c Вас убрали с мероприятия <b>{title}</b>",
    "group.invited": "\U0001f465 {who} зовёт вас в группу <b>{title}</b>",
    "group.joined": "\u2705 {who} принял приглашение в <b>{title}</b>",
}


def local(iso: str | None, tz_name: str) -> str:
    """Время в часовом поясе получателя.

    Внутри всё хранится и передаётся в UTC. Если подставить его в текст как
    есть, человек получит «в 16:00» для мероприятия, которое начинается
    в 19:00 по его часам — именно так и было.
    """
    if not iso:
        return ""
    try:
        moment = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    try:
        zone = ZoneInfo(tz_name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    return f"{moment.astimezone(zone):%d.%m в %H:%M}"


class _Blank(dict):
    """Недостающие ключи превращает в пустую строку.

    Без этого одна лишняя фигурная скобка в шаблоне роняла format, и человек
    получал сообщение вида «Изменилось мероприятие {title}» — сырой шаблон.
    Лучше отдать текст с пропуском, чем показать разметку.
    """

    def __missing__(self, key: str) -> str:  # noqa: D105
        return ""


def render(kind: str, payload: dict, tz_name: str = "UTC") -> str:
    tpl = TEMPLATES.get(kind)
    if not tpl:
        return payload.get("text", "")
    safe = _Blank({k: (v if v is not None else "") for k, v in payload.items()})
    # время подставляем уже в поясе получателя
    if payload.get("when_ts"):
        safe["when"] = local(payload["when_ts"], tz_name)
    try:
        return tpl.format_map(safe)
    except (IndexError, ValueError):
        return payload.get("text", tpl)


async def enqueue(
    db: AsyncSession,
    user_id: UUID,
    kind: str,
    payload: dict,
    *,
    scheduled_at: datetime | None = None,
    dedup_key: str | None = None,
) -> None:
    # dedup_key защищает от двойной отправки одного и того же, а не от
    # повторения события через месяц. Раньше ключ жил вечно, и повторное
    # приглашение (человека исключили и позвали обратно) валилось на
    # UNIQUE — вместе со всем запросом. Поэтому: пока старое уведомление
    # не ушло, второе не ставим; как только ушло — освобождаем ключ.
    if dedup_key is not None:
        res = await db.execute(select(Outbox).where(Outbox.dedup_key == dedup_key))
        old = res.scalars().first()
        if old is not None:
            if old.state == "scheduled":
                return
            old.dedup_key = None
            await db.flush()

    db.add(
        Outbox(
            user_id=user_id,
            type=kind,
            payload=payload,
            dedup_key=dedup_key,
            scheduled_at=scheduled_at or datetime.now(timezone.utc),
        )
    )


# Уведомления, на которые можно ответить прямо из чата.
# Кнопки собирает воркер, нажатия обрабатывает бот — процессы разные,
# поэтому связь только через callback_data.
ACTIONS: dict[str, list[tuple[str, str]]] = {
    "event.invited": [("Иду", "going"), ("Под вопросом", "maybe"), ("Не иду", "declined")],
    "event.reminder": [("Иду", "going"), ("Не иду", "declined")],
    "waitlist.promoted": [("Иду", "going"), ("Не иду", "declined")],
}


def actions_for(kind: str, payload: dict) -> list[tuple[str, str]]:
    """Подписи кнопок и их callback_data."""
    event_id = payload.get("event_id")
    if not event_id:
        return []
    return [(label, f"rsvp:{event_id}:{status}") for label, status in ACTIONS.get(kind, [])]
