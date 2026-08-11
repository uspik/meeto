import { createPortal } from "react-dom";

/**
 * Выносит содержимое в корень документа.
 *
 * Шторки объявлены как position:fixed, но любой предок с transform,
 * filter или will-change превращается для них в систему координат — панель
 * прижимается к области вкладки и обрезается шапкой. Портал снимает вопрос
 * раз и навсегда, независимо от того, что появится в стилях предков.
 */
export function Overlay({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}
