import { z } from 'zod';
import { BillingCategory, BillingRecordStatus } from '@prisma/client';

/**
 * 請求 (Billing) バリデーションスキーマ
 *
 * t_seikyu の移行先である Billing モデルへの CRUD と一覧クエリを検証する。
 */

const billingCategoryEnum = z.nativeEnum(BillingCategory);
const billingStatusEnum = z.nativeEnum(BillingRecordStatus);

// 作成・更新は共通パッケージの1枚。ここには一覧・前受け・管理料だけ残す。
export {
  createBillingSchema,
  updateBillingSchema,
  type CreateBillingInput,
  type UpdateBillingInput,
} from '@komine/types';

// 一覧クエリ
export const listBillingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  contractPlotId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  category: billingCategoryEnum.optional(),
  status: billingStatusEnum.optional(),
  billingDateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  billingDateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sortBy: z
    .enum(['billing_date', 'contract_date', 'amount', 'created_at'])
    .optional()
    .default('billing_date'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export type ListBillingsQuery = z.infer<typeof listBillingsQuerySchema>;

// サマリー集計クエリ（一覧クエリからページネーション/ソートを除いたフィルタのみ。
// フィルタ一致の全件を集計するため page/limit は受けない）
export const billingSummaryQuerySchema = z.object({
  contractPlotId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  category: billingCategoryEnum.optional(),
  status: billingStatusEnum.optional(),
  billingDateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  billingDateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type BillingSummaryQuery = z.infer<typeof billingSummaryQuerySchema>;

/**
 * 前受金一括処理（#6）
 *
 * 年数の上限 100 は Billing.billing_years と揃える。1 回の操作で 100 件の
 * 請求と入金が作られるため、それ以上は入力誤りとみなす。
 */
export const prepaidBillingPreviewSchema = z.object({
  contractPlotId: z.string().uuid('contractPlotId must be a UUID'),
  receivedAmount: z.number().int().positive('受領額は1円以上で入力してください'),
  years: z.number().int().min(1).max(100),
  startYear: z.number().int().min(1900).max(2999).optional().nullable(),
});

export type PrepaidBillingPreviewInput = z.infer<typeof prepaidBillingPreviewSchema>;

export const createPrepaidBillingSchema = z.object({
  contractPlotId: z.string().uuid('contractPlotId must be a UUID'),
  receivedAmount: z.number().int().positive('受領額は1円以上で入力してください'),
  years: z.number().int().min(1).max(100),
  startYear: z.number().int().min(1900).max(2999),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'paymentDate must be YYYY-MM-DD'),
  notes: z.string().max(2000).optional().nullable(),
});

export type CreatePrepaidBillingInput = z.infer<typeof createPrepaidBillingSchema>;

/** 選んだ年・月の管理料請求をまとめて作る。apply=false は件数だけ返す。 */
export const generateManagementFeeBillingSchema = z.object({
  year: z.number().int().min(1900).max(2999),
  month: z.number().int().min(1).max(12),
  apply: z.boolean(),
});

export type GenerateManagementFeeBillingInput = z.infer<typeof generateManagementFeeBillingSchema>;
