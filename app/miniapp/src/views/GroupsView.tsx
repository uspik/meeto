import { useEffect, useState } from "react";

import { BottomBar } from "../components/BottomBar";
import { PeoplePicker } from "../components/PeoplePicker";
import { Select } from "../components/Select";
import { api } from "../lib/api";
import { plural } from "../lib/date";
import { copy, shareLink } from "../lib/share";
import type { Group, GroupRole, Member } from "../lib/types";

/** В интерфейсе три роли; остальные из модели наружу не выводим. */
const ROLES: Record<string, string> = {
  owner: "владелец",
  admin: "администратор",
  member: "участник",
};
const ASSIGNABLE: GroupRole[] = ["admin", "member"];

const fullName = (u: { first_name: string; last_name?: string | null }) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ");

interface Props {
  groups: Group[];
  /** куда позвали, но ответа ещё нет */
  invitations: Group[];
  meId: string;
  onChanged(): void;
}

export function GroupsView({ groups, invitations, meId, onChanged }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [picker, setPicker] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  // исключённые в этом сеансе — блок «Исключены» с кнопкой «Вернуть»
  const [removed, setRemoved] = useState<Member[]>([]);
  // список участников подгружается отдельным запросом: пока он идёт,
  // показываем скелетоны, иначе строки «выпрыгивают» на готовой странице
  const [loadingMembers, setLoadingMembers] = useState(false);

  const group = groups.find((g) => g.id === openId) ?? null;
  const iAmBoss = group?.my_role === "owner" || group?.my_role === "admin";

  useEffect(() => {
    if (!openId) return;
    setConfirmRotate(false);
    setCopied(false);
    setMembers([]);
    setRemoved([]);
    setLoadingMembers(true);
    api.members(openId)
      .then(setMembers)
      .catch(() => setMembers([]))
      .finally(() => setLoadingMembers(false));
    api.groupPending(openId).then(setPending).catch(() => setPending([]));
    // ссылка постоянная: показываем ту же, что и в прошлый раз
    api.invite(openId).then((r) => setInvite(r.url)).catch(() => setInvite(null));
  }, [openId]);

  async function guard(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "не получилось");
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    guard(async () => {
      const g = await api.createGroup({ title: title.trim() });
      setTitle("");
      setCreating(false);
      onChanged();
      setOpenId(g.id);
    });

  const rotate = () =>
    guard(async () => {
      const res = await api.rotateInvite(openId!);
      setInvite(res.url);
      setConfirmRotate(false);
      setCopied(false);
    });

  /* ---------- список групп ---------- */
  if (!group) {
    return (
      <>
        <div className="list gpage" id="listScroll" key="all">
          {invitations.length > 0 && (
            <>
              <div className="wsec" style={{ margin: "4px 0 6px" }}>Вас приглашают</div>
              {invitations.map((g, i) => (
                <div key={g.id} className="row inv rise" style={{ animationDelay: `${i * 45}ms` }}>
                  <span className="gav" style={{ background: g.color }}>
                    {g.title.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="meta">
                    <div className="rt"><em>{g.title}</em></div>
                    <div className="rs">
                      {g.members_count}{" "}
                      {plural(g.members_count, "участник", "участника", "участников")}
                    </div>
                  </div>
                  <div className="invbtns">
                    <button
                      className="declined"
                      disabled={busy}
                      onClick={() => guard(async () => { await api.declineGroup(g.id); onChanged(); })}
                    >
                      Отказаться
                    </button>
                    <button
                      className="going on"
                      disabled={busy}
                      onClick={() => guard(async () => {
                        const joined = await api.acceptGroup(g.id);
                        onChanged();
                        setOpenId(joined.id);
                      })}
                    >
                      Вступить
                    </button>
                  </div>
                </div>
              ))}
              {groups.length > 0 && (
                <div className="wsec" style={{ margin: "14px 0 6px" }}>Мои группы</div>
              )}
            </>
          )}

          {groups.length === 0 && invitations.length === 0 && !creating && (
            <div className="empty">
              <div>👥</div>
              Групп пока нет.<br />
              <span style={{ fontSize: 12 }}>Создайте первую — в неё можно звать людей.</span>
            </div>
          )}

          {groups.map((g, i) => (
            <div
              key={g.id}
              className="row rise"
              style={{ animationDelay: `${(invitations.length + i) * 45}ms` }}
              onClick={() => setOpenId(g.id)}
            >
              <span className="gav" style={{ background: g.color }}>
                {g.title.slice(0, 1).toUpperCase()}
              </span>
              <div className="meta">
                <div className="rt"><em>{g.title}</em></div>
                <div className="rs">
                  {g.members_count} {plural(g.members_count, "участник", "участника", "участников")}
                  {" · вы "}{ROLES[g.my_role ?? "member"]}
                </div>
              </div>
              <span style={{ color: "var(--hint)" }}>›</span>
            </div>
          ))}

          {creating && (
            <div className="fld" style={{ marginTop: 14 }}>
              <div className="lbl">Название группы</div>
              <input
                className="inp"
                value={title}
                autoFocus
                placeholder="Волейбол по средам"
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="rsvp" style={{ padding: "12px 0 0" }}>
                <button className="declined" onClick={() => { setCreating(false); setTitle(""); }}>
                  Отмена
                </button>
                <button
                  className="going on"
                  disabled={busy || !title.trim()}
                  onClick={create}
                >
                  Создать
                </button>
              </div>
            </div>
          )}

          {error && <div className="note warn2">{error}</div>}

          {/* Видимый штамп сборки: по нему сразу понятно, свежая ли версия
              приехала на устройство, или вебвью показывает кеш */}
          <div className="buildmark">Meeto · сборка {__BUILD__}</div>
        </div>
        <BottomBar label="Новая группа" onMain={() => setCreating(true)} />
      </>
    );
  }

  /* ---------- карточка группы ---------- */
  // в подборе людей прячем и тех, кто уже в группе, и тех, кто ещё думает
  const existing = new Set(members.map((m) => m.user.id));
  const joined = members.filter((m) => m.state !== "pending");
  const awaiting = members.filter((m) => m.state === "pending");

  return (
    <>
      <div className="list gpage" id="listScroll" key={group.id}>
        <div className="gtop">
          <button className="tb" onClick={() => setOpenId(null)}>‹ Все группы</button>
        </div>

        <div className="ghead">
          <span className="gav lg" style={{ background: group.color }}>
            {group.title.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="ttl">{group.title}</div>
            <div className="sub">
              {joined.length} {plural(joined.length, "участник", "участника", "участников")}
              {awaiting.length > 0 && ` · ${awaiting.length} не ответили`}
              {pending.length > 0 && ` · ${pending.length} ждут первого входа`}
            </div>
          </div>
        </div>

        {loadingMembers && [0, 1, 2].map((i) => (
          <div key={`sk${i}`} className="row sk" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="pav sk-b" />
            <div className="meta">
              <div className="sk-l w60" />
              <div className="sk-l w35" />
            </div>
          </div>
        ))}

        {joined.map((m, i) => (
          <div key={m.user.id} className="row rise" style={{ animationDelay: `${i * 40}ms` }}>
            <span className="pav" style={{ backgroundImage: m.user.photo_url ? `url(${m.user.photo_url})` : undefined }}>
              {m.user.photo_url ? "" : fullName(m.user).slice(0, 1).toUpperCase()}
            </span>
            <div className="meta">
              <div className="rt"><em>{fullName(m.user)}</em></div>
              <div className="rs">{ROLES[m.role] ?? m.role}</div>
            </div>
            {iAmBoss && m.role !== "owner" && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <Select
                  compact
                  value={ASSIGNABLE.includes(m.role) ? m.role : "member"}
                  options={ASSIGNABLE.map((r) => ({ value: r, label: ROLES[r] }))}
                  onChange={(v) =>
                    guard(async () => {
                      await api.setRole(group.id, m.user.id, v as GroupRole);
                      setMembers(await api.members(group.id));
                    })
                  }
                />
                <button
                  className="kick"
                  title="Исключить из группы"
                  onClick={() =>
                    guard(async () => {
                      await api.removeMember(group.id, m.user.id);
                      setMembers(await api.members(group.id));
                      // держим исключённого внизу страницы: вернуть его
                      // должно быть так же просто, как исключить
                      setRemoved((prev) => [...prev.filter((r) => r.user.id !== m.user.id), m]);
                      onChanged();
                    })
                  }
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}

        {awaiting.length > 0 && (
          <>
            <div className="wsec">Приглашены, ждём ответа</div>
            {awaiting.map((m, i) => (
              <div key={m.user.id} className="wrow rise" style={{ animationDelay: `${i * 40}ms` }}>
                <span
                  className="pav"
                  style={{ backgroundImage: m.user.photo_url ? `url(${m.user.photo_url})` : undefined }}
                >
                  {m.user.photo_url ? "" : fullName(m.user).slice(0, 1).toUpperCase()}
                </span>
                <div className="wmeta">
                  <div className="wname"><em>{fullName(m.user)}</em></div>
                  <div className="wsub">приглашение отправлено</div>
                </div>
                {iAmBoss && (
                  <button
                    className="kick"
                    title="Отозвать приглашение"
                    onClick={() =>
                      guard(async () => {
                        await api.removeMember(group.id, m.user.id);
                        setMembers(await api.members(group.id));
                        setRemoved((prev) => [...prev.filter((r) => r.user.id !== m.user.id), m]);
                      })
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {removed.length > 0 && (
          <>
            <div className="wsec">Исключены</div>
            {removed.map((m) => (
              <div key={m.user.id} className="wrow">
                <span
                  className="pav"
                  style={{
                    backgroundImage: m.user.photo_url ? `url(${m.user.photo_url})` : undefined,
                    opacity: 0.55,
                  }}
                >
                  {m.user.photo_url ? "" : fullName(m.user).slice(0, 1).toUpperCase()}
                </span>
                <div className="wmeta">
                  <div className="wname"><em>{fullName(m.user)}</em></div>
                  <div className="wsub">можно позвать обратно</div>
                </div>
                {iAmBoss && (
                  <button
                    className="tb"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        // роль возвращаем прежнюю, но только из тех, что
                        // бэкенд принимает в этой ручке
                        await api.addMembers(
                          group.id, [m.user.id], [],
                          ASSIGNABLE.includes(m.role) ? m.role : "member",
                        );
                        setMembers(await api.members(group.id));
                        setRemoved((prev) => prev.filter((r) => r.user.id !== m.user.id));
                        onChanged();
                      })
                    }
                  >
                    Вернуть
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {pending.length > 0 && (
          <>
            <div className="wsec">Позваны, ещё не в Meeto</div>
            {pending.map((h) => (
              <div key={h} className="wrow">
                <span className="pav" style={{ background: "var(--bg2)", color: "var(--hint)" }}>@</span>
                <div className="wmeta">
                  <div className="wname"><em>@{h}</em></div>
                  <div className="wsub">попадёт в группу при первом входе</div>
                </div>
                {iAmBoss && (
                  <button
                    className="kick"
                    title="Отменить приглашение"
                    onClick={() =>
                      guard(async () => {
                        await api.cancelPending(group.id, h);
                        setPending(await api.groupPending(group.id));
                      })
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {iAmBoss && invite && (
          <div className="linkbox">
            <div className="wsec" style={{ margin: "16px 0 6px" }}>Ссылка-приглашение</div>
            <button
              className="linkval"
              onClick={async () => {
                setCopied(await copy(invite));
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              <span>{invite}</span>
              <b>{copied ? "скопировано" : "копировать"}</b>
            </button>
            <div className="rsvp" style={{ padding: "8px 0 0" }}>
              <button
                className="maybe"
                onClick={() => shareLink(invite, `Присоединяйтесь к группе «${group.title}» в Meeto`)}
              >
                Поделиться
              </button>
              <button className="maybe" onClick={() => setConfirmRotate(true)} disabled={busy}>
                Поменять ссылку
              </button>
            </div>
            {confirmRotate && (
              <div className="note warn2" style={{ marginTop: 10 }}>
                Прежняя ссылка перестанет работать у всех, кому вы её отправляли.
                <div className="rsvp" style={{ padding: "10px 0 0" }}>
                  <button className="maybe" onClick={() => setConfirmRotate(false)}>Отмена</button>
                  <button className="declined on" onClick={rotate}>Поменять</button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="note warn2">{error}</div>}

        {group.my_role === "owner" && (
          confirmDrop ? (
            <div className="note warn2" style={{ marginTop: 14 }}>
              Удалить «{group.title}»? Мероприятия группы останутся, но она исчезнет у всех.
              <div className="rsvp" style={{ padding: "10px 0 0" }}>
                <button className="maybe" onClick={() => setConfirmDrop(false)}>Отмена</button>
                <button
                  className="declined on"
                  onClick={() =>
                    guard(async () => {
                      await api.deleteGroup(group.id);
                      setOpenId(null);
                      onChanged();
                    })
                  }
                >
                  Удалить
                </button>
              </div>
            </div>
          ) : (
            <div className="rsvp" style={{ padding: "14px 0 0" }}>
              <button className="declined" onClick={() => setConfirmDrop(true)}>
                Удалить группу
              </button>
            </div>
          )
        )}


      </div>

      {group.my_role !== "owner" && (
        <div className="rsvp" style={{ padding: "0 16px 12px" }}>
          <button
            className="declined"
            onClick={() =>
              guard(async () => {
                await api.removeMember(group.id, meId);
                setOpenId(null);
                onChanged();
              })
            }
          >
            Выйти из группы
          </button>
        </div>
      )}

      <BottomBar
        label={iAmBoss ? "Добавить участников" : "Назад к группам"}
        onMain={() => (iAmBoss ? setPicker(true) : setOpenId(null))}
      />

      {picker && (
        <PeoplePicker
          title="Кого добавить"
          exclude={existing}
          excludeHandles={pending}
          invite={invite ? { url: invite, text: `Присоединяйтесь к группе «${group.title}»` } : null}
          onClose={() => setPicker(false)}
          onDone={(users, usernames) =>
            guard(async () => {
              await api.addMembers(group.id, users.map((u) => u.id), usernames);
              setMembers(await api.members(group.id));
              setPending(await api.groupPending(group.id));
              onChanged();
            })
          }
        />
      )}
    </>
  );
}
