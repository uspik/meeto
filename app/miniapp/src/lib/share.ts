import { tg } from "./tg";

/** Родной шеринг Telegram: выбрать чат и отправить ссылку-приглашение. */
export function shareLink(url: string, text: string): void {
  const target = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const api = tg as unknown as { openTelegramLink?(u: string): void } | undefined;
  if (api?.openTelegramLink) api.openTelegramLink(target);
  else window.open(target, "_blank");
}


/** Копирование в буфер — в вебвью Telegram ссылку нельзя ни выделить, ни нажать. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}
