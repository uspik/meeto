/** Тонкая обёртка над Telegram WebApp: SDK может отсутствовать в обычном браузере. */
interface TgWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  HapticFeedback?: { impactOccurred(style: string): void };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void };
}

export const tg: TgWebApp | undefined =
  (window as unknown as { Telegram?: { WebApp: TgWebApp } }).Telegram?.WebApp;

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (tg.colorScheme === "dark") document.body.classList.add("dark");
}

export function haptic(style = "light"): void {
  tg?.HapticFeedback?.impactOccurred(style);
}

/** В браузере без Telegram отдаём пустую строку — API ответит 401, это ожидаемо. */
export function initData(): string {
  return tg?.initData ?? "";
}

/** startapp=g_<code> или e_<id> */
export function startParam(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("tgWebAppStartParam");
  if (fromUrl) return fromUrl;
  const raw = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } })
    .Telegram?.WebApp?.initDataUnsafe?.start_param;
  return raw ?? null;
}
