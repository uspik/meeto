"""Приглашения людей, которых в Meeto ещё нет.

Telegram не даёт mini-app доступ к контактам и не позволяет создать
пользователя за него. Поэтому приглашение по @username кладём в очередь:
когда человек впервые откроет бота, оно применится само — группа и
мероприятие уже будут его ждать.
"""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (
    Event, GroupMember, GroupRole, Participant, PendingInvite, RsvpStatus, User,
)


def norm(username: str) -> str:
    return username.strip().lstrip("@").lower()


async def resolve(db: AsyncSession, usernames: list[str]) -> tuple[list[User], list[str]]:
    """Делит список @username на «уже в Meeto» и «ещё нет»."""
    wanted = [norm(u) for u in usernames if norm(u)]
    if not wanted:
        return [], []
    rows = await db.execute(select(User).where(User.username.in_(wanted)))
    found = list(rows.scalars().all())
    known = {(u.username or "").lower() for u in found}
    return found, [u for u in wanted if u not in known]


async def remember(
    db: AsyncSession,
    usernames: list[str],
    *,
    by: UUID,
    group_id: UUID | None = None,
    event_id: UUID | None = None,
    role: GroupRole = GroupRole.member,
) -> list[str]:
    """Откладывает приглашения до появления человека."""
    saved: list[str] = []
    for name in usernames:
        exists = await db.execute(
            select(PendingInvite).where(
                PendingInvite.username == name,
                PendingInvite.group_id.is_(group_id) if group_id is None
                else PendingInvite.group_id == group_id,
                PendingInvite.event_id.is_(event_id) if event_id is None
                else PendingInvite.event_id == event_id,
            )
        )
        if exists.scalar_one_or_none() is not None:
            continue
        db.add(PendingInvite(username=name, group_id=group_id, event_id=event_id,
                             role=role, invited_by=by))
        saved.append(name)
    return saved


async def apply_for(db: AsyncSession, user: User) -> int:
    """Применяет накопленные приглашения при первом входе."""
    if not user.username:
        return 0
    rows = await db.execute(
        select(PendingInvite).where(PendingInvite.username == user.username.lower())
    )
    invites = list(rows.scalars().all())
    applied = 0

    for inv in invites:
        if inv.group_id is not None:
            already = await db.execute(
                select(GroupMember).where(
                    GroupMember.group_id == inv.group_id, GroupMember.user_id == user.id
                )
            )
            if already.scalar_one_or_none() is None:
                db.add(GroupMember(group_id=inv.group_id, user_id=user.id,
                                   role=inv.role, invited_by=inv.invited_by))
                applied += 1

        if inv.event_id is not None:
            ev = await db.get(Event, inv.event_id)
            already = await db.execute(
                select(Participant).where(
                    Participant.event_id == inv.event_id, Participant.user_id == user.id
                )
            )
            if ev is not None and already.scalar_one_or_none() is None:
                db.add(Participant(event_id=inv.event_id, user_id=user.id,
                                   status=RsvpStatus.invited))
                applied += 1

        await db.delete(inv)

    return applied
