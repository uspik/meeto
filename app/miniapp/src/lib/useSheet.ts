import { useCallback, useEffect, useRef, useState } from "react";

/** Открытые шторки в порядке появления: Esc закрывает только верхнюю. */
const opened: symbol[] = [];

/**
 * Esc закрывает то, что открыто последним.
 *
 * На компьютере окно закрывают клавишей, а не нажатием мимо. Шторки умеют
 * накладываться друг на друга (визард → выбор времени), поэтому держим
 * стопку и отдаём клавишу верхней — закрывать всё разом неверно.
 */
export function useEscape(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const mine = Symbol("sheet");
    opened.push(mine);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || opened[opened.length - 1] !== mine) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      const at = opened.lastIndexOf(mine);
      if (at >= 0) opened.splice(at, 1);
      window.removeEventListener("keydown", onKey);
    };
  }, [active]);
}

/** Задерживает размонтирование шторки, чтобы успела проиграть анимация ухода. */
export function useSheet(onClose: () => void, ms = 260) {
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => {
    setClosing((was) => {
      if (!was) window.setTimeout(onClose, ms);
      return true;
    });
  }, [onClose, ms]);

  useEscape(!closing, close);

  return { close, cls: closing ? "closing" : "" };
}
