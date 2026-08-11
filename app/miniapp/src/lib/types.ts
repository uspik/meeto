export type RsvpStatus =
  | "invited" | "going" | "maybe" | "declined" | "waitlisted" | "attended" | "no_show";
export type EventStatus = "draft" | "published" | "confirmed" | "cancelled" | "completed";
export type EventFormat = "online" | "offline" | "hybrid";
export type GroupRole = "owner" | "admin" | "moderator" | "organizer" | "member" | "guest";

export interface User {
  id: string; tg_id: number; username?: string | null;
  first_name: string; last_name?: string | null; photo_url?: string | null; timezone: string;
}

export interface Group {
  id: string; title: string; description?: string | null; color: string;
  owner_id: string; my_role?: GroupRole | null; members_count: number;
}

export interface Member { user: User; role: GroupRole; joined_at: string }

export interface Participant {
  user: User;
  status: RsvpStatus;
  arrival_at?: string | null;
  departure_at?: string | null;
  waitlist_pos?: number | null;
}

/** Список участников: ответившие плюс позванные, кого ещё нет в Meeto. */
export interface ParticipantsPayload { participants: Participant[]; pending: string[] }

export interface InviteResult { added: number; pending: string[] }

export interface Event {
  id: string;
  group_id?: string | null;
  group_title?: string | null;
  creator_id: string;
  title: string;
  description?: string | null;
  emoji: string;
  cover: string;
  format: EventFormat;
  place?: string | null;
  online_url?: string | null;
  starts_at: string;
  ends_at?: string | null;
  is_time_flexible: boolean;
  capacity_max?: number | null;
  quorum_min?: number | null;
  quorum_deadline?: string | null;
  status: EventStatus;
  cancel_reason?: string | null;
  going_count: number;
  seats_taken: number;
  my_status?: RsvpStatus | null;
  my_arrival?: string | null;
  can_edit: boolean;
  /** мероприятие уже прошло: отметка «Завершено» ставится дополнительно */
  is_past: boolean;
  can_rsvp: boolean;
  /** время прихода можно указать даже организатору */
  can_set_arrival: boolean;
  rsvp_locked_reason?: string | null;
}

export interface Conflict { from: string; to: string; event_ids: string[] }
export interface CalendarPayload { events: Event[]; conflicts: Conflict[] }

/** Статус для отрисовки: отменённое перебивает личный ответ. */
export type VisualStatus =
  | "going" | "invited" | "maybe" | "declined" | "waitlisted" | "cancelled";

export function visualStatus(e: Event): VisualStatus {
  if (e.status === "cancelled") return "cancelled";
  const s = e.my_status ?? "invited";
  if (s === "attended") return "going";
  if (s === "no_show") return "declined";
  return s as VisualStatus;
}

export const STATUS_LABEL: Record<VisualStatus, string> = {
  going: "Иду",
  invited: "Не ответил",
  maybe: "Под вопросом",
  declined: "Не иду",
  waitlisted: "В очереди",
  cancelled: "Отменено",
};
