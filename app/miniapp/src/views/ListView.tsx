import { BottomBar } from "../components/BottomBar";
import { EventRow } from "../components/EventRow";
import { MN, WD, addDays, sameDay } from "../lib/date";
import type { Event } from "../lib/types";

export type Period = "week" | "month" | "quarter" | "all";
export const PERIODS: Record<Period, string> = {
  week: "Неделя", month: "Месяц", quarter: "3 месяца", all: "Всё",
};

interface Props {
  events: Event[];
  today: Date;
  period: Period;
  onPeriod(p: Period): void;
  onOpenEvent(e: Event): void;
  onCreate(): void;
}

export function ListView(p: Props) {
  const sorted = [...p.events].sort(
    (a, b) => +new Date(a.starts_at) - +new Date(b.starts_at),
  );

  let last = "";
  const blocks: JSX.Element[] = [];
  for (const e of sorted) {
    const start = new Date(e.starts_at);
    const key = start.toDateString();
    if (key !== last) {
      last = key;
      const title = sameDay(start, p.today)
        ? "Сегодня"
        : sameDay(start, addDays(p.today, 1))
          ? "Завтра"
          : `${WD[(start.getDay() + 6) % 7]}, ${start.getDate()} ${MN[start.getMonth()]}`;
      blocks.push(
        <div key={key} className={`daysep ${sameDay(start, p.today) ? "now-sep" : ""}`}>
          {title}
        </div>,
      );
    }
    blocks.push(<EventRow key={e.id} event={e} onOpen={p.onOpenEvent} />);
  }

  return (
    <>
      <div className="periods">
        {(Object.keys(PERIODS) as Period[]).map((k) => (
          <button
            key={k}
            className={`chip ${p.period === k ? "on" : ""}`}
            onClick={() => p.onPeriod(k)}
          >
            {PERIODS[k]}
          </button>
        ))}
      </div>
      <div className="list" id="listScroll">
        {blocks.length ? blocks : (
          <div className="empty"><div>🗓</div>За этот период мероприятий нет</div>
        )}
      </div>
      <BottomBar label="Новое мероприятие" onMain={p.onCreate} />
    </>
  );
}
