import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..deps import current_user, is_owner, membership, require_group
from ..models import Group, GroupInvite, GroupMember, GroupRole, User
from ..schemas import GroupIn, GroupOut, InviteOut, MemberOut, MembersIn
from ..services.notify import enqueue

router = APIRouter(prefix="/groups", tags=["groups"])


async def _out(db: AsyncSession, group: Group, me: User) -> GroupOut:
    cnt = await db.execute(
        select(func.count()).select_from(GroupMember).where(GroupMember.group_id == group.id)
    )
    mem = await membership(db, group.id, me.id)
    return GroupOut(
        id=group.id, title=group.title, description=group.description, color=group.color,
        owner_id=group.owner_id, my_role=mem.role if mem else None,
        members_count=int(cnt.scalar_one()),
    )


@router.get("", response_model=list[GroupOut])
async def my_groups(me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(Group)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_id == me.id, Group.deleted_at.is_(None))
        .order_by(Group.created_at)
    )
    return [await _out(db, g, me) for g in res.scalars().all()]


@router.post("", response_model=GroupOut, status_code=201)
async def create(body: GroupIn, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    group = Group(title=body.title, description=body.description, color=body.color, owner_id=me.id)
    db.add(group)
    await db.flush()
    db.add(GroupMember(group_id=group.id, user_id=me.id, role=GroupRole.owner))
    await db.commit()
    await db.refresh(group)
    return await _out(db, group, me)


@router.get("/{group_id}", response_model=GroupOut)
async def one(group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    group, _ = await require_group(db, group_id, me)
    return await _out(db, group, me)


@router.patch("/{group_id}", response_model=GroupOut)
async def edit(
    group_id: UUID, body: GroupIn, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    group, _ = await require_group(db, group_id, me, "group.edit_settings")
    group.title, group.description, group.color = body.title, body.description, body.color
    await db.commit()
    return await _out(db, group, me)


@router.delete("/{group_id}", status_code=204)
async def remove(group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    group, member = await require_group(db, group_id, me)
    if not is_owner(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "удалить группу может только владелец")
    group.deleted_at = datetime.now(timezone.utc)
    await db.commit()


@router.get("/{group_id}/members", response_model=list[MemberOut])
async def members(group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_group(db, group_id, me)
    res = await db.execute(
        select(GroupMember).where(GroupMember.group_id == group_id).order_by(GroupMember.joined_at)
    )
    return list(res.scalars().all())


UI_ROLES = {GroupRole.owner, GroupRole.admin, GroupRole.member}


@router.post("/{group_id}/members", response_model=list[MemberOut], status_code=201)
async def add_members(
    group_id: UUID, body: MembersIn,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    """Добавить людей в группу — как при создании чата в Telegram."""
    group, _ = await require_group(db, group_id, me, "members.invite")
    if body.role not in UI_ROLES or body.role is GroupRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "недопустимая роль")

    added: list[GroupMember] = []
    for uid_ in body.user_ids:
        if await membership(db, group_id, uid_) is not None:
            continue
        if await db.get(User, uid_) is None:
            continue
        member = GroupMember(group_id=group_id, user_id=uid_, role=body.role, invited_by=me.id)
        db.add(member)
        added.append(member)
        await enqueue(db, uid_, "group.invited", {"title": group.title, "who": me.display_name},
                      dedup_key=f"group-add:{group_id}:{uid_}")
    await db.commit()
    for m in added:
        await db.refresh(m)
    return added


@router.patch("/{group_id}/members/{user_id}", response_model=MemberOut)
async def set_role(
    group_id: UUID, user_id: UUID, role: GroupRole,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    group, member = await require_group(db, group_id, me, "group.manage_roles")
    target = await membership(db, group_id, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "участник не найден")
    if target.role is GroupRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "нельзя понизить владельца")
    if role is GroupRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "владение передаётся отдельной ручкой")
    if role not in UI_ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "недопустимая роль")
    # админ не трогает других админов
    if not is_owner(member) and target.role is GroupRole.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "только владелец меняет админов")
    target.role = role
    await db.commit()
    return target


@router.delete("/{group_id}/members/{user_id}", status_code=204)
async def kick(
    group_id: UUID, user_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    await require_group(db, group_id, me, "members.remove")
    target = await membership(db, group_id, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "участник не найден")
    if target.role is GroupRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "владельца исключить нельзя")
    await db.delete(target)
    await db.commit()


@router.post("/{group_id}/transfer-ownership", status_code=204)
async def transfer(
    group_id: UUID, user_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    group, member = await require_group(db, group_id, me)
    if not is_owner(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "передать владение может только владелец")
    target = await membership(db, group_id, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "участник не найден")
    member.role = GroupRole.admin
    target.role = GroupRole.owner
    group.owner_id = user_id
    await db.commit()


@router.post("/{group_id}/invites", response_model=InviteOut, status_code=201)
async def make_invite(
    group_id: UUID, max_uses: int | None = None, expires_at: datetime | None = None,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    await require_group(db, group_id, me, "members.invite")
    code = secrets.token_urlsafe(9)
    db.add(GroupInvite(code=code, group_id=group_id, created_by=me.id,
                       max_uses=max_uses, expires_at=expires_at))
    await db.commit()
    url = f"https://t.me/{settings.bot_username}/app?startapp=g_{code}"
    return InviteOut(code=code, url=url, expires_at=expires_at, max_uses=max_uses)


@router.post("/invites/{code}/accept", response_model=GroupOut)
async def accept(code: str, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    invite = await db.get(GroupInvite, code)
    now = datetime.now(timezone.utc)
    if invite is None or invite.revoked_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ссылка недействительна")
    if invite.expires_at is not None and invite.expires_at < now:
        raise HTTPException(status.HTTP_410_GONE, "срок ссылки истёк")
    if invite.max_uses is not None and invite.uses >= invite.max_uses:
        raise HTTPException(status.HTTP_410_GONE, "ссылка исчерпана")

    group = await db.get(Group, invite.group_id)
    if group is None or group.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "группа не найдена")

    if await membership(db, group.id, me.id) is None:
        db.add(GroupMember(group_id=group.id, user_id=me.id,
                           role=invite.role_on_join, invited_by=invite.created_by))
        invite.uses += 1
        await enqueue(db, group.owner_id, "group.invited",
                      {"title": group.title, "who": me.display_name})
    await db.commit()
    return await _out(db, group, me)
