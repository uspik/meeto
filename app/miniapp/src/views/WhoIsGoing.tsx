import { useCallback, useEffect, useState } from "react";

import { Avatar } from "../components/Avatar";
import { Overlay } from "../components/Overlay";
import { api } from "../lib/api";
import { subscribe } from "../lib/live";
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

interface Props { event: Event; onClose(): void; onChanged?(): void }

export function WhoIsGoing({ event, onClose, onChanged }: Props) {
  const { close, cls } = useSheet(onClose);
  const [rows, setRows] = useState<Participant[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // кого именно убираем: подтверждение прямо в строке, без отдельного окна
  const [dropping, setDropping] = useState<string | null>(null);
  // убранные в этом сеансе — показываем отдельным блоком с кнопкой «Вернуть»
  const [removed, setRemoved] = useState<Participant[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function restore(p: Participant) {
    setRestoring(p.user.id);
    try {
      await api.inviteToEvent(event.id, [p.user.id]);
      setRemoved((prev) => prev.filter((r) => r.user.id !== p.user.id));
      setRows((prev) => [...prev, { ...p, status: "invited", waitlist_pos: null }]);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось вернуть");
    } finally {
      setRestoring(null);
    }
  }

  const load = useCallback(async (quiet = false) => {
    try {
      const p = await api.participants(event.id);
      setRows(p.participants);
      setPending(p.pending);
      setError(null);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "не удалось загрузить");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [event.id]);

  useEffect(() => { void load(); }, [load]);

  // Чужой ответ виден сразу: пришло сообщение по шине — перечитываем список.
  // Тихо, без «Загружаем…»: экран уже наполнен, и мигать ему незачем.
  useEffect(
    () => subscribe((change) => {
      if (change.kind === "group") return;
      if (change.event_id && change.event_id !== event.id) return;
      void load(true);
    }),
    [event.id, load],
  );

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
                <Avatar user={p.user} />

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

                {event.can_edit && p.user.id !== event.creator_id && (
                  dropping === p.user.id ? (
                    <span className="wdrop">
                      <button className="kick no" onClick={() => setDropping(null)}>↩</button>
                      <button
                        className="kick yes"
                        onClick={async () => {
                          try {
                            await api.dropParticipant(event.id, p.user.id);
                            setRows((prev) => prev.filter((r) => r.user.id !== p.user.id));
                            // не выкидываем совсем: держим внизу списка,
                            // чтобы убранного можно было вернуть одним нажатием
                            setRemoved((prev) => [...prev, p]);
                            onChanged?.();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "не удалось убрать");
                          } finally {
                            setDropping(null);
                          }
                        }}
                      >
                        ✓
                      </button>
                    </span>
                  ) : (
                    <button
                      className="kick"
                      title="Убрать с мероприятия"
                      onClick={() => setDropping(p.user.id)}
                    >
                      ✕
                    </button>
                  )
                )}
              </div>
            );
          })}

          {removed.length > 0 && (
            <>
              <div className="wsec">Убраны с мероприятия</div>
              {removed.map((p) => (
                <div key={p.user.id} className="wrow">
                  <Avatar user={p.user} dim />
                  <div className="wmeta">
                    <div className="wname"><em>{fullName(p.user)}</em></div>
                    <div className="wsub">убран — можно позвать обратно</div>
                  </div>
                  <button
                    className="tb"
                    disabled={restoring === p.user.id}
                    onClick={() => void restore(p)}
                  >
                    Вернуть
                  </button>
                </div>
              ))}
            </>
          )}

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

          {!loading && rows.length === 0 && pending.length === 0 && removed.length === 0 && (
            <div className="empty"><div>👤</div>Пока никого</div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
