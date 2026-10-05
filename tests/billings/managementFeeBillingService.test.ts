// payment_status 再計算はここでは検証対象外のため no-op に差し替える
jest.mock('../../src/plots/services/paymentStatusService', () => ({
  recalculateContractPlotPaymentStatus: jest.fn().mockResolvedValue('unpaid'),
}));

import {
  generateManagementFeeBillings,
  existingBillingCoverage,
  parseFeeAmount,
  parseBillingMonth,
  parseBillingYears,
  DEFAULT_BILLING_MONTH,
} from '../../src/billings/managementFeeBillingService';

interface MockContract {
  id: string;
  managementFee: {
    management_fee: string | null;
    billing_month: string | null;
    billing_years: string | null;
  } | null;
  saleContractRoles: Array<{ role: string; customer_id: string }>;
  billings: Array<{ use_start_year: number | null; use_end_year: number | null }>;
}

const buildContract = (over: Partial<MockContract> = {}): MockContract => ({
  id: 'cp1',
  managementFee: { management_fee: '5000', billing_month: '3', billing_years: '1' },
  saleContractRoles: [{ role: 'contractor', customer_id: 'c1' }],
  billings: [],
  ...over,
});

function buildPrisma(contracts: MockContract[]) {
  const billingCreate = jest.fn().mockResolvedValue({ id: 'b-new' });
  const prisma = {
    contractPlot: { findMany: jest.fn().mockResolvedValue(contracts) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ billing: { create: billingCreate } })
    ),
  };
  return { prisma: prisma as never, billingCreate };
}

describe('parse helpers (#196)', () => {
  it('parseFeeAmount は数字以外を除去し 0/不能は null', () => {
    expect(parseFeeAmount('5000')).toBe(5000);
    expect(parseFeeAmount('¥5,000')).toBe(5000);
    expect(parseFeeAmount('0')).toBeNull();
    expect(parseFeeAmount('')).toBeNull();
    expect(parseFeeAmount(null)).toBeNull();
  });
  it('parseBillingMonth は 1..12 以外を既定(3)に', () => {
    expect(parseBillingMonth('3')).toBe(3);
    expect(parseBillingMonth('10')).toBe(10);
    expect(parseBillingMonth('0')).toBe(DEFAULT_BILLING_MONTH);
    expect(parseBillingMonth('13')).toBe(DEFAULT_BILLING_MONTH);
    expect(parseBillingMonth(null)).toBe(DEFAULT_BILLING_MONTH);
  });
  it('parseBillingYears は未設定/0 を 1(年次) に', () => {
    expect(parseBillingYears('1')).toBe(1);
    expect(parseBillingYears('10')).toBe(10);
    expect(parseBillingYears('0')).toBe(1);
    expect(parseBillingYears(null)).toBe(1);
  });
});

describe('existingBillingCoverage (#391)', () => {
  it('use_start_year 等値は covered', () => {
    expect(existingBillingCoverage([{ use_start_year: 2026, use_end_year: 2026 }], 2026)).toBe(
      'covered'
    );
  });
  it('前納レンジに含まれれば covered', () => {
    expect(existingBillingCoverage([{ use_start_year: 2022, use_end_year: 2026 }], 2026)).toBe(
      'covered'
    );
    expect(existingBillingCoverage([{ use_start_year: 2022, use_end_year: 2026 }], 2024)).toBe(
      'covered'
    );
  });
  it('use_end_year が NULL なら開始年単年として扱う', () => {
    expect(existingBillingCoverage([{ use_start_year: 2026, use_end_year: null }], 2026)).toBe(
      'covered'
    );
    expect(existingBillingCoverage([{ use_start_year: 2025, use_end_year: null }], 2026)).toBe(
      'none'
    );
  });
  it('use_start_year NULL のみは needs_review', () => {
    expect(existingBillingCoverage([{ use_start_year: null, use_end_year: null }], 2026)).toBe(
      'needs_review'
    );
  });
  it('カバーする請求があれば NULL 請求が混在しても covered を優先', () => {
    expect(
      existingBillingCoverage(
        [
          { use_start_year: null, use_end_year: null },
          { use_start_year: 2022, use_end_year: 2026 },
        ],
        2026
      )
    ).toBe('covered');
  });
  it('該当もNULLも無ければ none', () => {
    expect(existingBillingCoverage([{ use_start_year: 2020, use_end_year: 2024 }], 2026)).toBe(
      'none'
    );
    expect(existingBillingCoverage([], 2026)).toBe('none');
  });
});

