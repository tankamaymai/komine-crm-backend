/**
 * 合祀の年になった人を、一斉に解約する日。
 * お盆は 8月13日、10月は 10月1日。年はその区画の合祀年のまま、日だけを揃える。
 */

export type ReleaseTiming = 'obon' | 'october';

export const DEFAULT_RELEASE_TIMING: ReleaseTiming = 'october';

export function isReleaseTiming(value: unknown): value is ReleaseTiming {
  return value === 'obon' || value === 'october';
}

/** 月は 1〜12 */
export function releaseMonthDay(timing: ReleaseTiming): { month: number; day: number } {
  if (timing === 'obon') return { month: 8, day: 13 };
  return { month: 10, day: 1 };
}

/** その年の解約日（UTC 00:00。@db.Date 用） */
export function releaseDateInYear(year: number, timing: ReleaseTiming): Date {
  const { month, day } = releaseMonthDay(timing);
  return new Date(Date.UTC(year, month - 1, day));
}

/** 日付の年を残して、解約日の月日に揃える */
export function shiftDateToReleaseTiming(date: Date, timing: ReleaseTiming): Date {
  return releaseDateInYear(date.getUTCFullYear(), timing);
}

/**
 * 今日が、今年の解約日以降か。
 * 今年より前の合祀は、ここでは自動解約しない（確認してからにする）。
 */
export function isReleaseDayReached(today: Date, timing: ReleaseTiming): boolean {
  const release = releaseDateInYear(today.getUTCFullYear(), timing);
  return today.getTime() >= release.getTime();
}
