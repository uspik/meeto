-- Meeto — схема БД (PostgreSQL 16)
-- Совместима с Alembic: этот файл — референс, миграции генерируются из моделей.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- GiST по (uuid, tstzrange)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- поиск по чату

-- ============================================================
-- ENUM'ы
-- ============================================================

CREATE TYPE group_role       AS ENUM ('owner','admin','moderator','organizer','member','guest');
CREATE TYPE membership_state AS ENUM ('active','pending','banned','left');
CREATE TYPE event_format     AS ENUM ('online','offline','hybrid');
CREATE TYPE event_visibility AS ENUM ('group','invite_only','public_link');
CREATE TYPE event_status     AS ENUM ('draft','published','confirmed','cancelled','completed');
CREATE TYPE rsvp_status      AS ENUM ('invited','going','maybe','declined','waitlisted','attended','no_show');
CREATE TYPE requirement_kind AS ENUM ('checkbox','text','number','file');
CREATE TYPE completion_state AS ENUM ('pending','confirmed','rejected');
CREATE TYPE notify_channel   AS ENUM ('bot','inapp','off');
CREATE TYPE pref_scope       AS ENUM ('user','group','event');
CREATE TYPE outbox_state     AS ENUM ('scheduled','sending','sent','failed','cancelled');
CREATE TYPE chat_scope       AS ENUM ('group','event');

-- ============================================================
-- Пользователи
-- ============================================================

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tg_id          bigint      NOT NULL UNIQUE,
    username       text,
    first_name     text        NOT NULL,
    last_name      text,
    photo_url      text,
    language_code  text        NOT NULL DEFAULT 'ru',
    timezone       text        NOT NULL DEFAULT 'Europe/Moscow',  -- IANA
    quiet_hours    int4range,                                     -- [22,8) в минутах/часах локально
    is_bot_blocked boolean     NOT NULL DEFAULT false,
    is_premium     boolean     NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz
);

-- ============================================================
-- Группы и членство
-- ============================================================

