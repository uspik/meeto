from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import Group, GroupMember, GroupRole, User
from .permissions import can
from .security import AuthError, decode


async def current_user(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> User:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "нужен bearer-токен")
    try:
        user_id = decode(token)
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    user = await db.get(User, UUID(user_id))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "пользователь не найден")
    return user


async def membership(db: AsyncSession, group_id: UUID, user_id: UUID) -> GroupMember | None:
    res = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id, GroupMember.user_id == user_id
        )
    )
    return res.scalar_one_or_none()


async def require_group(
    db: AsyncSession, group_id: UUID, user: User, flag: str | None = None
) -> tuple[Group, GroupMember]:
    group = await db.get(Group, group_id)
    if group is None or group.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "группа не найдена")

    member = await membership(db, group_id, user.id)
    if member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "вы не участник группы")

    if flag and not can(member.role, flag, group.member_defaults, member.permissions_override):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"нет права {flag}")

    return group, member


def is_owner(member: GroupMember) -> bool:
    return member.role is GroupRole.owner
