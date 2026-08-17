/**
 * Живые обновления: сервер говорит «вот это изменилось», экран перечитывает.
 *
 * Почему так, а не «сервер прислал новые данные»: по потоку ездит только
 * адрес изменения, а данные каждый экран берёт обычными ручками. Тогда
 * не нужно повторять на клиенте правила видимости и прав, а ответ на
 * гонку «старое пришло позже нового» даёт сам HTTP-запрос — он всегда
 * возвращает текущее состояние.
 *
 * Соединение одно на всё приложение: его держит App, экраны подписываются
 * на разбор уже полученных сообщений.
 */

import { BASE, accessToken, renew } from "./api";

export interface Change {
  /** event — поменялось мероприятие, group — состав или настройки группы.
   *  wake и reconnect — синтетические: связь восстановилась или вкладка
   *  вернулась из фона, и данные надо перечитать целиком. */
  kind: "event" | "group" | "wake" | "reconnect";
  event_id?: string | null;
  group_id?: string | null;
}

type Listener = (change: Change) => void;

const listeners = new Set<Listener>();

/** Подписка экрана на изменения. Возвращает функцию отписки. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(change: Change): void {
  for (const fn of [...listeners]) fn(change);
}

/**
 * Держит соединение с сервером. Вызывается один раз после входа.
 *
 * Само переподключение EventSource нам не подходит: он повторяет запрос
 * с тем же протухшим токеном. Поэтому при обрыве закрываемся сами,
 * обновляем токен и открываемся заново с нарастающей паузой, а после
 * трёх неудач подстраховываемся опросом раз в 20 секунд — на случай,
 * если поток режет прокси или мобильный оператор.
 */
export function connect(): () => void {
  let source: EventSource | null = null;
  let stopped = false;
  let fails = 0;
  let retryTimer = 0;
  let pollTimer = 0;

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => emit({ kind: "wake" }), 20_000);
  };
  const stopPolling = () => {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  };

  const open = () => {
    if (stopped || document.hidden) return;
    const token = accessToken();
    if (!token) { schedule(); return; }

    source = new EventSource(`${BASE}/stream?token=${encodeURIComponent(token)}`);

    source.onopen = () => {
      // пока связи не было, что-то могло измениться — перечитываем всё
      const missed = fails > 0;
      fails = 0;
      stopPolling();
      if (missed) emit({ kind: "reconnect" });
    };

    source.onmessage = (e) => {
      try {
        emit(JSON.parse(e.data) as Change);
      } catch {
        // мусор в потоке не должен ронять подписку
      }
    };

    source.onerror = () => {
      source?.close();
      source = null;
      schedule();
    };
  };

  const schedule = () => {
    if (stopped || retryTimer) return;
    fails += 1;
    if (fails >= 3) startPolling();
    const wait = Math.min(1000 * 2 ** (fails - 1), 30_000);
    retryTimer = window.setTimeout(async () => {
      retryTimer = 0;
      // самая частая причина обрыва — истёкший access-токен
      if (fails > 1) await renew().catch(() => false);
      open();
    }, wait);
  };

  const onVisible = () => {
    if (document.hidden) {
      // в фоне соединение всё равно замораживают — закрываем сами
      source?.close();
      source = null;
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      return;
    }
    emit({ kind: "wake" });
    if (!source) { fails = 0; open(); }
  };

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  open();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
    window.clearTimeout(retryTimer);
    stopPolling();
    source?.close();
    source = null;
  };
}
