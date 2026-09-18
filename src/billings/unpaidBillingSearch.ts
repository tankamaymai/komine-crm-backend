export const remainingAmount = (amount: number, paidAmount: number): number => amount - paidAmount;

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
