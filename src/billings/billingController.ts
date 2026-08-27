import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { BillingSummaryResponse } from '@komine/types';
import prisma from '../db/prisma';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { recalculateContractPlotPaymentStatus } from '../plots/services/paymentStatusService';
import { recalculateBillingPayments } from './billingService';
import { resolvePaymentFeeTypeLabel } from '../payments/feeTypeLabels';
import {
  createBillingSchema,
  updateBillingSchema,
  listBillingsQuerySchema,
  billingSummaryQuerySchema,
} from '../validations/billingValidation';

type BillingWithRelations = Prisma.BillingGetPayload<{
  include: {
    customer: { select: { id: true; name: true; name_kana: true } };
    contractPlot: {
      select: {
        id: true;
        physicalPlot: {
          select: { id: true; plot_number: true; display_number: true; area_name: true };
        };
      };
    };
  };
}>;

const toDateOrNull = (s?: string | null): Date | null => (s ? new Date(`${s}T00:00:00Z`) : null);

const formatBilling = (b: BillingWithRelations) => ({
  id: b.id,
  contractPlotId: b.contract_plot_id,
  customerId: b.customer_id,
  category: b.category,
  amount: b.amount,
  useStartYear: b.use_start_year,
  useEndYear: b.use_end_year,
  targetMonth: b.target_month,
  billingYears: b.billing_years,
  contractDate: b.contract_date?.toISOString().split('T')[0] ?? null,
  billingDate: b.billing_date?.toISOString().split('T')[0] ?? null,
  paidAmount: b.paid_amount,
  lastPaymentDate: b.last_payment_date?.toISOString().split('T')[0] ?? null,
  terminated: b.terminated,
  terminatedDate: b.terminated_date?.toISOString().split('T')[0] ?? null,
  status: b.status,
  applicationType: b.application_type,
  billingType: b.billing_type,
  notes: b.notes,
  prepaidBatchId: b.prepaid_batch_id,
  legacySeikyuCd: b.legacy_seikyu_cd,
  customer: b.customer
    ? { id: b.customer.id, name: b.customer.name, nameKana: b.customer.name_kana }
    : null,
  plotNumber: b.contractPlot?.physicalPlot.plot_number ?? null,
  displayNumber: b.contractPlot?.physicalPlot.display_number ?? null,
  areaName: b.contractPlot?.physicalPlot.area_name ?? null,
  createdAt: b.created_at.toISOString(),
  updatedAt: b.updated_at.toISOString(),
});

const includeRelations = {
  customer: { select: { id: true, name: true, name_kana: true } },
  contractPlot: {
    select: {
      id: true,
      physicalPlot: {
        select: { id: true, plot_number: true, display_number: true, area_name: true },
      },
    },
  },
} satisfies Prisma.BillingInclude;

/**
 * 請求一覧取得
 */
export const getBillings = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = listBillingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const q = parsed.data;
    const skip = (q.page - 1) * q.limit;

    const where: Prisma.BillingWhereInput = { deleted_at: null };
    if (q.contractPlotId) where.contract_plot_id = q.contractPlotId;
    if (q.customerId) where.customer_id = q.customerId;
    if (q.category) where.category = q.category;
    if (q.status) where.status = q.status;
    if (q.billingDateFrom || q.billingDateTo) {
      where.billing_date = {
        ...(q.billingDateFrom && { gte: new Date(`${q.billingDateFrom}T00:00:00Z`) }),
        ...(q.billingDateTo && { lte: new Date(`${q.billingDateTo}T23:59:59Z`) }),
      };
    }

    const [items, totalCount] = await Promise.all([
      prisma.billing.findMany({
        where,
        skip,
        take: q.limit,
        orderBy: { [q.sortBy]: q.sortOrder },
        include: includeRelations,
      }),
      prisma.billing.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        items: items.map(formatBilling),
        pagination: {
          page: q.page,
          limit: q.limit,
          totalCount,
          totalPages: Math.ceil(totalCount / q.limit),
        },
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid query'));
      return;
    }
    next(error);
  }
};

/**
 * 請求サマリー集計取得
 *
 * フィルタ一致の「全件」を集計する（GET /billings/summary）。
 * 一覧はページネーションされるため、画面上部の請求総額/入金済/未入金/
 * 延滞件数 StatCard をページ分の reduce で出すと誤読される
 * （frontend #225）。サーバ側で aggregate して返す。
 */
