/**
 * 請求書（護持費のお知らせ）一括印刷の対象抽出ロジック
 *
 * 対象判定は DB 非依存の純関数に切り出してある。3月の繁忙期に数百通を
 * 一括送付する運用のため、誤って対象に入る／落ちるのは実害が大きい。
 */

import {
  parseYearMonth,
  computeNextBillingYear,
  formatNextNoticeDate,
  selectBulkInvoiceTargets,
  selectBillableFees,
  attachContractDetails,
  type BulkInvoiceContractDetail,
  type BulkInvoiceSourceRow,
} from '../../src/documents/bulkInvoiceLogic';

const row = (overrides: Partial<BulkInvoiceSourceRow> = {}): BulkInvoiceSourceRow => ({
  contractPlotId: 'plot-1',
  billingYears: '10',
  billingMonth: '3',
  lastBillingMonth: '201703',
  managementFee: '82800',
  customerId: 'cust-1',
  customerName: '山田 太郎',
  customerNameKana: 'ヤマダ タロウ',
  areaName: 'A区',
  plotNumber: '1-2-3',
  displayNumber: 'A-1-2-3',
  ...overrides,
});

describe('parseYearMonth', () => {
  it('YYYYMM を年月に分解する', () => {
    expect(parseYearMonth('202603')).toEqual({ year: 2026, month: 3 });
    expect(parseYearMonth('199112')).toEqual({ year: 1991, month: 12 });
  });

  it('桁数・月が不正なものは null', () => {
    expect(parseYearMonth('2026')).toBeNull();
    expect(parseYearMonth('20260')).toBeNull();
    expect(parseYearMonth('202613')).toBeNull();
    expect(parseYearMonth('202600')).toBeNull();
    expect(parseYearMonth('20260a')).toBeNull();
    expect(parseYearMonth('')).toBeNull();
    expect(parseYearMonth(null)).toBeNull();
  });
});

describe('computeNextBillingYear', () => {
  it('最終請求月の年に請求年数を足した年が次回の請求年', () => {
    expect(computeNextBillingYear('202103', 5)).toBe(2026);
    expect(computeNextBillingYear('201703', 10)).toBe(2027);
  });

  it('最終請求月が不正なら null', () => {
    expect(computeNextBillingYear(null, 10)).toBeNull();
    expect(computeNextBillingYear('0', 10)).toBeNull();
  });
});

describe('formatNextNoticeDate', () => {
  it('和文の年月表記にする', () => {
    expect(formatNextNoticeDate(2037, 3)).toBe('2037年3月');
  });

  it('月が不明なときは年だけ表示する', () => {
    expect(formatNextNoticeDate(2037, null)).toBe('2037年');
  });
});

