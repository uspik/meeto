import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..deps import current_user, is_owner, membership, require_group
from ..models import (
    Group, GroupInvite, GroupMember, GroupRole, MembershipState, PendingInvite, User,
)
from ..schemas import GroupIn, GroupOut, InviteOut, InviteResult, MemberOut, MembersIn
from ..services import invites as inv
from ..services import live
from ..services.notify import enqueue

router = APIRouter(prefix="/groups", tags=["groups"])


async def _out(db: AsyncSession, group: Group, me: User) -> GroupOut:
    cnt = await db.execute(
        select(func.count()).select_from(GroupMember)
        .where(GroupMember.group_id == group.id,
               GroupMember.state == MembershipState.active.value)
    )
    mem = await membership(db, group.id, me.id)
    return GroupOut(
        id=group.id, title=group.title, description=group.description, color=group.color,
        owner_id=group.owner_id, my_role=mem.role if mem else None,
        members_count=int(cnt.scalar_one()),
        from_chat=group.tg_chat_id is not None,
    )


@router.get("", response_model=list[GroupOut])
async def my_groups(me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(Group)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_id == me.id,
               GroupMember.state == MembershipState.active.value,
               Group.deleted_at.is_(None))
        .order_by(Group.created_at)
    )
    return [await _out(db, g, me) for g in res.scalars().all()]


