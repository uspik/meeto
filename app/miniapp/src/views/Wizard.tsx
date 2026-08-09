import { useState } from "react";
import { MN, WD, dstr, hm } from "../lib/date";
import { api } from "../lib/api";
import { haptic } from "../lib/tg";
import type { Event, EventFormat, Group } from "../lib/types";

const STEPS = ["Основное", "Когда", "Где", "Места"];
const EMOJI = ["🎯", "🏐", "🏃", "🎂", "🍽️", "🎬", "🎲", "💻", "📚", "⛰️"];
const GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)", "linear-gradient(135deg,#ffb347,#ff7b00)",
  "linear-gradient(135deg,#43e97b,#38f9d7)", "linear-gradient(135deg,#fa709a,#fee140)",
  "linear-gradient(135deg,#4facfe,#00f2fe)", "linear-gradient(135deg,#a18cd1,#fbc2eb)",
];
const SOLIDS = ["#5b8def", "#2fbf5c", "#f59200", "#e2564d", "#9b5de5", "#00b8b0", "#4a4a55", "#e05a9c"];
const PALETTE = [...GRADIENTS, ...SOLIDS];
const DURS: [number, string][] = [[30, "30 мин"], [60, "1 час"], [120, "2 часа"], [1440, "весь день"]];

interface Draft {
  emoji: string; cover: string; title: string; description: string; groupId: string | null;
  date: string; time: string; dur: number;
  format: EventFormat; place: string; url: string;
  capOn: boolean; capacity: number; quorumOn: boolean; quorum: number; qtime: string;
}

interface Props {
  groups: Group[]; day: Date; existing: Event[];
  onClose(): void; onCreated(e: Event): void;
}

