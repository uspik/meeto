import { useEffect, useState } from "react";

import { Overlay } from "../components/Overlay";
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
  attended: "st-going",
  waitlisted: "st-waitlisted",
  declined: "st-declined",
};

/** Порядок как в жизни: сначала те, кто точно будет. */
const ORDER: RsvpStatus[] = [
  "going", "attended", "maybe", "waitlisted", "invited", "declined", "no_show",
];

const fullName = (u: { first_name: string; last_name?: string | null }) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ");

const initials = (u: { first_name: string; last_name?: string | null }) =>
  fullName(u).slice(0, 1).toUpperCase() || "?";

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

  const start = new Date(event.starts_at);
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const going = rows.filter((p) => p.status === "going").length;

  /** Время прихода: у всех идущих показываем явно, чтобы было видно, кто позже. */
  function arrival(p: Participant): string | null {
    if (p.status !== "going" && p.status !== "attended") return null;
    const at = p.arrival_at ? new Date(p.arrival_at) : start;
    return hm(at);
  }

  return (
    <Overlay>
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

          {sorted.map((p) => {
            const at = arrival(p);
            return (
              <div key={p.user.id} className="wrow">
                <span
                  className="pav"
                  style={{
                    backgroundImage: p.user.photo_url ? `url(${p.user.photo_url})` : undefined,
                  }}
                >
                  {p.user.photo_url ? "" : initials(p.user)}
                </span>

                <div className="wmeta">
                  <div className="wname">
                    <em>{fullName(p.user)}</em>
                    <span className={`stat ${CHIP[p.status] ?? "st-neutral"}`}>
                      {LABEL[p.status]}
                      {p.status === "waitlisted" && p.waitlist_pos ? ` #${p.waitlist_pos}` : ""}
                    </span>
                  </div>
                  {p.user.username && <div className="wsub">@{p.user.username}</div>}
                </div>

                {at && (
                  <span className="wtime" title="во сколько придёт">
                    {at}
                  </span>
                )}
              </div>
            );
          })}

          {pending.length > 0 && (
            <>
              <div className="wsec">Позваны, ещё не в Meeto</div>
              {pending.map((h) => (
                <div key={h} className="wrow">
                  <span className="pav" style={{ background: "var(--bg2)", color: "var(--hint)" }}>
                    @
                  </span>
                  <div className="wmeta">
                    <div className="wname"><em>@{h}</em></div>
                    <div className="wsub">приглашение сработает при первом входе</div>
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
    </Overlay>
  );
}