describe('selectBulkInvoiceTargets', () => {
  const baseOptions = { year: 2027, month: 3, billingYears: [5, 10], includeOverdue: false };

  it('最終請求月 + 請求年数 が対象年に一致するものを抽出する', () => {
    const targets = selectBulkInvoiceTargets(
      [
        row({ contractPlotId: 'a', billingYears: '10', lastBillingMonth: '201703' }), // 2027 → 対象
        row({ contractPlotId: 'b', billingYears: '5', lastBillingMonth: '202203' }), // 2027 → 対象
        row({ contractPlotId: 'c', billingYears: '10', lastBillingMonth: '202103' }), // 2031 → 対象外
      ],
      baseOptions
    );

    expect(targets.map((t) => t.contractPlotId)).toEqual(['a', 'b']);
    expect(targets[0]?.targetYear).toBe(2027);
    expect(targets[0]?.overdue).toBe(false);
  });

  it('請求年数が指定外（年払い・永代）のものは除外する', () => {
    const targets = selectBulkInvoiceTargets(
      [
        row({ contractPlotId: 'annual', billingYears: '1', lastBillingMonth: '202603' }),
        row({ contractPlotId: 'perpetual', billingYears: '0', lastBillingMonth: '202603' }),
        row({ contractPlotId: 'blank', billingYears: null }),
        row({ contractPlotId: 'noisy', billingYears: '毎年' }),
      ],
      baseOptions
    );

    expect(targets).toEqual([]);
  });

  it('includeOverdue で対象年より前の請求漏れも拾い、overdue を立てる', () => {
    const rows = [
      row({ contractPlotId: 'due', billingYears: '10', lastBillingMonth: '201703' }), // 2027
      row({ contractPlotId: 'missed', billingYears: '10', lastBillingMonth: '201203' }), // 2022
    ];

    expect(selectBulkInvoiceTargets(rows, baseOptions).map((t) => t.contractPlotId)).toEqual([
      'due',
    ]);

    const withOverdue = selectBulkInvoiceTargets(rows, { ...baseOptions, includeOverdue: true });
    expect(withOverdue.map((t) => t.contractPlotId).sort()).toEqual(['due', 'missed']);

    const missed = withOverdue.find((t) => t.contractPlotId === 'missed');
    expect(missed?.overdue).toBe(true);
    // 請求されるべきだった年を出し、対象年で上書きしない
    expect(missed?.targetYear).toBe(2022);
  });

  it('対象年より後（前受け済み）は includeOverdue でも抽出しない', () => {
    const targets = selectBulkInvoiceTargets(
      [row({ billingYears: '10', lastBillingMonth: '202603' })], // 2036
      { ...baseOptions, includeOverdue: true }
    );

    expect(targets).toEqual([]);
  });

  it('請求月を指定すると、その月の契約だけを対象にする', () => {
    const rows = [
      row({ contractPlotId: 'march', billingMonth: '3', lastBillingMonth: '201703' }),
      row({ contractPlotId: 'october', billingMonth: '10', lastBillingMonth: '201703' }),
      row({ contractPlotId: 'unset', billingMonth: '0', lastBillingMonth: '201703' }),
    ];

    expect(selectBulkInvoiceTargets(rows, baseOptions).map((t) => t.contractPlotId)).toEqual([
      'march',
    ]);

    // 月を指定しなければ請求月に関わらず全件
    const all = selectBulkInvoiceTargets(rows, { ...baseOptions, month: null });
    expect(all.map((t) => t.contractPlotId).sort()).toEqual(['march', 'october', 'unset']);
  });

  it('金額が読めない・0円のものは請求書にならないため除外する', () => {
    const targets = selectBulkInvoiceTargets(
      [
        row({ contractPlotId: 'zero', managementFee: '0' }),
        row({ contractPlotId: 'null', managementFee: null }),
        row({ contractPlotId: 'noisy', managementFee: '要確認' }),
      ],
      baseOptions
    );

    expect(targets).toEqual([]);
  });

  it('最終請求月が無いものは次回請求年を決められないため除外する', () => {
    const targets = selectBulkInvoiceTargets([row({ lastBillingMonth: null })], baseOptions);

    expect(targets).toEqual([]);
  });

  it('請求書に載せる項目を組み立てる', () => {
    const [target] = selectBulkInvoiceTargets(
      [row({ billingYears: '10', lastBillingMonth: '201703', managementFee: '82800' })],
      baseOptions
    );

    expect(target).toMatchObject({
      customerName: '山田 太郎',
      billingYears: 10,
      billingMonth: 3,
      lastBillingMonth: '2017-03',
      targetYear: 2027,
      amount: 82800,
      // 今回 2027年3月にお預かりし、次は 10 年後
      nextNoticeDate: '2037年3月',
    });
  });

  it('契約者名が無いものは宛名を出せないため除外する', () => {
    const targets = selectBulkInvoiceTargets(
      [row({ customerName: null }), row({ contractPlotId: 'blank', customerName: '  ' })],
      baseOptions
    );

    expect(targets).toEqual([]);
  });

  it('封入作業のため区画順に並べる', () => {
    const targets = selectBulkInvoiceTargets(
      [
        row({ contractPlotId: 'c', areaName: 'B区', plotNumber: '1' }),
        row({ contractPlotId: 'a', areaName: 'A区', plotNumber: '2' }),
        row({ contractPlotId: 'b', areaName: 'A区', plotNumber: '10' }),
      ],
      baseOptions
    );

    expect(targets.map((t) => t.contractPlotId)).toEqual(['a', 'b', 'c']);
  });

  it('移行データの plot_number ではなく、台帳と同じ区画番号の順に並べる', () => {
    const targets = selectBulkInvoiceTargets(
      [
        row({ contractPlotId: 'c', plotNumber: 'legacy-671', displayNumber: '10' }),
        row({ contractPlotId: 'a', plotNumber: 'legacy-680', displayNumber: '2' }),
        row({ contractPlotId: 'b', plotNumber: 'legacy-672', displayNumber: '3' }),
      ],
      baseOptions
    );

    expect(targets.map((t) => t.displayNumber)).toEqual(['2', '3', '10']);
  });
});

/**
 * 対象判定（management_fees だけで完結）と宛名の合流を 2 段階に分けている。
 * 全契約分の宛名を引かずに済ませるための分割なので、合流側で件数が変わらないことを固定する。
 */
describe('selectBillableFees / attachContractDetails', () => {
  const baseOptions = { year: 2027, month: 3, billingYears: [5, 10], includeOverdue: false };

  const detail = (
    overrides: Partial<BulkInvoiceContractDetail> = {}
  ): BulkInvoiceContractDetail => ({
    contractPlotId: 'plot-1',
    customerId: 'cust-1',
    customerName: '山田 太郎',
    customerNameKana: 'ヤマダ タロウ',
    areaName: 'A区',
    plotNumber: '1-2-3',
    displayNumber: 'A-1-2-3',
    ...overrides,
  });

  it('宛名を引く前に対象を絞れる（合流するのは請求年が来た区画だけ）', () => {
    const fees = selectBillableFees(
      [
        row({ contractPlotId: 'due', billingYears: '10', lastBillingMonth: '201703' }),
        row({ contractPlotId: 'later', billingYears: '10', lastBillingMonth: '202103' }),
      ],
      baseOptions
    );

    expect(fees.map((f) => f.contractPlotId)).toEqual(['due']);
  });

  it('宛名が見つからない区画は落とす', () => {
    const fees = selectBillableFees([row({ contractPlotId: 'missing' })], baseOptions);

    expect(attachContractDetails(fees, [])).toEqual([]);
    expect(
      attachContractDetails(fees, [detail({ contractPlotId: 'missing', customerName: null })])
    ).toEqual([]);
  });

  it('一括で引いた宛名を contractPlotId で突き合わせる', () => {
    const fees = selectBillableFees(
      [row({ contractPlotId: 'a' }), row({ contractPlotId: 'b' })],
      baseOptions
    );

    const targets = attachContractDetails(fees, [
      detail({ contractPlotId: 'b', customerName: '佐藤 花子', areaName: 'B区' }),
      detail({ contractPlotId: 'a', customerName: '山田 太郎', areaName: 'A区' }),
    ]);

    expect(targets.map((t) => [t.contractPlotId, t.customerName])).toEqual([
      ['a', '山田 太郎'],
      ['b', '佐藤 花子'],
    ]);
  });
});
