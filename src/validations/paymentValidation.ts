import { z } from 'zod';

/**
 * 入金 (Payment) バリデーションスキーマ
 *
 * t_nyukin の移行先である Payment モデルへの CRUD と一覧クエリを検証する。
 * billing_id は nullable（孤児入金 16 件のような請求未紐付けケースに対応）。
 */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .optional()
  .nullable();

// 作成
// 請求紐付けあり: billingId 必須
// 孤児入金: billingId なしで customerId or contractPlotId のいずれか必須
export const createPaymentSchema = z
  .object({
    billingId: z.string().uuid().optional().nullable(),
    customerId: z.string().uuid().optional().nullable(),
    contractPlotId: z.string().uuid().optional().nullable(),
    scheduledDate: dateString,
    scheduledAmount: z.number().int().nonnegative().optional().nullable(),
    paymentDate: dateString,
    paymentAmount: z.number().int().nonnegative(),
    feeType: z.string().max(50).optional().nullable(),
    applicationType: z.number().int().optional().nullable(),
    billingType: z.number().int().optional().nullable(),
    staffInCharge: z.string().max(100).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .refine((v) => v.billingId || v.customerId || v.contractPlotId, {
    message: 'billingId, customerId, contractPlotId のいずれかは必須です',
    path: ['billingId'],
  });

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// 更新（部分更新可）
export const updatePaymentSchema = z.object({
  billingId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  contractPlotId: z.string().uuid().optional().nullable(),
  scheduledDate: dateString,
  scheduledAmount: z.number().int().nonnegative().optional().nullable(),
  paymentDate: dateString,
  paymentAmount: z.number().int().nonnegative().optional(),
  feeType: z.string().max(50).optional().nullable(),
  applicationType: z.number().int().optional().nullable(),
  billingType: z.number().int().optional().nullable(),
  staffInCharge: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

// 一覧クエリ
export const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  billingId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  contractPlotId: z.string().uuid().optional(),
  /**
   * 顧客名の部分一致（議事録 2026-07-21 §7）。
   * 現金受領時に名前で対象者を探す用途。漢字・カナの両方を対象にする
   * （議事録 §3 の「ひらがなでも漢字でも検索」と揃える）。
   */
  name: z.string().max(100).optional(),
  /**
   * 請求年月の絞り込み（議事録 2026-07-21 §7）。"2026-03" 形式。
   *
   * 請求を出した日（billing_date）ではなく、請求の対象期間で絞る。
   * 「2026年3月分の請求」を探す用途のため、Billing.use_start_year + target_month に
   * 一致させる（実データで target_month は 11,489/11,492 件に入っている）。
   */
  billingYearMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '請求年月は YYYY-MM 形式で指定してください')
    .optional(),
  paymentDateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  paymentDateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  orphan: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  sortBy: z
    .enum(['payment_date', 'scheduled_date', 'payment_amount', 'created_at'])
    .optional()
    .default('payment_date'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
