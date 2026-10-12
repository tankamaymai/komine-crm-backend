/**
 * 区画図で動かしたマスの場所の読み書き
 */
import { PrismaClient } from '@prisma/client';

import {
  getPlotMapPositions,
  replacePlotMapPositions,
} from '../../../src/plots/services/plotMapPositionService';

type MockPrisma = {
  plotMapCellPosition: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
  $transaction: jest.Mock;
};

const buildPrisma = (): MockPrisma => {
  const mock: MockPrisma = {
    plotMapCellPosition: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: MockPrisma) => Promise<unknown>) => fn(mock));
  return mock;
};
const asPrisma = (mock: MockPrisma) => mock as unknown as PrismaClient;

describe('getPlotMapPositions', () => {
  it('区画図の記録を画面用の形で返す', async () => {
    const prisma = buildPrisma();
    prisma.plotMapCellPosition.findMany.mockResolvedValue([
      { origin_row: 1, origin_col: 4, plot_label: '12', row: 3, col: 5 },
    ]);

    const positions = await getPlotMapPositions(asPrisma(prisma), '1-A');

    expect(prisma.plotMapCellPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { map_id: '1-A' } })
    );
    expect(positions).toEqual([{ originRow: 1, originCol: 4, plotLabel: '12', row: 3, col: 5 }]);
  });
});

describe('replacePlotMapPositions', () => {
  it('その区の記録を消してから書き直す', async () => {
    const prisma = buildPrisma();
    const positions = [{ originRow: 1, originCol: 4, plotLabel: '12', row: 3, col: 5 }];

    const saved = await replacePlotMapPositions(asPrisma(prisma), {
      mapId: '1-A',
      positions,
      staffId: 7,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.plotMapCellPosition.deleteMany).toHaveBeenCalledWith({
      where: { map_id: '1-A' },
    });
    expect(prisma.plotMapCellPosition.createMany).toHaveBeenCalledWith({
      data: [
        {
          map_id: '1-A',
          origin_row: 1,
          origin_col: 4,
          plot_label: '12',
          row: 3,
          col: 5,
          updated_by: 7,
        },
      ],
    });
    expect(saved).toEqual(positions);
  });

  it('移動がなければ消すだけ', async () => {
    const prisma = buildPrisma();

    const saved = await replacePlotMapPositions(asPrisma(prisma), {
      mapId: '1-A',
      positions: [],
      staffId: null,
    });

    expect(prisma.plotMapCellPosition.deleteMany).toHaveBeenCalledWith({
      where: { map_id: '1-A' },
    });
    expect(prisma.plotMapCellPosition.createMany).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });
});
