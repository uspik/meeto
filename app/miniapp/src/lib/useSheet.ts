import { useCallback, useState } from "react";

/** Задерживает размонтирование шторки, чтобы успела проиграть анимация ухода. */
export function useSheet(onClose: () => void, ms = 260) {
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => {
    setClosing((was) => {
      if (!was) window.setTimeout(onClose, ms);
      return true;
    });
  }, [onClose, ms]);

  return { close, cls: closing ? "closing" : "" };
}
