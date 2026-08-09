import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Group } from "../lib/types";

const ROLE: Record<string, string> = {
  owner: "владелец", admin: "админ", moderator: "модератор",
  organizer: "организатор", member: "участник", guest: "гость",
};

interface Props { groups: Group[]; onClose(): void; onChanged(): void }

export function GroupsPage({ groups, onClose, onChanged }: Props) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setError(null); }, [groups.length]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createGroup({ title: title.trim() });
      setTitle("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось создать группу");
    } finally {
      setBusy(false);
    }
  }

  async function makeLink(id: string) {
    try {
      const res = await api.invite(id);
      setInvite((prev) => ({ ...prev, [id]: res.url }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось создать ссылку");
    }
  }

  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <div className="sheet on">
        <div className="grab" />
        <div className="sh-hd">
          <div style={{ flex: 1 }}>
            <h2>Группы</h2>
            <p>{groups.length ? `${groups.length} — вы участник` : "пока пусто"}</p>
          </div>
          <button className="ib" onClick={onClose}>✕</button>
        </div>

        <div className="sh-sec">
          {groups.map((g) => (
            <div key={g.id} className="kv" style={{ display: "block" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 32, height: 32, borderRadius: "50%", background: g.color, flex: "0 0 auto",
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{g.title}</div>
                  <div style={{ fontSize: 12, color: "var(--hint)" }}>
                    {g.members_count} участников · вы {ROLE[g.my_role ?? "member"]}
                  </div>
                </div>
                <button className="tb" onClick={() => makeLink(g.id)}>Ссылка</button>
              </div>
              {invite[g.id] && (
                <div className="note" style={{ marginTop: 8, wordBreak: "break-all" }}>
                  {invite[g.id]}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="sh-sec">
          <div className="fld" style={{ marginTop: 12 }}>
            <div className="lbl">Новая группа</div>
            <input className="inp" value={title} placeholder="Волейбол по средам"
              onChange={(e) => setTitle(e.target.value)} />
          </div>
          {error && <div className="note warn2">{error}</div>}
        </div>

        <div className="rsvp">
          <button className="going on" disabled={busy || !title.trim()} onClick={create}>
            Создать группу
          </button>
        </div>
      </div>
    </>
  );
}
