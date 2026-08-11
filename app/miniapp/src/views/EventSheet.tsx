import { useState } from "react";
import { Overlay } from "../components/Overlay";

import { useSheet } from "../lib/useSheet";
import { Icon } from "../components/Icon";
import { StatusChip } from "../components/StatusChip";
import { MN, hm, p2 } from "../lib/date";
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
  onWho(e: Event): void;
}

export function EventSheet({ event, onClose, onChanged, onEdit, onInvite, onWho }: Props) {
  const { close, cls } = useSheet(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = new Date(event.starts_at);
  const finish = event.ends_at ? new Date(event.ends_at) : new Date(+start + 3600_000);
  const window = Math.max(0, Math.round((+finish - +start) / 60_000));

  // сдвиг прихода в минутах от начала: по умолчанию приходим к началу
  const [late, setLate] = useState(() =>
    event.my_arrival
      ? Math.max(0, Math.round((+new Date(event.my_arrival) - +start) / 60_000))
      : 0,
  );
  const arriveAt = new Date(+start + late * 60_000);

  async function saveArrival(minutes: number) {
    setLate(minutes);
    if (event.my_status !== "going") return;
    try {
      onChanged(await api.rsvp(event.id, {
        status: "going",
        arrival_at: new Date(+start + minutes * 60_000).toISOString(),
      }));
    } catch {
      /* молча: значение вернётся при следующей загрузке */
    }
  }

  async function answer(status: RsvpStatus) {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const next = event.my_status === status ? "invited" : status;
      onChanged(await api.rsvp(event.id, {
        status: next,
        arrival_at: next === "going" && late > 0
          ? new Date(+start + late * 60_000).toISOString()
          : null,
      }));
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
    <Overlay>
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

        <div className="sh-sec">
          <button className="wide" onClick={() => onWho(event)}>
            <span>Кто идёт</span>
            <b>{event.going_count}</b>
          </button>

          {event.can_set_arrival && window > 15 && (
            <div className="kv" style={{ display: "block" }}>
              <span style={{ width: "auto" }}>Во сколько придёте</span>
              <input
                type="range"
                className="rng"
                min={0}
                max={window - 15}
                step={15}
                value={Math.min(late, Math.max(0, window - 15))}
                onChange={(e) => setLate(Number(e.target.value))}
                onMouseUp={(e) => saveArrival(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => saveArrival(Number((e.target as HTMLInputElement).value))}
              />
              <div className="rngrow">
                <span>{hm(start)}</span>
                <b>{late === 0 ? "к началу" : `к ${p2(arriveAt.getHours())}:${p2(arriveAt.getMinutes())}`}</b>
                <span>{hm(finish)}</span>
              </div>
            </div>
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
    </Overlay>
  );
}
