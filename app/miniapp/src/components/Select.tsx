import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Overlay } from "./Overlay";
import { useEscape } from "../lib/useSheet";

export interface Option { value: string; label: string }

interface Props {
  value: string;
  options: Option[];
  onChange(v: string): void;
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Выпадающий список в стилистике приложения.
 *
 * Список рисуется через портал и позиционируется по координатам кнопки:
 * внутри строки участника и ленты фильтров стоит overflow:hidden, и обычный
 * absolute-список там обрезался — именно это выглядело «криво раскрывается».
 */
export function Select({ value, options, onChange, compact, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, up: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  // мышью список закрывают нажатием мимо, с клавиатуры — Esc
  useEscape(open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const height = Math.min(options.length * 40 + 8, 260);
    // не хватает места снизу — раскрываем вверх
    const up = r.bottom + height + 8 > window.innerHeight;
    setBox({
      top: up ? r.top - height - 6 : r.bottom + 6,
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 170) - 8)),
      width: Math.max(r.width, 170),
      up,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const scroll = () => setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        className={`plate ${compact ? "compact" : ""} ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span>{current?.label ?? ""}</span><i>▼</i>
      </button>

      {open && (
        <Overlay>
          <div
            ref={list}
            className={`drop ${box.up ? "up" : ""}`}
            style={{ top: box.top, left: box.left, width: box.width }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                className={`opt ${o.value === value ? "on" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Overlay>
      )}
    </>
  );
}