CREATE TABLE groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title           text        NOT NULL,
    description     text,
    avatar_url      text,
    owner_id        uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- дефолтные права роли member, настраиваются владельцем:
    member_defaults jsonb       NOT NULL DEFAULT '{"events.create": false, "members.invite": true}',
    -- срок хранения сообщений чата в днях; NULL = бессрочно
    chat_retention_days int,
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE TABLE group_members (
    group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role         group_role       NOT NULL DEFAULT 'member',
    state        membership_state NOT NULL DEFAULT 'active',
    -- точечные переопределения флагов поверх пресета роли:
    -- {"events.create": true, "chat.write": false}
    permissions_override jsonb    NOT NULL DEFAULT '{}',
    invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    muted_until  timestamptz,
    joined_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX ix_group_members_user ON group_members(user_id) WHERE state = 'active';

-- ровно один владелец на группу
CREATE UNIQUE INDEX ux_group_single_owner
    ON group_members(group_id) WHERE role = 'owner';

CREATE TABLE group_invites (
    code         text PRIMARY KEY,                       -- короткий, url-safe
    group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_on_join group_role  NOT NULL DEFAULT 'member',
    max_uses     int,
    uses         int         NOT NULL DEFAULT 0,
    requires_approval boolean NOT NULL DEFAULT false,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_group_invites_group ON group_invites(group_id);

-- ============================================================
-- Мероприятия
-- ============================================================

CREATE TABLE events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id      uuid REFERENCES groups(id) ON DELETE CASCADE,  -- NULL = личное мероприятие
    creator_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    title         text        NOT NULL,
    description   text,
    format        event_format NOT NULL DEFAULT 'offline',
    location_text text,
    location_lat  double precision,
    location_lon  double precision,
    online_url    text,                                   -- виден только going

    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz,
    timezone      text        NOT NULL DEFAULT 'Europe/Moscow',
    is_time_flexible boolean  NOT NULL DEFAULT false,     -- участник указывает своё окно

    cover_url     text,
    cover_color   text        NOT NULL DEFAULT '#5B8DEF',

    capacity_max     int  CHECK (capacity_max  IS NULL OR capacity_max  > 0),
    waitlist_enabled boolean NOT NULL DEFAULT true,
    allow_plus_ones  boolean NOT NULL DEFAULT false,
    max_plus_ones    int     NOT NULL DEFAULT 0,

    quorum_min       int  CHECK (quorum_min IS NULL OR quorum_min > 0),
    quorum_deadline  timestamptz,
    auto_cancel_on_quorum_fail boolean NOT NULL DEFAULT true,
    quorum_resolved_at timestamptz,                       -- защита от повторной обработки

    rsvp_deadline timestamptz,
    visibility    event_visibility NOT NULL DEFAULT 'group',
    status        event_status     NOT NULL DEFAULT 'draft',
    cancel_reason text,

    -- денормализованные счётчики, обновляются в той же транзакции, что и RSVP
    going_count   int NOT NULL DEFAULT 0,
    seats_taken   int NOT NULL DEFAULT 0,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_event_time     CHECK (ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT ck_quorum_pair    CHECK ((quorum_min IS NULL) = (quorum_deadline IS NULL)),
    CONSTRAINT ck_quorum_before  CHECK (quorum_deadline IS NULL OR quorum_deadline <= starts_at),
    CONSTRAINT ck_quorum_cap     CHECK (quorum_min IS NULL OR capacity_max IS NULL
                                        OR quorum_min <= capacity_max),
    CONSTRAINT ck_plus_ones      CHECK (NOT allow_plus_ones OR max_plus_ones > 0)
);
CREATE INDEX ix_events_group_time ON events(group_id, starts_at)
    WHERE status <> 'draft';
CREATE INDEX ix_events_quorum_due ON events(quorum_deadline)
    WHERE status = 'published' AND quorum_deadline IS NOT NULL AND quorum_resolved_at IS NULL;
CREATE INDEX ix_events_upcoming ON events(starts_at) WHERE status IN ('published','confirmed');

-- ============================================================
-- Участие (RSVP)
-- ============================================================

CREATE TABLE event_participants (
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    status        rsvp_status NOT NULL DEFAULT 'invited',
    arrival_at    timestamptz,       -- если is_time_flexible
    departure_at  timestamptz,
    plus_ones     int NOT NULL DEFAULT 0 CHECK (plus_ones >= 0),
    note          text,
    waitlist_pos  int,
    promote_expires_at timestamptz,  -- окно на подтверждение после промоушена
    invited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    invited_at    timestamptz NOT NULL DEFAULT now(),
    responded_at  timestamptz,
    -- интервал присутствия для поиска пересечений; заполняется триггером
    -- (generated-колонка не может ссылаться на другую таблицу)
    span          tstzrange,
    PRIMARY KEY (event_id, user_id),
    CONSTRAINT ck_participant_window CHECK (departure_at IS NULL OR arrival_at IS NULL
                                            OR departure_at > arrival_at)
);
CREATE INDEX ix_participants_user_status ON event_participants(user_id, status);
CREATE INDEX ix_participants_waitlist ON event_participants(event_id, waitlist_pos)
    WHERE status = 'waitlisted';

-- ============================================================
-- Требования (чек-лист)
-- ============================================================

CREATE TABLE event_requirements (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    position      int  NOT NULL DEFAULT 0,
    title         text NOT NULL,
    description   text,
    kind          requirement_kind NOT NULL DEFAULT 'checkbox',
    is_mandatory  boolean NOT NULL DEFAULT false,
    requires_verification boolean NOT NULL DEFAULT false,
    notify_on_complete    boolean NOT NULL DEFAULT true,  -- уведомлять владельца
    due_at        timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_requirements_event ON event_requirements(event_id, position);

CREATE TABLE requirement_completions (
    requirement_id uuid NOT NULL REFERENCES event_requirements(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state          completion_state NOT NULL DEFAULT 'confirmed',
    value          jsonb,             -- {"text": "..."} | {"number": 1500} | {"file_url": "..."}
    completed_at   timestamptz NOT NULL DEFAULT now(),
    verified_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    verified_at    timestamptz,
    verifier_comment text,
    PRIMARY KEY (requirement_id, user_id)
);
CREATE INDEX ix_completions_user ON requirement_completions(user_id);

-- ============================================================
-- Уведомления
-- ============================================================

CREATE TABLE notification_prefs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope      pref_scope NOT NULL,
    scope_id   uuid,                  -- NULL для scope='user'
    event_type text NOT NULL,         -- 'event.reminder', 'requirement.completed', ...
    channel    notify_channel NOT NULL DEFAULT 'bot',
    enabled    boolean NOT NULL DEFAULT true,
    lead_times int[] NOT NULL DEFAULT '{}',   -- минуты до начала, для reminder
    CONSTRAINT ck_scope_id CHECK ((scope = 'user') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX ux_prefs ON notification_prefs(
    user_id, scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), event_type);

CREATE TABLE notifications_outbox (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         text NOT NULL,
    payload      jsonb NOT NULL,
    dedup_key    text,                -- 'reminder:<event>:<user>:60'
    scheduled_at timestamptz NOT NULL DEFAULT now(),
    state        outbox_state NOT NULL DEFAULT 'scheduled',
    attempts     int NOT NULL DEFAULT 0,
    last_error   text,
    sent_at      timestamptz,
    tg_message_id bigint,             -- чтобы редактировать, а не дублировать
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_outbox_dedup ON notifications_outbox(dedup_key)
    WHERE dedup_key IS NOT NULL AND state <> 'cancelled';
CREATE INDEX ix_outbox_due ON notifications_outbox(scheduled_at)
    WHERE state = 'scheduled';

-- ============================================================
-- Чат
-- ============================================================

CREATE TABLE chats (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope      chat_scope NOT NULL,
    scope_id   uuid NOT NULL,          -- group_id | event_id
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_chat_scope ON chats(scope, scope_id);

CREATE TABLE messages (
    id          bigserial PRIMARY KEY,
    chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    text        text,
    attachments jsonb NOT NULL DEFAULT '[]',
    reply_to_id bigint REFERENCES messages(id) ON DELETE SET NULL,
    mentions    uuid[] NOT NULL DEFAULT '{}',
    is_pinned   boolean NOT NULL DEFAULT false,
    is_system   boolean NOT NULL DEFAULT false,   -- «Иван присоединился», «Время изменено»
    created_at  timestamptz NOT NULL DEFAULT now(),
    edited_at   timestamptz,
    deleted_at  timestamptz,
    CONSTRAINT ck_message_body CHECK (text IS NOT NULL OR attachments <> '[]')
);
CREATE INDEX ix_messages_chat ON messages(chat_id, id DESC);
CREATE INDEX ix_messages_search ON messages USING gin (text gin_trgm_ops);

CREATE TABLE message_reactions (
    message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      text   NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE chat_reads (
    chat_id              uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id bigint,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);

-- ============================================================
-- Аудит
-- ============================================================

CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    scope      text NOT NULL,          -- 'group' | 'event'
    scope_id   uuid NOT NULL,
    action     text NOT NULL,          -- 'role.changed', 'event.cancelled', ...
    payload    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_scope ON audit_log(scope, scope_id, created_at DESC);

-- ============================================================
-- Триггер: заполнение интервала присутствия
-- ============================================================

CREATE OR REPLACE FUNCTION fill_participant_span() RETURNS trigger AS $$
DECLARE
    e_start timestamptz;
    e_end   timestamptz;
BEGIN
    SELECT starts_at, COALESCE(ends_at, starts_at + interval '1 hour')
      INTO e_start, e_end
      FROM events WHERE id = NEW.event_id;

    NEW.span := tstzrange(COALESCE(NEW.arrival_at, e_start),
                          COALESCE(NEW.departure_at, e_end), '[)');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_participant_span
    BEFORE INSERT OR UPDATE OF arrival_at, departure_at ON event_participants
    FOR EACH ROW EXECUTE FUNCTION fill_participant_span();

-- ============================================================
-- Поиск пересечений принятых мероприятий пользователя
-- ============================================================

CREATE OR REPLACE VIEW v_user_conflicts AS
SELECT a.user_id,
       a.event_id  AS event_a,
       b.event_id  AS event_b,
       lower(a.span * b.span) AS conflict_from,
       upper(a.span * b.span) AS conflict_to
FROM event_participants a
JOIN event_participants b
  ON a.user_id = b.user_id
 AND a.event_id < b.event_id
 AND a.span && b.span
JOIN events ea ON ea.id = a.event_id AND ea.status <> 'cancelled'
JOIN events eb ON eb.id = b.event_id AND eb.status <> 'cancelled'
WHERE a.status = 'going' AND b.status = 'going';

CREATE INDEX ix_participants_span ON event_participants
    USING gist (user_id, span) WHERE status = 'going';
