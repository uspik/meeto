import { useState } from "react";

import { useSheet } from "../lib/useSheet";
import { Icon } from "../components/Icon";
import { StatusChip } from "../components/StatusChip";
import { MN, hm } from "../lib/date";
import { api } from "../lib/api";
import { haptic } from "../lib/tg";
import type { Event, RsvpStatus } from "../lib/types";

const FORMAT = { online: "🔗 Онлайн", offline: "📍 Офлайн", hybrid: "🔗📍 Гибрид" } as const;
const ANSWERS: [RsvpStatus, string][] = [
  ["going", "Иду"], ["maybe", "Под вопросом"], ["declined", "Не иду"],
];

interface Props {
  event: Event;
  onClose(): void;
  onChanged(e: Event): void;
  onEdit(e: Event): void;
  onInvite(e: Event): void;
}

export function EventSheet({ event, onClose, onChanged, onEdit, onInvite }: Props) {
  const { close, cls } = useSheet(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = new Date(event.starts_at);

  async function answer(status: RsvpStatus) {
    haptic();
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.rsvp(event.id, { status: event.my_status === status ? "invited" : status }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось сохранить ответ");
    } finally {
      setBusy(false);
    }
  }

  const seatsPct = event.capacity_max
    ? Math.min(100, (event.seats_taken / event.capacity_max) * 100) : 0;
  const quorumPct = event.quorum_min
    ? Math.min(100, (event.going_count / event.quorum_min) * 100) : 0;

  return (
    <>
      <div className={`scrim on ${cls}`} onClick={close} />
      <div className={`sheet on ${cls}`}>
        <div className="grab" />
        <div className="sh-hd">
          <Icon event={event} size="xl" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{event.title}</h2>
            <p>
              {event.group_title ?? "Личное"} <StatusChip event={event} />
              {event.is_past && event.status !== "cancelled" && (
                <span className="done-badge">Завершено</span>
              )}
            </p>
          </div>
        </div>

        {event.status === "cancelled" && (
          <div className="sh-sec">
            <div style={{
              background: "color-mix(in srgb,var(--cancel) 11%,transparent)",
              borderRadius: 12, padding: "10px 12px", fontSize: 12.5,
            }}>
              🟠 {event.cancel_reason ?? "Мероприятие отменено"}
            </div>
          </div>
        )}

        <div className="sh-sec">
          <div className="kv">
            <span>Когда</span>
            <div>
              {start.getDate()} {MN[start.getMonth()]}, {hm(start)}
              {event.ends_at ? `–${hm(new Date(event.ends_at))}` : ""}
            </div>
          </div>
          <div className="kv"><span>Формат</span><div>{FORMAT[event.format]}</div></div>
          <div className="kv">
            <span>Место</span>
            <div>
              {event.format === "online"
                ? (event.online_url ?? "ссылка появится после ответа «Иду»")
                : (event.place ?? "уточняется")}
            </div>
          </div>

          {event.capacity_max && (
            <div className="kv">
              <span>Места</span>
              <div>
                <div className="bar">
                  <i style={{
                    width: `${seatsPct}%`,
                    background: event.seats_taken >= event.capacity_max
                      ? "var(--cancel)" : "var(--link)",
                  }} />
                </div>
                {event.seats_taken} из {event.capacity_max}
                {event.seats_taken >= event.capacity_max ? " · лист ожидания открыт" : ""}
              </div>
            </div>
          )}

          {event.quorum_min && (
            <div className="kv">
              <span>Кворум</span>
              <div>
                <div className="bar">
                  <i style={{
                    width: `${quorumPct}%`,
                    background: event.going_count >= event.quorum_min
                      ? "var(--accept)" : "var(--cancel)",
                  }} />
                </div>
                {event.going_count} из {event.quorum_min}
                {event.going_count >= event.quorum_min ? " · набран" : ""}
              </div>
            </div>
          )}

          {event.description && (
            <div className="kv"><span>Описание</span><div>{event.description}</div></div>
          )}
        </div>

        <div className="rsvp">
          {ANSWERS.map(([value, label]) => (
            <button
              key={value}
              className={`${value} ${event.my_status === value ? "on" : ""}`}
              disabled={busy || !event.can_rsvp}
              onClick={() => answer(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {event.can_edit && (
          <div className="rsvp" style={{ paddingTop: 8 }}>
            <button className="maybe" onClick={() => onEdit(event)}>Редактировать</button>
            <button className="maybe" onClick={() => onInvite(event)}>Позвать людей</button>
          </div>
        )}

        <div className="hint">
          {error
            ?? event.rsvp_locked_reason
            ?? (event.my_status === "waitlisted"
              ? "Вы в листе ожидания — сообщим, когда место освободится"
              : "Смена ответа сразу обновляет календарь")}
        </div>
      </div>
    </>
  );
}
