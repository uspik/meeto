/** Тонкая обёртка над Telegram WebApp: SDK может отсутствовать в обычном браузере. */

interface Inset { top: number; bottom: number; left: number; right: number }

interface TgWebApp {
  version: string;
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  isFullscreen?: boolean;
  isVerticalSwipesEnabled?: boolean;
  safeAreaInset?: Inset;
  contentSafeAreaInset?: Inset;

  ready(): void;
  expand(): void;
  onEvent?(event: string, handler: () => void): void;

  // Bot API 7.7+
  disableVerticalSwipes?(): void;
  // Bot API 8.0+
  requestFullscreen?(): void;
  exitFullscreen?(): void;

  HapticFeedback?: { impactOccurred(style: string): void };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void };
}

export const tg: TgWebApp | undefined =
  (window as unknown as { Telegram?: { WebApp: TgWebApp } }).Telegram?.WebApp;

/** Версия клиента не ниже требуемой: методы появились не сразу. */
function atLeast(want: string): boolean {
  const have = (tg?.version ?? "0").split(".").map(Number);
  const need = want.split(".").map(Number);
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  }
  return true;
}

/**
 * Отступы под системные элементы.
 *
 * В полноэкранном режиме шапка Telegram с крестиком и меню лежит поверх
 * приложения, поэтому свой заголовок нужно опустить ниже — иначе кнопки
 * перекрывают вкладки.
 */
function applyInsets(): void {
  if (!tg) return;
  const safe = tg.safeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const content = tg.contentSafeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const root = document.documentElement.style;
  root.setProperty("--safe-top", `${safe.top + content.top}px`);
  root.setProperty("--safe-bottom", `${safe.bottom + content.bottom}px`);
  root.setProperty("--safe-left", `${safe.left}px`);
  root.setProperty("--safe-right", `${safe.right}px`);
  document.body.classList.toggle("tg-fullscreen", Boolean(tg.isFullscreen));
}

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (tg.colorScheme === "dark") document.body.classList.add("dark");

  // Свайп вниз больше не сворачивает приложение: при прокрутке календаря
  // жест то и дело закрывал Meeto вместо прокрутки списка.
  if (atLeast("7.7")) tg.disableVerticalSwipes?.();

  // Полный экран — с 8.0. На старых клиентах остаётся обычная шторка.
  if (atLeast("8.0")) tg.requestFullscreen?.();

  applyInsets();
  for (const event of ["fullscreenChanged", "safeAreaChanged", "contentSafeAreaChanged",
    "viewportChanged", "themeChanged"]) {
    tg.onEvent?.(event, applyInsets);
  }
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
  const raw = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } };
  }).Telegram?.WebApp?.initDataUnsafe?.start_param;
  return raw ?? null;
}
