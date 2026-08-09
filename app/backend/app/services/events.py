"""Бизнес-логика мероприятий: места, лист ожидания, кворум, пересечения."""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Event, EventStatus, Participant, RsvpStatus


def span(event: Event, part: Participant | None = None) -> tuple[datetime, datetime]:
    """Окно присутствия. Гибкое время участника сужает интервал мероприятия."""
    start = event.starts_at
    end = event.ends_at or (event.starts_at + timedelta(hours=1))
    if part and event.is_time_flexible:
        if part.arrival_at and start < part.arrival_at < end:
            start = part.arrival_at
        if part.departure_at and start < part.departure_at < end:
            end = part.departure_at
    return start, end


def find_conflicts(pairs: list[tuple[Event, Participant]]) -> list[dict]:
    """Sweep line по принятым мероприятиям, O(n log n)."""
    items = sorted(
        (
            (*span(ev, pt), ev.id)
            for ev, pt in pairs
            if pt.status is RsvpStatus.going and ev.status is not EventStatus.cancelled
        ),
        key=lambda x: x[0],
    )
    out: list[dict] = []
    for i, (s1, e1, id1) in enumerate(items):
        for s2, e2, id2 in items[i + 1 :]:
            if s2 >= e1:
                break
            frm, to = max(s1, s2), min(e1, e2)
            if to > frm:
                out.append({"from": frm, "to": to, "event_ids": [id1, id2]})
    return out


async def seats_used(db: AsyncSession, event_id: UUID) -> int:
    res = await db.execute(
        select(func.coalesce(func.sum(Participant.plus_ones + 1), 0)).where(
            Participant.event_id == event_id, Participant.status == RsvpStatus.going
        )
    )
    return int(res.scalar_one())


async def recount(db: AsyncSession, event: Event) -> None:
    going = await db.execute(
        select(func.count()).where(
            Participant.event_id == event.id, Participant.status == RsvpStatus.going
        )
    )
    event.going_count = int(going.scalar_one())
    event.seats_taken = await seats_used(db, event.id)


async def set_rsvp(
    db: AsyncSession, event: Event, part: Participant, wanted: RsvpStatus, plus_ones: int = 0
) -> RsvpStatus:
    """Меняет ответ участника, соблюдая лимит мест.

    Вызывать внутри транзакции, где строка события уже взята FOR UPDATE, —
    иначе при одновременных ответах возможен овербукинг.
    """
    if wanted is RsvpStatus.going:
        need = plus_ones + 1
        taken = await seats_used(db, event.id)
        if part.status is RsvpStatus.going:
            taken -= part.plus_ones + 1
        if event.capacity_max is not None and taken + need > event.capacity_max:
            if not event.waitlist_enabled:
                raise ValueError("мест нет, лист ожидания выключен")
            last = await db.execute(
                select(func.coalesce(func.max(Participant.waitlist_pos), 0)).where(
                    Participant.event_id == event.id
                )
            )
            part.status = RsvpStatus.waitlisted
            part.waitlist_pos = int(last.scalar_one()) + 1
            part.responded_at = datetime.now(timezone.utc)
            await recount(db, event)
            return part.status

    part.status = wanted
    part.plus_ones = plus_ones
    part.waitlist_pos = None
    part.responded_at = datetime.now(timezone.utc)
    await recount(db, event)
    return part.status


async def promote_waitlist(db: AsyncSession, event: Event) -> list[Participant]:
    """Освободились места — двигаем очередь по FIFO."""
    if event.capacity_max is None:
        return []
    promoted: list[Participant] = []
    free = event.capacity_max - await seats_used(db, event.id)
    if free <= 0:
        return []
    res = await db.execute(
        select(Participant)
        .where(Participant.event_id == event.id, Participant.status == RsvpStatus.waitlisted)
        .order_by(Participant.waitlist_pos)
    )
    for cand in res.scalars():
        need = cand.plus_ones + 1
        if need > free:
            continue
        cand.status = RsvpStatus.going
        cand.waitlist_pos = None
        free -= need
        promoted.append(cand)
        if free <= 0:
            break
    if promoted:
        await recount(db, event)
    return promoted


def quorum_state(event: Event) -> str:
    if event.quorum_min is None:
        return "not_required"
    if event.going_count >= event.quorum_min:
        return "reached"
    return "pending"
