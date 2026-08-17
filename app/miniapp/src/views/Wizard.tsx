import { useEffect, useState } from "react";
import { DatePicker, NumberPicker, Plate, TimePicker } from "../components/Pickers";
import { Fold } from "../components/Fold";
import { PeoplePicker } from "../components/PeoplePicker";
import { useSheet } from "../lib/useSheet";
import { MN, WD, addDays, dstr, hm, plural, sameDay, startOfDay } from "../lib/date";
import { api } from "../lib/api";
import { haptic } from "../lib/tg";
import type { Event, EventFormat, Group, User } from "../lib/types";
import { Overlay } from "../components/Overlay";

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
/** Дату показываем коротко: «12 сентября 2026» в плитку не влезает. */
const dateLabel = (iso: string) =>
  `${Number(iso.slice(8))} ${MN[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

interface Draft {
  emoji: string; cover: string; title: string; description: string; groupId: string | null;
  date: string; time: string; dur: number;
  /** dur — длительность бегунком, custom — своя дата и время окончания */
  endMode: "dur" | "custom";
  endDate: string; endTime: string;
  format: EventFormat; place: string; url: string;
  capOn: boolean; capacity: number; quorumOn: boolean; quorum: number;
  qdate: string; qtime: string;
}

interface Props {
  groups: Group[];
  day: Date;
  existing: Event[];
  /** если передано — режим редактирования: группу менять нельзя */
  edit?: Event | null;
  onClose(): void;
  onCreated(e: Event): void;
}

export function Wizard({ groups, day, existing, edit, onClose, onCreated }: Props) {
  const editing = Boolean(edit);
  const { close, cls } = useSheet(onClose);
  const [step, setStep] = useState(0);
  // направление въезда шага; сбрасывается после проигрыша анимации
  const [slide, setSlide] = useState<"" | "enter-r" | "enter-l">("");
  const [picker, setPicker] =
    useState<null | "date" | "time" | "edate" | "etime" | "qdate" | "qtime" | "cap" | "quorum">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [guests, setGuests] = useState<User[]>([]);
  const [guestHandles, setGuestHandles] = useState<string[]>([]);
  const [people, setPeople] = useState(false);
  // Подсказка по умолчанию: вечер, а если вечер уже прошёл — ближайшие
  // полчаса вперёд. Предлагать время, которое нельзя выбрать, незачем.
  function firstTime(when: Date): string {
    const now = new Date();
    if (!sameDay(when, now) || hm(now) < "19:00") return "19:00";
    const soon = new Date(now.getTime() + 30 * 60_000);
    soon.setMinutes(soon.getMinutes() < 30 ? 30 : 0, 0, 0);
    if (soon.getMinutes() === 0) soon.setHours(soon.getHours() + 1);
    return hm(soon);
  }

  const [d, setD] = useState<Draft>(() => {
    const base = day < startOfDay(new Date()) ? new Date() : day;
    if (!edit) {
      return {
        emoji: "🎯", cover: GRADIENTS[0], title: "", description: "",
        groupId: groups[0]?.id ?? null,
        // в календаре можно стоять на прошедшем дне — создаём всё равно
        // с сегодняшнего, назад мероприятия не ставятся
        date: dstr(base), time: firstTime(base), dur: 120,
        endMode: "dur", endDate: dstr(base), endTime: "21:00",
        format: "offline", place: "", url: "",
        capOn: false, capacity: 12, quorumOn: false, quorum: 6,
        // срок кворума по умолчанию — за сутки до начала: остаётся день,
        // чтобы отменить или перепланировать. Но не раньше сегодняшнего дня:
        // назад срок не ставится.
        qdate: dstr(addDays(base, -1) < startOfDay(new Date())
          ? new Date()
          : addDays(base, -1)),
        qtime: "20:00",
      };
    }
    const s0 = new Date(edit.starts_at);
    const e0 = edit.ends_at ? new Date(edit.ends_at) : new Date(s0.getTime() + 3600_000);
    const mins = Math.max(15, Math.round((+e0 - +s0) / 60_000));
    // всё, что не укладывается в бегунок (до 8 часов) и не «весь день»,
    // открываем сразу своим окончанием — иначе правка тихо укоротит событие
    const custom = mins > 480 && mins !== 1440;
    const qd = edit.quorum_deadline ? new Date(edit.quorum_deadline) : addDays(s0, -1);
    return {
      emoji: edit.emoji, cover: edit.cover, title: edit.title,
      description: edit.description ?? "", groupId: edit.group_id ?? null,
      date: dstr(s0), time: hm(s0),
      dur: custom ? 120 : mins,
      endMode: custom ? "custom" : "dur",
      endDate: dstr(e0), endTime: hm(e0),
      format: edit.format, place: edit.place ?? "", url: edit.online_url ?? "",
      capOn: edit.capacity_max != null, capacity: edit.capacity_max ?? 12,
      quorumOn: edit.quorum_min != null, quorum: edit.quorum_min ?? 6,
      qdate: dstr(qd), qtime: hm(qd),
    };
  });

  const patch = (v: Partial<Draft>) => setD((prev) => ({ ...prev, ...v }));
  const custom = d.endMode === "custom";
  const allDay = !custom && d.dur === 1440;

  function at(date: string, time: string): Date {
    const [Y, M, D] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    return new Date(Y, M - 1, D, h, m);
  }

  function bounds(): [Date, Date] {
    const s = at(d.date, allDay ? "00:00" : d.time);
    if (custom) return [s, at(d.endDate, d.endTime)];
    return [s, new Date(s.getTime() + d.dur * 60_000)];
  }

  const [start, end] = bounds();
  // конец раньше начала — не молчим и не «чиним» сами: человек должен
  // увидеть, что именно он выбрал
  const badEnd = custom && +end <= +start;
  const days = Math.round((+at(d.endDate, "00:00") - +at(d.date, "00:00")) / 86_400_000);

  /** Переключение «длительность ↔ своё окончание» без потери выбранного. */
  function toCustom() {
    const [, e] = bounds();
    patch({ endMode: "custom", endDate: dstr(e), endTime: hm(e) });
  }

  const qAt = at(d.qdate, d.qtime);
  const lateQuorum = d.quorumOn && +qAt > +start;

  /* ---- границы выбора: назад мероприятия не ставятся ---- */
  const now = new Date();
  const todayStr = dstr(now);
  const nowHm = hm(now);
  // редактируем уже начавшееся — прошлое трогать не даём, но и не мешаем
  const floor = editing && +new Date(edit!.starts_at) < +now ? dstr(new Date(edit!.starts_at)) : todayStr;
  const startPast = d.date < floor || (d.date === floor && !allDay && d.time < nowHm && floor === todayStr);
  // конец не раньше начала, срок кворума — от сегодня и до начала
  const endFloor = d.date;
  const qFloor = todayStr;
  const qCeil = d.date;

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

  const valid = step === 0
    ? d.title.trim().length > 0
    : step === 1
      ? !badEnd && !startPast
      : !(step === 3 && d.quorumOn && lateQuorum);

  function go(delta: number) {
    if (delta > 0 && step === STEPS.length - 1) { void submit(); return; }
    const next = Math.max(0, Math.min(STEPS.length - 1, step + delta));
    if (next === step) return;
    setSlide(delta > 0 ? "enter-r" : "enter-l");
    setStep(next);
  }

  useEffect(() => {
    if (!slide) return;
    const t = window.setTimeout(() => setSlide(""), 320);
    return () => window.clearTimeout(t);
  }, [slide, step]);

  async function submit() {
    haptic();
    setBusy(true);
    setError(null);
    try {
      const deadline = at(d.qdate, d.qtime);

      const payload = {
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
        quorum_deadline: d.quorumOn ? deadline.toISOString() : null,
      };

      // группу при редактировании не отправляем: переносить мероприятие
      // между группами нельзя, у людей уже есть ответы
      const saved = edit
        ? await api.updateEvent(edit.id, payload)
        : await api.createEvent({ ...payload, group_id: d.groupId });

      if (guests.length || guestHandles.length) {
        await api.inviteToEvent(saved.id, guests.map((u) => u.id), guestHandles);
      }
      onCreated(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось создать");
    } finally {
      setBusy(false);
    }
  }

  const groupTitle = groups.find((g) => g.id === d.groupId)?.title ?? "Личное — без группы";

  return (
    <Overlay>
      <div className={`scrim on ${cls}`} onClick={close} />
      <div className={`wz on ${cls}`}>
        <div className="wz-hd">
          <div className="wz-top">
            <h3>{editing ? `${STEPS[step]} · правка` : STEPS[step]}</h3>
            <small>шаг {step + 1} из {STEPS.length}</small>
            <button className="ib" onClick={close}>✕</button>
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

          <div key={step} className={`wz-step on ${slide}`}>
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
                    disabled={editing}
                    onClick={() => !editing && setGroupOpen(!groupOpen)}>
                    <span>{groupTitle}</span><i>{editing ? "" : "▼"}</i>
                  </button>
                  {editing && (
                    <div className="note" style={{ marginTop: 8 }}>
                      Группу менять нельзя: у участников уже собраны ответы
                    </div>
                  )}
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
                    <Plate
                      text={`${Number(d.date.slice(8))} ${MN[Number(d.date.slice(5, 7)) - 1]} ${d.date.slice(0, 4)}`}
                      onOpen={() => setPicker("date")}
                    />
                  </div>
                  {!allDay && (
                    <div className="fld">
                      <div className="lbl">Начало</div>
                      <Plate text={d.time} onOpen={() => setPicker("time")} />
                    </div>
                  )}
                </div>
                <div className="fld">
                  <div className="lbl">Длительность</div>
                  <div className="pick">
                    {DURS.map(([v, l]) => (
                      <button key={v} className={`pk txt ${!custom && d.dur === v ? "on" : ""}`}
                        onClick={() => patch({ endMode: "dur", dur: v })}>{l}</button>
                    ))}
                    <button className={`pk txt ${custom ? "on" : ""}`} onClick={toCustom}>
                      свой выбор
                    </button>
                  </div>

                  {/* Бегунок и своё окончание занимают одно место и сменяют
                      друг друга: показывать оба сразу — значит спрашивать
                      одно и то же дважды. */}
                  <Fold open={!custom && !allDay}>
                    <input type="range" className="rng" min={15} max={480} step={15}
                      value={Math.min(480, d.dur)}
                      onChange={(e) => patch({ dur: Number(e.target.value) })} />
                    <div className="rngrow">
                      <span>15 мин</span><b>{durLabel(d.dur)}</b><span>8 часов</span>
                    </div>
                  </Fold>

                  <Fold open={custom}>
                    <div className="two" style={{ paddingTop: 10 }}>
                      <div className="fld" style={{ marginBottom: 0 }}>
                        <div className="lbl">Дата окончания</div>
                        <Plate text={dateLabel(d.endDate)} onOpen={() => setPicker("edate")} />
                      </div>
                      <div className="fld" style={{ marginBottom: 0 }}>
                        <div className="lbl">Время окончания</div>
                        <Plate text={d.endTime} onOpen={() => setPicker("etime")} />
                      </div>
                    </div>
                  </Fold>
                </div>
                <div className="note">
                  {WD[(start.getDay() + 6) % 7]}, <b>{start.getDate()} {MN[start.getMonth()]}</b>,{" "}
                  {allDay
                    ? "весь день"
                    : sameDay(start, end)
                      ? `${hm(start)}–${hm(end)}`
                      : `${hm(start)} → ${end.getDate()} ${MN[end.getMonth()]}, ${hm(end)}`}
                  {!badEnd && custom && days > 0 && (
                    <> · {days + 1} {plural(days + 1, "день", "дня", "дней")}</>
                  )}
                  {badEnd && (
                    <div className="clash"><b>Окончание раньше начала — поправьте</b></div>
                  )}
                  {startPast && (
                    <div className="clash"><b>Это время уже прошло — выберите будущее</b></div>
                  )}
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
                <Fold open={d.capOn}>
                  <div className="fld">
                    <div className="lbl">Всего мест</div>
                    <Plate text={String(d.capacity)} onOpen={() => setPicker("cap")} />
                  </div>
                </Fold>
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
                <Fold open={d.quorumOn}>
                  <div className="fld">
                    <div className="lbl">Нужно человек</div>
                    <Plate text={String(d.quorum)} onOpen={() => setPicker("quorum")} />
                  </div>
                  <div className="two">
                    <div className="fld">
                      <div className="lbl">Решение до</div>
                      <Plate text={dateLabel(d.qdate)} onOpen={() => setPicker("qdate")} />
                    </div>
                    <div className="fld">
                      <div className="lbl">Во сколько</div>
                      <Plate text={d.qtime} onOpen={() => setPicker("qtime")} />
                    </div>
                  </div>
                  {lateQuorum && (
                    <div className="note warn2">
                      Срок позже начала мероприятия — решение уже ничего не изменит
                    </div>
                  )}
                </Fold>
                <div className="tgl" style={{ borderTop: "1px solid var(--sep)" }}>
                  <div className="tx">
                    <b>Гости вне группы</b>
                    <span>
                      {guests.length || guestHandles.length
                        ? [...guests.map((u) => u.first_name),
                           ...guestHandles.map((h) => `@${h}`)].join(", ")
                        : "Позвать людей, не вступая ими в группу"}
                    </span>
                  </div>
                  <button className="tb" onClick={() => setPeople(true)}>Выбрать</button>
                </div>

                {d.capOn && d.quorumOn && d.quorum > d.capacity && (
                  <div className="note warn2">Минимум больше числа мест — исправьте</div>
                )}
                {error && <div className="note warn2">{error}</div>}
              </>
            )}
          </div>
        </div>

        {people && (
          <PeoplePicker
            title="Кого позвать"
            initial={guests}
            initialHandles={guestHandles}
            onClose={() => setPeople(false)}
            onDone={(users, usernames) => {
              setGuests(users);
              setGuestHandles(usernames);
            }}
          />
        )}

        <DatePicker open={picker === "date"} value={d.date} min={floor}
          onPick={(v) => patch({
            date: v,
            // окончание тянется за началом, иначе оно молча уезжает в прошлое
            endDate: v > d.endDate ? v : d.endDate,
            qdate: v < d.qdate ? v : d.qdate,
          })}
          onClose={() => setPicker(null)} />
        <TimePicker open={picker === "time"} value={d.time}
          min={d.date === todayStr ? nowHm : undefined}
          onPick={(v) => patch({ time: v })} onClose={() => setPicker(null)} />
        <DatePicker open={picker === "edate"} value={d.endDate} min={endFloor}
          onPick={(v) => patch({ endDate: v })} onClose={() => setPicker(null)} />
        <TimePicker open={picker === "etime"} value={d.endTime}
          min={d.endDate === d.date ? d.time : undefined}
          onPick={(v) => patch({ endTime: v })} onClose={() => setPicker(null)} />
        <DatePicker open={picker === "qdate"} value={d.qdate} min={qFloor} max={qCeil}
          onPick={(v) => patch({ qdate: v })} onClose={() => setPicker(null)} />
        <TimePicker open={picker === "qtime"} value={d.qtime}
          min={d.qdate === todayStr ? nowHm : undefined}
          max={d.qdate === d.date && !allDay ? d.time : undefined}
          onPick={(v) => patch({ qtime: v })} onClose={() => setPicker(null)} />
        <NumberPicker open={picker === "cap"} value={d.capacity} min={1} max={200}
          title="Всего мест" onPick={(v) => patch({ capacity: v })} onClose={() => setPicker(null)} />
        <NumberPicker open={picker === "quorum"} value={d.quorum} min={1} max={200}
          title="Нужно человек" onPick={(v) => patch({ quorum: v })} onClose={() => setPicker(null)} />

        <div className="wz-ft">
          {step > 0 && <button className="back" onClick={() => go(-1)}>Назад</button>}
          <button className="go" disabled={!valid || busy} onClick={() => go(1)}>
            {step === STEPS.length - 1
              ? (editing ? "Сохранить изменения" : "Создать мероприятие")
              : "Далее"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
