from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import current_user, membership, require_group
from ..models import Event, EventStatus, GroupMember, Participant, RsvpStatus, User
from ..permissions import can
from ..schemas import EventIn, EventOut, EventPatch, ParticipantOut, RsvpIn
from ..services import events as svc
from ..services.notify import enqueue

router = APIRouter(prefix="/events", tags=["events"])


def fmt_when(ev: Event) -> str:
    end = f"–{ev.ends_at:%H:%M}" if ev.ends_at else ""
    return f"{ev.starts_at:%d.%m} в {ev.starts_at:%H:%M}{end}"


async def my_part(db: AsyncSession, event_id: UUID, user_id: UUID) -> Participant | None:
    res = await db.execute(
        select(Participant).where(Participant.event_id == event_id, Participant.user_id == user_id)
    )
    return res.scalar_one_or_none()


async def to_out(db: AsyncSession, ev: Event, me: User, part: Participant | None = None) -> EventOut:
    if part is None:
        part = await my_part(db, ev.id, me.id)
    editable = ev.creator_id == me.id
    if not editable and ev.group_id:
        mem = await membership(db, ev.group_id, me.id)
        editable = bool(mem and can(mem.role, "events.edit_any",
                                    ev.group.member_defaults if ev.group else None,
                                    mem.permissions_override))
    going = part is not None and part.status is RsvpStatus.going
    return EventOut(
        **{k: getattr(ev, k) for k in (
            "id", "group_id", "creator_id", "title", "description", "emoji", "cover",
            "format", "place", "starts_at", "ends_at", "is_time_flexible", "capacity_max",
            "quorum_min", "quorum_deadline", "status", "cancel_reason", "going_count", "seats_taken",
        )},
        group_title=ev.group.title if ev.group else None,
        # ссылку на созвон видят только идущие
        online_url=ev.online_url if going or ev.creator_id == me.id else None,
        my_status=part.status if part else None,
        my_arrival=part.arrival_at if part else None,
        can_edit=editable,
    )


async def visible_pairs(db: AsyncSession, me: User, frm: datetime, to: datetime):
    """Мероприятия пользователя за период: свои, приглашения и события его групп."""
    group_ids = (await db.execute(
        select(GroupMember.group_id).where(GroupMember.user_id == me.id)
    )).scalars().all()

    res = await db.execute(
        select(Event, Participant)
        .outerjoin(Participant, (Participant.event_id == Event.id)
                   & (Participant.user_id == me.id))
        .where(Event.starts_at < to, Event.starts_at >= frm - timedelta(days=1),
               Event.status != EventStatus.draft)
        .order_by(Event.starts_at)
    )
    out = []
    for ev, pt in res.all():
        if pt is None and ev.group_id not in group_ids and ev.creator_id != me.id:
            continue
        out.append((ev, pt))
    return out


@router.post("", response_model=EventOut, status_code=201)
async def create(body: EventIn, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    if body.group_id:
        await require_group(db, body.group_id, me, "events.create")
    if body.ends_at and body.ends_at <= body.starts_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "конец раньше начала")
    if body.quorum_min and body.capacity_max and body.quorum_min > body.capacity_max:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "минимум больше числа мест")

    ev = Event(
        creator_id=me.id, timezone=body.timezone or me.timezone,
        **body.model_dump(exclude={"invite_all_group", "timezone"}),
    )
    db.add(ev)
    await db.flush()

    # создатель сразу идёт
    db.add(Participant(event_id=ev.id, user_id=me.id, status=RsvpStatus.going,
                       responded_at=datetime.now(timezone.utc)))
    await svc.recount(db, ev)

    if ev.group_id and body.invite_all_group:
        ids = (await db.execute(
            select(GroupMember.user_id).where(GroupMember.group_id == ev.group_id)
        )).scalars().all()
        for uid_ in ids:
            if uid_ == me.id:
                continue
            db.add(Participant(event_id=ev.id, user_id=uid_, status=RsvpStatus.invited))
            await enqueue(db, uid_, "event.invited",
                          {"title": ev.title, "when": fmt_when(ev),
                           "place": f"\n\U0001f4cd {ev.place}" if ev.place else "",
                           "event_id": str(ev.id)},
                          dedup_key=f"invited:{ev.id}:{uid_}")
    await db.commit()
    await db.refresh(ev)
    return await to_out(db, ev, me)


