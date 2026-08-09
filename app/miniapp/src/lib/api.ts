import { initData } from "./tg";
import type { CalendarPayload, Event, Group, Member, User } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

let access: string | null = null;
let refresh: string | null = null;

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

async function renew(): Promise<boolean> {
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
  const res = await fetch(`${BASE}/auth/telegram`, {
    method: "POST",
    headers: { Authorization: `tma ${initData()}` },
  });
  if (!res.ok) throw new ApiError(res.status, "не удалось войти через Telegram");
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
  invite: (id: string) =>
    raw<{ code: string; url: string }>(`/groups/${id}/invites`, { method: "POST" }),
  acceptInvite: (code: string) =>
    raw<Group>(`/groups/invites/${code}/accept`, { method: "POST" }),

  event: (id: string) => raw<Event>(`/events/${id}`),
  createEvent: (body: Record<string, unknown>) =>
    raw<Event>("/events", { method: "POST", body: JSON.stringify(body) }),
  cancelEvent: (id: string, reason: string) =>
    raw<Event>(`/events/${id}/cancel?reason=${encodeURIComponent(reason)}`, { method: "POST" }),
  rsvp: (id: string, body: Record<string, unknown>) =>
    raw<Event>(`/events/${id}/rsvp`, { method: "POST", body: JSON.stringify(body) }),
};
