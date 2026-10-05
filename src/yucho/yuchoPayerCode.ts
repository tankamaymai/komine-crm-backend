/**
 * 支払人コード（20桁）の安定採番。
 * 前半10桁=顧客、後半10桁=区画。一度決めたら変えない（IDから決定的に作る）。
 */

const ALL_NINES = '9999999999';

const tenDigitsFromId = (id: string): string => {
  const digits = id.replace(/\D/g, '');
  if (digits.length >= 10) {
    const slice = digits.slice(-10);
    if (slice !== ALL_NINES && Number(slice) > 0) return slice;
  }
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const n = String(hash >>> 0)
    .padStart(10, '0')
    .slice(-10);
  if (n === ALL_NINES || Number(n) === 0) return '0000000001';
  return n;
};

export const derivePayerCode = (
  customerId: string | null | undefined,
  contractPlotId: string
): string | null => {
  if (!customerId) return null;
  return `${tenDigitsFromId(customerId)}${tenDigitsFromId(contractPlotId)}`;
};

export const splitPayerCode = (
  code: string | null | undefined
): { payerCode1: string; payerCode2: string } | null => {
  if (!code || code.length !== 20 || !/^\d{20}$/.test(code)) return null;
  return { payerCode1: code.slice(0, 10), payerCode2: code.slice(10) };
};
