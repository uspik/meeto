import { tg } from "./tg";

/** Родной шеринг Telegram: выбрать чат и отправить ссылку-приглашение. */
export function shareLink(url: string, text: string): void {
  const target = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const api = tg as unknown as { openTelegramLink?(u: string): void } | undefined;
  if (api?.openTelegramLink) api.openTelegramLink(target);
  else window.open(target, "_blank");
}