describe('generateManagementFeeBillings (#196)', () => {
  it('対象契約に対象年度の管理料Billingを生成する', async () => {
    const { prisma, billingCreate } = buildPrisma([buildContract()]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(1);
    expect(billingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contract_plot_id: 'cp1',
          customer_id: 'c1',
          category: 'management_fee',
          amount: 5000,
          use_start_year: 2026,
          target_month: 3,
        }),
      })
    );
  });

  it('指定した請求月の人だけ作る', async () => {
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ id: 'oct', managementFee: { management_fee: '4000', billing_month: '10', billing_years: '1' } }),
      buildContract({ id: 'mar' }),
    ]);
    const r = await generateManagementFeeBillings(prisma, {
      targetYear: 2026,
      month: 10,
      apply: true,
    });

    expect(r.created).toBe(1);
    expect(r.skippedOtherMonth).toBe(1);
    expect(billingCreate).toHaveBeenCalledTimes(1);
    expect(billingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contract_plot_id: 'oct', target_month: 10 }),
      })
    );
  });

  it('対象年度の管理料Billingが既にあれば冪等スキップ', async () => {
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ billings: [{ use_start_year: 2026, use_end_year: 2026 }] }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(billingCreate).not.toHaveBeenCalled();
  });

  it('前納レンジ(use_start_year=2022, use_end_year=2026)が対象年を含めば二重請求しない(#391)', async () => {
    // レガシー移行の5/10年前納請求。targetYear=2026 は等値一致しないが、レンジに含まれる。
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ billings: [{ use_start_year: 2022, use_end_year: 2026 }] }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(billingCreate).not.toHaveBeenCalled();
  });

  it('既存請求の use_start_year が NULL の区画は自動生成せず needsReview に回す(#391)', async () => {
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ billings: [{ use_start_year: null, use_end_year: null }] }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.needsReview).toBe(1);
    expect(r.needsReviewPlotIds).toEqual(['cp1']);
    expect(billingCreate).not.toHaveBeenCalled();
  });

  it('前納レンジが対象年より過去で終わっていれば新規生成する(#391)', async () => {
    // 2020〜2024 の前納が終わり、2026 は未請求 → 生成対象。
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ billings: [{ use_start_year: 2020, use_end_year: 2024 }] }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(1);
    expect(r.skippedExisting).toBe(0);
    expect(billingCreate).toHaveBeenCalledTimes(1);
  });

  it('複数年一括前納(billing_years>1)は既定でスキップする', async () => {
    const { prisma } = buildPrisma([
      buildContract({
        managementFee: { management_fee: '5000', billing_month: '3', billing_years: '10' },
      }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.skippedPrepaid).toBe(1);
  });

  it('includePrepaid=true なら前納契約も対象にする', async () => {
    const { prisma } = buildPrisma([
      buildContract({
        managementFee: { management_fee: '5000', billing_month: '3', billing_years: '10' },
      }),
    ]);
    const r = await generateManagementFeeBillings(prisma, {
      targetYear: 2026,
      apply: true,
      includePrepaid: true,
    });

    expect(r.created).toBe(1);
    expect(r.skippedPrepaid).toBe(0);
  });

  it('金額が解釈不能ならスキップ', async () => {
    const { prisma } = buildPrisma([
      buildContract({
        managementFee: { management_fee: null, billing_month: '3', billing_years: '1' },
      }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.skippedNoAmount).toBe(1);
  });

  it('請求先顧客(契約者/申込者)が無ければスキップ', async () => {
    const { prisma } = buildPrisma([buildContract({ saleContractRoles: [] })]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(0);
    expect(r.skippedNoCustomer).toBe(1);
  });

  it('dry-run(apply=false)では作成せず件数のみ算出', async () => {
    const { prisma, billingCreate } = buildPrisma([buildContract()]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: false });

    expect(r.created).toBe(1);
    expect(billingCreate).not.toHaveBeenCalled();
  });

  it('契約者が無くても申込者を請求先に使う', async () => {
    const { prisma, billingCreate } = buildPrisma([
      buildContract({ saleContractRoles: [{ role: 'applicant', customer_id: 'c-app' }] }),
    ]);
    const r = await generateManagementFeeBillings(prisma, { targetYear: 2026, apply: true });

    expect(r.created).toBe(1);
    expect(billingCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ customer_id: 'c-app' }) })
    );
  });
});
