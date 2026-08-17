import { initData } from "./tg";
import type {
  CalendarPayload, Event, Group, GroupRole, InviteResult, Member,
  ParticipantsPayload, User,
} from "./types";

export const BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

let access: string | null = null;
let refresh: string | null = null;

/** Токен для потока изменений: EventSource умеет только строку запроса. */
export const accessToken = (): string | null => access;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function raw<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401 && retry && refresh) {
    const ok = await renew();
    if (ok) return raw<T>(path, init, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function renew(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${refresh}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    access = data.access;
    refresh = data.refresh;
    return true;
  } catch {
    return false;
  }
}

export interface Session { user: User; start_param: string | null }

export async function login(): Promise<Session> {
  // Отладочный вход: /?dev=<токен>. Работает, только если тот же токен
  // задан на сервере в DEV_LOGIN_TOKEN — иначе ручки просто нет.
  const dev = new URLSearchParams(location.search).get("dev");

  const res = dev
    ? await fetch(`${BASE}/auth/dev`, { method: "POST", headers: { "X-Dev-Token": dev } })
    : await fetch(`${BASE}/auth/telegram`, {
        method: "POST",
        headers: { Authorization: `tma ${initData()}` },
      });

  if (!res.ok) {
    throw new ApiError(res.status, dev
      ? "отладочный вход не сработал"
      : "не удалось войти через Telegram");
  }
  const data = await res.json();
  access = data.access;
  refresh = data.refresh;
  return { user: data.user, start_param: data.start_param ?? null };
}

export const api = {
  me: () => raw<User>("/me"),

  calendar: (from: Date, to: Date) =>
    raw<CalendarPayload>(
      `/calendar?from=${from.toISOString()}&to=${to.toISOString()}&with_conflicts=true`,
    ),

  groups: () => raw<Group[]>("/groups"),
  createGroup: (body: { title: string; description?: string; color?: string }) =>
    raw<Group>("/groups", { method: "POST", body: JSON.stringify(body) }),
  members: (id: string) => raw<Member[]>(`/groups/${id}/members`),
  deleteGroup: (id: string) => raw<void>(`/groups/${id}`, { method: "DELETE" }),
  groupPending: (id: string) => raw<string[]>(`/groups/${id}/pending`),
  cancelPending: (id: string, username: string) =>
    raw<void>(`/groups/${id}/pending/${username}`, { method: "DELETE" }),
  invite: (id: string) => raw<{ code: string; url: string }>(`/groups/${id}/invites`),
  rotateInvite: (id: string) =>
    raw<{ code: string; url: string }>(`/groups/${id}/invites`, { method: "POST" }),
  /** Куда позвали, но вы ещё не ответили. */
  groupInvitations: () => raw<Group[]>("/groups/invitations"),
  acceptGroup: (id: string) => raw<Group>(`/groups/${id}/accept`, { method: "POST" }),
  declineGroup: (id: string) => raw<void>(`/groups/${id}/decline`, { method: "POST" }),
  acceptInvite: (code: string) =>
    raw<Group>(`/groups/invites/${code}/accept`, { method: "POST" }),

  searchUsers: (q: string) =>
    raw<User[]>(`/users/search?q=${encodeURIComponent(q)}`),
  eventCandidates: (id: string) => raw<User[]>(`/users/of-event/${id}`),

  addMembers: (
    groupId: string, userIds: string[], usernames: string[] = [], role: GroupRole = "member",
  ) =>
    raw<InviteResult>(`/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ user_ids: userIds, usernames, role }),
    }),
  setRole: (groupId: string, userId: string, role: GroupRole) =>
    raw<Member>(`/groups/${groupId}/members/${userId}?role=${role}`, { method: "PATCH" }),
  removeMember: (groupId: string, userId: string) =>
    raw<void>(`/groups/${groupId}/members/${userId}`, { method: "DELETE" }),

  event: (id: string) => raw<Event>(`/events/${id}`),
  updateEvent: (id: string, body: Record<string, unknown>) =>
    raw<Event>(`/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  inviteToEvent: (id: string, userIds: string[], usernames: string[] = []) =>
    raw<InviteResult>(`/events/${id}/invite`, {
      method: "POST",
      body: JSON.stringify({ user_ids: userIds, usernames }),
    }),
  participants: (id: string) => raw<ParticipantsPayload>(`/events/${id}/participants`),
  dropParticipant: (eventId: string, userId: string) =>
    raw<void>(`/events/${eventId}/participants/${userId}`, { method: "DELETE" }),
  createEvent: (body: Record<string, unknown>) =>
    raw<Event>("/events", { method: "POST", body: JSON.stringify(body) }),
  cancelEvent: (id: string, reason: string) =>
    raw<Event>(`/events/${id}/cancel?reason=${encodeURIComponent(reason)}`, { method: "POST" }),
  rsvp: (id: string, body: Record<string, unknown>) =>
    raw<Event>(`/events/${id}/rsvp`, { method: "POST", body: JSON.stringify(body) }),
};
