"""Кого и о чём уведомлять живьём.

Тонкая прослойка между действиями и шиной (`bus`): считает адресатов и
кладёт в поток короткое «вот это изменилось». Данные не передаются —
клиент перезапрашивает их обычными ручками.

Важно: звать после `commit()`. Если сообщить раньше, вкладка успеет
перезапросить данные до фиксации транзакции и покажет старое состояние.
"""

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Event, GroupMember, Participant
from . import bus

log = logging.getLogger("meeto.live")


async def watchers(db: AsyncSession, event: Event) -> set[UUID]:
    """Кому видно мероприятие: участники плюс состав группы.

    Тот же круг, что и в календаре: человек видит мероприятие своей группы,
    даже если ещё не ответил.
    """
    ids = set((await db.execute(
        select(Participant.user_id).where(Participant.event_id == event.id)
    )).scalars().all())
    ids.add(event.creator_id)
    if event.group_id is not None:
        ids |= set((await db.execute(
            select(GroupMember.user_id).where(GroupMember.group_id == event.group_id)
        )).scalars().all())
    return ids


async def event_changed(db: AsyncSession, event: Event, *, extra: set[UUID] | None = None) -> None:
    """Мероприятие поменялось: состав, время, статус, чей-то ответ."""
    users = await watchers(db, event)
    if extra:
        users |= extra
    await bus.publish(
        "event", users=users, event_id=str(event.id),
        group_id=str(event.group_id) if event.group_id else None,
    )


async def group_changed(db: AsyncSession, group_id: UUID, *, extra: set[UUID] | None = None) -> None:
    """Состав или настройки группы поменялись."""
    users = set((await db.execute(
        select(GroupMember.user_id).where(GroupMember.group_id == group_id)
    )).scalars().all())
    if extra:
        users |= extra
    await bus.publish("group", users=users, group_id=str(group_id))