export function Wizard({ groups, day, existing, onClose, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [d, setD] = useState<Draft>({
    emoji: "🎯", cover: GRADIENTS[0], title: "", description: "",
    groupId: groups[0]?.id ?? null,
    date: dstr(day), time: "19:00", dur: 120,
    format: "offline", place: "", url: "",
    capOn: false, capacity: 12, quorumOn: false, quorum: 6, qtime: "20:00",
  });

  const patch = (v: Partial<Draft>) => setD((prev) => ({ ...prev, ...v }));
  const allDay = d.dur === 1440;

  function bounds(): [Date, Date] {
    const [Y, M, D] = d.date.split("-").map(Number);
    const [h, m] = allDay ? [0, 0] : d.time.split(":").map(Number);
    const s = new Date(Y, M - 1, D, h, m);
    return [s, new Date(s.getTime() + d.dur * 60_000)];
  }

  const [start, end] = bounds();

  // все пересечения, а не только первое
  const clashes = existing
    .filter((e) => e.my_status === "going" && e.status !== "cancelled")
    .map((e) => {
      const s = +new Date(e.starts_at);
      const t = e.ends_at ? +new Date(e.ends_at) : s + 3_600_000;
      return { e, s, t };
    })
    .filter((x) => x.s < +end && x.t > +start)
    .sort((a, b) => a.s - b.s);

  const durLabel = (v: number) =>
    v === 1440 ? "весь день"
      : [Math.floor(v / 60) ? `${Math.floor(v / 60)} ч` : "", v % 60 ? `${v % 60} мин` : ""]
        .filter(Boolean).join(" ");

  const valid = step !== 0 || d.title.trim().length > 0;

  function go(delta: number) {
    if (delta > 0 && step === STEPS.length - 1) { void submit(); return; }
    const next = Math.max(0, Math.min(STEPS.length - 1, step + delta));
    if (next === step) return;
    setDir(delta);
    setStep(next);
  }

  async function submit() {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const [qh, qm] = d.qtime.split(":").map(Number);
      const qd = new Date(start);
      qd.setHours(qh, qm, 0, 0);
      const created = await api.createEvent({
        group_id: d.groupId,
        title: d.title.trim(),
        description: d.description || null,
        emoji: d.emoji,
        cover: d.cover,
        format: d.format,
        place: d.format === "online" ? null : d.place || null,
        online_url: d.format === "offline" ? null : d.url || null,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        capacity_max: d.capOn ? d.capacity : null,
        quorum_min: d.quorumOn ? d.quorum : null,
        quorum_deadline: d.quorumOn ? qd.toISOString() : null,
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось создать");
    } finally {
      setBusy(false);
    }
  }

  const groupTitle = groups.find((g) => g.id === d.groupId)?.title ?? "Личное — без группы";

  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <div className="wz on">
        <div className="wz-hd">
          <div className="wz-top">
            <h3>{STEPS[step]}</h3>
            <small>шаг {step + 1} из {STEPS.length}</small>
            <button className="ib" onClick={onClose}>✕</button>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => <i key={s} className={i <= step ? "on" : ""} />)}
          </div>
        </div>

        <div className="wz-bd">
          <div className="prev">
            <span className="ico v-c s-going lg"><i style={{ background: d.cover }}>{d.emoji}</i></span>
            <div style={{ minWidth: 0 }}>
              <div className="ttl">
                {d.title.trim() || <span style={{ color: "var(--hint)" }}>Без названия</span>}
              </div>
              <div className="sub">
                {start.getDate()} {MN[start.getMonth()]},{" "}
                {allDay ? "весь день" : `${hm(start)}–${hm(end)}`} · {groupTitle}
              </div>
            </div>
          </div>

          <div key={step} className={`wz-step on ${dir > 0 ? "" : ""}`}>
            {step === 0 && (
              <>
                <div className="fld">
                  <div className="lbl">Фон обложки</div>
                  <div className="colors">
                    {PALETTE.map((c) => (
                      <button key={c} className={`sw2 ${d.cover === c ? "on" : ""}`}
                        style={{ background: c }} onClick={() => patch({ cover: c })} />
                    ))}
                  </div>
                </div>
                <div className="fld">
                  <div className="lbl">Значок</div>
                  <div className="pick">
                    {EMOJI.map((x) => (
                      <button key={x} className={`pk ${d.emoji === x ? "on" : ""}`}
                        onClick={() => patch({ emoji: x })}>{x}</button>
                    ))}
                  </div>
                </div>
                <div className="fld">
                  <div className="lbl">Название</div>
                  <input className="inp" value={d.title} placeholder="Волейбол по средам"
                    onChange={(e) => patch({ title: e.target.value })} />
                </div>
                <div className="fld" style={{ position: "relative" }}>
                  <div className="lbl">Группа</div>
                  <button className={`plate ${groupOpen ? "open" : ""}`}
                    onClick={() => setGroupOpen(!groupOpen)}>
                    <span>{groupTitle}</span><i>▼</i>
                  </button>
                  <div className={`pop-list ${groupOpen ? "open" : ""}`}>
                    <button className={`opt ${d.groupId === null ? "on" : ""}`}
                      onClick={() => { patch({ groupId: null }); setGroupOpen(false); }}>
                      Личное — без группы
                    </button>
                    {groups.map((g) => (
                      <button key={g.id} className={`opt ${d.groupId === g.id ? "on" : ""}`}
                        onClick={() => { patch({ groupId: g.id }); setGroupOpen(false); }}>
                        {g.title}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="fld">
                  <div className="lbl">Описание</div>
                  <textarea className="inp" rows={3} placeholder="Необязательно"
                    value={d.description} onChange={(e) => patch({ description: e.target.value })} />
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="two">
                  <div className="fld">
                    <div className="lbl">Дата</div>
                    <input type="date" className="inp" value={d.date}
                      onChange={(e) => patch({ date: e.target.value || d.date })} />
                  </div>
                  {!allDay && (
                    <div className="fld">
                      <div className="lbl">Начало</div>
                      <input type="time" className="inp" value={d.time}
                        onChange={(e) => patch({ time: e.target.value || d.time })} />
                    </div>
                  )}
                </div>
                <div className="fld">
                  <div className="lbl">Длительность</div>
                  <div className="pick">
                    {DURS.map(([v, l]) => (
                      <button key={v} className={`pk txt ${d.dur === v ? "on" : ""}`}
                        onClick={() => patch({ dur: v })}>{l}</button>
                    ))}
                  </div>
                  {!allDay && (
                    <>
                      <input type="range" className="rng" min={15} max={480} step={15}
                        value={Math.min(480, d.dur)}
                        onChange={(e) => patch({ dur: Number(e.target.value) })} />
                      <div className="rngrow">
                        <span>15 мин</span><b>{durLabel(d.dur)}</b><span>8 часов</span>
                      </div>
                    </>
                  )}
                </div>
                <div className="note">
                  {WD[(start.getDay() + 6) % 7]}, <b>{start.getDate()} {MN[start.getMonth()]}</b>,{" "}
                  {allDay ? "весь день" : `${hm(start)}–${hm(end)}`}
                  {clashes.length > 0 && (
                    <div className="clash">
                      <b>Пересекается с {clashes.length}{" "}
                        {clashes.length === 1 ? "мероприятием" : "мероприятиями"}</b>
                      {clashes.map(({ e, s, t }) => (
                        <div key={e.id}>
                          {e.title} · {hm(new Date(Math.max(s, +start)))}–
                          {hm(new Date(Math.min(t, +end)))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="fld">
                  <div className="lbl">Формат</div>
                  <div className="seg3">
                    <span className="pill3" style={{
                      transform: `translateX(${["offline", "online", "hybrid"].indexOf(d.format) * 100}%)`,
                    }} />
                    {(["offline", "online", "hybrid"] as EventFormat[]).map((f) => (
                      <button key={f} className={d.format === f ? "on" : ""}
                        onClick={() => patch({ format: f })}>
                        {f === "offline" ? "Офлайн" : f === "online" ? "Онлайн" : "Гибрид"}
                      </button>
                    ))}
                  </div>
                </div>
                {d.format !== "online" && (
                  <div className="fld">
                    <div className="lbl">Адрес или площадка</div>
                    <input className="inp" value={d.place} placeholder="СК «Динамо», зал №3"
                      onChange={(e) => patch({ place: e.target.value })} />
                  </div>
                )}
                {d.format !== "offline" && (
                  <>
                    <div className="fld">
                      <div className="lbl">Ссылка на встречу</div>
                      <input className="inp" value={d.url} placeholder="https://meet.google.com/..."
                        onChange={(e) => patch({ url: e.target.value })} />
                    </div>
                    <div className="note">Ссылку увидят только те, кто отметился «Иду»</div>
                  </>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div className="tgl">
                  <div className="tx">
                    <b>Ограничить число мест</b>
                    <span>Когда места кончатся, откроется лист ожидания</span>
                  </div>
                  <label className="sw">
                    <input type="checkbox" checked={d.capOn}
                      onChange={(e) => patch({ capOn: e.target.checked })} /><i />
                  </label>
                </div>
                {d.capOn && (
                  <div className="fld">
                    <div className="lbl">Всего мест</div>
                    <input type="number" min={1} className="inp num" value={d.capacity}
                      onChange={(e) => patch({ capacity: Number(e.target.value) || 1 })} />
                  </div>
                )}
                <div className="tgl">
                  <div className="tx">
                    <b>Минимум участников</b>
                    <span>Если к сроку не наберётся — мероприятие не состоится</span>
                  </div>
                  <label className="sw">
                    <input type="checkbox" checked={d.quorumOn}
                      onChange={(e) => patch({ quorumOn: e.target.checked })} /><i />
                  </label>
                </div>
                {d.quorumOn && (
                  <div className="two">
                    <div className="fld">
                      <div className="lbl">Нужно человек</div>
                      <input type="number" min={1} className="inp num" value={d.quorum}
                        onChange={(e) => patch({ quorum: Number(e.target.value) || 1 })} />
                    </div>
                    <div className="fld">
                      <div className="lbl">Решение в</div>
                      <input type="time" className="inp" value={d.qtime}
                        onChange={(e) => patch({ qtime: e.target.value || d.qtime })} />
                    </div>
                  </div>
                )}
                {d.capOn && d.quorumOn && d.quorum > d.capacity && (
                  <div className="note warn2">Минимум больше числа мест — исправьте</div>
                )}
                {error && <div className="note warn2">{error}</div>}
              </>
            )}
          </div>
        </div>

        <div className="wz-ft">
          {step > 0 && <button className="back" onClick={() => go(-1)}>Назад</button>}
          <button className="go" disabled={!valid || busy} onClick={() => go(1)}>
            {step === STEPS.length - 1 ? "Создать мероприятие" : "Далее"}
          </button>
        </div>
      </div>
    </>
  );
}
