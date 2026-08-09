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
  const settling = useRef(false);

  // прокручиваем к текущему значению при открытии, без анимации
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !settling.current) el.scrollTop = index * ROW;
  }, [index]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const i = Math.max(0, Math.min(count - 1, Math.round(el.scrollTop / ROW)));
    if (i !== index) {
      settling.current = true;
      onIndex(i);
      window.setTimeout(() => { settling.current = false; }, 120);
    }
  }

  return (
    <div className="wheel" ref={ref} onScroll={onScroll}>
      <div className="pad" />
      {Array.from({ length: count }, (_, i) => (
        <b key={i} className={i === index ? "on" : ""}>{label(i)}</b>
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
