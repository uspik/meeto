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

/**
 * Задерживает размонтирование шторки, чтобы успела проиграть анимация ухода.
 *
 * `close(then)` — уйти и сделать что-то другое вместо обычного закрытия:
 * так карточка мероприятия успевает уехать вниз, прежде чем на её месте
 * появится «Кто идёт». Без этого она пропадала рывком.
 */
export function useSheet(onClose: () => void, ms = 260) {
  const [closing, setClosing] = useState(false);

  // Аргумент нарочно нестрогий: close вешают и прямо на onClick, а туда
  // React передаёт событие — функцией оно не является, и мы просто закроем.
  const close = useCallback((then?: unknown) => {
    const done = typeof then === "function" ? (then as () => void) : onClose;
    setClosing((was) => {
      if (!was) window.setTimeout(done, ms);
      return true;
    });
  }, [onClose, ms]);

  useEscape(!closing, close);

  return { close, cls: closing ? "closing" : "" };
}
