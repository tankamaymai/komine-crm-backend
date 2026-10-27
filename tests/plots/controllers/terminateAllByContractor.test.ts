/**
 * terminateAllByContractor コントローラのテスト
 * POST /api/v1/plots/by-contractor/:customerId/terminate-all
 */

import { Request, Response, NextFunction } from 'express';

const mockPrisma: any = {
  contractPlot: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((callback: any) => Promise.resolve(callback(mockPrisma))),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable' },
  },
  ContractStatus: { vacant: 'vacant', active: 'active', terminated: 'terminated' },
  ContractRole: { applicant: 'applicant', contractor: 'contractor' },
  PaymentStatus: { unpaid: 'unpaid' },
}));

const mockRecordEntityUpdated = jest.fn();
jest.mock('../../../src/plots/services/historyService', () => ({
  recordEntityUpdated: (...args: unknown[]) => mockRecordEntityUpdated(...args),
}));

const mockUpdatePhysicalPlotStatus = jest.fn();
jest.mock('../../../src/plots/utils', () => ({
  updatePhysicalPlotStatus: (...args: unknown[]) => mockUpdatePhysicalPlotStatus(...args),
}));

import { terminateAllByContractor } from '../../../src/plots/controllers/terminateAllByContractor';
import { ValidationError } from '../../../src/middleware/errorHandler';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const buildRes = (): Response => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

const buildReq = (): Request =>
  ({
    params: { customerId: CUSTOMER_ID },
    body: { reason: '全区画の返還' },
    user: { id: 1, role: 'operator' },
  }) as unknown as Request;

describe('terminateAllByContractor', () => {
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    mockPrisma.$transaction.mockImplementation((callback: any) =>
      Promise.resolve(callback(mockPrisma))
    );
  });

  it('今の契約者になっている有効な契約だけを探す（名義変更で外れた人は対象外）', async () => {
    mockPrisma.contractPlot.findMany.mockResolvedValue([
      { id: 'cp-1', physical_plot_id: 'pp-1', contract_status: 'active' },
    ]);

    await terminateAllByContractor(buildReq(), buildRes(), next as NextFunction);

    expect(mockPrisma.contractPlot.findMany).toHaveBeenCalledWith({
      where: {
        deleted_at: null,
        contract_status: 'active',
        saleContractRoles: {
          some: {
            customer_id: CUSTOMER_ID,
            role: 'contractor',
            deleted_at: null,
            role_end_date: null,
          },
        },
      },
    });
  });

  it('その人の有効な契約を全部解約し、区画ごとに残数を戻して履歴を残す', async () => {
    mockPrisma.contractPlot.findMany.mockResolvedValue([
      { id: 'cp-1', physical_plot_id: 'pp-1', contract_status: 'active' },
      { id: 'cp-2', physical_plot_id: 'pp-2', contract_status: 'active' },
    ]);
    const res = buildRes();

    await terminateAllByContractor(buildReq(), res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(mockPrisma.contractPlot.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.contractPlot.update).toHaveBeenCalledWith({
      where: { id: 'cp-2' },
      data: { contract_status: 'terminated' },
    });
    expect(mockUpdatePhysicalPlotStatus).toHaveBeenCalledWith(mockPrisma, 'pp-1');
    expect(mockUpdatePhysicalPlotStatus).toHaveBeenCalledWith(mockPrisma, 'pp-2');
    expect(mockRecordEntityUpdated).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({ entityId: 'cp-1', changeReason: '全区画の返還' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        message: '2件の契約区画を解約しました',
        customerId: CUSTOMER_ID,
        terminatedIds: ['cp-1', 'cp-2'],
      },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('解約できる契約が無ければ止まる', async () => {
    mockPrisma.contractPlot.findMany.mockResolvedValue([]);
    const res = buildRes();

    await terminateAllByContractor(buildReq(), res, next as NextFunction);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].message).toBe('解約できる契約がありません');
    expect(mockPrisma.contractPlot.update).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('途中で失敗したら、まとめて取り消しになるよう例外を外へ出す', async () => {
    mockPrisma.contractPlot.findMany.mockResolvedValue([
      { id: 'cp-1', physical_plot_id: 'pp-1', contract_status: 'active' },
      { id: 'cp-2', physical_plot_id: 'pp-2', contract_status: 'active' },
    ]);
    mockPrisma.contractPlot.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'));
    const res = buildRes();

    await terminateAllByContractor(buildReq(), res, next as NextFunction);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    expect(res.status).not.toHaveBeenCalled();
  });
});
