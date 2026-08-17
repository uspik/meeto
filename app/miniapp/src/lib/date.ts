export const MN = ["января","февраля","марта","апреля","мая","июня","июля","августа",
  "сентября","октября","ноября","декабря"];
export const MNn = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август",
  "Сентябрь","Октябрь","Ноябрь","Декабрь"];
export const WD = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];

export const p2 = (n: number) => String(n).padStart(2, "0");
export const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * Время мероприятия одной строкой.
 *
 * Для многодневного «10:00–18:00» врало бы: показываем, каким днём и во
 * сколько оно кончится.
 */
export function timeRange(startISO: string, endISO?: string | null): string {
  const start = new Date(startISO);
  if (!endISO) return hm(start);
  const end = new Date(endISO);
  if (sameDay(start, end)) return `${hm(start)}–${hm(end)}`;
  return `${hm(start)} → ${end.getDate()} ${MN[end.getMonth()].slice(0, 3)} ${hm(end)}`;
}

export function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 100;
  const k = n % 10;
  if (m > 10 && m < 20) return many;
  if (k === 1) return one;
  if (k > 1 && k < 5) return few;
  return many;
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
