/**
 * ゆうちょ連携コントローラー
 *
 * - GET /api/v1/yucho/billing : 請求対象データの一覧取得
 * - GET /api/v1/yucho/export  : 公式ファイル（名簿CSV / 決済CSV / 全銀120文字）を返却
 */

import { Request, Response, NextFunction } from 'express';
import iconv from 'iconv-lite';
import { ZodError } from 'zod';
import { ValidationError } from '../middleware/errorHandler';
import { yuchoBillingQuerySchema, yuchoExportQuerySchema } from '../validations/yuchoValidation';
import { fetchYuchoBillingData } from './yuchoService';
import { buildDebitCsv, buildPayerMasterCsv } from './yuchoCsv';
import { getYuchoBusinessSettings } from './yuchoSettings';
import { buildZenginFile } from './yuchoZengin';

const formatZodError = (err: ZodError, message = 'バリデーションエラー'): ValidationError => {
  const details = err.issues.map((i) => ({
    field: i.path.join('.'),
    message: i.message,
  }));
  return new ValidationError(message, details);
};

const todayStamp = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

export const getYuchoBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = yuchoBillingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw formatZodError(parsed.error);
    }

    const data = await fetchYuchoBillingData(parsed.data);

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const exportYuchoCsv = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = yuchoExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw formatZodError(parsed.error, parsed.error.issues[0]?.message);
    }
    const params = parsed.data;

    const data = await fetchYuchoBillingData({
      year: params.year,
      month: params.month,
      category: params.category,
      status: params.status,
    });

    const stamp = todayStamp();
    const category = params.category;
    let body = '';
    let fileName = '';
    let contentType = 'text/csv; charset=Shift_JIS';

    if (params.kind === 'payer_master') {
      body = buildPayerMasterCsv({ items: data.items });
      fileName = `yucho-payer-master-${params.year}-${category}-${stamp}.csv`;
    } else if (params.kind === 'zengin') {
      const settings = getYuchoBusinessSettings();
      if (!settings) {
        throw new ValidationError('会社の番号が未入力', [
          { field: 'clientCode', message: '委託者コードなどの会社設定が未入力です' },
        ]);
      }
      body = buildZenginFile({
        items: data.items,
        settings,
        transferMonth: params.transferMonth ?? 1,
        transferDay: params.transferDay ?? 15,
      });
      fileName = `yucho-zengin-${params.year}-${category}-${stamp}.txt`;
      contentType = 'text/plain; charset=Shift_JIS';
    } else {
      body = buildDebitCsv({ items: data.items });
      fileName = `yucho-debit-${params.year}-${category}-${stamp}.csv`;
    }

    const buffer = iconv.encode(body, 'Shift_JIS');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(buffer);
  } catch (error) {
    next(error);
  }
};
