import type { Conflict, Event } from "./types";

/** Окно присутствия: гибкое время участника сужает интервал мероприятия. */
export function span(e: Event): [Date, Date] {
  const start = new Date(e.starts_at);
  const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 3600_000);
  if (e.is_time_flexible && e.my_arrival) {
    const a = new Date(e.my_arrival);
    if (a > start && a < end) return [a, end];
  }
  return [start, end];
}

/** Пересечения принятых мероприятий за конкретный день. */
export function conflictsOn(events: Event[], day: Date): Conflict[] {
  const accepted = events
    .filter((e) => e.my_status === "going" && e.status !== "cancelled" && onDay(e, day))
    .map((e) => {
      const [s, t] = span(e);
      return { id: e.id, s: s.getTime(), e: t.getTime() };
    })
    .sort((a, b) => a.s - b.s);

  const out: Conflict[] = [];
  for (let i = 0; i < accepted.length; i++) {
    for (let j = i + 1; j < accepted.length; j++) {
      if (accepted[j].s >= accepted[i].e) break;
      const from = Math.max(accepted[i].s, accepted[j].s);
      const to = Math.min(accepted[i].e, accepted[j].e);
      if (to > from) {
        out.push({
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          event_ids: [accepted[i].id, accepted[j].id],
        });
      }
    }
  }
  return out;
}

export function onDay(e: Event, d: Date): boolean {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const start = new Date(e.starts_at).getTime();
  const end = e.ends_at ? new Date(e.ends_at).getTime() : start;
  return start < s + 86_400_000 && end > s;
}
