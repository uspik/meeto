"""Поиск людей для приглашения.

Telegram не даёт mini-app доступ к адресной книге, поэтому «знакомые» —
это те, с кем у вас есть общая группа или мероприятие в Meeto. Плюс точный
поиск по @username среди всех, кто хоть раз запускал бота: без него позвать
нового человека можно было бы только ссылкой.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import current_user
from ..models import Event, GroupMember, Participant, User
from ..schemas import UserOut

router = APIRouter(prefix="/users", tags=["users"])


async def known_ids(db: AsyncSession, me: User) -> set:
    """Все, с кем пересекались в группах или мероприятиях."""
    my_groups = select(GroupMember.group_id).where(GroupMember.user_id == me.id)
    by_group = await db.execute(
        select(distinct(GroupMember.user_id)).where(GroupMember.group_id.in_(my_groups))
    )
    my_events = select(Participant.event_id).where(Participant.user_id == me.id)
    by_event = await db.execute(
        select(distinct(Participant.user_id)).where(Participant.event_id.in_(my_events))
    )
    ids = set(by_group.scalars().all()) | set(by_event.scalars().all())
    ids.discard(me.id)
    return ids


@router.get("/search", response_model=list[UserOut])
async def search(
    q: str = Query(default="", max_length=64),
    limit: int = Query(default=30, le=100),
    me: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    ids = await known_ids(db, me)
    term = q.strip().lstrip("@").lower()

    if not term:
        if not ids:
            return []
        res = await db.execute(
            select(User).where(User.id.in_(ids)).order_by(User.first_name).limit(limit)
        )
        return list(res.scalars().all())

    pattern = f"%{term}%"
    known_match = User.id.in_(ids) & or_(
        func.lower(User.first_name).like(pattern),
        func.lower(func.coalesce(User.last_name, "")).like(pattern),
        func.lower(func.coalesce(User.username, "")).like(pattern),
    )
    # незнакомых отдаём только по точному совпадению username — иначе получится
    # выгрузка базы пользователей по одной букве
    exact_username = func.lower(func.coalesce(User.username, "")) == term

    res = await db.execute(
        select(User)
        .where(User.id != me.id, or_(known_match, exact_username))
        .order_by(User.first_name)
        .limit(limit)
    )
    return list(res.scalars().all())


@router.get("/of-event/{event_id}", response_model=list[UserOut])
async def candidates(
    event_id: str, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    """Кого ещё можно позвать на мероприятие: знакомые минус уже приглашённые."""
    ev = await db.get(Event, event_id)
    already = set()
    if ev is not None:
        rows = await db.execute(select(Participant.user_id).where(Participant.event_id == ev.id))
        already = set(rows.scalars().all())
    ids = await known_ids(db, me) - already
    if not ids:
        return []
    res = await db.execute(select(User).where(User.id.in_(ids)).order_by(User.first_name))
    return list(res.scalars().all())
