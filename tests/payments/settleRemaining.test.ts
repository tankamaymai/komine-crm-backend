import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

const mockPrisma = {
  billing: { findFirst: jest.fn() },
  payment: { create: jest.fn() },
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

import { settleRemaining } from '../../src/payments/settleRemaining';
import { NotFoundError, ValidationError } from '../../src/middleware/errorHandler';

const BILLING_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAYMENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PLOT_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const todayJstDateString = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

const buildResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const buildRequest = (body: unknown = {}): Partial<Request> => ({
  body,
  query: {},
  params: {},
  user: {
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    is_active: true,
    supabase_uid: 'admin-uid',
  },
});

const billedUnpaid = (overrides: Record<string, unknown> = {}) => ({
  id: BILLING_UUID,
  amount: 10000,
  paid_amount: 0,
  status: 'billed',
  category: 'management_fee',
  contract_plot_id: PLOT_UUID,
  customer_id: CUSTOMER_UUID,
  deleted_at: null,
  ...overrides,
});

const buildPaymentRow = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_UUID,
  billing_id: BILLING_UUID,
  customer_id: CUSTOMER_UUID,
  contract_plot_id: PLOT_UUID,
  scheduled_date: null,
  scheduled_amount: null,
  payment_date: new Date(`${todayJstDateString()}T00:00:00Z`),
  payment_amount: 10000,
  fee_type: '管理料',
  application_type: null,
  billing_type: null,
  staff_in_charge: null,
  notes: null,
  legacy_nyukin_cd: null,
  billing: {
    id: BILLING_UUID,
    category: 'management_fee',
    amount: 10000,
    billing_date: new Date('2026-04-01'),
    status: 'billed',
  },
  customer: { id: CUSTOMER_UUID, name: '田中太郎', name_kana: 'タナカタロウ' },
  contractPlot: {
    id: PLOT_UUID,
    physicalPlot: {
      id: 'phys-1',
      plot_number: '10',
      display_number: '10',
      area_name: '出雲',
    },
  },
  created_at: new Date('2026-04-15T00:00:00Z'),
  updated_at: new Date('2026-04-15T00:00:00Z'),
  ...overrides,
});

