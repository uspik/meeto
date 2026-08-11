import { useEffect, useRef, useState } from "react";

export interface Option { value: string; label: string }

interface Props {
  value: string;
  options: Option[];
  onChange(v: string): void;
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Выпадающий список в стилистике приложения — вместо системного select,
 * который в вебвью выглядит инородно и не подчиняется теме.
 */
export function Select({ value, options, onChange, compact, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
    };
  }, [open]);

  return (
    <div className={`sel-wrap ${compact ? "compact" : ""}`} ref={box}>
      <button
        className={`plate ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span>{current?.label ?? ""}</span><i>▼</i>
      </button>
      <div className={`pop-list ${open ? "open" : ""}`}>
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
    </div>
  );
}
