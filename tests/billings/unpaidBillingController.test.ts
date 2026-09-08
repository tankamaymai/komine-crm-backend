import { Request, Response, NextFunction } from 'express';

const mockPrisma = {
  billing: { findMany: jest.fn() },
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

import { getUnpaidBillings } from '../../src/billings/unpaidBillingController';
import { ValidationError } from '../../src/middleware/errorHandler';
import { TOO_MANY_UNPAID } from '../../src/billings/unpaidBillingSearch';

const buildResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const buildRequest = (query: Record<string, string> = {}): Partial<Request> => ({
  query,
});

const unpaidRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  contract_plot_id: 'p1',
  customer_id: 'c1',
  category: 'management_fee',
  amount: 10000,
  paid_amount: 0,
  status: 'billed',
  use_start_year: 2026,
  use_end_year: 2026,
  billing_date: new Date('2026-03-01T00:00:00Z'),
  customer: { id: 'c1', name: '田中太郎', name_kana: 'タナカタロウ' },
  contractPlot: {
    physicalPlot: { plot_number: '10', display_number: '10', area_name: '出雲' },
    saleContractRoles: [
      { role: 'contractor', customer: { name: '田中太郎', name_kana: 'タナカタロウ' } },
    ],
    buriedPersons: [{ name: '田中花子', name_kana: 'タナカハナコ' }],
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getUnpaidBillings', () => {
  it('q が空なら ValidationError を next に渡す', async () => {
    const req = buildRequest({ q: '' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUnpaidBillings(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect((next as jest.Mock).mock.calls[0][0].message).toBe('名前か区画番号を書いてください');
    expect(mockPrisma.billing.findMany).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('category=management_fee のとき where にその区分だけ入り、未払い1件を返す', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([unpaidRow()]);
    const req = buildRequest({ q: '田中', category: 'management_fee' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUnpaidBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockPrisma.billing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
        where: expect.objectContaining({
          deleted_at: null,
          category: 'management_fee',
          status: { notIn: ['paid', 'terminated', 'written_off'] },
        }),
      })
    );
    const where = mockPrisma.billing.findMany.mock.calls[0][0].where;
    expect(where.category).toBe('management_fee');
    expect(JSON.stringify(where)).not.toContain('usage_fee');
    expect(where.OR ?? where.AND).toBeDefined();

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual({
      success: true,
      data: {
        items: [
          {
            billingId: 'b1',
            contractPlotId: 'p1',
            customerId: 'c1',
            contractorName: '田中太郎',
            buriedPersonName: '田中花子',
            plotNumber: '10',
            displayNumber: '10',
            category: 'management_fee',
            year: 2026,
            remainingAmount: 10000,
          },
        ],
      },
    });
  });

  it('埋葬者名だけが当たる行は buriedPersonName を入れ、契約者名だけの行は null', async () => {
    const buriedOnly = unpaidRow({
      id: 'b-buried',
      customer: { id: 'c1', name: '山田太郎', name_kana: 'ヤマダタロウ' },
      contractPlot: {
        physicalPlot: { plot_number: '10', display_number: '10', area_name: '出雲' },
        saleContractRoles: [
          { role: 'contractor', customer: { name: '山田太郎', name_kana: 'ヤマダタロウ' } },
        ],
        buriedPersons: [{ name: '田中花子', name_kana: 'タナカハナコ' }],
      },
    });
    const contractorOnly = unpaidRow({
      id: 'b-contractor',
      contractPlot: {
        physicalPlot: { plot_number: '10', display_number: '10', area_name: '出雲' },
        saleContractRoles: [
          { role: 'contractor', customer: { name: '田中太郎', name_kana: 'タナカタロウ' } },
        ],
        buriedPersons: [{ name: '佐藤花子', name_kana: 'サトウハナコ' }],
      },
    });

    mockPrisma.billing.findMany.mockResolvedValueOnce([buriedOnly]);
    const buriedReq = buildRequest({ q: '花子' });
    const buriedRes = buildResponse();
    await getUnpaidBillings(buriedReq as Request, buriedRes as Response, jest.fn() as NextFunction);
    const buriedItems = (buriedRes.json as jest.Mock).mock.calls[0][0].data.items;
    expect(buriedItems).toHaveLength(1);
    expect(buriedItems[0].buriedPersonName).toBe('田中花子');

    mockPrisma.billing.findMany.mockResolvedValueOnce([contractorOnly]);
    const contractorReq = buildRequest({ q: '田中' });
    const contractorRes = buildResponse();
    await getUnpaidBillings(
      contractorReq as Request,
      contractorRes as Response,
      jest.fn() as NextFunction
    );
    const contractorItems = (contractorRes.json as jest.Mock).mock.calls[0][0].data.items;
    expect(contractorItems).toHaveLength(1);
    expect(contractorItems[0].buriedPersonName).toBeNull();
    expect(contractorItems[0].contractorName).toBe('田中太郎');
  });

  it('残額ありの行が51件なら ValidationError を返し json は呼ばない', async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      unpaidRow({ id: `b${i}`, contract_plot_id: `p${i}` })
    );
    mockPrisma.billing.findMany.mockResolvedValue(rows);
    const req = buildRequest({ q: '田中' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUnpaidBillings(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect((next as jest.Mock).mock.calls[0][0].message).toBe(TOO_MANY_UNPAID);
    expect((next as jest.Mock).mock.calls[0][0].message).toBe(
      '結果が多すぎます。名前を長くしてください'
    );
    expect(res.json).not.toHaveBeenCalled();
  });
});
