from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import current_user, membership, require_group
from ..models import (
    Event, EventStatus, GroupMember, MembershipState, Participant, PendingInvite,
    RsvpStatus, User,
)
from ..permissions import can
from ..schemas import (
    EventIn, EventOut, EventPatch, InviteResult, InviteUsersIn, ParticipantOut,
    ParticipantsOut, RsvpIn,
)
from ..services import invites as inv
from ..services import events as svc
from ..services import live
from ..services.notify import announce, enqueue

router = APIRouter(prefix="/events", tags=["events"])


# правки, ради которых стоит слать уведомление
SIGNIFICANT = {
    "starts_at", "ends_at", "place", "format", "online_url",
    "capacity_max", "quorum_min", "quorum_deadline",
}


def aware(dt: datetime) -> datetime:
    """SQLite отдаёт даты без зоны, Postgres — с зоной. Приводим к одному виду,
    иначе сравнение падает с TypeError."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def when_of(ev: Event) -> str:
    """ISO-время начала: в текст его превратит воркер, уже в поясе получателя.

    Раньше время форматировалось здесь, в UTC, и человек получал «в 16:00»
    для мероприятия, которое у него начинается в 19:00.
    """
    return aware(ev.starts_at).isoformat()


def invite_payload(ev: Event) -> dict:
    """Один и тот же набор полей для приглашения, правки и напоминания."""
    return {
        "title": ev.title,
        "when_ts": when_of(ev),
        "place": f"\n\U0001f4cd {ev.place}" if ev.place else "",
        "event_id": str(ev.id),
    }


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

    # «Завершено» — это отдельная отметка, а не замена личному ответу:
    # в интерфейсе она стоит рядом со статусом посещения.
    now = datetime.now(timezone.utc)
    end = aware(ev.ends_at or ev.starts_at)
    is_past = ev.status is EventStatus.completed or end < now

    reason = None
    if ev.status is EventStatus.cancelled:
        reason = "Мероприятие отменено"
    elif is_past:
        reason = "Мероприятие завершено"
    elif ev.creator_id == me.id:
        # организатор идёт по определению, иначе некому проводить
        reason = "Вы организатор — вы всегда идёте"

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
        can_edit=editable and not is_past and ev.status is not EventStatus.cancelled,
        is_past=is_past,
        is_organizer=ev.creator_id == me.id,
        can_rsvp=reason is None,
        can_set_arrival=(
            going and not is_past and ev.status is not EventStatus.cancelled
        ),
        rsvp_locked_reason=reason,
    )


async def visible_pairs(db: AsyncSession, me: User, frm: datetime, to: datetime):
    """Мероприятия пользователя за период: свои, приглашения и события его групп."""
    group_ids = (await db.execute(
        select(GroupMember.group_id).where(GroupMember.user_id == me.id)
    )).scalars().all()

    # Берём всё, что пересекается с окном, а не только начинающееся в нём:
    # иначе мероприятие на несколько дней видно лишь в первый день, а во
    # второй и третий день календарь оказывается пустым.
    res = await db.execute(
        select(Event, Participant)
        .outerjoin(Participant, (Participant.event_id == Event.id)
                   & (Participant.user_id == me.id))
        .where(Event.starts_at < to,
               func.coalesce(Event.ends_at, Event.starts_at) >= frm - timedelta(days=1),
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
        # зовём только тех, кто уже в группе: приглашённым сначала надо
        # ответить на приглашение в саму группу
        ids = (await db.execute(
            select(GroupMember.user_id).where(
                GroupMember.group_id == ev.group_id,
                GroupMember.state == MembershipState.active.value,
            )
        )).scalars().all()
        # у группы из чата адресат один — сам чат; иначе пишем каждому
        in_chat = await announce(db, ev, "event.invited",
                                 invite_payload(ev), dedup_key=f"invited:{ev.id}")
        for uid_ in ids:
            if uid_ == me.id:
                continue
            db.add(Participant(event_id=ev.id, user_id=uid_, status=RsvpStatus.invited))
            if not in_chat:
                await enqueue(db, uid_, "event.invited", invite_payload(ev),
                              dedup_key=f"invited:{ev.id}:{uid_}")
    await db.commit()
    await db.refresh(ev)
    await live.event_changed(db, ev)
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
    # сначала состояние мероприятия, потом права: иначе автор завершённого
    # получал бы «нет прав», хотя дело не в правах
    if ev.status is EventStatus.cancelled:
        raise HTTPException(status.HTTP_409_CONFLICT, "мероприятие отменено")
    if out.is_past:
        raise HTTPException(status.HTTP_409_CONFLICT, "завершённое мероприятие не редактируется")
    if not out.can_edit:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нет прав на редактирование")

    incoming = body.model_dump(exclude_none=True)

    # Форма присылает всё поля разом, поэтому «поле пришло» ещё не значит
    # «значение поменялось». Сравниваем со старым — иначе уведомление уходило
    # на каждое сохранение, даже когда правили одно название.
    really_changed = {
        key for key, val in incoming.items()
        if getattr(ev, key) != val
    }
    for key, val in incoming.items():
        setattr(ev, key, val)

    # Стало больше мест — двигаем очередь, не дожидаясь чужого отказа
    if "capacity_max" in really_changed:
        for cand in await svc.promote_waitlist(db, ev):
            await enqueue(db, cand.user_id, "waitlist.promoted",
                          {"title": ev.title, "when_ts": when_of(ev), "event_id": str(ev.id)})

    # Беспокоим людей только тем, что влияет на решение идти или нет.
    if really_changed & SIGNIFICANT:
        # Тем, кто отказался или не ответил, правки безразличны.
        # Пишем идущим, стоящим в очереди и тем, кто под вопросом.
        if not await announce(db, ev, "event.updated", invite_payload(ev)):
            rows = (await db.execute(
                select(Participant).where(
                    Participant.event_id == ev.id,
                    Participant.status.in_([
                        RsvpStatus.going, RsvpStatus.waitlisted, RsvpStatus.maybe,
                    ]),
                )
            )).scalars().all()
            for pt in rows:
                if pt.user_id != me.id:
                    await enqueue(db, pt.user_id, "event.updated", invite_payload(ev))
    await db.commit()
    await db.refresh(ev)
    await live.event_changed(db, ev)
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
    payload = {"title": ev.title, "reason": reason or "", "event_id": str(ev.id)}
    if not await announce(db, ev, "event.cancelled", payload,
                          dedup_key=f"cancelled:{ev.id}"):
        rows = (await db.execute(
            select(Participant).where(Participant.event_id == ev.id)
        )).scalars()
        for pt in rows:
            if pt.user_id != me.id:
                await enqueue(db, pt.user_id, "event.cancelled", payload,
                              dedup_key=f"cancelled:{ev.id}:{pt.user_id}")
    await db.commit()
    await db.refresh(ev)
    await live.event_changed(db, ev)
    return await to_out(db, ev, me)


@router.get("/{event_id}/participants", response_model=ParticipantsOut)
async def participants(
    event_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    """Кто идёт: ответившие плюс те, кого позвали, но кто ещё не в Meeto."""
    res = await db.execute(
        select(Participant).where(Participant.event_id == event_id).order_by(Participant.invited_at)
    )
    waiting = await db.execute(
        select(PendingInvite.username).where(PendingInvite.event_id == event_id)
    )
    return ParticipantsOut(
        participants=[ParticipantOut.model_validate(p) for p in res.scalars().all()],
        pending=list(waiting.scalars().all()),
    )


@router.post("/{event_id}/invite", response_model=InviteResult, status_code=201)
async def invite(
    event_id: UUID, body: InviteUsersIn,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    """Позвать людей на мероприятие.

    В группу они при этом не попадают: гость может прийти на один матч,
    не вступая в команду.
    """
    ev = await db.get(Event, event_id)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    out = await to_out(db, ev, me)
    if not out.can_edit:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нет прав приглашать в это мероприятие")

    found, missing = await inv.resolve(db, body.usernames)
    ids = list(body.user_ids) + [u.id for u in found]

    added: list[Participant] = []
    for uid_ in ids:
        if await my_part(db, ev.id, uid_) is not None:
            continue
        if await db.get(User, uid_) is None:
            continue
        # invited_by в модели участника нет: добавление колонки потребовало бы
        # миграции живой базы, а схема пока создаётся из моделей
        part = Participant(event_id=ev.id, user_id=uid_)
        db.add(part)
        added.append(part)
        await enqueue(db, uid_, "event.invited",
                      {"title": ev.title, "when_ts": when_of(ev),
                       "place": f"\n\U0001f4cd {ev.place}" if ev.place else "",
                       "event_id": str(ev.id)},
                      dedup_key=f"invited:{ev.id}:{uid_}")

    await inv.remember_contact(db, me.id, ids)
    pending = await inv.remember(db, missing, by=me.id, event_id=ev.id)
    await db.commit()
    await live.event_changed(db, ev)
    return InviteResult(added=len(added), pending=pending)


@router.delete("/{event_id}/participants/{user_id}", status_code=204)
async def drop_participant(
    event_id: UUID, user_id: UUID,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    """Убрать человека с мероприятия. Организатора убрать нельзя."""
    ev = await db.get(Event, event_id)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "мероприятие не найдено")
    out = await to_out(db, ev, me)
    if not out.can_edit:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нет прав менять состав")
    if user_id == ev.creator_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "организатора убрать нельзя")

    part = await my_part(db, event_id, user_id)
    if part is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "участник не найден")

    was_going = part.status is RsvpStatus.going
    await db.delete(part)
    await db.flush()
    await svc.recount(db, ev)

    # освободилось место — двигаем очередь
    if was_going:
        for cand in await svc.promote_waitlist(db, ev):
            await enqueue(db, cand.user_id, "waitlist.promoted",
                          {"title": ev.title, "when_ts": when_of(ev), "event_id": str(ev.id)})

    # чтобы позвать обратно: убранный должен остаться в подборе людей,
    # даже если общих групп с ним больше нет
    await inv.remember_contact(db, me.id, [user_id])
    if ev.creator_id != me.id:
        await inv.remember_contact(db, ev.creator_id, [user_id])

    await enqueue(db, user_id, "event.removed", {"title": ev.title, "event_id": str(ev.id)})
    await db.commit()
    await live.event_changed(db, ev, extra={user_id})


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
    guard = await to_out(db, ev, me)
    part = await my_part(db, event_id, me.id)

    # Организатору ответ закрыт, но время прихода он указывать вправе:
    # запрос, который не меняет статус, пропускаем.
    arrival_only = part is not None and part.status == body.status
    if not guard.can_rsvp and not (arrival_only and guard.can_set_arrival):
        raise HTTPException(status.HTTP_409_CONFLICT, guard.rsvp_locked_reason or "ответ закрыт")

    if part is None:
        part = Participant(event_id=event_id, user_id=me.id)
        db.add(part)
        await db.flush()

    was = part.status
    try:
        now = await svc.set_rsvp(db, ev, part, body.status, body.plus_ones)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    # время прихода имеет смысл на любом мероприятии, а не только «гибком»
    if body.arrival_at is not None or body.departure_at is not None:
        part.arrival_at, part.departure_at = body.arrival_at, body.departure_at
    part.note = body.note

    if was is RsvpStatus.going and now is not RsvpStatus.going:
        for cand in await svc.promote_waitlist(db, ev):
            await enqueue(db, cand.user_id, "waitlist.promoted",
                          {"title": ev.title, "when_ts": when_of(ev), "event_id": str(ev.id)})

    # Поштучных уведомлений организатору о каждом ответе больше нет:
    # на мероприятии в двадцать человек это превращалось в спам.
    # Остаются только события, которые действительно требуют реакции:
    # набранный кворум, заполнение мест, продвижение очереди.
    if (was is not RsvpStatus.going and now is RsvpStatus.going
            and ev.capacity_max is not None and ev.seats_taken >= ev.capacity_max
            and ev.creator_id != me.id):
        await enqueue(db, ev.creator_id, "capacity.full",
                      {"title": ev.title, "capacity": ev.capacity_max, "event_id": str(ev.id)},
                      dedup_key=f"full:{ev.id}:{ev.capacity_max}")

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
    # чужой ответ виден организатору сразу: у него открыт «Кто идёт»
    await live.event_changed(db, ev)
    return await to_out(db, ev, me)