@router.get("/invitations", response_model=list[GroupOut])
async def invitations(me: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Куда позвали, но вы ещё не ответили."""
    res = await db.execute(
        select(Group)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_id == me.id,
               GroupMember.state == MembershipState.pending.value,
               Group.deleted_at.is_(None))
        .order_by(Group.created_at)
    )
    return [await _out(db, g, me) for g in res.scalars().all()]


@router.post("/{group_id}/accept", response_model=GroupOut)
async def accept_invitation(
    group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    group, member = await require_group(db, group_id, me, allow_pending=True)
    member.state = MembershipState.active.value
    await enqueue(db, group.owner_id, "group.joined",
                  {"title": group.title, "who": me.display_name},
                  dedup_key=f"joined:{group_id}:{me.id}")
    await db.commit()
    await live.group_changed(db, group_id)
    return await _out(db, group, me)


@router.post("/{group_id}/decline", status_code=204)
async def decline_invitation(
    group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    _, member = await require_group(db, group_id, me, allow_pending=True)
    await db.delete(member)
    await db.commit()
    await live.group_changed(db, group_id, extra={me.id})


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
        select(GroupMember)
        .where(GroupMember.group_id == group_id,
               GroupMember.state.in_([MembershipState.active.value,
                                      MembershipState.pending.value]))
        .order_by(GroupMember.joined_at)
    )
    return list(res.scalars().all())


UI_ROLES = {GroupRole.owner, GroupRole.admin, GroupRole.member}


@router.post("/{group_id}/members", response_model=InviteResult, status_code=201)
async def add_members(
    group_id: UUID, body: MembersIn,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    """Добавить людей в группу — как при создании чата в Telegram.

    Кого ещё нет в Meeto, зовём по @username: приглашение сработает при
    первом входе, и группа уже будет его ждать.
    """
    group, _ = await require_group(db, group_id, me, "members.invite")
    if body.role not in UI_ROLES or body.role is GroupRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "недопустимая роль")

    found, missing = await inv.resolve(db, body.usernames)
    ids = list(body.user_ids) + [u.id for u in found]

    added: list[GroupMember] = []
    for uid_ in ids:
        if await membership(db, group_id, uid_) is not None:
            continue
        if await db.get(User, uid_) is None:
            continue
        # человека не зачисляем молча: он должен согласиться
        member = GroupMember(group_id=group_id, user_id=uid_, role=body.role,
                             invited_by=me.id, state=MembershipState.pending.value)
        db.add(member)
        added.append(member)
        await enqueue(db, uid_, "group.invited",
                      {"title": group.title, "who": me.display_name, "group_id": str(group_id)},
                      dedup_key=f"group-add:{group_id}:{uid_}")

    await inv.remember_contact(db, me.id, ids)
    pending = await inv.remember(db, missing, by=me.id, group_id=group_id, role=body.role)
    await db.commit()
    await live.group_changed(db, group_id, extra=set(ids))
    return InviteResult(added=len(added), pending=pending)


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
    await live.group_changed(db, group_id)
    return target


@router.delete("/{group_id}/members/{user_id}", status_code=204)
async def kick(
    group_id: UUID, user_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    # выйти из группы можно всегда, исключать других — только с правом
    if user_id == me.id:
        await require_group(db, group_id, me)
    else:
        await require_group(db, group_id, me, "members.remove")
    target = await membership(db, group_id, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "участник не найден")
    if target.role is GroupRole.owner:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "владелец не может выйти — сначала передайте владение"
            if user_id == me.id else "владельца исключить нельзя",
        )
    await db.delete(target)
    # исключение не должно быть дорогой в один конец: запоминаем контакт,
    # иначе человек пропадает из подбора людей и позвать его обратно можно
    # только по точному @username — а его может и не быть вовсе
    if user_id != me.id:
        group_obj = await db.get(Group, group_id)
        keepers = {me.id} | ({group_obj.owner_id} if group_obj else set())
        for keeper in keepers:
            await inv.remember_contact(db, keeper, [user_id])
    await db.commit()
    await live.group_changed(db, group_id, extra={user_id})


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


def invite_url(code: str) -> str:
    # Прямая ссылка на главный Mini App бота. Формат /app?startapp= требует
    # отдельно созданного через /newapp приложения, иначе Telegram отвечает
    # «Bot application not found».
    return f"https://t.me/{settings.bot_username}?startapp=g_{code}"


async def active_invite(db: AsyncSession, group_id: UUID) -> GroupInvite | None:
    res = await db.execute(
        select(GroupInvite)
        .where(GroupInvite.group_id == group_id, GroupInvite.revoked_at.is_(None))
        .order_by(GroupInvite.created_at.desc())
    )
    return res.scalars().first()


@router.get("/{group_id}/invites", response_model=InviteOut)
async def current_invite(
    group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    """Постоянная ссылка группы.

    Отдаём одну и ту же при каждом заходе — раньше кнопка выпускала новый код,
    и разосланные приглашения тихо копились.
    """
    await require_group(db, group_id, me, "members.invite")
    invite = await active_invite(db, group_id)
    if invite is None:
        invite = GroupInvite(code=secrets.token_urlsafe(9), group_id=group_id, created_by=me.id)
        db.add(invite)
        await db.commit()
    return InviteOut(code=invite.code, url=invite_url(invite.code),
                     expires_at=invite.expires_at, max_uses=invite.max_uses)


@router.post("/{group_id}/invites", response_model=InviteOut, status_code=201)
async def make_invite(
    group_id: UUID, max_uses: int | None = None, expires_at: datetime | None = None,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    """Перевыпуск: прежняя ссылка перестаёт работать."""
    await require_group(db, group_id, me, "members.invite")
    old = await active_invite(db, group_id)
    if old is not None:
        old.revoked_at = datetime.now(timezone.utc)
    code = secrets.token_urlsafe(9)
    db.add(GroupInvite(code=code, group_id=group_id, created_by=me.id,
                       max_uses=max_uses, expires_at=expires_at))
    await db.commit()
    return InviteOut(code=code, url=invite_url(code),
                     expires_at=expires_at, max_uses=max_uses)


@router.get("/{group_id}/pending", response_model=list[str])
async def pending(
    group_id: UUID, me: User = Depends(current_user), db: AsyncSession = Depends(get_db)
):
    """Кого позвали, но кто ещё не открывал Meeto."""
    await require_group(db, group_id, me)
    rows = await db.execute(
        select(PendingInvite.username).where(PendingInvite.group_id == group_id)
    )
    return list(rows.scalars().all())


@router.delete("/{group_id}/pending/{username}", status_code=204)
async def drop_pending(
    group_id: UUID, username: str,
    me: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    await require_group(db, group_id, me, "members.invite")
    rows = await db.execute(
        select(PendingInvite).where(
            PendingInvite.group_id == group_id,
            PendingInvite.username == username.lstrip("@").lower(),
        )
    )
    for row in rows.scalars():
        await db.delete(row)
    await db.commit()


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
                           role=invite.role_on_join, invited_by=invite.created_by,
                           state=MembershipState.active.value))
        invite.uses += 1
        await enqueue(db, group.owner_id, "group.invited",
                      {"title": group.title, "who": me.display_name})
    await db.commit()
    return await _out(db, group, me)
