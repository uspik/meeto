import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { MNn, WD, dstr, mondayOf, p2, sameDay } from "../lib/date";

const ROW = 44; // высота позиции барабана, должна совпадать с .wheel b в styles.css

interface SheetProps { open: boolean; onClose(): void; children: React.ReactNode }

/** Общая обёртка: затемнение + выезжающая снизу панель. */
function Sheet({ open, onClose, children }: SheetProps) {
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

interface DateProps { open: boolean; value: string; onPick(v: string): void; onClose(): void }

export function DatePicker({ open, value, onPick, onClose }: DateProps) {
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
          return (
            <button
              key={key}
              className={[
                d.getMonth() !== month.getMonth() ? "out" : "",
                sameDay(d, today) ? "td" : "",
                key === value ? "on" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => { onPick(key); onClose(); }}
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
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    commit.current(cur.current);
  }, []);

  function highlight(i: number) {
    const kids = ref.current?.children;
    if (!kids) return;
    (kids[cur.current + 1] as HTMLElement | undefined)?.classList.remove("on");
    (kids[i + 1] as HTMLElement | undefined)?.classList.add("on");
    cur.current = i;
  }

  const goTo = (i: number) =>
    ref.current?.scrollTo({
      top: Math.max(0, Math.min(count - 1, i)) * ROW,
      behavior: "smooth",
    });

  // Колесо мыши: одна засечка прокручивает около 100 px, то есть больше двух
  // позиций по 44 px — барабан стабильно промахивался на 2. Перехватываем
  // событие и двигаем ровно на шаг. Тачпад шлёт много мелких дельт, поэтому
  // их копим. К касаниям это не относится: там остаётся родная инерция.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    let last = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 30;
      if (notch) {
        const now = performance.now();
        if (now - last < 90) return;
        last = now;
        goTo(cur.current + Math.sign(e.deltaY));
      } else {
        acc += e.deltaY;
        if (Math.abs(acc) >= ROW * 0.6) {
          goTo(cur.current + Math.sign(acc));
          acc = 0;
        }
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [count]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const i = Math.max(0, Math.min(count - 1, Math.round(el.scrollTop / ROW)));
    if (i !== cur.current) highlight(i);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit.current(cur.current), 140);
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

interface TimeProps { open: boolean; value: string; onPick(v: string): void; onClose(): void }

export function TimePicker({ open, value, onPick, onClose }: TimeProps) {
  const [h, m] = value.split(":").map(Number);
  if (!open) return <Sheet open={false} onClose={onClose}><div /></Sheet>;
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="pop-ttl"><b>Время</b></div>
      <div className="wheels">
        <Wheel count={24} index={h} label={p2} onIndex={(i) => onPick(`${p2(i)}:${p2(m)}`)} />
        <span className="wsep">:</span>
        <Wheel count={60} index={m} label={p2} onIndex={(i) => onPick(`${p2(h)}:${p2(i)}`)} />
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
