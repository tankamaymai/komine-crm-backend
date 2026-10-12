/**
 * 区画図で動かしたマスの場所。元の行・列を目印にする（同じ番号が複数ある区があるため）。
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { PlotMapId } from './plotMapSpecs';

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface PlotMapCellPosition {
  originRow: number;
  originCol: number;
  plotLabel: string;
  row: number;
  col: number;
}

export async function getPlotMapPositions(
  prisma: DbClient,
  mapId: PlotMapId
): Promise<PlotMapCellPosition[]> {
  const rows = await prisma.plotMapCellPosition.findMany({
    where: { map_id: mapId },
    orderBy: [{ origin_row: 'asc' }, { origin_col: 'asc' }],
  });
  return rows.map((row) => ({
    originRow: row.origin_row,
    originCol: row.origin_col,
    plotLabel: row.plot_label,
    row: row.row,
    col: row.col,
  }));
}

/** その区の記録を丸ごと置き換える。後から保存した人の並びになる。 */
export async function replacePlotMapPositions(
  prisma: PrismaClient,
  options: { mapId: PlotMapId; positions: PlotMapCellPosition[]; staffId: number | null }
): Promise<PlotMapCellPosition[]> {
  const { mapId, positions, staffId } = options;
  await prisma.$transaction(async (tx) => {
    await tx.plotMapCellPosition.deleteMany({ where: { map_id: mapId } });
    if (positions.length === 0) return;
    await tx.plotMapCellPosition.createMany({
      data: positions.map((position) => ({
        map_id: mapId,
        origin_row: position.originRow,
        origin_col: position.originCol,
        plot_label: position.plotLabel,
        row: position.row,
        col: position.col,
        updated_by: staffId,
      })),
    });
  });
  return positions;
}
