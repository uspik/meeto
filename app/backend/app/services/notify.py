"""Транзакционный аутбокс: запись кладём в ту же транзакцию, что и действие."""

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Outbox

# Тексты собираются здесь, чтобы бот и воркер не расходились
TEMPLATES = {
    "event.invited": "\U0001f4c5 Вас пригласили: <b>{title}</b>\n{when}{place}",
    "event.updated": "✏️ Изменилось мероприятие <b>{title}</b>\n{when}{place}",
    "event.cancelled": "\U0001f7e0 Отменено: <b>{title}</b>\n{reason}",
    "event.reminder": "⏰ Скоро: <b>{title}</b>\n{when}{place}",
    "rsvp.received": "✅ {who} — {answer}: <b>{title}</b> ({going} идут)",
    "waitlist.promoted": "\U0001f389 Место освободилось: <b>{title}</b>\n{when}",
    "quorum.reached": "✅ Кворум набран: <b>{title}</b> — {going}/{quorum}",
    "quorum.failed": "\U0001f7e0 Кворум не набран, мероприятие отменено: <b>{title}</b>",
    "group.invited": "\U0001f465 Вас добавили в группу <b>{title}</b>",
}


def render(kind: str, payload: dict) -> str:
    tpl = TEMPLATES.get(kind)
    if not tpl:
        return payload.get("text", "")
    safe = {k: (v if v is not None else "") for k, v in payload.items()}
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
