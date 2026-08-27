import { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        is_active: boolean;
        supabase_uid: string;
      };
    }
  }
}

const mockPrisma = {
  billing: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    updateMany: jest.fn(),
  },
  customer: {
    findFirst: jest.fn(),
  },
  contractPlot: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

// updateBilling から呼ばれる再集計（#211）。ロジック自体は billingService.test.ts で検証。
const recalculateBillingPaymentsMock = jest.fn();
jest.mock('../../src/billings/billingService', () => ({
  recalculateBillingPayments: (...args: unknown[]) => recalculateBillingPaymentsMock(...args),
}));

import {
  getBillings,
  getBillingsSummary,
  getBillingById,
  createBilling,
  updateBilling,
  deleteBilling,
} from '../../src/billings/billingController';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const PLOT_UUID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_UUID = '33333333-3333-4333-8333-333333333333';

const buildResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const buildRequest = (
  overrides: Partial<{
    body: unknown;
    query: Record<string, string>;
    params: Record<string, string>;
  }> = {}
): Partial<Request> => ({
  body: overrides.body ?? {},
  query: overrides.query ?? {},
  params: overrides.params ?? {},
  user: {
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    is_active: true,
    supabase_uid: 'admin-uid',
  },
});

const buildBillingRow = (overrides: Record<string, unknown> = {}) => ({
  id: VALID_UUID,
  contract_plot_id: PLOT_UUID,
  customer_id: CUSTOMER_UUID,
  category: 'management_fee',
  amount: 12000,
  use_start_year: 2026,
  use_end_year: 2026,
  target_month: 4,
  billing_years: 1,
  contract_date: new Date('2024-01-15'),
  billing_date: new Date('2026-04-01'),
  paid_amount: 0,
  last_payment_date: null,
  terminated: false,
  terminated_date: null,
  status: 'billed',
  application_type: null,
  billing_type: null,
  notes: null,
  prepaid_batch_id: null,
  legacy_seikyu_cd: null,
  customer: { id: CUSTOMER_UUID, name: '山田太郎', name_kana: 'ヤマダタロウ' },
  contractPlot: {
    id: PLOT_UUID,
    physicalPlot: { id: 'pp-1', plot_number: 'A-1', area_name: '第1期' },
  },
  created_at: new Date('2026-04-01T00:00:00Z'),
  updated_at: new Date('2026-04-01T00:00:00Z'),
  ...overrides,
});

