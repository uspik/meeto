"""Группа Meeto, выросшая из чата Telegram.

Здесь только работа с базой — aiogram сюда не заглядывает. Так эти правила
можно прогнать смоуком без живого бота, а `bot.py` остаётся тонким слоем
над обновлениями Telegram.

Важное ограничение, из которого выросла вся схема: **бот не может получить
список участников чата**. Bot API отдаёт только администраторов и общее
число участников. Поэтому владелец чата попадает в группу сразу (его видно
через `getChatAdministrators`), а остальные — по кнопке «Я в деле» под
приветственным сообщением бота.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import Group, GroupMember, GroupRole, MembershipState, User

log = logging.getLogger("meeto.chats")

# В группе из чата мероприятие может создать любой участник: чат и так общий,
# спрашивать разрешения у владельца ради анонса незачем.
CHAT_MEMBER_DEFAULTS = {"events.create": True, "members.invite": True}


async def upsert_user(db: AsyncSession, tg: dict) -> User:
    """Пользователь по данным из обновления Telegram.

    Заводим и тех, кто ещё ни разу не открывал mini-app: иначе владельца чата
    некуда записать. Имя и username обновляем, всё остальное доедет при первом
    входе через initData.
    """
    tg_id = int(tg["id"])
    user = (await db.execute(select(User).where(User.tg_id == tg_id))).scalar_one_or_none()
    if user is None:
        user = User(tg_id=tg_id, timezone=settings.default_tz)
        db.add(user)
    user.first_name = tg.get("first_name") or user.first_name or ""
    if tg.get("last_name"):
        user.last_name = tg["last_name"]
    if tg.get("username"):
        user.username = tg["username"]
    await db.flush()
    return user


async def group_of_chat(db: AsyncSession, chat_id: int, *, alive: bool = True) -> Group | None:
    res = await db.execute(select(Group).where(Group.tg_chat_id == chat_id))
    group = res.scalars().first()
    if group is None or (alive and group.deleted_at is not None):
        return None
    return group


async def link_chat(db: AsyncSession, *, chat_id: int, title: str, owner: dict) -> Group:
    """Бота добавили в чат — заводим группу с тем же названием.

    Повторное добавление в тот же чат не плодит вторую группу: находим
    прежнюю по `tg_chat_id` и оживляем её вместе со всеми мероприятиями.
    """
    group = await group_of_chat(db, chat_id, alive=False)
    holder = await upsert_user(db, owner)

    if group is None:
        group = Group(title=title[:128], tg_chat_id=chat_id, owner_id=holder.id,
                      member_defaults=dict(CHAT_MEMBER_DEFAULTS))
        db.add(group)
        await db.flush()
        log.info("группа %s создана из чата %s", group.id, chat_id)
    else:
        group.deleted_at = None
        group.title = title[:128] or group.title

    # владелец чата — владелец группы; если группа была на ком-то другом,
    # прежнего владельца оставляем администратором, а не выкидываем
    old = (await db.execute(
        select(GroupMember).where(GroupMember.group_id == group.id,
                                  GroupMember.role == GroupRole.owner)
    )).scalars().all()
    for member in old:
        if member.user_id != holder.id:
            member.role = GroupRole.admin

    await _ensure_member(db, group, holder, role=GroupRole.owner)
    group.owner_id = holder.id
    await db.flush()
    return group


async def _ensure_member(
    db: AsyncSession, group: Group, user: User, *, role: GroupRole = GroupRole.member
) -> bool:
    """True — человека в группе не было. Приглашение подтверждать не нужно:
    он уже согласился, когда нажал кнопку в чате."""
    member = (await db.execute(
        select(GroupMember).where(GroupMember.group_id == group.id,
                                  GroupMember.user_id == user.id)
    )).scalar_one_or_none()
    if member is None:
        db.add(GroupMember(group_id=group.id, user_id=user.id, role=role,
                           state=MembershipState.active.value))
        return True
    # был приглашён и не ответил — нажатие кнопки и есть ответ
    member.state = MembershipState.active.value
    if role is GroupRole.owner:
        member.role = role
    return False


async def join_chat_group(db: AsyncSession, *, chat_id: int, tg: dict) -> tuple[Group, bool] | None:
    """Нажали «Я в деле» под приветствием бота."""
    group = await group_of_chat(db, chat_id)
    if group is None:
        return None
    user = await upsert_user(db, tg)
    added = await _ensure_member(db, group, user)
    return group, added


async def leave_chat_group(db: AsyncSession, *, chat_id: int, tg_id: int) -> bool:
    """Вышел из чата — выходит и из группы.

    Мероприятия, на которые он уже записался, за ним остаются: человек мог
    выйти из чата, но идти собирается. Владельца не трогаем — иначе группа
    останется без хозяина.
    """
    group = await group_of_chat(db, chat_id)
    if group is None:
        return False
    user = (await db.execute(select(User).where(User.tg_id == tg_id))).scalar_one_or_none()
    if user is None:
        return False
    member = (await db.execute(
        select(GroupMember).where(GroupMember.group_id == group.id,
                                  GroupMember.user_id == user.id)
    )).scalar_one_or_none()
    if member is None or member.role is GroupRole.owner:
        return False
    await db.delete(member)
    return True


async def rename_chat_group(db: AsyncSession, *, chat_id: int, title: str) -> bool:
    group = await group_of_chat(db, chat_id)
    if group is None or not title:
        return False
    group.title = title[:128]
    return True


async def unlink_chat(db: AsyncSession, *, chat_id: int) -> bool:
    """Бота убрали из чата — группу удаляем.

    Удаление мягкое, как и в приложении: строки остаются, группа пропадает
    из списков. Вернут бота в тот же чат — `link_chat` поднимет её обратно
    вместе с мероприятиями.
    """
    group = await group_of_chat(db, chat_id)
    if group is None:
        return False
    group.deleted_at = datetime.now(timezone.utc)
    log.info("группа %s отвязана: бота убрали из чата %s", group.id, chat_id)
    return True
