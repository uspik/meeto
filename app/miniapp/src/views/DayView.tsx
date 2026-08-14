import { BottomBar } from "../components/BottomBar";
import { SkeletonDay } from "../components/Skeleton";
import { Icon } from "../components/Icon";
import { hm, plural, sameDay } from "../lib/date";
import { conflictsOn, onDay, span } from "../lib/conflicts";
import type { Event } from "../lib/types";
import { visualStatus } from "../lib/types";

const HH = 76;                 // высота часа
const PAD = 20 * 60_000;       // поля вокруг блока
const SNAP = 30 * 60_000;      // округление границ сегмента

interface Props {
  cursor: Date;
  events: Event[];
  today: Date;
  onOpenEvent(e: Event): void;
  onPickDay(): void;
  onCreate(): void;
  loading?: boolean;
}

export function DayView(p: Props) {
  const evs = p.events
    .filter((e) => onDay(e, p.cursor))
    .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));

  if (!evs.length) {
    return (
      <>
        <div className="dscroll" id="dayScroll">
          {p.loading ? <SkeletonDay /> : (
            <div className="empty">
              <div>🗓</div>
              В этот день мероприятий нет<br />
              <span style={{ fontSize: 12 }}>Свободно весь день</span>
            </div>
          )}
        </div>
        <BottomBar label="Выбрать день" onMain={p.onPickDay} onCreate={p.onCreate} />
      </>
    );
  }

  // показываем только интервалы с мероприятиями, пустые часы схлопываем
  const raw = evs
    .map((e) => {
      const [s, t] = span(e);
      return [
        Math.floor((s.getTime() - PAD) / SNAP) * SNAP,
        Math.ceil((t.getTime() + PAD) / SNAP) * SNAP,
      ] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);

  const segs: [number, number][] = [];
  for (const [s, e] of raw) {
    const last = segs[segs.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else segs.push([s, e]);
  }

  const cs = conflictsOn(p.events, p.cursor);
  const now = new Date();
  const goingCount = evs.filter((e) => e.my_status === "going" && e.status !== "cancelled").length;

  return (
    <>
      <div className="dscroll" id="dayScroll">
        <div className="dsum">
          {evs.length} {plural(evs.length, "мероприятие", "мероприятия", "мероприятий")} · {goingCount} принято
        </div>

        {segs.map(([from, to], si) => {
          const y = (t: number) => ((t - from) / 3_600_000) * HH;
          const hours: number[] = [];
          for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= to; t += 3_600_000) hours.push(t);

          const inSeg = evs.filter((e) => {
            const [s, t] = span(e);
            return t.getTime() > from && s.getTime() < to;
          });

          const lanes: number[] = [];
          const placed = inSeg.map((e) => {
            const [s0, e0] = span(e);
            const s = Math.max(s0.getTime(), from);
            const en = Math.min(e0.getTime(), to);
            let lane = lanes.findIndex((end) => end <= s);
            if (lane < 0) { lane = lanes.length; lanes.push(en); } else lanes[lane] = en;
            return { e, s, en, lane };
          });
          const width = 100 / Math.max(1, lanes.length);

          const gap = si > 0 ? (from - segs[si - 1][1]) / 3_600_000 : 0;

          return (
            <div key={from}>
              {si > 0 && (
                <div className="gap">
                  <span>
                    {gap >= 1
                      ? `${Math.round(gap)} ${plural(Math.round(gap), "час", "часа", "часов")} свободно`
                      : "перерыв"}
                  </span>
                </div>
              )}
              <div className="seg-tl" style={{ height: ((to - from) / 3_600_000) * HH }}>
                <div className="gutter">
                  {hours.map((t) => (
                    <span key={t} style={{ top: y(t) }}>{hm(new Date(t))}</span>
                  ))}
                </div>
                <div className="track">
                  {hours.map((t) => <div key={t} className="hline" style={{ top: y(t) }} />)}

                  {cs.map((c) => {
                    const f = Math.max(+new Date(c.from), from);
                    const t = Math.min(+new Date(c.to), to);
                    if (t <= f) return null;
                    return (
                      <div
                        key={c.from + c.event_ids.join()}
                        className="xsec"
                        style={{ top: y(f), height: Math.max(6, y(t) - y(f)), left: 0, right: 0 }}
                      />
                    );
                  })}

                  {sameDay(now, p.cursor) && +now > from && +now < to && (
                    <div className="now" style={{ top: y(+now) }} />
                  )}

                  {placed.map(({ e, s, en, lane }, bi) => {
                    const h = Math.max(38, y(en) - y(s) - 4);
                    return (
                      <div
                        key={e.id}
                        className={`blk rise s-${visualStatus(e)}`}
                        style={{
                          animationDelay: `${bi * 45}ms`,
                          top: y(s), height: h,
                          left: `calc(${lane * width}% + 6px)`,
                          width: `calc(${width}% - 12px)`,
                        }}
                        onClick={() => p.onOpenEvent(e)}
                      >
                        <Icon event={e} size="sm" />
                        <span style={{ minWidth: 0 }}>
                          <span className="t">{e.title}</span>
                          {h > 50 && (
                            <span className="tm">
                              {hm(new Date(e.starts_at))}
                              {e.ends_at ? `–${hm(new Date(e.ends_at))}` : ""}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <BottomBar label="Выбрать день" onMain={p.onPickDay} onCreate={p.onCreate} />
    </>
  );
}
