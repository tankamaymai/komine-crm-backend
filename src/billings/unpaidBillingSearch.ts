export const remainingAmount = (amount: number, paidAmount: number): number => amount - paidAmount;

/** UTC 日付を YYYY-MM-DD にする。約束日の保存と同じ付け方 */
export const dateOnlyString = (value: Date | null | undefined): string | null => {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
};

export const isCollectibleUnpaid = (status: string, remaining: number): boolean =>
  remaining >= 1 && !['paid', 'terminated', 'written_off'].includes(status);

export const matchesYear = (
  useStartYear: number | null,
  useEndYear: number | null,
  billingDateYearJst: number | null,
  year: number
): boolean => {
  if (useStartYear === year || useEndYear === year) return true;
  if (useStartYear == null && useEndYear == null) {
    return billingDateYearJst === year;
  }
  return false;
};

export const jstYear = (d: Date | null): number | null => {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  return y ? Number(y) : null;
};

export const displayYear = (
  useStartYear: number | null,
  useEndYear: number | null,
  billingDateYearJst: number | null
): number | null => useStartYear ?? useEndYear ?? billingDateYearJst;

export const TOO_MANY_UNPAID = '結果が多すぎます。名前を長くしてください';
export const UNPAID_LIMIT = 50;
