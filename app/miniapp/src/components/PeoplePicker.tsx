import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { useSheet } from "../lib/useSheet";
import { shareLink } from "../lib/share";
import type { User } from "../lib/types";

interface Props {
  title: string;
  /** кого не показывать: уже в группе или уже приглашён */
  exclude?: Set<string>;
  /** ссылка-приглашение для тех, кого в Meeto ещё нет */
  invite?: { url: string; text: string } | null;
  /** usernames — те, кого в Meeto ещё нет; их зовём заранее */
  onDone(users: User[], usernames: string[]): void;
  onClose(): void;
}

const fullName = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(" ");
const initials = (u: User) =>
  [u.first_name, u.last_name].filter(Boolean).map((s) => s![0]).join("").toUpperCase() || "?";

/**
 * Экран выбора людей — как при создании чата в Telegram: поиск, галочки,
 * чипы выбранных. Список берётся не из контактов (Telegram их не отдаёт),
 * а из тех, с кем есть общие группы или мероприятия; незнакомого можно
 * найти по точному @username или позвать ссылкой.
 */
export function PeoplePicker({ title, exclude, invite, onDone, onClose }: Props) {
  const { close, cls } = useSheet(onClose);
  const [q, setQ] = useState("");
  const [list, setList] = useState<User[]>([]);
  const [picked, setPicked] = useState<User[]>([]);
  const [invited, setInvited] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    setLoading(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        setList(await api.searchUsers(q));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "не удалось загрузить список");
      } finally {
        setLoading(false);
      }
    }, q ? 250 : 0);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  const visible = useMemo(
    () => list.filter((u) => !exclude?.has(u.id)),
    [list, exclude],
  );
  const pickedIds = useMemo(() => new Set(picked.map((u) => u.id)), [picked]);

  const toggle = (u: User) =>
    setPicked((prev) =>
      prev.some((p) => p.id === u.id) ? prev.filter((p) => p.id !== u.id) : [...prev, u],
    );

  // @username, которого ещё нет в Meeto: приглашение сработает при первом входе
  const handle = q.trim().replace(/^@/, "").toLowerCase();
  const canInviteHandle =
    /^[a-z0-9_]{4,32}$/.test(handle) &&
    !invited.includes(handle) &&
    !visible.some((u) => (u.username ?? "").toLowerCase() === handle);

  const inviteHandle = () => {
    setInvited((prev) => [...prev, handle]);
    setQ("");
  };

  return (
    <>
      <div className={`scrim on ${cls}`} onClick={close} />
      <div className={`wz on ${cls}`}>
        <div className="wz-hd">
          <div className="wz-top">
            <h3>{title}</h3>
            <small>
              {picked.length + invited.length
                ? `выбрано ${picked.length + invited.length}`
                : "никого"}
            </small>
            <button className="ib" onClick={close}>✕</button>
          </div>
          <input
            className="inp"
            style={{ marginTop: 10 }}
            value={q}
            placeholder="Имя или @username"
            onChange={(e) => setQ(e.target.value)}
          />
          {(picked.length > 0 || invited.length > 0) && (
            <div className="picked">
              {picked.map((u) => (
                <button key={u.id} className="pchip" onClick={() => toggle(u)}>
                  {fullName(u)} <i>✕</i>
                </button>
              ))}
              {invited.map((h) => (
                <button
                  key={h}
                  className="pchip wait"
                  onClick={() => setInvited((prev) => prev.filter((x) => x !== h))}
                >
                  @{h} <i>✕</i>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="wz-bd">
          {error && <div className="note warn2">{error}</div>}

          {!error && loading && <div className="empty">Ищем…</div>}

          {!error && !loading && visible.length === 0 && (
            <div className="empty">
              <div>👤</div>
              {q
                ? "Никого не нашли. Позовите по @username — приглашение сработает, когда человек впервые откроет Meeto."
                : "Здесь появятся те, с кем у вас есть общие группы и мероприятия."}
            </div>
          )}

          {visible.map((u) => (
            <div
              key={u.id}
              className={`prow ${pickedIds.has(u.id) ? "on" : ""}`}
              onClick={() => toggle(u)}
            >
              <span className="pav" style={{ backgroundImage: u.photo_url ? `url(${u.photo_url})` : undefined }}>
                {u.photo_url ? "" : initials(u)}
              </span>
              <div className="meta">
                <div className="rt"><em>{fullName(u)}</em></div>
                {u.username && <div className="rs">@{u.username}</div>}
              </div>
              <span className="pcheck">{pickedIds.has(u.id) ? "✓" : ""}</span>
            </div>
          ))}

          {canInviteHandle && (
            <button className="add" style={{ marginTop: 12 }} onClick={inviteHandle}>
              Позвать @{handle} — его пока нет в Meeto
            </button>
          )}

          {invite && (
            <button
              className="add"
              style={{ marginTop: 12 }}
              onClick={() => shareLink(invite.url, invite.text)}
            >
              Позвать ссылкой в Telegram
            </button>
          )}
        </div>

        <div className="wz-ft">
          <button className="back" onClick={close}>Отмена</button>
          <button
            className="go"
            disabled={picked.length + invited.length === 0}
            onClick={() => { onDone(picked, invited); close(); }}
          >
            Добавить{picked.length + invited.length
              ? ` (${picked.length + invited.length})` : ""}
          </button>
        </div>
      </div>
    </>
  );
}
