import { Request, Response } from 'express';
import prisma from '../../db/prisma';
import { getRequestLogger } from '../../utils/logger';
import { getSalesLedger, getVacantLedger } from '../services/ledgerViewService';

/**
 * GET /plots/inventory/vacant-ledger
 * Excel「空き区画一覧」と同じ項目（番号と㎡）を期ごとに返す。
 */
export async function getInventoryVacantLedger(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getVacantLedger(prisma);
    res.status(200).json({ success: true, data });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error fetching vacant ledger');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '空き区画一覧の取得中にエラーが発生しました',
      },
    });
  }
}

/**
 * GET /plots/inventory/sales-ledger
 * Excel「今年度販売区画数」「年別販売区画数」と同じ項目を返す。
 * agent クエリで取扱名の部分一致（例: 大友）。
 */
export async function getInventorySalesLedger(req: Request, res: Response): Promise<void> {
  try {
    const agent = typeof req.query['agent'] === 'string' ? req.query['agent'] : undefined;
    const data = await getSalesLedger(prisma, { agent });
    res.status(200).json({ success: true, data });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error fetching sales ledger');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '販売数の取得中にエラーが発生しました',
      },
    });
  }
}
