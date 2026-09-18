import { z } from 'zod';
import { BillingCategory, BillingRecordStatus } from '@prisma/client';

/**
 * 請求 (Billing) バリデーションスキーマ
 *
 * t_seikyu の移行先である Billing モデルへの CRUD と一覧クエリを検証する。
 */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .optional()
  .nullable();

const billingCategoryEnum = z.nativeEnum(BillingCategory);
const billingStatusEnum = z.nativeEnum(BillingRecordStatus);

// 作成
export const createBillingSchema = z.object({
  contractPlotId: z.string().uuid('contractPlotId must be a UUID'),
  customerId: z.string().uuid('customerId must be a UUID'),
  category: billingCategoryEnum,
  amount: z.number().int().nonnegative(),
  useStartYear: z.number().int().min(1900).max(2999).optional().nullable(),
  useEndYear: z.number().int().min(1900).max(2999).optional().nullable(),
  targetMonth: z.number().int().min(1).max(12).optional().nullable(),
  billingYears: z.number().int().min(1).max(100).optional().nullable(),
  contractDate: dateString,
  billingDate: dateString,
  applicationType: z.number().int().optional().nullable(),
  billingType: z.number().int().optional().nullable(),
  status: billingStatusEnum.optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export type CreateBillingInput = z.infer<typeof createBillingSchema>;

// 更新（部分更新可）
export const updateBillingSchema = z.object({
  category: billingCategoryEnum.optional(),
  amount: z.number().int().nonnegative().optional(),
  useStartYear: z.number().int().min(1900).max(2999).optional().nullable(),
  useEndYear: z.number().int().min(1900).max(2999).optional().nullable(),
  targetMonth: z.number().int().min(1).max(12).optional().nullable(),
  billingYears: z.number().int().min(1).max(100).optional().nullable(),
  contractDate: dateString,
  billingDate: dateString,
  applicationType: z.number().int().optional().nullable(),
  billingType: z.number().int().optional().nullable(),
  status: billingStatusEnum.optional(),
  terminated: z.boolean().optional(),
  terminatedDate: dateString,
  notes: z.string().max(2000).optional().nullable(),
});

export type UpdateBillingInput = z.infer<typeof updateBillingSchema>;

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
