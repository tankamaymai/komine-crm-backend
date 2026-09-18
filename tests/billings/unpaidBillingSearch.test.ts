import {
  remainingAmount,
  isCollectibleUnpaid,
  matchesYear,
  displayYear,
} from '../../src/billings/unpaidBillingSearch';

describe('remainingAmount', () => {
  it('returns amount minus paid', () => {
    expect(remainingAmount(10000, 3000)).toBe(7000);
  });
});

describe('isCollectibleUnpaid', () => {
  it('accepts billed with remaining', () => {
    expect(isCollectibleUnpaid('billed', 10000)).toBe(true);
  });
  it('rejects paid even if remaining says otherwise', () => {
    expect(isCollectibleUnpaid('paid', 10000)).toBe(false);
  });
  it('rejects remaining 0', () => {
    expect(isCollectibleUnpaid('billed', 0)).toBe(false);
  });
});

describe('matchesYear', () => {
  it('matches use_start_year', () => {
    expect(matchesYear(2026, 2026, 2025, 2026)).toBe(true);
  });
  it('uses billing_date year only when both use years are null', () => {
    expect(matchesYear(null, null, 2026, 2026)).toBe(true);
    expect(matchesYear(2025, 2025, 2026, 2026)).toBe(false);
  });
});

describe('displayYear', () => {
  it('prefers use_start_year', () => {
    expect(displayYear(2026, 2027, 2025)).toBe(2026);
  });
});
