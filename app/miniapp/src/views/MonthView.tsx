import { useEffect, useRef, useState } from "react";
import { EventRow } from "../components/EventRow";
import { BottomBar } from "../components/BottomBar";
import { Icon } from "../components/Icon";
import { MN, WD, mondayOf, plural, sameDay } from "../lib/date";
import { onDay } from "../lib/conflicts";
import type { Event } from "../lib/types";

interface Props {
  cursor: Date;
  selected: Date;
  events: Event[];
  today: Date;
  onSelect(d: Date): void;
  onOpenDay(): void;
  onOpenEvent(e: Event): void;
  onCreate(): void;
}

export function MonthView(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [firstPaint, setFirstPaint] = useState(true);

  // список дня подъезжает в зону видимости, календарь при этом не сжимается
  useEffect(() => {
    if (firstPaint) { setFirstPaint(false); return; }
    const sc = scroller.current, st = strip.current;
    if (sc && st) sc.scrollTo({ top: Math.max(0, st.offsetTop - 10), behavior: "smooth" });
  }, [p.selected.getTime()]);

  const first = new Date(p.cursor.getFullYear(), p.cursor.getMonth(), 1);
  const start = mondayOf(first);
  const days = new Date(p.cursor.getFullYear(), p.cursor.getMonth() + 1, 0).getDate();
  const total = Math.ceil((((first.getDay() + 6) % 7) + days) / 7) * 7;

  const cells = Array.from({ length: total }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const evs = p.events.filter((e) => onDay(e, d));
    // не больше трёх кружков: иначе ряд шире ячейки
    const shown = evs.slice(0, evs.length > 3 ? 2 : 3);
    return { d, evs, shown };
  });

  const dayEvents = p.events
    .filter((e) => onDay(e, p.selected))
    .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));

  return (
    <>
      <div className="mscroll" ref={scroller}>
        <div className="wd">{WD.map((w) => <span key={w}>{w}</span>)}</div>
        <div className="month">
          {cells.map(({ d, evs, shown }) => (
            <div
              key={d.toISOString()}
              className={[
                "cell",
                d.getMonth() !== p.cursor.getMonth() ? "out" : "",
                (d.getDay() + 6) % 7 > 4 ? "we" : "",
                sameDay(d, p.today) ? "today" : "",
                sameDay(d, p.selected) ? "sel" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => (sameDay(d, p.selected) ? p.onOpenDay() : p.onSelect(d))}
            >
              <span className="daynum">{d.getDate()}</span>
              <span className="dots">
                {shown.map((e, k) => <Icon key={e.id} event={e} z={9 - k} />)}
                {evs.length > shown.length && (
                  <span className="more">+{evs.length - shown.length}</span>
                )}
              </span>
            </div>
          ))}
        </div>
        <div className="mdiv" />
        <div id="strip" ref={strip}>
          <div className={`daysep ${sameDay(p.selected, p.today) ? "now-sep" : ""}`}>
            {sameDay(p.selected, p.today) ? "Сегодня · " : ""}
            {p.selected.getDate()} {MN[p.selected.getMonth()]}
            {dayEvents.length
              ? ` · ${dayEvents.length} ${plural(dayEvents.length, "мероприятие", "мероприятия", "мероприятий")}`
              : ""}
          </div>
          {dayEvents.length === 0 ? (
            <div style={{ color: "var(--hint)", fontSize: 13, padding: "4px 2px 10px" }}>
              Ничего не запланировано
            </div>
          ) : (
            dayEvents.map((e, i) => (
              <EventRow key={e.id} event={e} index={i} onOpen={p.onOpenEvent} />
            ))
          )}
        </div>
      </div>
      <BottomBar label="Открыть день" onMain={p.onOpenDay} onCreate={p.onCreate} />
    </>
  );
}
