import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, login } from "./lib/api";
import { MN, MNn, WD, addDays, sameDay, startOfDay } from "./lib/date";
import { initTelegram, startParam } from "./lib/tg";
import type { Event, Group, User } from "./lib/types";
import { DayView } from "./views/DayView";
import { EventSheet } from "./views/EventSheet";
import { GroupsPage } from "./views/GroupsPage";
import { ListView, type Period } from "./views/ListView";
import { MonthView } from "./views/MonthView";
import { Wizard } from "./views/Wizard";

type View = "month" | "day" | "list";
type Filter = "all" | "going" | "away";

const VIEWS: Record<View, string> = { month: "Месяц", day: "День", list: "Список" };
const FILTERS: Record<Filter, string> = { all: "Все", going: "Принято", away: "Не участвую" };

export default function App() {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [view, setView] = useState<View>("month");
  const [filter, setFilter] = useState<Filter>("all");
  const [period, setPeriod] = useState<Period>("month");
  const [cursor, setCursor] = useState(today);
  const [selected, setSelected] = useState(today);

  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [openEvent, setOpenEvent] = useState<Event | null>(null);
  const [wizard, setWizard] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);

  const range = useMemo((): [Date, Date] => {
    if (view === "list") {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      if (period === "week") return [cursor, addDays(cursor, 7)];
      if (period === "month") return [new Date(y, m, 1), new Date(y, m + 1, 1)];
      if (period === "quarter") return [new Date(y, m, 1), new Date(y, m + 3, 1)];
      return [new Date(y - 1, 0, 1), new Date(y + 2, 0, 1)];
    }
    if (view === "day") return [startOfDay(cursor), addDays(startOfDay(cursor), 1)];
    const y = cursor.getFullYear(), m = cursor.getMonth();
    return [addDays(new Date(y, m, 1), -7), addDays(new Date(y, m + 1, 1), 7)];
  }, [view, period, cursor]);

  const reload = useCallback(async () => {
    try {
      const [payload, gs] = await Promise.all([api.calendar(range[0], range[1]), api.groups()]);
      setEvents(payload.events);
      setGroups(gs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setFatal("Сессия истекла — переоткройте приложение");
      else setFatal(e instanceof Error ? e.message : "не удалось загрузить данные");
    }
  }, [range]);

  useEffect(() => {
    initTelegram();
    (async () => {
      try {
        const session = await login();
        setUser(session.user);
        const param = session.start_param ?? startParam();
        if (param?.startsWith("g_")) {
          await api.acceptInvite(param.slice(2)).catch(() => undefined);
        }
      } catch {
        setFatal("Откройте приложение из Telegram — вход возможен только оттуда");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => { if (user) void reload(); }, [user, reload]);

  const inScope = useCallback(
    (e: Event) => {
      const t = +new Date(e.starts_at);
      return t >= +range[0] && t < +range[1];
    },
    [range],
  );

  const counts = useMemo(() => {
    const scoped = events.filter((e) =>
      view === "day" ? sameDay(new Date(e.starts_at), cursor) : inScope(e),
    );
    const going = scoped.filter((e) => e.my_status === "going" && e.status !== "cancelled").length;
    return { all: scoped.length, going, away: scoped.length - going };
  }, [events, view, cursor, inScope]);

  const visible = useMemo(
    () => events.filter((e) => {
      if (filter === "all") return true;
      const going = e.my_status === "going" && e.status !== "cancelled";
      return filter === "going" ? going : !going;
    }),
    [events, filter],
  );

  function shift(delta: number) {
    const next = new Date(cursor);
    if (view === "month") next.setMonth(next.getMonth() + delta);
    else if (view === "day") next.setDate(next.getDate() + delta);
    else if (period === "week") next.setDate(next.getDate() + 7 * delta);
    else if (period === "quarter") next.setMonth(next.getMonth() + 3 * delta);
    else next.setMonth(next.getMonth() + delta);
    setCursor(next);
    if (view === "month") setSelected(next);
  }

  function switchView(v: View) {
    if (v === view) return;
    if (v === "day") setCursor(selected);
    if (v === "month") setSelected(cursor);
    setView(v);
  }

  function upsert(updated: Event) {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === updated.id);
      return idx < 0 ? [...prev, updated] : prev.map((e) => (e.id === updated.id ? updated : e));
    });
    setOpenEvent((cur) => (cur && cur.id === updated.id ? updated : cur));
  }

  const title =
    view === "month"
      ? <>{MNn[cursor.getMonth()]}<u>{cursor.getFullYear()}</u></>
      : view === "day"
        ? <>{cursor.getDate()} {MN[cursor.getMonth()]}
            <u>{sameDay(cursor, today) ? "сегодня" : WD[(cursor.getDay() + 6) % 7].toLowerCase()}</u></>
        : <>{MNn[cursor.getMonth()]}<u>{cursor.getFullYear()}</u></>;

  if (loading) return <div className="phone"><div className="empty">Загружаем…</div></div>;
  if (fatal && !user) return <div className="phone"><div className="empty"><div>🔒</div>{fatal}</div></div>;

  return (
    <div className="phone">
      <div className="hdr">
        <div className="hdr-top">
          <div className="hdr-title">{title}</div>
          <button className="theme" onClick={() => document.body.classList.toggle("dark")}>◐</button>
          <button className="tb" onClick={() => { setCursor(today); setSelected(today); }}>Сегодня</button>
          <button className="ib" onClick={() => shift(-1)}>‹</button>
          <button className="ib" onClick={() => shift(1)}>›</button>
        </div>

        <div className="seg">
          <span className="pill" style={{
            transform: `translateX(${Object.keys(VIEWS).indexOf(view) * 100}%)`,
          }} />
          {(Object.keys(VIEWS) as View[]).map((k) => (
            <button key={k} className={k === view ? "on" : ""} onClick={() => switchView(k)}>
              {VIEWS[k]}
            </button>
          ))}
        </div>

        <div className="filters">
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
              {k === "going" && <u style={{ background: "var(--accept)" }} />}
              {k === "away" && <u style={{ background: "var(--neutral)" }} />}
              {FILTERS[k]}<b>{counts[k]}</b>
            </button>
          ))}
          <button className="chip" onClick={() => setGroupsOpen(true)}>Группы</button>
        </div>
      </div>

      <div id="body">
        <div className="view in">
          {view === "month" && (
            <MonthView
              cursor={cursor} selected={selected} events={visible} today={today}
              onSelect={setSelected}
              onOpenDay={() => { setCursor(selected); setView("day"); }}
              onOpenEvent={setOpenEvent}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "day" && (
            <DayView
              cursor={cursor} events={visible} today={today}
              onOpenEvent={setOpenEvent}
              onPickDay={() => { setSelected(cursor); setView("month"); }}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "list" && (
            <ListView
              events={visible.filter(inScope)} today={today} period={period}
              onPeriod={setPeriod} onOpenEvent={setOpenEvent} onCreate={() => setWizard(true)}
            />
          )}
        </div>
      </div>

      {openEvent && (
        <EventSheet
          event={openEvent}
          onClose={() => setOpenEvent(null)}
          onChanged={upsert}
        />
      )}

      {wizard && (
        <Wizard
          groups={groups} day={view === "day" ? cursor : selected} existing={events}
          onClose={() => setWizard(false)}
          onCreated={(e) => { upsert(e); setWizard(false); setCursor(startOfDay(new Date(e.starts_at)));
            setSelected(startOfDay(new Date(e.starts_at))); setView("day"); }}
        />
      )}

      {groupsOpen && (
        <GroupsPage
          groups={groups} onClose={() => setGroupsOpen(false)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}
