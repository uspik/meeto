import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, login } from "./lib/api";
import { MN, MNn, WD, addDays, sameDay, startOfDay } from "./lib/date";
import { initTelegram, startParam } from "./lib/tg";
import { connect, subscribe } from "./lib/live";
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
  const [invitations, setInvitations] = useState<Group[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  // То, что реально нарисовано. Обновляется только вместе с приходом данных
  // за текущий период: иначе на долю секунды показывался прежний список,
  // пересобранный по новому диапазону, — те самые «прыгающие местами» строки.
  const [feed, setFeed] = useState<Event[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Метка периода, за который лежат данные. Пока она не совпадает с текущим
  // периодом, показывать по ним числа нельзя: именно так и получалось, что
  // в фильтре на долю секунды мелькала единица от прошлой вкладки.
  const [loadedKey, setLoadedKey] = useState("");
  // скелетоны — только пока показывать вообще нечего; при смене периода
  // держим прежние строки до прихода новых, иначе экран дёргается дважды
  const [everLoaded, setEverLoaded] = useState(false);

  // Двухслойный переход между вкладками: уходящий экран остаётся снимком
  // разметки на 340 мс и растворяется, пока новый въезжает навстречу.
  const bodyRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  // dir: 1 — вправо по порядку вкладок, -1 — влево. ghost живёт 340 мс.
  const [anim, setAnim] = useState<{ dir: 1 | -1; html: string; id: number } | null>(null);

  const [openEvent, setOpenEvent] = useState<Event | null>(null);
  const [wizard, setWizard] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string | "all">("all");
  // приглашая на мероприятие, сразу держим под рукой тех, кто уже позван:
  // показывать их в списке — значит предлагать пригласить дважды
  const [inviteTo, setInviteTo] =
    useState<{ event: Event; exclude: Set<string>; handles: string[] } | null>(null);
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

  const rangeKey = `${+range[0]}-${+range[1]}`;
  // данные ещё не за тот период, который показываем
  const stale = loadedKey !== rangeKey;

  const reload = useCallback(async () => {
    const key = rangeKey;
    try {
      const [payload, gs, inv] = await Promise.all([
        api.calendar(range[0], range[1]),
        api.groups(),
        api.groupInvitations().catch(() => [] as Group[]),
      ]);
      setEvents(payload.events);
      setGroups(gs);
      setInvitations(inv);
      // помечаем, за какой период данные: пока метка не совпала с текущим
      // периодом, считать по ним нельзя — именно от этого прыгали счётчики
      setLoadedKey(key);
      setEverLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setFatal("Сессия истекла — переоткройте приложение");
      else setFatal(e instanceof Error ? e.message : "не удалось загрузить данные");
    }
  }, [range, rangeKey]);

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

  // Живые обновления. Соединение одно на приложение, экраны подписываются
  // на разбор сообщений сами. reload держим в ссылке: иначе смена периода
  // пересоздавала бы поток на каждый шаг календаря.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!user) return;
    const stop = connect();
    let pending = 0;
    const off = subscribe((change) => {
      // Пачку изменений (ответили сразу несколько человек) сводим в один
      // запрос: перечитывать календарь на каждое сообщение незачем.
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        void reloadRef.current();
        // открытая карточка мероприятия живёт отдельно от календаря
        setOpenEvent((cur) => {
          if (cur && (!change.event_id || change.event_id === cur.id)) {
            void api.event(cur.id).then(upsert).catch(() => undefined);
          }
          return cur;
        });
      }, 120);
    });
    return () => { window.clearTimeout(pending); off(); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const inScope = useCallback(
    (e: Event) => {
      const t = +new Date(e.starts_at);
      return t >= +range[0] && t < +range[1];
    },
    [range],
  );

  // Счётчики фильтров. Пока данные не за тот период, который показываем,
  // считать по ним нельзя: получится число «из прошлой вкладки», которое
  // через мгновение сменится правильным. Поэтому держим прежнее до конца
  // загрузки — обычно оно и оказывается верным, и цифра просто не дёргается.
  const shown = useRef({ all: 0, going: 0, away: 0 });
  const counts = useMemo(() => {
    if (stale) return shown.current;
    const scoped = feed.filter((e) => {
      if (groupFilter !== "all" && (e.group_id ?? "personal") !== groupFilter) return false;
      return view === "day" ? sameDay(new Date(e.starts_at), cursor) : inScope(e);
    });
    const going = scoped.filter((e) => e.my_status === "going" && e.status !== "cancelled").length;
    return { all: scoped.length, going, away: scoped.length - going };
  }, [feed, view, cursor, inScope, groupFilter, stale]);

  useEffect(() => { shown.current = counts; }, [counts]);

  useEffect(() => { if (!stale) setFeed(events); }, [events, stale]);


  // Скелетоны показываем, только когда показывать действительно нечего:
  // при переходе месяц → список периоды пересекаются, строки уже на экране,
  // и подменять их скелетонами значит анимировать список дважды подряд.
  const emptyForNow = useMemo(
    () => feed.filter((e) => inScope(e)).length === 0,
    [feed, inScope],
  );
  const skeletons = !everLoaded || (stale && emptyForNow);

  const visible = useMemo(
    () => feed.filter((e) => {
      if (groupFilter !== "all" && (e.group_id ?? "personal") !== groupFilter) return false;
      if (filter === "all") return true;
      const going = e.my_status === "going" && e.status !== "cancelled";
      return filter === "going" ? going : !going;
    }),
    [feed, filter, groupFilter],
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

  // Клавиатура на компьютере: стрелки листают период, «сегодня» — на Home,
  // Tab/Shift+Tab и Esc работают сами. Обработчик переустанавливается на
  // каждый рендер намеренно — так он всегда видит актуальные view и cursor,
  // а список зависимостей не приходится держать в голове.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || el?.isContentEditable;
      // при открытой шторке стрелки принадлежат ей, а не календарю
      if (typing || openEvent || editEvent || wizard || inviteTo || whoFor) return;
      if (view === "groups") return;

      if (e.key === "ArrowLeft") { e.preventDefault(); shift(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); shift(1); }
      else if (e.key === "Home") { e.preventDefault(); setCursor(today); setSelected(today); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
        {/* Фильтр в ключе: при его смене экран пересобирается и строки
            въезжают заново, а не перескакивают на новые места. */}
        <div
          key={`${view}:${filter}:${groupFilter}`}
          className={`view in ${anim ? `enter-${anim.dir > 0 ? "r" : "l"}` : ""}`}
        >
          {view === "month" && (
            <MonthView
              cursor={cursor} selected={selected} events={visible} today={today}
              loading={skeletons}
              onSelect={setSelected}
              onOpenDay={() => switchView("day")}
              onOpenEvent={setOpenEvent}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "day" && (
            <DayView
              cursor={cursor} events={visible} today={today} loading={skeletons}
              onOpenEvent={setOpenEvent}
              onPickDay={() => switchView("month")}
              onCreate={() => setWizard(true)}
            />
          )}
          {view === "groups" && (
            <GroupsView
              groups={groups}
              invitations={invitations}
              meId={user?.id ?? ""}
              onChanged={() => void reload()}
            />
          )}
          {view === "list" && (
            <ListView
              events={visible.filter(inScope)} today={today} period={period} loading={skeletons}
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
          onInvite={async (e) => {
            setOpenEvent(null);
            const p = await api.participants(e.id).catch(() => null);
            setInviteTo({
              event: e,
              exclude: new Set(p?.participants.map((x) => x.user.id) ?? []),
              handles: p?.pending ?? [],
            });
          }}
          onWho={(e) => { setOpenEvent(null); setWhoFor(e); }}
        />
      )}

      {whoFor && (
        <WhoIsGoing
          event={whoFor}
          onClose={() => setWhoFor(null)}
          onChanged={() => void reload()}
        />
      )}

      {inviteTo && (
        <PeoplePicker
          title="Кого позвать"
          exclude={inviteTo.exclude}
          excludeHandles={inviteTo.handles}
          onClose={() => setInviteTo(null)}
          onDone={async (users, usernames) => {
            await api
              .inviteToEvent(inviteTo.event.id, users.map((u) => u.id), usernames)
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
