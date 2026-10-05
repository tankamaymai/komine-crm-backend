import { z } from 'zod';
import {
  CLOSED_REASON_LABEL,
  getYuchoClosedReason,
  isExistingDate,
} from '../yucho/yuchoBusinessDay';

/**
 * ゆうちょ連携バリデーション
 *
 * 管理料の請求データ取得とCSV生成に関するクエリパラメータを検証する。
 * 合祀に料金はないため、引き落とし対象には含めない。
 */

// 請求対象カテゴリ
export const YuchoCategoryEnum = z.enum(['management', 'collective', 'all']);
export type YuchoCategory = z.infer<typeof YuchoCategoryEnum>;

// 請求ステータスフィルタ
//   unbilled: 未請求 (ManagementFee → 未集金/未払い相当, CollectiveBurial → pending)
//   billed:   請求済 (CollectiveBurial.billing_status = billed)
//   paid:     支払済 (CollectiveBurial.billing_status = paid)
//   all:      全て
export const YuchoStatusEnum = z.enum(['unbilled', 'billed', 'paid', 'all']);
export type YuchoStatus = z.infer<typeof YuchoStatusEnum>;

export const YuchoExportKindEnum = z.enum(['payer_master', 'debit', 'zengin']);
export type YuchoExportKind = z.infer<typeof YuchoExportKindEnum>;

const yearSchema = z.coerce.number().int().min(1900).max(2999);
const monthSchema = z.coerce.number().int().min(1).max(12);
const transferDaySchema = z.coerce.number().int().min(1).max(31);

// 請求データ取得用クエリスキーマ
export const yuchoBillingQuerySchema = z.object({
  year: yearSchema,
  month: monthSchema.optional(),
  category: YuchoCategoryEnum.optional().default('all'),
  status: YuchoStatusEnum.optional().default('unbilled'),
});

export type YuchoBillingQuery = z.infer<typeof yuchoBillingQuerySchema>;

export const yuchoExportQuerySchema = z
  .object({
    year: yearSchema,
    month: monthSchema.optional(),
    category: YuchoCategoryEnum.optional().default('all'),
    status: YuchoStatusEnum.optional().default('unbilled'),
    kind: YuchoExportKindEnum.optional().default('debit'),
    transferDay: transferDaySchema.optional(),
    transferMonth: monthSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.kind === 'debit' || val.kind === 'zengin') && val.transferDay == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferDay'],
        message: '引き落とし日が必要です',
      });
    }
    if (val.kind === 'zengin' && val.transferMonth == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferMonth'],
        message: '引き落とし月が必要です',
      });
    }

    const transferMonth = val.transferMonth ?? val.month;
    if (val.transferDay == null || transferMonth == null) return;
    if (!isExistingDate(val.year, transferMonth, val.transferDay)) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferDay'],
        message: `${transferMonth}月${val.transferDay}日はありません`,
      });
      return;
    }
    // 名簿CSV・決済CSVには日付が入らない（人がゆうちょの画面で選ぶ）ので、1本ファイルだけ止める
    const closed = getYuchoClosedReason(val.year, transferMonth, val.transferDay);
    if (val.kind === 'zengin' && closed) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferDay'],
        message: `${transferMonth}月${val.transferDay}日はゆうちょが休み（${CLOSED_REASON_LABEL[closed]}）なので引き落とせません`,
      });
    }
  });

export type YuchoExportQuery = z.infer<typeof yuchoExportQuerySchema>;

// =============================================================================
// レスポンス型定義
// =============================================================================

export interface YuchoBillingItem {
  category: 'management' | 'collective';
  sourceId: string;
  contractPlotId: string;
  plotNumber: string;
  displayNumber: string | null;
  areaName: string;
  contractDate: string;
  customerId: string | null;
  customerName: string | null;
  customerNameKana: string | null;
  billingAmount: number;
  billingStatus: string;
  scheduledDate: string | null;
  billingMonth: number | null;
  billingInfo: {
    bankName: string | null;
    branchName: string | null;
    accountType: string | null;
    accountNumber: string | null;
    accountHolder: string | null;
    // ゆうちょ記号(5桁)・番号。店番/口座番号の正準ソース（#170）。
    yuchoSymbol: string | null;
    yuchoNumber: string | null;
  } | null;
  payerCode?: string | null;
  payerCode1?: string | null;
  payerCode2?: string | null;
  accountKana?: string | null;
  exportable?: boolean;
  excludeReason?: 'no_account' | 'bad_number' | 'no_kana' | 'no_payer_code' | 'zero_amount' | null;
}

export interface YuchoBillingSummary {
  /** 請求対象の総件数（口座未登録を含む） */
  totalCount: number;
  /** 請求対象の総額（口座未登録を含む） */
  totalAmount: number;
  /** 実際にCSV（振替ファイル）へ出力される件数（口座登録あり・金額>0）。CSVのデータ行数と一致する */
  exportableCount: number;
  /** 実際にCSVへ出力される金額の合計。CSVトレーラーの合計金額と一致する */
  exportableAmount: number;
  /** 口座未登録のため振替ファイルから除外される件数（請求漏れ検知用） */
  excludedNoAccountCount: number;
  byCategory: {
    management: { count: number; amount: number };
    collective: { count: number; amount: number };
  };
}

export interface YuchoBillingResponse {
  period: { year: number; month: number | null };
  items: YuchoBillingItem[];
  summary: YuchoBillingSummary;
  exportSettings: {
    zenginReady: boolean;
    missing: string[];
  };
}
