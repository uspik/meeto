import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { MNn, WD, dstr, mondayOf, p2, sameDay } from "../lib/date";
import { useEscape } from "../lib/useSheet";

const ROW = 44; // высота позиции барабана, должна совпадать с .wheel b в styles.css

interface SheetProps { open: boolean; onClose(): void; children: React.ReactNode }

/** Общая обёртка: затемнение + выезжающая снизу панель. */
function Sheet({ open, onClose, children }: SheetProps) {
  // барабаны открываются поверх визарда — Esc должен закрывать их, а не его
  useEscape(open, onClose);
  return (
    <div className={`pop ${open ? "on" : ""}`} onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="pop-in">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Календарь                                                          */
/* ------------------------------------------------------------------ */

interface DateProps {
  open: boolean; value: string; onPick(v: string): void; onClose(): void;
  /** границы выбора в виде «2026-08-17»; вне них дни серые и не нажимаются */
  min?: string; max?: string;
}

export function DatePicker({ open, value, onPick, onClose, min, max }: DateProps) {
  const [Y, M] = value.split("-").map(Number);
  const [month, setMonth] = useState(() => new Date(Y, M - 1, 1));
  const today = useRef(new Date()).current;

  // при повторном открытии показываем месяц выбранной даты
  useEffect(() => {
    if (open) setMonth(new Date(Y, M - 1, 1));
  }, [open, Y, M]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = mondayOf(first);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const total = Math.ceil((((first.getDay() + 6) % 7) + days) / 7) * 7;

  const shift = (delta: number) =>
    setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="pop-ttl">
        <button className="ib" onClick={() => shift(-1)}>‹</button>
        <b>{MNn[month.getMonth()]} {month.getFullYear()}</b>
        <button className="ib" onClick={() => shift(1)}>›</button>
      </div>
      <div className="cal-wd">{WD.map((w) => <span key={w}>{w}</span>)}</div>
      <div className="cal">
        {Array.from({ length: total }, (_, i) => {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const key = dstr(d);
          // строки дат сравниваются лексикографически: формат фиксированный
          const off = (min && key < min) || (max && key > max);
          return (
            <button
              key={key}
              disabled={Boolean(off)}
              className={[
                d.getMonth() !== month.getMonth() ? "out" : "",
                off ? "off" : "",
                sameDay(d, today) ? "td" : "",
                key === value ? "on" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => { if (!off) { onPick(key); onClose(); } }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <button className="pop-done" onClick={onClose}>Готово</button>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Барабаны                                                           */
/* ------------------------------------------------------------------ */

interface WheelProps { count: number; index: number; label(i: number): string; onIndex(i: number): void }

function Wheel({ count, index, label, onIndex }: WheelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef(index).current;
  const cur = useRef(index);
  const timer = useRef(0);
  const commit = useRef(onIndex);
  commit.current = onIndex;

  // Позицию задаём один раз, при монтировании: барабан пересоздаётся на каждое
  // открытие пикера. Писать scrollTop на изменение значения нельзя — код
  // начинает спорить с пальцем, и прокрутка перескакивает позиции.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = start * ROW;
  }, [start]);

  // Значение уходит наверх после остановки, а подсветка двигается напрямую
  // через DOM. Раньше каждое событие прокрутки перерисовывало весь шаг визарда
  // — на длинной прокрутке главный поток захлёбывался и барабан подвисал.
  //
  // При исчезновении отдаём последнее положение той функцией, что была при
  // появлении: если набор значений успел смениться, новая посчитала бы по
  // старому индексу чужое значение и барабан бы «прыгнул».
  const atMount = useRef(onIndex).current;
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    atMount(cur.current);
  }, [atMount]);

  function highlight(i: number) {
    const kids = ref.current?.children;
    if (!kids) return;
    (kids[cur.current + 1] as HTMLElement | undefined)?.classList.remove("on");
    (kids[i + 1] as HTMLElement | undefined)?.classList.add("on");
    cur.current = i;
  }

  const target = useRef(index);

  const goTo = (i: number, smooth = true) => {
    const clamped = Math.max(0, Math.min(count - 1, i));
    target.current = clamped;
    ref.current?.scrollTo({ top: clamped * ROW, behavior: smooth ? "smooth" : "auto" });
    return clamped;
  };

  // Разгон растёт геометрически, а не линейно: 1, 1, 2, 4, 7, 13 и дальше до
  // потолка. Первые две засечки всегда по одной позиции — точность правки
  // сохраняется. Потолок привязан к длине списка, иначе на часах (24 позиции)
  // одна засечка перепрыгивала бы почти весь барабан.
  const cap = Math.max(4, Math.round(count / 4));
  const stepFor = (streak: number) =>
    streak < 2 ? 1 : Math.min(cap, Math.round(1.9 ** (streak - 1)));

  // Колесо мыши: одна засечка прокручивает около 100 px, то есть больше двух
  // позиций по 44 px — барабан стабильно промахивался на 2. Перехватываем
  // событие и двигаем сами. Пауза или смена направления сбрасывают разгон —
  // значит, значение всегда можно поправить по одному шагу.
  // К касаниям это не относится: там остаётся родная инерция.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    let last = 0;
    let streak = 0;
    let dir = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sign = Math.sign(e.deltaY) || 1;
      const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 30;

      if (notch) {
        const now = performance.now();
        const gap = now - last;
        if (gap < 55) return;                       // дребезг одной засечки
        const rolling = gap < 280 && sign === dir;
        streak = rolling ? streak + 1 : 0;
        if (!rolling) target.current = cur.current; // догоняем реальную позицию
        dir = sign;
        last = now;
        goTo(target.current + sign * stepFor(streak), streak < 2);
      } else {
        // тачпад: шаг пропорционален пройденному расстоянию, разгон встроен
        acc += e.deltaY;
        const steps = Math.trunc(acc / (ROW * 0.5));
        if (steps) {
          acc -= steps * ROW * 0.5;
          if (performance.now() - last > 280) target.current = cur.current;
          last = performance.now();
          goTo(target.current + steps, Math.abs(steps) <= 2);
        }
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [count, cap]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const i = Math.max(0, Math.min(count - 1, Math.round(el.scrollTop / ROW)));
    if (i !== cur.current) highlight(i);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      target.current = cur.current;
      commit.current(cur.current);
    }, 140);
  }

  return (
    <div className="wheel" ref={ref} onScroll={onScroll}>
      <div className="pad" />
      {Array.from({ length: count }, (_, i) => (
        // по значению можно попасть сразу тапом, не докручивая
        <b key={i} className={i === start ? "on" : ""} onClick={() => goTo(i)}>
          {label(i)}
        </b>
      ))}
      <div className="pad" />
    </div>
  );
}

interface TimeProps {
  open: boolean; value: string; onPick(v: string): void; onClose(): void;
  /** «08:30» — раньше этого времени барабан не крутится */
  min?: string; max?: string;
}

const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const clock = (total: number) => `${p2(Math.floor(total / 60))}:${p2(total % 60)}`;

/**
 * Барабан времени с границами.
 *
 * Обрезаем только часы. Минуты остаются полными — и вот почему: их набор
 * зависел бы от выбранного часа, барабан приходилось бы пересоздавать, а он
 * при исчезновении отдаёт наверх своё последнее положение. Получалось, что
 * смена часа возвращала прежнее значение: барабан «сам по себе ездил», а на
 * крайнем часе в нём оставалась одна позиция и минуты вообще не выбирались.
 * Теперь минуты крутятся всегда, а выход зажимается по границам.
 */
export function TimePicker({ open, value, onPick, onClose, min, max }: TimeProps) {
  const lo = min ? mins(min) : 0;
  const hi = max ? mins(max) : 24 * 60 - 1;
  const at = Math.min(Math.max(mins(value), lo), hi);
  const [h, m] = [Math.floor(at / 60), at % 60];

  const hFrom = Math.floor(lo / 60);
  const hTo = Math.floor(hi / 60);

  const pick = (total: number) => onPick(clock(Math.min(Math.max(total, lo), hi)));

  if (!open) return <Sheet open={false} onClose={onClose}><div /></Sheet>;
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="pop-ttl"><b>Время</b></div>
      <div className="wheels">
        <Wheel
          count={hTo - hFrom + 1}
          index={h - hFrom}
          label={(i) => p2(i + hFrom)}
          onIndex={(i) => pick((i + hFrom) * 60 + m)}
        />
        <span className="wsep">:</span>
        <Wheel count={60} index={m} label={p2} onIndex={(i) => pick(h * 60 + i)} />
      </div>
      <button className="pop-done" onClick={onClose}>Готово</button>
    </Sheet>
  );
}

interface NumProps {
  open: boolean; value: number; min: number; max: number; title: string;
  onPick(v: number): void; onClose(): void;
}

export function NumberPicker({ open, value, min, max, title, onPick, onClose }: NumProps) {
  if (!open) return <Sheet open={false} onClose={onClose}><div /></Sheet>;
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="pop-ttl"><b>{title}</b></div>
      <div className="wheels one">
        <Wheel
          count={max - min + 1}
          index={Math.max(0, Math.min(max - min, value - min))}
          label={(i) => String(min + i)}
          onIndex={(i) => onPick(min + i)}
        />
      </div>
      <button className="pop-done" onClick={onClose}>Готово</button>
    </Sheet>
  );
}

/** Плашка-поле, открывающая пикер. */
export function Plate({ text, onOpen }: { text: string; onOpen(): void }) {
  return (
    <button className="plate" onClick={onOpen}>
      <span>{text}</span><i>▼</i>
    </button>
  );
}
