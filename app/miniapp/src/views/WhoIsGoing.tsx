import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { hm, plural } from "../lib/date";
import { useSheet } from "../lib/useSheet";
import type { Event, Participant, RsvpStatus } from "../lib/types";

const LABEL: Record<RsvpStatus, string> = {
  going: "Иду",
  invited: "Не ответил",
  maybe: "Под вопросом",
  declined: "Не иду",
  waitlisted: "В очереди",
  attended: "Был",
  no_show: "Не пришёл",
};

const CHIP: Record<string, string> = {
  going: "st-going",
  waitlisted: "st-waitlisted",
  declined: "st-declined",
  attended: "st-going",
};

/** Порядок как в жизни: сначала те, кто точно будет. */
const ORDER: RsvpStatus[] = [
  "going", "attended", "maybe", "waitlisted", "invited", "declined", "no_show",
];

const fullName = (u: { first_name: string; last_name?: string | null }) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ");

interface Props { event: Event; onClose(): void }

export function WhoIsGoing({ event, onClose }: Props) {
  const { close, cls } = useSheet(onClose);
  const [rows, setRows] = useState<Participant[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.participants(event.id)
      .then((p) => { setRows(p.participants); setPending(p.pending); })
      .catch((e) => setError(e instanceof Error ? e.message : "не удалось загрузить"))
      .finally(() => setLoading(false));
  }, [event.id]);

  const sorted = [...rows].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const going = rows.filter((p) => p.status === "going").length;

  return (
    <>
      <div className={`scrim on ${cls}`} onClick={close} />
      <div className={`sheet on ${cls}`}>
        <div className="grab" />
        <div className="sh-hd">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>Кто идёт</h2>
            <p>
              {going} {plural(going, "человек", "человека", "человек")} из {rows.length}
              {event.capacity_max ? ` · мест ${event.capacity_max}` : ""}
            </p>
          </div>
          <button className="ib" onClick={close}>✕</button>
        </div>

        <div className="sh-sec">
          {error && <div className="note warn2">{error}</div>}
          {loading && <div className="empty">Загружаем…</div>}

          {sorted.map((p) => (
            <div key={p.user.id} className="prow" style={{ cursor: "default" }}>
              <span
                className="pav"
                style={{ backgroundImage: p.user.photo_url ? `url(${p.user.photo_url})` : undefined }}
              >
                {p.user.photo_url ? "" : fullName(p.user).slice(0, 1).toUpperCase()}
              </span>
              <div className="meta">
                <div className="rt">
                  <em>{fullName(p.user)}</em>
                  <span className={`stat ${CHIP[p.status] ?? "st-neutral"}`}>
                    {LABEL[p.status]}
                    {p.status === "waitlisted" && p.waitlist_pos ? ` #${p.waitlist_pos}` : ""}
                  </span>
                </div>
                {p.arrival_at && (
                  <div className="rs">придёт к {hm(new Date(p.arrival_at))}</div>
                )}
              </div>
            </div>
          ))}

          {pending.length > 0 && (
            <>
              <div className="daysep">Позваны, но ещё не в Meeto</div>
              {pending.map((h) => (
                <div key={h} className="prow" style={{ cursor: "default" }}>
                  <span className="pav">@</span>
                  <div className="meta">
                    <div className="rt"><em>@{h}</em></div>
                    <div className="rs">приглашение сработает при первом входе</div>
                  </div>
                </div>
              ))}
            </>
          )}

          {!loading && rows.length === 0 && pending.length === 0 && (
            <div className="empty"><div>👤</div>Пока никого</div>
          )}
        </div>
      </div>
    </>
  );
}
