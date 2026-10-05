/**
 * ゆうちょの営業日判定。
 * 土日・国民の祝日・振替休日・国民の休日・12/31〜1/3 は払込指定日にできない。
 * 春分・秋分は 1980〜2099 年の近似式。臨時の祝日（法改正）は反映されない。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDate = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

const keyOf = (date: Date): string => `${date.getUTCMonth() + 1}-${date.getUTCDate()}`;

const nthMonday = (year: number, month: number, n: number): number => {
  const firstDow = utcDate(year, month, 1).getUTCDay();
  const firstMonday = 1 + ((8 - firstDow) % 7);
  return firstMonday + (n - 1) * 7;
};

const equinoxDay = (year: number, base: number): number =>
  Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));

const holidayCache = new Map<number, Set<string>>();

/** その年の休日（祝日・振替休日・国民の休日）を "月-日" の集合で返す。 */
export const getJapaneseHolidays = (year: number): Set<string> => {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const base = new Set<string>([
    '1-1',
    `1-${nthMonday(year, 1, 2)}`,
    '2-11',
    '2-23',
    `3-${equinoxDay(year, 20.8431)}`,
    '4-29',
    '5-3',
    '5-4',
    '5-5',
    `7-${nthMonday(year, 7, 3)}`,
    '8-11',
    `9-${nthMonday(year, 9, 3)}`,
    `9-${equinoxDay(year, 23.2488)}`,
    `10-${nthMonday(year, 10, 2)}`,
    '11-3',
    '11-23',
  ]);
  const result = new Set(base);

  for (let date = utcDate(year, 1, 2); date.getUTCFullYear() === year; date = addDays(date, 1)) {
    if (base.has(keyOf(date)) || date.getUTCDay() === 0) continue;
    if (base.has(keyOf(addDays(date, -1))) && base.has(keyOf(addDays(date, 1)))) {
      result.add(keyOf(date));
    }
  }

  for (const key of base) {
    const [month, day] = key.split('-').map(Number) as [number, number];
    let date = utcDate(year, month, day);
    if (date.getUTCDay() !== 0) continue;
    do {
      date = addDays(date, 1);
    } while (result.has(keyOf(date)));
    result.add(keyOf(date));
  }

  holidayCache.set(year, result);
  return result;
};

export const isExistingDate = (year: number, month: number, day: number): boolean => {
  const date = utcDate(year, month, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export type YuchoClosedReason = 'weekend' | 'holiday' | 'year_end';

/** 休みならその理由、営業日なら null。存在しない日付は呼び出し側で先に弾く。 */
export const getYuchoClosedReason = (
  year: number,
  month: number,
  day: number
): YuchoClosedReason | null => {
  const dow = utcDate(year, month, day).getUTCDay();
  if (dow === 0 || dow === 6) return 'weekend';
  if ((month === 12 && day === 31) || (month === 1 && day <= 3)) return 'year_end';
  if (getJapaneseHolidays(year).has(`${month}-${day}`)) return 'holiday';
  return null;
};

export const CLOSED_REASON_LABEL: Record<YuchoClosedReason, string> = {
  weekend: '土日',
  holiday: '祝日',
  year_end: '年末年始',
};
