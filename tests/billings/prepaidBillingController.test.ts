import { Request, Response, NextFunction } from 'express';

const mockPrisma = {
  contractPlot: { findFirst: jest.fn() },
  billing: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  payment: { create: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

const recalculateMock = jest.fn();
jest.mock('../../src/plots/services/paymentStatusService', () => ({
  recalculateContractPlotPaymentStatus: (...args: unknown[]) => recalculateMock(...args),
}));

import {
  previewPrepaidBilling,
  createPrepaidBilling,
  deletePrepaidBilling,
} from '../../src/billings/prepaidBillingController';

const PLOT_UUID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_UUID = '33333333-3333-4333-8333-333333333333';

const buildResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const buildRequest = (
  overrides: Partial<{ body: unknown; params: Record<string, string> }> = {}
): Partial<Request> => ({
  body: overrides.body ?? {},
  params: overrides.params ?? {},
});

/** 管理料 1 万円・3 月請求・契約者ありの区画 */
const plotWithFee = (
  billings: Array<{ use_start_year: number | null; use_end_year: number | null }> = []
) => ({
  id: PLOT_UUID,
  managementFee: { management_fee: '10000', billing_month: '3' },
  saleContractRoles: [{ role: 'contractor', customer_id: CUSTOMER_UUID }],
  billings,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(mockPrisma)
  );
});

describe('previewPrepaidBilling', () => {
  it('年ごとの内訳と年額との差額を返す', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(plotWithFee([]));
    const req = buildRequest({
      body: { contractPlotId: PLOT_UUID, receivedAmount: 300000, years: 30, startYear: 2026 },
    });
    const res = buildResponse();

    await previewPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.rows).toHaveLength(30);
    expect(payload.data.rows[0]).toEqual({
      year: 2026,
      amount: 10000,
      duplicated: false,
      needsReview: false,
    });
    expect(payload.data.annualFee).toBe(10000);
    expect(payload.data.difference).toBe(0);
    expect(payload.data.duplicatedYears).toEqual([]);
    expect(payload.data.needsReviewYears).toEqual([]);
  });

  it('年が判定できない既存請求があるとき要確認の年を返す', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(
      plotWithFee([{ use_start_year: null, use_end_year: null }])
    );
    const req = buildRequest({
      body: { contractPlotId: PLOT_UUID, receivedAmount: 20000, years: 2, startYear: 2026 },
    });
    const res = buildResponse();

    await previewPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.needsReviewYears).toEqual([2026, 2027]);
    // 要確認は登録を止めない（重複とは別扱い）
    expect(payload.data.duplicatedYears).toEqual([]);
  });

  it('開始年の指定が無ければ既存請求から推定する', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(
      plotWithFee([{ use_start_year: 2025, use_end_year: 2025 }])
    );
    const req = buildRequest({
      body: { contractPlotId: PLOT_UUID, receivedAmount: 20000, years: 2 },
    });
    const res = buildResponse();

    await previewPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.startYear).toBe(2026);
    expect(payload.data.startYearEstimated).toBe(true);
  });

  it('既存請求と重なる年を返す', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(
      plotWithFee([{ use_start_year: 2027, use_end_year: 2027 }])
    );
    const req = buildRequest({
      body: { contractPlotId: PLOT_UUID, receivedAmount: 20000, years: 2, startYear: 2026 },
    });
    const res = buildResponse();

    await previewPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.duplicatedYears).toEqual([2027]);
  });
});

describe('createPrepaidBilling', () => {
  it('年数分の請求と入金を作り、区画の入金状態を再計算する', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(plotWithFee([]));
    mockPrisma.billing.create.mockImplementation(
      async ({ data }: { data: { amount: number } }) => ({
        id: `billing-${data.amount}`,
      })
    );
    const req = buildRequest({
      body: {
        contractPlotId: PLOT_UUID,
        receivedAmount: 30000,
        years: 3,
        startYear: 2026,
        paymentDate: '2026-03-15',
      },
    });
    const res = buildResponse();

    await createPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    expect(mockPrisma.billing.create).toHaveBeenCalledTimes(3);
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(3);
    expect(recalculateMock).toHaveBeenCalledWith(mockPrisma, PLOT_UUID);

    const firstBilling = mockPrisma.billing.create.mock.calls[0][0].data;
    expect(firstBilling).toMatchObject({
      contract_plot_id: PLOT_UUID,
      customer_id: CUSTOMER_UUID,
      category: 'management_fee',
      amount: 10000,
      use_start_year: 2026,
      use_end_year: 2026,
      billing_years: 1,
      target_month: 3,
      status: 'paid',
      paid_amount: 10000,
    });
    expect(firstBilling.prepaid_batch_id).toEqual(expect.any(String));

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data).toMatchObject({
      billingCount: 3,
      startYear: 2026,
      endYear: 2028,
      totalAmount: 30000,
    });
  });

  it('既存請求と重なる年があれば作成せず 409 を返す', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue(
      plotWithFee([{ use_start_year: 2026, use_end_year: 2026 }])
    );
    const req = buildRequest({
      body: {
        contractPlotId: PLOT_UUID,
        receivedAmount: 20000,
        years: 2,
        startYear: 2026,
        paymentDate: '2026-03-15',
      },
    });
    const res = buildResponse();

    await createPrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    expect(mockPrisma.billing.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.error.code).toBe('DUPLICATED_YEARS');
    expect(payload.error.details.years).toEqual([2026]);
  });

  it('契約者が居ない区画では 400 を返す', async () => {
    mockPrisma.contractPlot.findFirst.mockResolvedValue({
      ...plotWithFee([]),
      saleContractRoles: [],
    });
    const req = buildRequest({
      body: {
        contractPlotId: PLOT_UUID,
        receivedAmount: 10000,
        years: 1,
        startYear: 2026,
        paymentDate: '2026-03-15',
      },
    });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await createPrepaidBilling(req as Request, res as Response, next);

    expect(mockPrisma.billing.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('deletePrepaidBilling', () => {
  it('同じ batch の請求と入金を論理削除して再計算する', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([
      { id: 'b1', contract_plot_id: PLOT_UUID },
      { id: 'b2', contract_plot_id: PLOT_UUID },
    ]);
    mockPrisma.billing.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 2 });
    const req = buildRequest({ params: { batchId: 'batch-1' } });
    const res = buildResponse();

    await deletePrepaidBilling(req as Request, res as Response, jest.fn() as NextFunction);

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { prepaid_batch_id: 'batch-1', deleted_at: null },
      data: { deleted_at: expect.any(Date) },
    });
    expect(mockPrisma.billing.updateMany).toHaveBeenCalledWith({
      where: { prepaid_batch_id: 'batch-1', deleted_at: null },
      data: { deleted_at: expect.any(Date) },
    });
    expect(recalculateMock).toHaveBeenCalledWith(mockPrisma, PLOT_UUID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('該当する請求が無ければ 404', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([]);
    const req = buildRequest({ params: { batchId: 'missing' } });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await deletePrepaidBilling(req as Request, res as Response, next);

    expect(mockPrisma.billing.updateMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
