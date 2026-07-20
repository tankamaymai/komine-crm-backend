/**
 * 空き区画（物理区画のみ）先行登録 POST /plots/physical のテスト（システム確認 項目⑦）
 */
import { Request, Response } from 'express';

const mockPrisma: any = {
  physicalPlot: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  Prisma: {
    Decimal: class MockDecimal {
      constructor(private value: number) {}
      toNumber() {
        return this.value;
      }
    },
  },
}));

import { createPhysicalPlot } from '../../src/plots/controllers/createPhysicalPlot';
import { ConflictError } from '../../src/middleware/errorHandler';

describe('createPhysicalPlot', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseJson: jest.Mock;
  let responseStatus: jest.Mock;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    responseJson = jest.fn().mockReturnThis();
    responseStatus = jest.fn().mockReturnValue({ json: responseJson });
    mockRequest = { body: {} };
    mockResponse = { status: responseStatus, json: responseJson };
    mockNext = jest.fn();
  });

  it('契約者なしで物理区画のみを登録し 201 を返す', async () => {
    mockPrisma.physicalPlot.findUnique.mockResolvedValue(null);
    mockPrisma.physicalPlot.create.mockResolvedValue({
      id: 'pp-new',
      plot_number: 'A-999',
      display_number: 'A-999',
      area_name: '第1期A',
      area_sqm: { toNumber: () => 1.5 },
      status: 'available',
      notes: '先行登録',
      created_at: new Date('2026-07-01'),
    });

    mockRequest.body = {
      plotNumber: 'A-999',
      displayNumber: 'A-999',
      areaName: '第1期A',
      areaSqm: 1.5,
      notes: '先行登録',
    };

    await createPhysicalPlot(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockPrisma.physicalPlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plot_number: 'A-999',
          area_name: '第1期A',
          status: 'available',
        }),
      })
    );
    expect(responseStatus).toHaveBeenCalledWith(201);
    expect(responseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          plotNumber: 'A-999',
          areaName: '第1期A',
          areaSqm: 1.5,
          status: 'available',
        }),
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('areaSqm 省略時はデフォルト 3.6 で登録する', async () => {
    mockPrisma.physicalPlot.findUnique.mockResolvedValue(null);
    mockPrisma.physicalPlot.create.mockResolvedValue({
      id: 'pp-new',
      plot_number: 'B-1',
      display_number: null,
      area_name: '第2期',
      area_sqm: { toNumber: () => 3.6 },
      status: 'available',
      notes: null,
      created_at: new Date('2026-07-01'),
    });

    mockRequest.body = { plotNumber: 'B-1', areaName: '第2期' };

    await createPhysicalPlot(mockRequest as Request, mockResponse as Response, mockNext);

    const createArg = mockPrisma.physicalPlot.create.mock.calls[0][0];
    expect(createArg.data.area_sqm.toNumber()).toBe(3.6);
    expect(createArg.data.display_number).toBeNull();
    expect(responseStatus).toHaveBeenCalledWith(201);
  });

  it('区画番号が重複している場合は ConflictError を next に渡す', async () => {
    mockPrisma.physicalPlot.findUnique.mockResolvedValue({ id: 'pp-existing' });

    mockRequest.body = { plotNumber: 'A-1', areaName: '第1期A' };

    await createPhysicalPlot(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockPrisma.physicalPlot.create).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalledWith(expect.any(ConflictError));
  });
});
