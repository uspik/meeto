import type { Event } from "../lib/types";
import { STATUS_LABEL, visualStatus } from "../lib/types";

const CLS: Record<string, string> = {
  going: "st-going",
  cancelled: "st-cancelled",
  waitlisted: "st-waitlisted",
  declined: "st-declined",
};

export function StatusChip({ event }: { event: Event }) {
  const st = visualStatus(event);
  return <span className={`stat ${CLS[st] ?? "st-neutral"}`}>{STATUS_LABEL[st]}</span>;
}
