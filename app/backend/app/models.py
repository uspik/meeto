import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, DateTime, Enum, ForeignKey, Index,
    Integer, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON, TypeDecorator, CHAR

from .db import Base


class GUID(TypeDecorator):
    """uuid для Postgres, строка для SQLite (нужно в тестах)."""

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import UUID as PGUUID

            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if dialect.name == "postgresql":
            return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
        return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


JSONType = JSON().with_variant(JSONB, "postgresql")


def uid() -> uuid.UUID:
    return uuid.uuid4()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class GroupRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    moderator = "moderator"
    organizer = "organizer"
    member = "member"
    guest = "guest"


class EventFormat(str, enum.Enum):
    online = "online"
    offline = "offline"
    hybrid = "hybrid"


class EventStatus(str, enum.Enum):
    draft = "draft"
    published = "published"
    confirmed = "confirmed"
    cancelled = "cancelled"
    completed = "completed"


class RsvpStatus(str, enum.Enum):
    invited = "invited"
    going = "going"
    maybe = "maybe"
    declined = "declined"
    waitlisted = "waitlisted"
    attended = "attended"
    no_show = "no_show"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uid)
    tg_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str] = mapped_column(String(128), default="")
    last_name: Mapped[str | None] = mapped_column(String(128))
    photo_url: Mapped[str | None] = mapped_column(Text)
    language_code: Mapped[str] = mapped_column(String(8), default="ru")
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Moscow")
    is_bot_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    @property
    def display_name(self) -> str:
        return " ".join(filter(None, [self.first_name, self.last_name])) or (self.username or "—")


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uid)
    title: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str] = mapped_column(String(64), default="#5b8def")
    owner_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("users.id"))
    member_defaults: Mapped[dict] = mapped_column(
        JSONType, default=lambda: {"events.create": False, "members.invite": True}
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    members: Mapped[list["GroupMember"]] = relationship(back_populates="group", lazy="selectin")


class GroupMember(Base):
    __tablename__ = "group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[GroupRole] = mapped_column(Enum(GroupRole), default=GroupRole.member)
    permissions_override: Mapped[dict] = mapped_column(JSONType, default=dict)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(GUID, ForeignKey("users.id"))
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    group: Mapped[Group] = relationship(back_populates="members")
    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="selectin")


class GroupInvite(Base):
    __tablename__ = "group_invites"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("groups.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("users.id"))
    role_on_join: Mapped[GroupRole] = mapped_column(Enum(GroupRole), default=GroupRole.member)
    max_uses: Mapped[int | None] = mapped_column(Integer)
    uses: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uid)
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("groups.id", ondelete="CASCADE")
    )
    creator_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("users.id"))

    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    emoji: Mapped[str] = mapped_column(String(8), default="\U0001f3af")
    cover: Mapped[str] = mapped_column(Text, default="linear-gradient(135deg,#667eea,#764ba2)")

    format: Mapped[EventFormat] = mapped_column(Enum(EventFormat), default=EventFormat.offline)
    place: Mapped[str | None] = mapped_column(Text)
    online_url: Mapped[str | None] = mapped_column(Text)

    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Moscow")
    is_time_flexible: Mapped[bool] = mapped_column(Boolean, default=False)

    capacity_max: Mapped[int | None] = mapped_column(Integer)
    waitlist_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    quorum_min: Mapped[int | None] = mapped_column(Integer)
    quorum_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    auto_cancel_on_quorum_fail: Mapped[bool] = mapped_column(Boolean, default=True)
    quorum_resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    status: Mapped[EventStatus] = mapped_column(Enum(EventStatus), default=EventStatus.published)
    cancel_reason: Mapped[str | None] = mapped_column(Text)

    going_count: Mapped[int] = mapped_column(Integer, default=0)
    seats_taken: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    __table_args__ = (
        CheckConstraint("ends_at IS NULL OR ends_at > starts_at", name="ck_event_time"),
        CheckConstraint("capacity_max IS NULL OR capacity_max > 0", name="ck_capacity"),
        CheckConstraint("quorum_min IS NULL OR quorum_min > 0", name="ck_quorum"),
        Index("ix_events_group_time", "group_id", "starts_at"),
    )

    participants: Mapped[list["Participant"]] = relationship(
        back_populates="event", lazy="selectin", cascade="all, delete-orphan"
    )
    group: Mapped[Group | None] = relationship(lazy="selectin")


class Participant(Base):
    __tablename__ = "event_participants"

    event_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[RsvpStatus] = mapped_column(Enum(RsvpStatus), default=RsvpStatus.invited)
    arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    departure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    plus_ones: Mapped[int] = mapped_column(Integer, default=0)
    waitlist_pos: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    invited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    event: Mapped[Event] = relationship(back_populates="participants")
    user: Mapped[User] = relationship(lazy="selectin")

    __table_args__ = (Index("ix_participants_user_status", "user_id", "status"),)


class Outbox(Base):
    """Транзакционный аутбокс: запись создаётся в той же транзакции, что и действие."""

    __tablename__ = "notifications_outbox"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uid)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("users.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSONType, default=dict)
    dedup_key: Mapped[str | None] = mapped_column(String(200))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    state: Mapped[str] = mapped_column(String(16), default="scheduled")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        UniqueConstraint("dedup_key", name="ux_outbox_dedup"),
        Index("ix_outbox_due", "scheduled_at", "state"),
    )


class PendingInvite(Base):
    """Приглашение человеку, которого в Meeto ещё нет.

    Хранится по @username. Как только он впервые откроет бота, приглашение
    применится само — и группа с мероприятием уже будут его ждать.
    Новая таблица создаётся из моделей, существующие не трогает.
    """

    __tablename__ = "pending_invites"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uid)
    username: Mapped[str] = mapped_column(String(64), index=True)
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("groups.id", ondelete="CASCADE")
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID, ForeignKey("events.id", ondelete="CASCADE")
    )
    role: Mapped[GroupRole] = mapped_column(Enum(GroupRole), default=GroupRole.member)
    invited_by: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        UniqueConstraint("username", "group_id", "event_id", name="ux_pending_target"),
    )
