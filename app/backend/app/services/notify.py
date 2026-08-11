"""Транзакционный аутбокс: запись кладём в ту же транзакцию, что и действие."""

from datetime import datetime, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
    "group.invited": "\U0001f465 Вас добавили в группу <b>{title}</b>",
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


def render(kind: str, payload: dict, tz_name: str = "UTC") -> str:
    tpl = TEMPLATES.get(kind)
    if not tpl:
        return payload.get("text", "")
    safe = {k: (v if v is not None else "") for k, v in payload.items()}
    # время подставляем уже в поясе получателя
    if "when_ts" in payload:
        safe["when"] = local(payload.get("when_ts"), tz_name)
    try:
        return tpl.format(**safe)
    except KeyError:
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
    db.add(
        Outbox(
            user_id=user_id,
            type=kind,
            payload=payload,
            dedup_key=dedup_key,
            scheduled_at=scheduled_at or datetime.now(timezone.utc),
        )
    )