export const getBillingsSummary = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = billingSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const q = parsed.data;

    const where: Prisma.BillingWhereInput = { deleted_at: null };
    if (q.contractPlotId) where.contract_plot_id = q.contractPlotId;
    if (q.customerId) where.customer_id = q.customerId;
    if (q.category) where.category = q.category;
    if (q.status) where.status = q.status;
    if (q.billingDateFrom || q.billingDateTo) {
      where.billing_date = {
        ...(q.billingDateFrom && { gte: new Date(`${q.billingDateFrom}T00:00:00Z`) }),
        ...(q.billingDateTo && { lte: new Date(`${q.billingDateTo}T23:59:59Z`) }),
      };
    }

    // 未入金は回収可能な債権のみで算出する（#272）。
    // 解約済み（terminated）・貸倒（written_off）は債務/債権が消滅しており、
    // 含めると回収不能金額が「未入金」に積み上がる。#170 の
    // deriveContractPlotPayment と同じく terminated を除外する。
    // AND 合成でユーザー指定の status・category 等のフィルタは維持する。
    // 注: これは請求台帳サマリーで全料金区分（または指定 category）が対象。
    // 区画詳細の uncollected_amount は護持費（管理料）限定（komine-docs#10 項目2）で別概念。
    const collectibleWhere: Prisma.BillingWhereInput = {
      AND: [where, { terminated: false, status: { notIn: ['written_off', 'terminated'] } }],
    };

    const [sums, collectibleSums, totalCount, overdueCount] = await Promise.all([
      prisma.billing.aggregate({
        where,
        _sum: { amount: true, paid_amount: true },
      }),
      prisma.billing.aggregate({
        where: collectibleWhere,
        _sum: { amount: true, paid_amount: true },
      }),
      prisma.billing.count({ where }),
      prisma.billing.count({ where: { ...where, status: 'overdue' } }),
    ]);

    const totalAmount = sums._sum.amount ?? 0;
    const paidAmount = sums._sum.paid_amount ?? 0;
    const collectibleAmount = collectibleSums._sum.amount ?? 0;
    const collectiblePaid = collectibleSums._sum.paid_amount ?? 0;
    const data: BillingSummaryResponse = {
      totalAmount,
      paidAmount,
      // 過入金で負にしない（uncollectedFromTotals と同じ規約）
      unpaidAmount: Math.max(0, collectibleAmount - collectiblePaid),
      overdueCount,
      totalCount,
    };

    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid query'));
      return;
    }
    next(error);
  }
};

/**
 * 請求詳細取得（紐付く入金一覧を含む）
 */
