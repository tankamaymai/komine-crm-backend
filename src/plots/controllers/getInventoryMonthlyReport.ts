import { Request, Response } from 'express';
import { getMonthlyReport } from '../services/monthlyReportService';
import prisma from '../../db/prisma';
import { getRequestLogger } from '../../utils/logger';

/**
 * GET /plots/inventory/monthly-report
 * 月次報告（区画残数）帳票のデータを取得
 *
 * 業務が税理士へ提出している Excel シートの配置を再現したもの
 * （議事録 2026-07-21 §6）。画面表示と Excel ダウンロードが同じ
 * レスポンスを使うので、両者の数字がズレない。
 */
export async function getInventoryMonthlyReport(req: Request, res: Response): Promise<void> {
  try {
    // 既定は true（帳票の枠に載らない区画も「その他」で出し、合計を全区画数に一致させる）
    const includeOther = req.query['includeOther'] !== 'false';

    const data = await getMonthlyReport(prisma, { includeOther });

    res.status(200).json({ success: true, data });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error fetching inventory monthly report');
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '月次報告データの取得中にエラーが発生しました',
      },
    });
  }
}
