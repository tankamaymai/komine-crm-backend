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
  billing: { findFirst: jest.fn(), findMany: jest.fn() },
  payment: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  customer: { findFirst: jest.fn() },
  contractPlot: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

const recalculateBillingPaymentsMock = jest.fn();
jest.mock('../../src/billings/billingService', () => ({
  recalculateBillingPayments: (...args: unknown[]) => recalculateBillingPaymentsMock(...args),
}));

import {
  getPayments,
  getPaymentById,
  createPayment,
  updatePayment,
  deletePayment,
} from '../../src/payments/paymentController';

const PAYMENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILLING_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANOTHER_BILLING_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CUSTOMER_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PLOT_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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

const buildPaymentRow = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_UUID,
  billing_id: BILLING_UUID,
  customer_id: null,
  contract_plot_id: null,
  scheduled_date: null,
  scheduled_amount: null,
  payment_date: new Date('2026-04-15'),
  payment_amount: 12000,
  fee_type: '管理料',
  application_type: null,
  billing_type: null,
  staff_in_charge: '山本',
  notes: null,
  legacy_nyukin_cd: null,
  billing: {
    id: BILLING_UUID,
    category: 'management_fee',
    amount: 12000,
    billing_date: new Date('2026-04-01'),
    status: 'paid',
  },
  customer: null,
  contractPlot: null,
  created_at: new Date('2026-04-15T00:00:00Z'),
  updated_at: new Date('2026-04-15T00:00:00Z'),
  ...overrides,
});

