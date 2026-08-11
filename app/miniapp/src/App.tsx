import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, login } from "./lib/api";
import { MN, MNn, WD, addDays, sameDay, startOfDay } from "./lib/date";
import { initTelegram, startParam } from "./lib/tg";
import type { Event, Group, User } from "./lib/types";
import { DayView } from "./views/DayView";
import { EventSheet } from "./views/EventSheet";
import { GroupsView } from "./views/GroupsView";
import { ListView, type Period } from "./views/ListView";
import { PeoplePicker } from "./components/PeoplePicker";
import { Select } from "./components/Select";
import { WhoIsGoing } from "./views/WhoIsGoing";
import { MonthView } from "./views/MonthView";
import { Wizard } from "./views/Wizard";

type View = "month" | "day" | "list" | "groups";
type Filter = "all" | "going" | "away";

const VIEWS: Record<View, string> = {
  month: "Месяц", day: "День", list: "Список", groups: "Группы",
};
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

  // Двухслойный переход между вкладками: уходящий экран остаётся снимком
  // разметки на 340 мс и растворяется, пока новый въезжает навстречу.
  const bodyRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  // dir: 1 — вправо по порядку вкладок, -1 — влево. ghost живёт 340 мс.
  const [anim, setAnim] = useState<{ dir: 1 | -1; html: string; id: number } | null>(null);

  const [openEvent, setOpenEvent] = useState<Event | null>(null);
  const [wizard, setWizard] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string | "all">("all");
  const [inviteTo, setInviteTo] = useState<Event | null>(null);
  const [whoFor, setWhoFor] = useState<Event | null>(null);
  const [editEvent, setEditEvent] = useState<Event | null>(null);

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
    const scoped = events.filter((e) => {
      if (groupFilter !== "all" && (e.group_id ?? "personal") !== groupFilter) return false;
      return view === "day" ? sameDay(new Date(e.starts_at), cursor) : inScope(e);
    });
    const going = scoped.filter((e) => e.my_status === "going" && e.status !== "cancelled").length;
    return { all: scoped.length, going, away: scoped.length - going };
  }, [events, view, cursor, inScope, groupFilter]);

  const visible = useMemo(
    () => events.filter((e) => {
      if (groupFilter !== "all" && (e.group_id ?? "personal") !== groupFilter) return false;
      if (filter === "all") return true;
      const going = e.my_status === "going" && e.status !== "cancelled";
      return filter === "going" ? going : !going;
    }),
    [events, filter, groupFilter],
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

  function switchView(v: View, at?: Date) {
    if (v === view && !at) return;
    const order = Object.keys(VIEWS) as View[];
    const idx = order.indexOf(v);
    const dir: 1 | -1 = idx > order.indexOf(view) ? 1 : -1;

    const html = bodyRef.current?.querySelector(".view:not(.ghost)")?.innerHTML ?? "";
    setAnim({ dir, html, id: Date.now() });

    if (at) { setSelected(at); setCursor(at); }
    else if (v === "day") setCursor(selected);
    else if (v === "month") setSelected(cursor);
    setView(v);
  }

  useEffect(() => {
    if (!anim) return;
    const t = window.setTimeout(() => setAnim(null), 340);
    return () => window.clearTimeout(t);
  }, [anim]);

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

        <div className="seg" style={{ "--tabs": Object.keys(VIEWS).length } as React.CSSProperties}>
          <span className="pill" style={{
            transform: `translateX(${Object.keys(VIEWS).indexOf(view) * 100}%)`,
          }} />
          {(Object.keys(VIEWS) as View[]).map((k) => (
            <button key={k} className={k === view ? "on" : ""} onClick={() => switchView(k)}>
              {VIEWS[k]}
            </button>
          ))}
        </div>

        <div className={`filters ${view === "groups" ? "hidden" : ""}`}>
          <div className="filters-row" ref={filtersRef}>
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <button
              key={k}
              className={`chip ${filter === k ? "on" : ""}`}
              onClick={(e) => {
                setFilter(k);
                // «nearest» — минимальная прокрутка: чип просто целиком
                // въезжает в экран, а не уезжает к левому краю
                (e.currentTarget as HTMLElement).scrollIntoView({
                  behavior: "smooth", inline: "nearest", block: "nearest",
                });
              }}
            >
              {k === "going" && <u style={{ background: "var(--accept)" }} />}
              {k === "away" && <u style={{ background: "var(--neutral)" }} />}
              {FILTERS[k]}<b>{counts[k]}</b>
            </button>
          ))}
            {groups.length > 0 && (
              <Select
                compact
                value={groupFilter}
                onChange={setGroupFilter}
                options={[
                  { value: "all", label: "Все группы" },
                  { value: "personal", label: "Личные" },
                  ...groups.map((g) => ({ value: g.id, label: g.title })),
                ]}
              />
            )}
          </div>
        </div>
      </div>

      <div id="body" ref={bodyRef}>
        {anim && anim.html && (
          <div
            key={anim.id}
            className={`view in ghost leave-${anim.dir > 0 ? "l" : "r"}`}
            aria-hidden
            dangerouslySetInnerHTML={{ __html: anim.html }}
          />
        )}
        <div key={view} className={`view in ${anim ? `enter-${anim.dir > 0 ? "r" : "l"}` : ""}`}>
          {view === "month" && (
            <MonthView
              cursor={cursor} selected={selected} events={visible} today={today}
              onSelect={setSelected}
              onOpenDay={() => switchView("day")}
              onOpenEvent={setOpenEvent}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "day" && (
            <DayView
              cursor={cursor} events={visible} today={today}
              onOpenEvent={setOpenEvent}
              onPickDay={() => switchView("month")}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "groups" && (
            <GroupsView groups={groups} meId={user?.id ?? ""} onChanged={() => void reload()} />
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
          onEdit={(e) => { setOpenEvent(null); setEditEvent(e); }}
          onInvite={(e) => { setOpenEvent(null); setInviteTo(e); }}
          onWho={(e) => { setOpenEvent(null); setWhoFor(e); }}
        />
      )}

      {whoFor && <WhoIsGoing event={whoFor} onClose={() => setWhoFor(null)} />}

      {inviteTo && (
        <PeoplePicker
          title="Кого позвать"
          onClose={() => setInviteTo(null)}
          onDone={async (users, usernames) => {
            await api
              .inviteToEvent(inviteTo.id, users.map((u) => u.id), usernames)
              .catch(() => undefined);
            void reload();
          }}
        />
      )}

      {(wizard || editEvent) && (
        <Wizard
          groups={groups}
          day={view === "day" ? cursor : selected}
          existing={events}
          edit={editEvent}
          onClose={() => { setWizard(false); setEditEvent(null); }}
          onCreated={(e) => {
            upsert(e);
            setWizard(false);
            setEditEvent(null);
            switchView("day", startOfDay(new Date(e.starts_at)));
          }}
        />
      )}
    </div>
  );
}
