import { Request, Response, NextFunction } from 'express';

const mockPrisma = {
  billing: { findMany: jest.fn() },
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

import { getUncollectedBillings } from '../../src/billings/uncollectedBillingController';
import { ValidationError } from '../../src/middleware/errorHandler';

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

describe('getUncollectedBillings', () => {
  it('q 無しで護持費の未払いが返る', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([unpaidRow()]);
    const req = buildRequest({});
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockPrisma.billing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deleted_at: null,
          category: 'management_fee',
          status: { notIn: ['paid', 'terminated', 'written_off'] },
        }),
      })
    );
    const findManyArgs = mockPrisma.billing.findMany.mock.calls[0][0];
    expect(findManyArgs.take).toBeUndefined();
    const where = findManyArgs.where;
    expect(where.category).toBe('management_fee');
    expect(where.OR).toBeUndefined();
    expect(JSON.stringify(where)).not.toContain('nameContains');
    expect(JSON.stringify(where)).not.toMatch(/"contains"\s*:/);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0]).toEqual({
      billingId: 'b1',
      contractPlotId: 'p1',
      customerId: 'c1',
      contractorName: '田中太郎',
      buriedPersonName: null,
      plotNumber: '10',
      displayNumber: '10',
      category: 'management_fee',
      year: 2026,
      remainingAmount: 10000,
    });
    expect(payload.data.pagination).toEqual({
      page: 1,
      limit: 50,
      totalCount: 1,
      totalPages: 1,
    });
  });

  it('使用料は where に入らず JS でも落とす', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([unpaidRow({ category: 'usage_fee' })]);
    const req = buildRequest({});
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    const where = mockPrisma.billing.findMany.mock.calls[0][0].where;
    expect(where.category).toBe('management_fee');
    expect(JSON.stringify(where)).not.toContain('usage_fee');

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.items).toEqual([]);
    expect(payload.data.pagination.totalCount).toBe(0);
  });

  it('paid は返らない', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([unpaidRow({ status: 'paid' })]);
    const req = buildRequest({});
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.items).toEqual([]);
  });

  it('ページ2は残額2番目の1件と pagination を返す', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([
      unpaidRow({ id: 'b-low', amount: 1000, paid_amount: 0 }),
      unpaidRow({ id: 'b-high', amount: 3000, paid_amount: 0 }),
      unpaidRow({ id: 'b-mid', amount: 2000, paid_amount: 0 }),
    ]);
    const req = buildRequest({ page: '2', limit: '1' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0].remainingAmount).toBe(2000);
    expect(payload.data.items[0].billingId).toBe('b-mid');
    expect(payload.data.pagination).toEqual({
      page: 2,
      limit: 1,
      totalCount: 3,
      totalPages: 3,
    });
  });

  it('q 空文字でも findMany する', async () => {
    mockPrisma.billing.findMany.mockResolvedValue([]);
    const req = buildRequest({ q: '' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockPrisma.billing.findMany).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const where = mockPrisma.billing.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });

  it('year 1899 は ValidationError で findMany しない', async () => {
    const req = buildRequest({ year: '1899' });
    const res = buildResponse();
    const next = jest.fn() as NextFunction;

    await getUncollectedBillings(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(mockPrisma.billing.findMany).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
