import type { Event } from "../lib/types";
import { visualStatus } from "../lib/types";

interface Props { event: Event; size?: "sm" | "lg" | "xl" | ""; z?: number }

/** Круглая обложка со статусной подпоркой. Стиль статусов — вариант «чип». */
export function Icon({ event, size = "", z }: Props) {
  const st = visualStatus(event);
  return (
    <span className={`ico v-c s-${st} ${size}`} style={z ? { zIndex: z } : undefined}>
      <i style={{ background: event.cover }}>{event.emoji}</i>
    </span>
  );
}
