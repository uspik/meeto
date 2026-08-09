"""Роли — это именованные пресеты флагов, а не жёсткая иерархия."""

from .models import GroupRole

PRESETS: dict[GroupRole, set[str]] = {
    GroupRole.owner: {
        "group.delete", "group.transfer_ownership", "group.edit_settings", "group.manage_roles",
        "members.invite", "members.remove", "members.view_contacts",
        "events.create", "events.edit_any", "events.cancel_any",
        "notifications.configure_group", "analytics.view", "data.export",
    },
    GroupRole.admin: {
        "group.edit_settings", "group.manage_roles",
        "members.invite", "members.remove", "members.view_contacts",
        "events.create", "events.edit_any", "events.cancel_any",
        "notifications.configure_group", "analytics.view", "data.export",
    },
    GroupRole.moderator: {"members.invite", "members.view_contacts", "events.create"},
    GroupRole.organizer: {"members.invite", "members.view_contacts", "events.create"},
    GroupRole.member: set(),
    GroupRole.guest: set(),
}

# Флаги, которые владелец настраивает для роли member на уровне группы
MEMBER_TUNABLE = {"events.create", "members.invite", "members.view_contacts"}


def flags_for(role: GroupRole, member_defaults: dict | None, override: dict | None) -> set[str]:
    flags = set(PRESETS.get(role, set()))
    if role is GroupRole.member and member_defaults:
        for flag in MEMBER_TUNABLE:
            if member_defaults.get(flag):
                flags.add(flag)
    for flag, allowed in (override or {}).items():
        flags.add(flag) if allowed else flags.discard(flag)
    return flags


def can(role: GroupRole, flag: str, member_defaults=None, override=None) -> bool:
    return flag in flags_for(role, member_defaults, override)
