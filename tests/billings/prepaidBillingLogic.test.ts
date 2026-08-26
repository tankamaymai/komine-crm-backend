import {
  allocateAmounts,
  buildYearRows,
  estimateStartYear,
  findDuplicatedYears,
} from '../../src/billings/prepaidBillingLogic';

describe('allocateAmounts', () => {
  it('割り切れるときは全年同額になる', () => {
    expect(allocateAmounts(300000, 30)).toEqual(Array(30).fill(10000));
  });

  it('端数は初年度に寄せる', () => {
    const result = allocateAmounts(310000, 30);
    expect(result[0]).toBe(10343);
    expect(result.slice(1)).toEqual(Array(29).fill(10333));
    expect(result.reduce((a, b) => a + b, 0)).toBe(310000);
  });

  it('1年分でも受領額そのままを返す', () => {
    expect(allocateAmounts(12345, 1)).toEqual([12345]);
  });

  it('年数が0以下なら空配列', () => {
    expect(allocateAmounts(10000, 0)).toEqual([]);
  });
});

describe('estimateStartYear', () => {
  it('既存請求の最終年の翌年を返す', () => {
    const existing = [
      { use_start_year: 2024, use_end_year: 2024 },
      { use_start_year: 2025, use_end_year: 2025 },
    ];
    expect(estimateStartYear(existing, 2026)).toEqual({ startYear: 2026, estimated: true });
  });

  it('前納レンジがあれば終了年の翌年を返す', () => {
    const existing = [{ use_start_year: 2022, use_end_year: 2031 }];
    expect(estimateStartYear(existing, 2026)).toEqual({ startYear: 2032, estimated: true });
  });

  it('既存請求が無ければ当年度を返す', () => {
    expect(estimateStartYear([], 2026)).toEqual({ startYear: 2026, estimated: true });
  });

  it('年が判定できない請求が混ざるときは推定しない', () => {
    const existing = [{ use_start_year: null, use_end_year: null }];
    expect(estimateStartYear(existing, 2026)).toEqual({ startYear: 2026, estimated: false });
  });
});

describe('buildYearRows', () => {
  it('開始年から昇順に年と金額を並べる', () => {
    const rows = buildYearRows(2026, [10000, 10000, 10000], []);
    expect(rows).toEqual([
      { year: 2026, amount: 10000, duplicated: false },
      { year: 2027, amount: 10000, duplicated: false },
      { year: 2028, amount: 10000, duplicated: false },
    ]);
  });

  it('既存請求がカバーする年に重複の印を付ける', () => {
    const existing = [{ use_start_year: 2027, use_end_year: 2027 }];
    const rows = buildYearRows(2026, [10000, 10000], existing);
    expect(rows.map((r) => r.duplicated)).toEqual([false, true]);
  });
});

describe('findDuplicatedYears', () => {
  it('重複した年だけを返す', () => {
    const rows = [
      { year: 2026, amount: 10000, duplicated: false },
      { year: 2027, amount: 10000, duplicated: true },
    ];
    expect(findDuplicatedYears(rows)).toEqual([2027]);
  });

  it('重複が無ければ空配列', () => {
    expect(findDuplicatedYears([{ year: 2026, amount: 10000, duplicated: false }])).toEqual([]);
  });
});