describe('billingController', () => {
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
    next = jest.fn();
    // 既定: $transaction はそのまま mockPrisma をトランザクションクライアントとして渡す
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => unknown) =>
      cb(mockPrisma)
    );
    // payment_status 再計算（recalculateContractPlotPaymentStatus）が読む請求一覧の既定値
    mockPrisma.billing.findMany.mockResolvedValue([]);
  });

  describe('getBillings', () => {
    it('returns paginated list with formatted items', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([buildBillingRow()]);
      mockPrisma.billing.count.mockResolvedValue(1);

      const req = buildRequest({ query: { page: '1', limit: '10' } });
      await getBillings(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0]).toMatchObject({
        id: VALID_UUID,
        contractPlotId: PLOT_UUID,
        customerId: CUSTOMER_UUID,
        category: 'management_fee',
        amount: 12000,
        billingDate: '2026-04-01',
        plotNumber: 'A-1',
        areaName: '第1期',
        prepaidBatchId: null,
      });
      expect(payload.data.pagination).toEqual({
        page: 1,
        limit: 10,
        totalCount: 1,
        totalPages: 1,
      });
    });

    it('maps prepaid_batch_id to prepaidBatchId for batch cancel', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([
        buildBillingRow({ prepaid_batch_id: 'batch-1' }),
      ]);
      mockPrisma.billing.count.mockResolvedValue(1);

      const req = buildRequest({ query: { page: '1', limit: '10' } });
      await getBillings(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items[0].prepaidBatchId).toBe('batch-1');
    });

    it('applies filter conditions to where clause', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([]);
      mockPrisma.billing.count.mockResolvedValue(0);

      const req = buildRequest({
        query: {
          contractPlotId: PLOT_UUID,
          customerId: CUSTOMER_UUID,
          category: 'management_fee',
          status: 'billed',
          billingDateFrom: '2026-01-01',
          billingDateTo: '2026-12-31',
        },
      });
      await getBillings(req as Request, res as Response, next);

      const callArgs = mockPrisma.billing.findMany.mock.calls[0][0];
      expect(callArgs.where).toMatchObject({
        deleted_at: null,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
        category: 'management_fee',
        status: 'billed',
      });
      expect(callArgs.where.billing_date.gte).toBeInstanceOf(Date);
      expect(callArgs.where.billing_date.lte).toBeInstanceOf(Date);
    });

    it('rejects invalid query (non-uuid contractPlotId)', async () => {
      const req = buildRequest({ query: { contractPlotId: 'not-a-uuid' } });
      await getBillings(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });
  });

  describe('getBillingsSummary', () => {
    it('returns aggregated totals over all matching billings (frontend #225)', async () => {
      mockPrisma.billing.aggregate.mockResolvedValue({
        _sum: { amount: 500000, paid_amount: 320000 },
      });
      // 1回目: totalCount, 2回目: overdueCount
      mockPrisma.billing.count.mockResolvedValueOnce(120).mockResolvedValueOnce(7);

      const req = buildRequest({ query: {} });
      await getBillingsSummary(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload).toEqual({
        success: true,
        data: {
          totalAmount: 500000,
          paidAmount: 320000,
          unpaidAmount: 180000,
          overdueCount: 7,
          totalCount: 120,
        },
      });
    });

    it('未入金額は解約済・貸倒請求を除いた回収可能債権のみで算出する (#272)', async () => {
      mockPrisma.billing.aggregate
        // 1回目: フィルタ一致の全件（解約済 200,000 円を含む）
        .mockResolvedValueOnce({ _sum: { amount: 500000, paid_amount: 200000 } })
        // 2回目: 回収可能（terminated/written_off 除外）のみ
        .mockResolvedValueOnce({ _sum: { amount: 300000, paid_amount: 200000 } });
      mockPrisma.billing.count.mockResolvedValueOnce(120).mockResolvedValueOnce(7);

      const req = buildRequest({ query: {} });
      await getBillingsSummary(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      // 全件差の 300,000 ではなく回収可能のみの 100,000（#170 の未収規則と整合）
      expect(payload.data.unpaidAmount).toBe(100000);
      expect(payload.data.totalAmount).toBe(500000);
      expect(payload.data.paidAmount).toBe(200000);
      // 2回目の aggregate に除外条件が AND 合成されること（ユーザーフィルタは維持）
      const collectibleWhere = mockPrisma.billing.aggregate.mock.calls[1][0].where;
      expect(collectibleWhere.AND[1]).toEqual({
        terminated: false,
        status: { notIn: ['written_off', 'terminated'] },
      });
      expect(collectibleWhere.AND[0]).toMatchObject({ deleted_at: null });
    });

    it('applies filter conditions and adds overdue status for overdue count', async () => {
      mockPrisma.billing.aggregate.mockResolvedValue({
        _sum: { amount: null, paid_amount: null },
      });
      mockPrisma.billing.count.mockResolvedValue(0);

      const req = buildRequest({
        query: {
          contractPlotId: PLOT_UUID,
          category: 'management_fee',
          status: 'billed',
        },
      });
      await getBillingsSummary(req as Request, res as Response, next);

      const aggWhere = mockPrisma.billing.aggregate.mock.calls[0][0].where;
      expect(aggWhere).toMatchObject({
        deleted_at: null,
        contract_plot_id: PLOT_UUID,
        category: 'management_fee',
        status: 'billed',
      });
      // overdueCount 側は status が 'overdue' で上書きされる
      const overdueWhere = mockPrisma.billing.count.mock.calls[1][0].where;
      expect(overdueWhere).toMatchObject({ deleted_at: null, status: 'overdue' });

      // SUM が null（0件）のとき 0 に丸める
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data).toEqual({
        totalAmount: 0,
        paidAmount: 0,
        unpaidAmount: 0,
        overdueCount: 0,
        totalCount: 0,
      });
    });

    it('rejects invalid query (non-uuid contractPlotId)', async () => {
      const req = buildRequest({ query: { contractPlotId: 'not-a-uuid' } });
      await getBillingsSummary(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });
  });

  describe('getBillingById', () => {
    it('returns billing detail with payments', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({
        ...buildBillingRow(),
        payments: [
          {
            id: 'p1',
            payment_date: new Date('2026-04-15'),
            scheduled_date: new Date('2026-04-15'),
            payment_amount: 12000,
            scheduled_amount: 12000,
            fee_type: '管理料',
            staff_in_charge: '山本',
            notes: null,
          },
        ],
      });

      const req = buildRequest({ params: { id: VALID_UUID } });
      await getBillingById(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.id).toBe(VALID_UUID);
      expect(payload.data.payments).toHaveLength(1);
      expect(payload.data.payments[0]).toMatchObject({
        id: 'p1',
        paymentDate: '2026-04-15',
        paymentAmount: 12000,
        feeType: '管理料',
      });
    });

    it('returns NotFoundError when not found', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue(null);

      const req = buildRequest({ params: { id: VALID_UUID } });
      await getBillingById(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });
  });

  describe('createBilling', () => {
    it('creates a new billing when contract plot and customer exist', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: PLOT_UUID });
      mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_UUID });
      mockPrisma.billing.create.mockResolvedValue(buildBillingRow());

      const req = buildRequest({
        body: {
          contractPlotId: PLOT_UUID,
          customerId: CUSTOMER_UUID,
          category: 'management_fee',
          amount: 12000,
          billingDate: '2026-04-01',
        },
      });
      await createBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data.id).toBe(VALID_UUID);
      const createCall = mockPrisma.billing.create.mock.calls[0][0];
      expect(createCall.data.contract_plot_id).toBe(PLOT_UUID);
      expect(createCall.data.customer_id).toBe(CUSTOMER_UUID);
      expect(createCall.data.amount).toBe(12000);
    });

    it('returns NotFoundError when contract plot does not exist', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue(null);
      mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_UUID });

      const req = buildRequest({
        body: {
          contractPlotId: PLOT_UUID,
          customerId: CUSTOMER_UUID,
          category: 'management_fee',
          amount: 12000,
        },
      });
      await createBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
      expect(mockPrisma.billing.create).not.toHaveBeenCalled();
    });

    it('rejects invalid body (missing amount)', async () => {
      const req = buildRequest({
        body: {
          contractPlotId: PLOT_UUID,
          customerId: CUSTOMER_UUID,
          category: 'management_fee',
        },
      });
      await createBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });

    it('rejects invalid category', async () => {
      const req = buildRequest({
        body: {
          contractPlotId: PLOT_UUID,
          customerId: CUSTOMER_UUID,
          category: 'invalid_category',
          amount: 1000,
        },
      });
      await createBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });
  });

  describe('updateBilling', () => {
    it('partially updates a billing and recalculates status (#211)', async () => {
      // 1回目: 存在チェック / 2回目: 再計算後のレスポンス用再取得
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({ id: VALID_UUID, contract_plot_id: PLOT_UUID })
        .mockResolvedValueOnce(buildBillingRow({ amount: 15000, status: 'partial_paid' }));
      mockPrisma.billing.update.mockResolvedValue(
        buildBillingRow({ amount: 15000, status: 'paid' })
      );

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { amount: 15000 },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const updateCall = mockPrisma.billing.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: VALID_UUID });
      expect(updateCall.data).toEqual({ amount: 15000 });
      // 請求額変更後に status / paid_amount を入金合計から再算出すること（#211）
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(mockPrisma, VALID_UUID);
      // レスポンスは再計算後の値（status: partial_paid）であること
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.status).toBe('partial_paid');
    });

    it('returns NotFoundError when billing does not exist', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue(null);

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { amount: 1 },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });

    it('notes のみの編集では入金再集計を呼ばない（移行済み paid_amount の保全 #264）', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'paid',
          billing_date: new Date('2020-03-01'),
        })
        .mockResolvedValueOnce(buildBillingRow({ amount: 15000, status: 'paid' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ amount: 15000 }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { notes: '備考のみ更新' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    });

    it('amount が既存と同値なら入金再集計を呼ばない (#264)', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'paid',
          billing_date: null,
        })
        .mockResolvedValueOnce(buildBillingRow({ amount: 15000, status: 'paid' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ amount: 15000 }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { amount: 15000, notes: 'フォーム全体送信を想定' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    });

    it('terminated の変更では入金再集計を呼ぶ (#264)', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'billed',
          billing_date: new Date('2026-03-01'),
        })
        .mockResolvedValueOnce(buildBillingRow({ amount: 15000, status: 'terminated' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ amount: 15000 }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { terminated: true },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(mockPrisma, VALID_UUID);
    });

    it('自動算出対象ステータスへの手動変更は 400 で明示的に拒否される (#271)', async () => {
      // 修正前: status: 'paid' を受理して update 直後に computeBillingStatus が
      // 'billed' へ静かに戻す無言破棄だった
      mockPrisma.billing.findFirst.mockResolvedValueOnce({
        id: VALID_UUID,
        contract_plot_id: PLOT_UUID,
        amount: 15000,
        terminated: false,
        status: 'billed',
        billing_date: new Date('2026-03-01'),
      });

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { status: 'paid' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.message).toContain('自動算出');
      expect(mockPrisma.billing.update).not.toHaveBeenCalled();
    });

    it('written_off への手動変更は受理され再集計も呼ばれる (#271)', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'billed',
          billing_date: new Date('2026-03-01'),
        })
        .mockResolvedValueOnce(buildBillingRow({ status: 'written_off' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ status: 'written_off' }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { status: 'written_off' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const updateCall = mockPrisma.billing.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ status: 'written_off' });
      expect(recalculateBillingPaymentsMock).toHaveBeenCalled();
    });

    it('written_off の解除（任意ステータスへの変更）は受理され自動算出に戻る (#271)', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'written_off',
          billing_date: new Date('2026-03-01'),
        })
        .mockResolvedValueOnce(buildBillingRow({ status: 'billed' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ status: 'pending' }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { status: 'pending' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      // 解除後は再集計（computeBillingStatus）が実態のステータスを導出する
      expect(recalculateBillingPaymentsMock).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('status の同値送信（フォーム全体送信）は変更なしとして許容される (#271)', async () => {
      mockPrisma.billing.findFirst
        .mockResolvedValueOnce({
          id: VALID_UUID,
          contract_plot_id: PLOT_UUID,
          amount: 15000,
          terminated: false,
          status: 'billed',
          billing_date: new Date('2026-03-01'),
        })
        .mockResolvedValueOnce(buildBillingRow({ status: 'billed' }));
      mockPrisma.billing.update.mockResolvedValue(buildBillingRow({ status: 'billed' }));

      const req = buildRequest({
        params: { id: VALID_UUID },
        body: { status: 'billed', notes: '備考も更新' },
      });
      await updateBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('deleteBilling', () => {
    it('soft-deletes the billing and orphans related payments', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: VALID_UUID,
        contract_plot_id: PLOT_UUID,
      });
      const txMock = {
        billing: {
          update: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([]),
        },
        payment: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        contractPlot: {
          findFirst: jest.fn().mockResolvedValue({ payment_status: 'unpaid' }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({ params: { id: VALID_UUID } });
      await deleteBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(txMock.payment.updateMany).toHaveBeenCalledWith({
        where: { billing_id: VALID_UUID, deleted_at: null },
        data: { billing_id: null },
      });
      expect(txMock.billing.update).toHaveBeenCalledWith({
        where: { id: VALID_UUID },
        data: { deleted_at: expect.any(Date) },
      });
      // 請求削除後に区画の payment_status を再計算する（#162）
      expect(txMock.contractPlot.update).toHaveBeenCalledWith({
        where: { id: PLOT_UUID },
        data: { payment_status: 'unpaid', uncollected_amount: 0 },
      });
    });

    it('returns NotFoundError when billing does not exist', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue(null);

      const req = buildRequest({ params: { id: VALID_UUID } });
      await deleteBilling(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });
  });
});
