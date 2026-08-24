import { Request, Response } from 'express';

import prisma from '../../db/prisma';
import { getRequestLogger } from '../../utils/logger';
import { getPlotMapOverlays, PlotMapId } from '../services/plotMapService';

/**
 * GET /plots/inventory/map
 * 区画図に載せる契約・予約の重ね合わせ
 */
export async function getPlotMap(req: Request, res: Response): Promise<void> {
  try {
    const mapId = req.query['mapId'] as PlotMapId;
    const plots = await getPlotMapOverlays(prisma, { mapId });

    res.status(200).json({
      success: true,
      data: {
        mapId,
        plots,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error getting plot map');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '区画図データの取得に失敗しました',
      },
    });
  }
}
