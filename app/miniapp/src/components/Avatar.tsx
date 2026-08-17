import { useEffect, useState } from "react";

interface Person {
  first_name: string;
  last_name?: string | null;
  photo_url?: string | null;
}

/**
 * Аватарка с буквами под картинкой.
 *
 * Раньше фото ставилось фоном, а буквы рисовались только при пустом
 * `photo_url` — и если ссылка не открывалась, оставался пустой кружок.
 * А не открывается она регулярно: Telegram отдаёт временные адреса,
 * которые протухают, и людям, заведённым из чата, фото не достаётся вовсе.
 * Теперь буквы под картинкой всегда, а картинка — отдельным <img>,
 * который при ошибке просто исчезает.
 */
export function Avatar({
  user, size, className = "", dim = false,
}: {
  user: Person;
  /** переопределить размер; по умолчанию берётся из класса */
  size?: number;
  className?: string;
  /** приглушить — для тех, кого убрали */
  dim?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const url = user.photo_url || null;

  // сменился человек — снова пробуем загрузить его фото
  useEffect(() => { setBroken(false); }, [url]);

  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const initials = name.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <span
      className={`pav ${className}`}
      style={{
        width: size, height: size, fontSize: size ? size * 0.38 : undefined,
        opacity: dim ? 0.55 : undefined,
      }}
    >
      {initials}
      {url && !broken && (
        <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
      )}
    </span>
  );
}
