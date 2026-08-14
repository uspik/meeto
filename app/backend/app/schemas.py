from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .models import EventFormat, EventStatus, GroupRole, RsvpStatus


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORM):
    id: UUID
    tg_id: int
    username: str | None = None
    first_name: str
    last_name: str | None = None
    photo_url: str | None = None
    timezone: str


class TokensOut(BaseModel):
    access: str
    refresh: str
    expires_in: int
    user: UserOut
    start_param: str | None = None


class GroupIn(BaseModel):
    title: str = Field(min_length=1, max_length=128)
    description: str | None = None
    color: str = "#5b8def"


class MemberOut(ORM):
    user: UserOut
    role: GroupRole
    joined_at: datetime
    # active — в группе, pending — позвали, ответа ещё нет
    state: str = "active"


class GroupOut(ORM):
    id: UUID
    title: str
    description: str | None = None
    color: str
    owner_id: UUID
    my_role: GroupRole | None = None
    members_count: int = 0
    # выросла из чата Telegram: состав пополняется кнопкой в чате,
    # а уведомления о мероприятиях уходят туда же
    from_chat: bool = False


class InviteOut(BaseModel):
    code: str
    url: str
    expires_at: datetime | None = None
    max_uses: int | None = None


class EventIn(BaseModel):
    group_id: UUID | None = None
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    emoji: str = "\U0001f3af"
    cover: str = "linear-gradient(135deg,#667eea,#764ba2)"
    format: EventFormat = EventFormat.offline
    place: str | None = None
    online_url: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    timezone: str | None = None
    is_time_flexible: bool = False
    capacity_max: int | None = None
    waitlist_enabled: bool = True
    quorum_min: int | None = None
    quorum_deadline: datetime | None = None
    auto_cancel_on_quorum_fail: bool = True
    invite_all_group: bool = True


class EventPatch(BaseModel):
    """Группа сюда намеренно не входит: переносить мероприятие между группами
    нельзя — у участников уже сложились ответы и приглашения."""

    title: str | None = None
    description: str | None = None
    emoji: str | None = None
    cover: str | None = None
    format: EventFormat | None = None
    place: str | None = None
    online_url: str | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    capacity_max: int | None = None
    quorum_min: int | None = None
    quorum_deadline: datetime | None = None
    emoji: str | None = None
    is_time_flexible: bool | None = None
    waitlist_enabled: bool | None = None


class ParticipantOut(ORM):
    user: UserOut
    status: RsvpStatus
    arrival_at: datetime | None = None
    departure_at: datetime | None = None
    waitlist_pos: int | None = None


class MembersIn(BaseModel):
    user_ids: list[UUID] = []
    # тех, кого в Meeto ещё нет, зовём по @username — приглашение сработает,
    # когда человек впервые откроет бота
    usernames: list[str] = []
    role: GroupRole = GroupRole.member


class InviteUsersIn(BaseModel):
    """Гости вне группы: попадают в мероприятие, но не в саму группу."""

    user_ids: list[UUID] = []
    usernames: list[str] = []


class InviteResult(BaseModel):
    added: int = 0
    pending: list[str] = []


class ParticipantsOut(BaseModel):
    participants: list["ParticipantOut"] = []
    pending: list[str] = []


class EventOut(ORM):
    id: UUID
    group_id: UUID | None = None
    group_title: str | None = None
    creator_id: UUID
    title: str
    description: str | None = None
    emoji: str
    cover: str
    format: EventFormat
    place: str | None = None
    online_url: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    is_time_flexible: bool
    capacity_max: int | None = None
    quorum_min: int | None = None
    quorum_deadline: datetime | None = None
    status: EventStatus
    cancel_reason: str | None = None
    going_count: int
    seats_taken: int
    my_status: RsvpStatus | None = None
    my_arrival: datetime | None = None
    can_edit: bool = False
    is_past: bool = False
    is_organizer: bool = False
    can_rsvp: bool = True
    # организатор не может отказаться, но время прихода указать вправе
    can_set_arrival: bool = False
    rsvp_locked_reason: str | None = None


class RsvpIn(BaseModel):
    status: RsvpStatus
    arrival_at: datetime | None = None
    departure_at: datetime | None = None
    plus_ones: int = 0
    note: str | None = None


class Conflict(BaseModel):
    frm: datetime = Field(alias="from")
    to: datetime
    event_ids: list[UUID]

    model_config = ConfigDict(populate_by_name=True)


class CalendarOut(BaseModel):
    events: list[EventOut]
    conflicts: list[Conflict]
