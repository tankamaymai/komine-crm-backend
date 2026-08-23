/**
 * 空き区画の範囲一括登録コントローラー（議事録 2026-07-21 §6）
 */
import { Request, Response, NextFunction } from 'express';

const mockPrisma = {
  physicalPlot: {
    findMany: jest.fn(),
    createMany: jest.fn(),
  },
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('@prisma/client', () => ({
  Prisma: {
    Decimal: class {
      constructor(public value: number) {}
      toNumber() {
        return this.value;
      }
    },
  },
}));

import { createPhysicalPlotsBulk } from '../../src/plots/controllers/createPhysicalPlotsBulk';

/** created の読み直し用に返す行 */
function row(plotNumber: string, displayNumber: string, areaSqm = 3.6) {
  return {
    id: `id-${plotNumber}`,
    plot_number: plotNumber,
    display_number: displayNumber,
    area_name: 'C',
    area_sqm: { toNumber: () => areaSqm },
    status: 'available',
    notes: null,
    created_at: new Date('2026-08-12'),
  };
}

describe('createPhysicalPlotsBulk', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseJson: jest.Mock;
  let responseStatus: jest.Mock;
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    responseJson = jest.fn().mockReturnThis();
    responseStatus = jest.fn().mockReturnThis();
    mockResponse = { status: responseStatus, json: responseJson };
    mockNext = jest.fn();
    mockRequest = { body: {} };
    mockPrisma.physicalPlot.createMany.mockResolvedValue({ count: 0 });
  });

  it('範囲の全件を登録し 201 を返す', async () => {
    mockPrisma.physicalPlot.findMany
      .mockResolvedValueOnce([]) // 既存チェック
      .mockResolvedValueOnce([row('C-1', '1'), row('C-2', '2')]); // created 読み直し
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 2 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(responseStatus).toHaveBeenCalledWith(201);
    const body = responseJson.mock.calls[0][0];
    expect(body.data.createdCount).toBe(2);
    expect(body.data.skippedCount).toBe(0);
    expect(body.data.created.map((c: { plotNumber: string }) => c.plotNumber)).toEqual([
      'C-1',
      'C-2',
    ]);
  });

  it('既存番号はスキップし、残りだけ登録する', async () => {
    mockPrisma.physicalPlot.findMany
      .mockResolvedValueOnce([{ plot_number: 'C-2' }])
      .mockResolvedValueOnce([row('C-1', '1'), row('C-3', '3')]);
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 3 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    const createArg = mockPrisma.physicalPlot.createMany.mock.calls[0][0];
    expect(createArg.data.map((d: { plot_number: string }) => d.plot_number)).toEqual([
      'C-1',
      'C-3',
    ]);

    const body = responseJson.mock.calls[0][0];
    expect(body.data.createdCount).toBe(2);
    expect(body.data.skipped).toEqual([
      { plotNumber: 'C-2', displayNumber: '2', reason: 'この区画番号は既に登録されています' },
    ]);
  });

  // 事前照会と挿入の間に他の登録が入る競合への保険
  it('createMany には skipDuplicates を付ける', async () => {
    mockPrisma.physicalPlot.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 1 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockPrisma.physicalPlot.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  // plot_number は deleted_at を含まない単独 @unique。論理削除済みを除外すると
  // create が P2002 になる
  it('重複判定は論理削除済みも含める（deleted_at で絞らない）', async () => {
    mockPrisma.physicalPlot.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 1 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    const where = mockPrisma.physicalPlot.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ plot_number: { in: ['C-1'] } });
    expect(where.deleted_at).toBeUndefined();
  });

  it('全件が既存なら createMany を呼ばず skippedCount だけ返す', async () => {
    mockPrisma.physicalPlot.findMany.mockResolvedValueOnce([
      { plot_number: 'C-1' },
      { plot_number: 'C-2' },
    ]);
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 2 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockPrisma.physicalPlot.createMany).not.toHaveBeenCalled();
    const body = responseJson.mock.calls[0][0];
    expect(body.data.createdCount).toBe(0);
    expect(body.data.skippedCount).toBe(2);
  });

  it('status は available、面積は指定値で作る', async () => {
    mockPrisma.physicalPlot.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockRequest.body = { areaName: '納骨堂-天空', startNumber: 1, endNumber: 1, areaSqm: 0.09 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    const created = mockPrisma.physicalPlot.createMany.mock.calls[0][0].data[0];
    expect(created.status).toBe('available');
    expect(created.area_name).toBe('納骨堂-天空');
    expect(created.area_sqm.toNumber()).toBe(0.09);
    expect(created.plot_number).toBe('納骨堂-天空-1');
  });

  it('範囲が逆転していれば next にエラーを渡す', async () => {
    mockRequest.body = { areaName: 'C', startNumber: 10, endNumber: 1 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect((mockNext as jest.Mock).mock.calls[0][0].message).toBe(
      '開始番号は終了番号以下で指定してください'
    );
    expect(mockPrisma.physicalPlot.createMany).not.toHaveBeenCalled();
  });

  it('上限を超える範囲は next にエラーを渡し DB を触らない', async () => {
    mockRequest.body = { areaName: 'C', startNumber: 1, endNumber: 1000 };

    await createPhysicalPlotsBulk(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect((mockNext as jest.Mock).mock.calls[0][0].message).toBe(
      '一度に登録できるのは500件までです'
    );
    expect(mockPrisma.physicalPlot.findMany).not.toHaveBeenCalled();
  });
});
