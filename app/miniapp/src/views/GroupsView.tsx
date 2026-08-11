import { useEffect, useState } from "react";

import { BottomBar } from "../components/BottomBar";
import { PeoplePicker } from "../components/PeoplePicker";
import { api } from "../lib/api";
import { shareLink } from "../lib/share";
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

interface Props { groups: Group[]; onChanged(): void }

export function GroupsView({ groups, onChanged }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [picker, setPicker] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const group = groups.find((g) => g.id === openId) ?? null;
  const iAmBoss = group?.my_role === "owner" || group?.my_role === "admin";

  useEffect(() => {
    if (!openId) return;
    setInvite(null);
    api.members(openId).then(setMembers).catch(() => setMembers([]));
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

  const link = () =>
    guard(async () => {
      const res = await api.invite(openId!);
      setInvite(res.url);
    });

  /* ---------- список групп ---------- */
  if (!group) {
    return (
      <>
        <div className="list" id="listScroll">
          {groups.length === 0 && !creating && (
            <div className="empty">
              <div>👥</div>
              Групп пока нет.<br />
              <span style={{ fontSize: 12 }}>Создайте первую — в неё можно звать людей.</span>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.id} className="row" onClick={() => setOpenId(g.id)}>
              <span className="gav" style={{ background: g.color }}>
                {g.title.slice(0, 1).toUpperCase()}
              </span>
              <div className="meta">
                <div className="rt"><em>{g.title}</em></div>
                <div className="rs">
                  {g.members_count} участников · вы {ROLES[g.my_role ?? "member"]}
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
        </div>
        <BottomBar label="Новая группа" onMain={() => setCreating(true)} />
      </>
    );
  }

  /* ---------- карточка группы ---------- */
  const existing = new Set(members.map((m) => m.user.id));

  return (
    <>
      <div className="list" id="listScroll">
        <div className="gtop">
          <button className="tb" onClick={() => setOpenId(null)}>‹ Все группы</button>
        </div>

        <div className="ghead">
          <span className="gav lg" style={{ background: group.color }}>
            {group.title.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div className="ttl">{group.title}</div>
            <div className="sub">{members.length} участников</div>
          </div>
        </div>

        {members.map((m) => (
          <div key={m.user.id} className="row">
            <span className="pav" style={{ backgroundImage: m.user.photo_url ? `url(${m.user.photo_url})` : undefined }}>
              {m.user.photo_url ? "" : fullName(m.user).slice(0, 1).toUpperCase()}
            </span>
            <div className="meta">
              <div className="rt"><em>{fullName(m.user)}</em></div>
              <div className="rs">{ROLES[m.role] ?? m.role}</div>
            </div>
            {iAmBoss && m.role !== "owner" && (
              <select
                className="rolesel"
                value={ASSIGNABLE.includes(m.role) ? m.role : "member"}
                onChange={(e) =>
                  guard(async () => {
                    await api.setRole(group.id, m.user.id, e.target.value as GroupRole);
                    setMembers(await api.members(group.id));
                  })
                }
              >
                {ASSIGNABLE.map((r) => (
                  <option key={r} value={r}>{ROLES[r]}</option>
                ))}
              </select>
            )}
          </div>
        ))}

        {invite && <div className="note" style={{ wordBreak: "break-all" }}>{invite}</div>}
        {error && <div className="note warn2">{error}</div>}

        {iAmBoss && (
          <div className="rsvp" style={{ padding: "14px 0 0" }}>
            <button className="maybe" onClick={link} disabled={busy}>Ссылка-приглашение</button>
            {invite && (
              <button
                className="maybe"
                onClick={() => shareLink(invite, `Присоединяйтесь к группе «${group.title}» в Meeto`)}
              >
                Поделиться
              </button>
            )}
          </div>
        )}
      </div>

      <BottomBar
        label={iAmBoss ? "Добавить участников" : "Назад к группам"}
        onMain={() => (iAmBoss ? setPicker(true) : setOpenId(null))}
      />

      {picker && (
        <PeoplePicker
          title="Кого добавить"
          exclude={existing}
          invite={invite ? { url: invite, text: `Присоединяйтесь к группе «${group.title}»` } : null}
          onClose={() => setPicker(false)}
          onDone={(users) =>
            guard(async () => {
              await api.addMembers(group.id, users.map((u) => u.id));
              setMembers(await api.members(group.id));
              onChanged();
            })
          }
        />
      )}
    </>
  );
}