describe('settleRemaining', () => {
  let res: Partial<Response>;
  let next: NextFunction;
  let txMock: {
    billing: { findFirst: jest.Mock; update: jest.Mock };
    payment: { create: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
    next = jest.fn();
    txMock = {
      billing: { findFirst: jest.fn(), update: jest.fn() },
      payment: { create: jest.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof txMock) => unknown) =>
      cb(txMock)
    );
  });

  it('残額10000の billed を入れると残額・今日JST・請求側の紐付けで作成し201', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());
    txMock.payment.create.mockResolvedValue(buildPaymentRow());

    const todayJst = todayJstDateString();
    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: todayJst,
    });
    await settleRemaining(req as Request, res as Response, next);
    expect(txMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payment_amount: 10000,
          payment_date: new Date(`${todayJst}T00:00:00Z`),
          billing_id: BILLING_UUID,
          contract_plot_id: PLOT_UUID,
          customer_id: CUSTOMER_UUID,
          fee_type: '管理料',
        }),
      })
    );
    expect(recalculateBillingPaymentsMock).toHaveBeenCalledTimes(1);
    expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  it('paid_amount === amount なら ValidationError で payment.create しない', async () => {
    txMock.billing.findFirst.mockResolvedValue(
      billedUnpaid({ paid_amount: 10000, status: 'paid' })
    );

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: '2026-01-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect((next as jest.Mock).mock.calls[0][0].message).toBe(
      'すでに入金されています。もう一度探してください'
    );
    expect(txMock.payment.create).not.toHaveBeenCalled();
    expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('請求が無ければ NotFoundError', async () => {
    txMock.billing.findFirst.mockResolvedValue(null);

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: '2026-01-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    expect((next as jest.Mock).mock.calls[0][0].message).toBe('指定の請求が見つかりません');
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('護持費の一部は指定した金額と次の日を残し、入金のあとに約束を上書きする', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());
    txMock.payment.create.mockResolvedValue(buildPaymentRow({ payment_amount: 3000 }));

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 3000,
      paymentDate: '2026-10-01',
      nextPaymentDate: '2026-12-01',
      seenRemaining: 10000,
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(txMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payment_amount: 3000,
          payment_date: new Date('2026-10-01T00:00:00.000Z'),
        }),
      })
    );
    expect(recalculateBillingPaymentsMock).toHaveBeenCalledWith(txMock, BILLING_UUID);
    expect(txMock.billing.update).toHaveBeenCalledWith({
      where: { id: BILLING_UUID },
      data: { next_payment_date: new Date('2026-12-01T00:00:00.000Z') },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { remainingAmount: 7000, nextPaymentDate: '2026-12-01' },
    });
  });

  it('護持費の0円は入金を作らず次の日だけ残す', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 0,
      nextPaymentDate: '2026-12-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(txMock.payment.create).not.toHaveBeenCalled();
    expect(recalculateBillingPaymentsMock).not.toHaveBeenCalled();
    expect(txMock.billing.update).toHaveBeenCalledWith({
      where: { id: BILLING_UUID },
      data: { next_payment_date: new Date('2026-12-01T00:00:00.000Z') },
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { remainingAmount: 10000, nextPaymentDate: '2026-12-01' },
    });
  });

  it('全額を入れると次の日は残さない', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());
    txMock.payment.create.mockResolvedValue(buildPaymentRow());

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: '2026-10-01',
      nextPaymentDate: '2026-12-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(txMock.billing.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { remainingAmount: 0, nextPaymentDate: null },
    });
  });

  it('一部なのに次の日が無いと止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 3000,
      paymentDate: '2026-10-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe('次に払う日を書いてください');
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('残額より多い金額は、見ていた残額と同じなら残額超過で止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10001,
      paymentDate: '2026-10-01',
      seenRemaining: 10000,
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe('残っている金額までにしてください');
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('見ていた残額と今の残額が違い、入力が今の残額を超えると残額変更で止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid({ paid_amount: 3000 }));

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: '2026-10-01',
      seenRemaining: 10000,
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe(
      '残額が変わっています。もう一度探してください'
    );
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('もらった日が今日より先なら止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid());

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 10000,
      paymentDate: '2999-01-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe(
      'もらった日は今日以前にしてください。これからの日は次に払う日に書いてください'
    );
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('使用料の0円は止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid({ category: 'usage_fee' }));

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 0,
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe('今回の金額は1円以上にしてください');
    expect(txMock.payment.create).not.toHaveBeenCalled();
    expect(txMock.billing.update).not.toHaveBeenCalled();
  });

  it('使用料に次の日が付いていると止める', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid({ category: 'usage_fee' }));

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 3000,
      paymentDate: '2026-10-01',
      nextPaymentDate: '2026-12-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect((next as jest.Mock).mock.calls[0][0].message).toBe('この種類には次に払う日を残せません');
    expect(txMock.payment.create).not.toHaveBeenCalled();
  });

  it('使用料の一部は次の日なしで入金できる', async () => {
    txMock.billing.findFirst.mockResolvedValue(billedUnpaid({ category: 'usage_fee' }));
    txMock.payment.create.mockResolvedValue(buildPaymentRow({ payment_amount: 3000 }));

    const req = buildRequest({
      billingId: BILLING_UUID,
      paymentAmount: 3000,
      paymentDate: '2026-10-01',
    });
    await settleRemaining(req as Request, res as Response, next);

    expect(txMock.payment.create).toHaveBeenCalled();
    expect(txMock.billing.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { remainingAmount: 7000, nextPaymentDate: null },
    });
  });
});
