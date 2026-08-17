import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Плавно сворачивает и разворачивает содержимое по высоте.
 *
 * Тут переход по стилю, а не `@keyframes`, и это тот редкий случай, когда
 * так можно: элемент уже смонтирован и у него есть предыдущее значение
 * высоты, от которого браузеру есть куда переходить. Ненадёжен другой
 * случай — когда класс вешают сразу после монтирования.
 *
 * Высота считается по содержимому и после анимации отпускается в `auto`:
 * иначе выпадающий список или подсказка внутри упрутся в жёсткий предел.
 */
export function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">(open ? "auto" : 0);
  const first = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (first.current) { first.current = false; return; }

    if (open) {
      // из текущей высоты (0) в высоту содержимого, потом отпускаем в auto
      setHeight(el.scrollHeight);
    } else {
      // из auto перейти нельзя — сначала фиксируем текущую высоту
      setHeight(el.scrollHeight);
      requestAnimationFrame(() => setHeight(0));
    }
  }, [open]);

  useEffect(() => {
    if (!open || height === "auto" || height === 0) return;
    const t = window.setTimeout(() => setHeight("auto"), 320);
    return () => window.clearTimeout(t);
  }, [open, height]);

  return (
    <div
      ref={box}
      className={`fold ${open ? "on" : ""}`}
      style={{ height: height === "auto" ? undefined : height }}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}
