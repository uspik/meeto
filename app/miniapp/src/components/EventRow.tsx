import { hm, timeRange } from "../lib/date";
import type { Event } from "../lib/types";
import { visualStatus } from "../lib/types";
import { Icon } from "./Icon";
import { StatusChip } from "./StatusChip";

interface Props { event: Event; index?: number; onOpen(e: Event): void }

export function EventRow({ event, index, onOpen }: Props) {
  const st = visualStatus(event);
  const time =
    timeRange(event.starts_at, event.ends_at) +
    (event.is_time_flexible && event.my_arrival ? ` · с ${hm(new Date(event.my_arrival))}` : "");

  const badges: string[] = [];
  if (event.status !== "cancelled") {
    if (event.quorum_min && event.going_count < event.quorum_min)
      badges.push(`кворум ${event.going_count}/${event.quorum_min}`);
    else if (event.capacity_max && event.seats_taken >= event.capacity_max) badges.push("мест нет");
    else if (event.capacity_max) badges.push(`${event.seats_taken}/${event.capacity_max}`);
  }

  return (
    <div
      className={`row s-${st} chip${event.is_past ? " is-past" : ""}${index === undefined ? "" : " rise"}`}
      style={index === undefined ? undefined : { animationDelay: `${index * 45}ms` }}
      onClick={() => onOpen(event)}
    >
      <Icon event={event} size="lg" />
      <div className="meta">
        <div className="rt">
          <em>{event.title}</em>
          <StatusChip event={event} />
        </div>
        <div className="rs">
          {time} · {event.format === "online" ? "🔗 онлайн" : `📍 ${event.place ?? "место уточняется"}`}
          {event.group_title ? ` · ${event.group_title}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
        {/* «Завершено» дополняет ответ участника, а не заменяет его */}
        {event.is_past && event.status !== "cancelled" && (
          <span className="done-badge">Завершено</span>
        )}
        {badges.map((b) => (
          <span key={b} className={b.startsWith("кворум") ? "badge b-q" : "badge b-s"}>{b}</span>
        ))}
      </div>
    </div>
  );
}