@router.get("/{event_id}", response_model=EventOut)
async def one(event_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    ev = await db.get(Event, event_id)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    return await to_out(db, ev, me)


@router.patch("/{event_id}", response_model=EventOut)
async def edit(
    event_id: UUID, body: EventPatch,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    ev = await db.get(Event, event_id)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    out = await to_out(db, ev, me)
    if not out.can_edit:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нет прав на редактирование")

    changed = body.model_dump(exclude_none=True)
    time_moved = "starts_at" in changed or "ends_at" in changed
    for key, val in changed.items():
        setattr(ev, key, val)

    if time_moved or "place" in changed:
        rows = (await db.execute(
            select(Participant).where(Participant.event_id == ev.id,
                                      Participant.status.in_([RsvpStatus.going, RsvpStatus.maybe]))
        )).scalars().all()
        for pt in rows:
            if pt.user_id != me.id:
                await enqueue(db, pt.user_id, "event.updated",
                              {"title": ev.title, "when": fmt_when(ev),
                               "place": f"\n\U0001f4cd {ev.place}" if ev.place else "",
                               "event_id": str(ev.id)})
    await db.commit()
    await db.refresh(ev)
    return await to_out(db, ev, me)


@router.post("/{event_id}/cancel", response_model=EventOut)
async def cancel(
    event_id: UUID, reason: str = "",
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    ev = await db.get(Event, event_id)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    out = await to_out(db, ev, me)
    if not out.can_edit:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нет прав на отмену")

    ev.status = EventStatus.cancelled
    ev.cancel_reason = reason or None
    rows = (await db.execute(select(Participant).where(Participant.event_id == ev.id))).scalars()
    for pt in rows:
        if pt.user_id != me.id:
            await enqueue(db, pt.user_id, "event.cancelled",
                          {"title": ev.title, "reason": reason or "", "event_id": str(ev.id)},
                          dedup_key=f"cancelled:{ev.id}:{pt.user_id}")
    await db.commit()
    await db.refresh(ev)
    return await to_out(db, ev, me)


@router.get("/{event_id}/participants", response_model=list[ParticipantOut])
async def participants(
    event_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    res = await db.execute(
        select(Participant).where(Participant.event_id == event_id).order_by(Participant.invited_at)
    )
    return list(res.scalars().all())


@router.post("/{event_id}/rsvp", response_model=EventOut)
async def rsvp(
    event_id: UUID, body: RsvpIn,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    # блокируем строку события: иначе при одновременных ответах будет овербукинг
    res = await db.execute(select(Event).where(Event.id == event_id).with_for_update())
    ev = res.scalar_one_or_none()
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    if ev.status is EventStatus.cancelled:
        raise HTTPException(status.HTTP_409_CONFLICT, "мероприятие отменено")

    part = await my_part(db, event_id, me.id)
    if part is None:
        part = Participant(event_id=event_id, user_id=me.id)
        db.add(part)
        await db.flush()

    was = part.status
    try:
        now = await svc.set_rsvp(db, ev, part, body.status, body.plus_ones)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    if ev.is_time_flexible:
        part.arrival_at, part.departure_at = body.arrival_at, body.departure_at
    part.note = body.note

    if was is RsvpStatus.going and now is not RsvpStatus.going:
        for cand in await svc.promote_waitlist(db, ev):
            await enqueue(db, cand.user_id, "waitlist.promoted",
                          {"title": ev.title, "when": fmt_when(ev), "event_id": str(ev.id)})

    if was != now and ev.creator_id != me.id:
        await enqueue(db, ev.creator_id, "rsvp.received",
                      {"who": me.display_name, "answer": now.value, "title": ev.title,
                       "going": ev.going_count, "event_id": str(ev.id)})

    if (ev.quorum_min and ev.going_count >= ev.quorum_min
            and ev.status is EventStatus.published):
        ev.status = EventStatus.confirmed
        ev.quorum_resolved_at = datetime.now(timezone.utc)
        rows = (await db.execute(
            select(Participant).where(Participant.event_id == ev.id,
                                      Participant.status == RsvpStatus.going)
        )).scalars().all()
        for pt in rows:
            await enqueue(db, pt.user_id, "quorum.reached",
                          {"title": ev.title, "going": ev.going_count, "quorum": ev.quorum_min,
                           "event_id": str(ev.id)},
                          dedup_key=f"quorum-ok:{ev.id}:{pt.user_id}")

    await db.commit()
    await db.refresh(ev)
    return await to_out(db, ev, me)