describe('paymentController', () => {
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
    next = jest.fn();
  });

  describe('getPayments', () => {
    it('returns paginated list with formatted items', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([buildPaymentRow()]);
      mockPrisma.payment.count.mockResolvedValue(1);

      const req = buildRequest({ query: { page: '1', limit: '10' } });
      await getPayments(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0]).toMatchObject({
        id: PAYMENT_UUID,
        billingId: BILLING_UUID,
        paymentDate: '2026-04-15',
        paymentAmount: 12000,
      });
    });

    // 請求経由の入金（実データで12,505件中12,372件）は顧客が Billing 側にある。
    // ここを返さないと名前で探す一覧に名前が出ない
    it('請求経由の入金でも顧客名を返す', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        buildPaymentRow({
          customer: null,
          billing: {
            id: BILLING_UUID,
            category: 'management_fee',
            amount: 12000,
            billing_date: new Date('2026-04-01'),
            status: 'paid',
            use_start_year: 2026,
            target_month: 3,
            customer: { id: 'c1', name: '田中太郎', name_kana: 'タナカタロウ' },
          },
        }),
      ]);
      mockPrisma.payment.count.mockResolvedValue(1);

      const req = buildRequest({ query: {} });
      await getPayments(req as Request, res as Response, next);

      const item = (res.json as jest.Mock).mock.calls[0][0].data.items[0];
      expect(item.customer).toEqual({ id: 'c1', name: '田中太郎', nameKana: 'タナカタロウ' });
      expect(item.billing.billingYearMonth).toBe('2026-03');
    });

    it('直リンクの顧客がいればそちらを優先する', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        buildPaymentRow({
          customer: { id: 'direct', name: '直リンク花子', name_kana: 'チョクリンクハナコ' },
          billing: {
            id: BILLING_UUID,
            category: 'management_fee',
            amount: 12000,
            billing_date: null,
            status: 'paid',
            use_start_year: 2026,
            target_month: 3,
            customer: { id: 'via-billing', name: '請求経由太郎', name_kana: 'セイキュウ' },
          },
        }),
      ]);
      mockPrisma.payment.count.mockResolvedValue(1);

      const req = buildRequest({ query: {} });
      await getPayments(req as Request, res as Response, next);

      const item = (res.json as jest.Mock).mock.calls[0][0].data.items[0];
      expect(item.customer.name).toBe('直リンク花子');
    });

    it('対象年・対象月が欠けていれば請求年月は null', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        buildPaymentRow({
          billing: {
            id: BILLING_UUID,
            category: 'management_fee',
            amount: 12000,
            billing_date: null,
            status: 'paid',
            use_start_year: null,
            target_month: 3,
            customer: null,
          },
        }),
      ]);
      mockPrisma.payment.count.mockResolvedValue(1);

      const req = buildRequest({ query: {} });
      await getPayments(req as Request, res as Response, next);

      const item = (res.json as jest.Mock).mock.calls[0][0].data.items[0];
      expect(item.billing.billingYearMonth).toBeNull();
    });

    it('filters orphan payments when orphan=true', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { orphan: 'true' } });
      await getPayments(req as Request, res as Response, next);

      const callArgs = mockPrisma.payment.findMany.mock.calls[0][0];
      expect(callArgs.where.billing_id).toBeNull();
    });

    // 議事録 2026-07-21 §7: 現金受領時に名前で対象者を探す。
    // 入金の顧客は Payment.customer（直リンク）と Billing.customer（請求経由）の
    // 2経路あり、片方だけ見ると取りこぼす
    it('名前で絞ると直リンクと請求経由の両方を OR で見る', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { name: '田中' } });
      await getPayments(req as Request, res as Response, next);

      const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        {
          customer: {
            OR: [
              { name: { contains: '田中', mode: 'insensitive' } },
              { name_kana: { contains: '田中', mode: 'insensitive' } },
            ],
          },
        },
        {
          billing: {
            customer: {
              OR: [
                { name: { contains: '田中', mode: 'insensitive' } },
                { name_kana: { contains: '田中', mode: 'insensitive' } },
              ],
            },
          },
        },
      ]);
    });

    // 漢字・カナ両対応（議事録 §3 の「ひらがなでも漢字でも検索」と揃える）
    it('名前はカナでも引ける', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { name: 'タナカ' } });
      await getPayments(req as Request, res as Response, next);

      const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
      expect(where.OR[0].customer.OR).toEqual(
        expect.arrayContaining([{ name_kana: { contains: 'タナカ', mode: 'insensitive' } }])
      );
    });

    // 請求を出した日ではなく請求の対象期間で絞る（「2026年3月分の請求」を探す用途）
    it('請求年月で絞ると use_start_year と target_month に一致させる', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { billingYearMonth: '2026-03' } });
      await getPayments(req as Request, res as Response, next);

      const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
      expect(where.billing).toEqual({ use_start_year: 2026, target_month: 3 });
    });

    it('請求年月の月は先頭0付きでも数値として解釈する', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { billingYearMonth: '2026-09' } });
      await getPayments(req as Request, res as Response, next);

      expect(mockPrisma.payment.findMany.mock.calls[0][0].where.billing).toEqual({
        use_start_year: 2026,
        target_month: 9,
      });
    });

    it('名前と請求年月は併用できる', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { name: '田中', billingYearMonth: '2026-03' } });
      await getPayments(req as Request, res as Response, next);

      const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
      expect(where.OR).toHaveLength(2);
      expect(where.billing).toEqual({ use_start_year: 2026, target_month: 3 });
    });

    it('請求年月の形式が不正なら 400 相当のエラーを渡す', async () => {
      const req = buildRequest({ query: { billingYearMonth: '2026/03' } });
      await getPayments(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect((next as jest.Mock).mock.calls[0][0].message).toBe(
        '請求年月は YYYY-MM 形式で指定してください'
      );
      expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('存在しない月（13月）は弾く', async () => {
      const req = buildRequest({ query: { billingYearMonth: '2026-13' } });
      await getPayments(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(mockPrisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('名前・請求年月を指定しなければ絞り込みを足さない', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: {} });
      await getPayments(req as Request, res as Response, next);

      const where = mockPrisma.payment.findMany.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
      expect(where.billing).toBeUndefined();
    });

    it('filters non-orphan payments when orphan=false', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.payment.count.mockResolvedValue(0);

      const req = buildRequest({ query: { orphan: 'false' } });
      await getPayments(req as Request, res as Response, next);

      const callArgs = mockPrisma.payment.findMany.mock.calls[0][0];
      expect(callArgs.where.billing_id).toEqual({ not: null });
    });
  });

  describe('getPaymentById', () => {
    it('returns payment detail', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(buildPaymentRow());

      const req = buildRequest({ params: { id: PAYMENT_UUID } });
      await getPaymentById(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.id).toBe(PAYMENT_UUID);
    });

    it('returns NotFoundError when not found', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      const req = buildRequest({ params: { id: PAYMENT_UUID } });
      await getPaymentById(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });

    it('レガシーセンチネル fee_type を使用料/管理料に解決して返す (#334)', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(
        buildPaymentRow({ fee_type: 'legacy-fee-20230001' })
      );

      const req = buildRequest({ params: { id: PAYMENT_UUID } });
      await getPaymentById(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.feeType).toBe('使用料');
    });
  });

  describe('createPayment', () => {
    it('creates a payment with billing_id and triggers billing recalculation', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({ id: BILLING_UUID });
      const txMock = {
        payment: { create: jest.fn().mockResolvedValue(buildPaymentRow()) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({
        body: {
          billingId: BILLING_UUID,
          paymentDate: '2026-04-15',
          paymentAmount: 12000,
        },
      });
      await createPayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(txMock.payment.create).toHaveBeenCalled();
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
    });

    it('creates an orphan payment (customerId only) without billing recalculation', async () => {
      mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_UUID });
      const txMock = {
        payment: {
          create: jest
            .fn()
            .mockResolvedValue(buildPaymentRow({ billing_id: null, customer_id: CUSTOMER_UUID })),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({
        body: {
          customerId: CUSTOMER_UUID,
          paymentDate: '2026-04-15',
          paymentAmount: 5000,
        },
      });
      await createPayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    });

    it('rejects body with no billing/customer/plot reference', async () => {
      const req = buildRequest({
        body: { paymentAmount: 1000 },
      });
      await createPayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });

    it('returns NotFoundError when billing does not exist', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue(null);

      const req = buildRequest({
        body: { billingId: BILLING_UUID, paymentAmount: 1000 },
      });
      await createPayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });

    it('billingの区画と異なるcontractPlotIdはValidationErrorになる (#213)', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: BILLING_UUID,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
      });
      const otherPlotId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: otherPlotId });

      const req = buildRequest({
        body: {
          billingId: BILLING_UUID,
          contractPlotId: otherPlotId,
          paymentAmount: 10000,
        },
      });
      await createPayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('billing紐付け時は区画・顧客がbilling側の値で正規化される (#213)', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: BILLING_UUID,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
      });
      const txMock = {
        payment: { create: jest.fn().mockResolvedValue(buildPaymentRow()) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({
        body: {
          billingId: BILLING_UUID,
          paymentAmount: 10000,
        },
      });
      await createPayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(txMock.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billing_id: BILLING_UUID,
            contract_plot_id: PLOT_UUID,
            customer_id: CUSTOMER_UUID,
          }),
        })
      );
    });
  });

  describe('updatePayment', () => {
    it('recalculates both old and new billings when billing_id changes', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: BILLING_UUID,
      });
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: ANOTHER_BILLING_UUID,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
      });
      const txMock = {
        payment: {
          update: jest
            .fn()
            .mockResolvedValue(buildPaymentRow({ billing_id: ANOTHER_BILLING_UUID })),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({
        params: { id: PAYMENT_UUID },
        body: { billingId: ANOTHER_BILLING_UUID },
      });
      await updatePayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, ANOTHER_BILLING_UUID);
      // billing 紐付け時は区画・顧客が billing 側の値へ正規化される（#213）
      expect(txMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contractPlot: { connect: { id: PLOT_UUID } },
            customer: { connect: { id: CUSTOMER_UUID } },
          }),
        })
      );
    });

    it('billingの区画と異なるcontractPlotId指定はValidationErrorになる (#213)', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: null,
        contract_plot_id: null,
        customer_id: null,
      });
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: BILLING_UUID,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
      });
      const otherPlotId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

      const req = buildRequest({
        params: { id: PAYMENT_UUID },
        body: { billingId: BILLING_UUID, contractPlotId: otherPlotId },
      });
      await updatePayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('billingの区画と異なる既存contract_plot_idもValidationErrorになる (#213)', async () => {
      const otherPlotId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: null,
        contract_plot_id: otherPlotId, // 既存の区画が billing と不一致
        customer_id: null,
      });
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: BILLING_UUID,
        contract_plot_id: PLOT_UUID,
        customer_id: CUSTOMER_UUID,
      });

      const req = buildRequest({
        params: { id: PAYMENT_UUID },
        body: { billingId: BILLING_UUID },
      });
      await updatePayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });

    it('disconnects billing when billingId set to null', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: BILLING_UUID,
      });
      const txMock = {
        payment: {
          update: jest.fn().mockResolvedValue(buildPaymentRow({ billing_id: null })),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({
        params: { id: PAYMENT_UUID },
        body: { billingId: null },
      });
      await updatePayment(req as Request, res as Response, next);

      const updateCall = txMock.payment.update.mock.calls[0][0];
      expect(updateCall.data.billing).toEqual({ disconnect: true });
      // 旧 Billing は再集計される
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
    });

    it('returns NotFoundError when payment does not exist', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      const req = buildRequest({
        params: { id: PAYMENT_UUID },
        body: { paymentAmount: 1 },
      });
      await updatePayment(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotFoundError' }));
    });
  });

  describe('deletePayment', () => {
    it('soft-deletes payment and recalculates linked billing', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: BILLING_UUID,
      });
      const txMock = {
        payment: { update: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({ params: { id: PAYMENT_UUID } });
      await deletePayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(txMock.payment.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_UUID },
        data: { deleted_at: expect.any(Date) },
      });
      expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
    });

    it('skips billing recalculation for orphan payment', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        id: PAYMENT_UUID,
        billing_id: null,
      });
      const txMock = {
        payment: { update: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(txMock));

      const req = buildRequest({ params: { id: PAYMENT_UUID } });
      await deletePayment(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    });

    void PLOT_UUID;
  });
});
