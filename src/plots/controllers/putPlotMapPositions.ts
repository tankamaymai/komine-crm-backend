import { Request, Response } from 'express';

import prisma from '../../db/prisma';
import { getRequestLogger } from '../../utils/logger';
import { PlotMapId } from '../services/plotMapSpecs';
import { PlotMapCellPosition, replacePlotMapPositions } from '../services/plotMapPositionService';

/**
 * PUT /plots/inventory/map/positions
 * 区画図で動かしたマスの場所を、その区ごと置き換えて保存する
 */
export async function putPlotMapPositions(req: Request, res: Response): Promise<void> {
  try {
    const { mapId, positions } = req.body as { mapId: PlotMapId; positions: PlotMapCellPosition[] };
    const saved = await replacePlotMapPositions(prisma, {
      mapId,
      positions,
      staffId: req.user?.id ?? null,
    });

    res.status(200).json({
      success: true,
      data: { mapId, positions: saved },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error saving plot map positions');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '区画図の保存に失敗しました',
      },
    });
  }
}