export const getBillingById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const billing = await prisma.billing.findFirst({
      where: { id, deleted_at: null },
      include: {
        ...includeRelations,
        payments: {
          where: { deleted_at: null },
          orderBy: { payment_date: 'desc' },
        },
      },
    });
    if (!billing) throw new NotFoundError('請求が見つかりません');

    res.status(200).json({
      success: true,
      data: {
        ...formatBilling(billing),
        payments: billing.payments.map((p) => ({
          id: p.id,
          paymentDate: p.payment_date?.toISOString().split('T')[0] ?? null,
          scheduledDate: p.scheduled_date?.toISOString().split('T')[0] ?? null,
          paymentAmount: p.payment_amount,
          scheduledAmount: p.scheduled_amount,
          // レガシーセンチネル（legacy-fee-2023000X）を使用料/管理料へ解決して返す（#334）
          feeType: resolvePaymentFeeTypeLabel(p.fee_type),
          staffInCharge: p.staff_in_charge,
          notes: p.notes,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 請求作成
 */
export const createBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createBillingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    // 紐付け先の存在チェック
    const [contractPlot, customer] = await Promise.all([
      prisma.contractPlot.findFirst({
        where: { id: input.contractPlotId, deleted_at: null },
        select: { id: true },
      }),
      prisma.customer.findFirst({
        where: { id: input.customerId, deleted_at: null },
        select: { id: true },
      }),
    ]);
    if (!contractPlot) throw new NotFoundError('指定の契約区画が見つかりません');
    if (!customer) throw new NotFoundError('指定の顧客が見つかりません');

    const created = await prisma.$transaction(async (tx) => {
      const billing = await tx.billing.create({
        data: {
          contract_plot_id: input.contractPlotId,
          customer_id: input.customerId,
          category: input.category,
          amount: input.amount,
          use_start_year: input.useStartYear ?? null,
          use_end_year: input.useEndYear ?? null,
          target_month: input.targetMonth ?? null,
          billing_years: input.billingYears ?? null,
          contract_date: toDateOrNull(input.contractDate),
          billing_date: toDateOrNull(input.billingDate),
          application_type: input.applicationType ?? null,
          billing_type: input.billingType ?? null,
          status: input.status ?? 'pending',
          notes: input.notes ?? null,
        },
        include: includeRelations,
      });
      // 請求額が増えたので ContractPlot の payment_status を再計算（#162）
      await recalculateContractPlotPaymentStatus(tx, input.contractPlotId);
      return billing;
    });

    res.status(201).json({ success: true, data: formatBilling(created) });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid body'));
      return;
    }
    next(error);
  }
};

/**
 * 請求更新（部分更新）
 */
export const updateBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const parsed = updateBillingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    const existing = await prisma.billing.findFirst({ where: { id, deleted_at: null } });
    if (!existing) throw new NotFoundError('請求が見つかりません');

    // status の手動変更は written_off / overdue（とその解除）に限定する（#271）。
    // それ以外の値は更新直後に入金実績からの自動算出（computeBillingStatus）で
    // 上書きされ「UIで選べるのに保存されない」無言破棄になっていたため、
    // 受理できない変更は明示的に 400 で返す。
    // ※同値送信（フォーム全体送信で現在値をそのまま送るケース）は変更なしとして許容。
    const MANUAL_STATUSES: string[] = ['written_off', 'overdue'];
    if (input.status !== undefined && input.status !== existing.status) {
      const manualTarget = MANUAL_STATUSES.includes(input.status);
      const manualRelease = MANUAL_STATUSES.includes(existing.status);
      if (!manualTarget && !manualRelease) {
        throw new ValidationError(
          'ステータスは入金実績から自動算出されるため手動変更できません。' +
            '手動で設定できるのは「貸倒（written_off）」「延滞（overdue）」とその解除のみです'
        );
      }
    }

    const data: Prisma.BillingUpdateInput = {};
    if (input.category !== undefined) data.category = input.category;
    if (input.amount !== undefined) data.amount = input.amount;
    if (input.useStartYear !== undefined) data.use_start_year = input.useStartYear;
    if (input.useEndYear !== undefined) data.use_end_year = input.useEndYear;
    if (input.targetMonth !== undefined) data.target_month = input.targetMonth;
    if (input.billingYears !== undefined) data.billing_years = input.billingYears;
    if (input.contractDate !== undefined) data.contract_date = toDateOrNull(input.contractDate);
    if (input.billingDate !== undefined) data.billing_date = toDateOrNull(input.billingDate);
    if (input.applicationType !== undefined) data.application_type = input.applicationType;
    if (input.billingType !== undefined) data.billing_type = input.billingType;
    if (input.status !== undefined) data.status = input.status;
    if (input.terminated !== undefined) data.terminated = input.terminated;
    if (input.terminatedDate !== undefined)
      data.terminated_date = toDateOrNull(input.terminatedDate);
    if (input.notes !== undefined) data.notes = input.notes;

    // 入金集計・status 算出に影響するフィールドが「実際に変化した」時だけ再集計する（#264）。
    // レガシー移行の Billing は paid_amount を t_seikyu.nyukin_goukei から直接投入しており
    // Payment 行と独立のため（del_flg=1 入金は未移行等）、notes 等の無関係な編集で
    // 無条件に再集計すると移行済みの入金実績が Payment 合計で上書きされ消失する。
    const dateEquals = (a: Date | null, b: Date | null): boolean =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const paymentRelevantChanged =
      (input.amount !== undefined && input.amount !== existing.amount) ||
      (input.terminated !== undefined && input.terminated !== existing.terminated) ||
      (input.status !== undefined && input.status !== existing.status) ||
      (input.billingDate !== undefined &&
        !dateEquals(toDateOrNull(input.billingDate), existing.billing_date));

    const updated = await prisma.$transaction(async (tx) => {
      await tx.billing.update({
        where: { id },
        data,
      });
      // 請求額・解約フラグの変更で paid/partial_paid/terminated 等の status が
      // 変わりうるため、入金合計から status・paid_amount・last_payment_date を
      // 再算出する（#211）。内部で ContractPlot の payment_status 再計算（#162）も行う。
      // written_off / overdue の手動ステータスは computeBillingStatus 側で尊重される。
      if (paymentRelevantChanged) {
        await recalculateBillingPayments(tx, existing.id);
      }
      // status が再書き込みされうるため、レスポンスは再計算後の値を取得し直す
      return tx.billing.findFirst({
        where: { id: existing.id },
        include: includeRelations,
      });
    });

    if (!updated) throw new NotFoundError('請求が見つかりません');

    res.status(200).json({ success: true, data: formatBilling(updated) });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid body'));
      return;
    }
    next(error);
  }
};

/**
 * 請求削除（論理削除）
 *
 * 紐付く Payment は billing_id を null にして孤児化する（onDelete: SetNull）。
 * 物理削除ではなく soft delete のみ実装するので、Prisma の onDelete は発火しない。
 * → 紐付く Payment の billing_id は明示的に null 化する。
 */
export const deleteBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const existing = await prisma.billing.findFirst({ where: { id, deleted_at: null } });
    if (!existing) throw new NotFoundError('請求が見つかりません');

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { billing_id: id, deleted_at: null },
        data: { billing_id: null },
      });
      await tx.billing.update({
        where: { id },
        data: { deleted_at: new Date() },
      });
      // 請求が消えたので ContractPlot の payment_status を再計算（#162）
      await recalculateContractPlotPaymentStatus(tx, existing.contract_plot_id);
    });

    res.status(200).json({ success: true, data: { message: '請求を削除しました' } });
  } catch (error) {
    next(error);
  }
};
