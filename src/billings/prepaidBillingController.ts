/**
 * 前受金一括処理のコントローラ（#6）
 *
 * 管理料を複数年分まとめて前払いする顧客に対し、受領額と年数の入力から
 * 年ごとの請求（Billing）と入金（Payment）を一度に起票する。実際の受領は
 * 窓口での 1 回だが、帳簿上は年ごとに並べて管理するという業務要件による。
 *
 * 対象年・金額の決定は prepaidBillingLogic の純関数に委ね、ここでは
 * Prisma 操作とレスポンス整形だけを行う。
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import type { CreatePrepaidBillingResponse, PrepaidBillingPreviewResponse } from '@komine/types';
import prisma from '../db/prisma';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { recalculateContractPlotPaymentStatus } from '../plots/services/paymentStatusService';
import {
  DEFAULT_BILLING_MONTH,
  parseBillingMonth,
  parseFeeAmount,
  type ExistingMgmtBilling,
} from './managementFeeBillingService';
import {
  allocateAmounts,
  buildYearRows,
  estimateStartYear,
  findDuplicatedYears,
  findNeedsReviewYears,
} from './prepaidBillingLogic';
import {
  createPrepaidBillingSchema,
  prepaidBillingPreviewSchema,
} from '../validations/billingValidation';

interface PlotContext {
  customerId: string | null;
  annualFee: number | null;
  billingMonth: number;
  existingBillings: ExistingMgmtBilling[];
}

/**
 * 対象区画の管理料設定・請求先顧客・既存の管理料請求をまとめて引く。
 *
 * 請求先は契約者を優先し、無ければ申込者に落とす（managementFeeBillingService と同じ規約）。
 */
async function loadPlotContext(contractPlotId: string): Promise<PlotContext> {
  const plot = await prisma.contractPlot.findFirst({
    where: { id: contractPlotId, deleted_at: null },
    select: {
      id: true,
      managementFee: { select: { management_fee: true, billing_month: true } },
      saleContractRoles: {
        where: { deleted_at: null, role: { in: ['contractor', 'applicant'] } },
        select: { role: true, customer_id: true },
      },
      billings: {
        where: { deleted_at: null, category: 'management_fee' },
        select: { use_start_year: true, use_end_year: true },
      },
    },
  });

  if (!plot) throw new NotFoundError('指定の契約区画が見つかりません');

  const roles = plot.saleContractRoles;
  const target =
    roles.find((r) => r.role === 'contractor') ?? roles.find((r) => r.role === 'applicant');

  return {
    customerId: target?.customer_id ?? null,
    annualFee: parseFeeAmount(plot.managementFee?.management_fee),
    billingMonth: plot.managementFee
      ? parseBillingMonth(plot.managementFee.billing_month)
      : DEFAULT_BILLING_MONTH,
    existingBillings: plot.billings,
  };
}

/**
 * POST /api/v1/billings/prepaid/preview
 * 年ごとの割当額・重複年・年額との差額を返す（DB は変更しない）
 */
export const previewPrepaidBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = prepaidBillingPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    const ctx = await loadPlotContext(input.contractPlotId);
    const estimated = estimateStartYear(ctx.existingBillings, new Date().getFullYear());
    const startYear = input.startYear ?? estimated.startYear;

    const rows = buildYearRows(
      startYear,
      allocateAmounts(input.receivedAmount, input.years),
      ctx.existingBillings
    );

    const data: PrepaidBillingPreviewResponse = {
      rows,
      startYear,
      startYearEstimated: estimated.estimated,
      annualFee: ctx.annualFee,
      difference: ctx.annualFee == null ? null : input.receivedAmount - ctx.annualFee * input.years,
      duplicatedYears: findDuplicatedYears(rows),
      needsReviewYears: findNeedsReviewYears(rows),
    };

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/billings/prepaid
 * 年数分の請求と入金を 1 トランザクションで作成する
 */
export const createPrepaidBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createPrepaidBillingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    const ctx = await loadPlotContext(input.contractPlotId);
    if (!ctx.customerId) {
      throw new ValidationError(
        '請求先の顧客が登録されていないため前受金を登録できません（契約者または申込者が必要です）'
      );
    }

    const rows = buildYearRows(
      input.startYear,
      allocateAmounts(input.receivedAmount, input.years),
      ctx.existingBillings
    );

    // 二重請求は業務上いちばん困るため、1 年でも重なるなら作らずに返す
    const duplicatedYears = findDuplicatedYears(rows);
    if (duplicatedYears.length > 0) {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATED_YEARS',
          message: `既に請求がある年が含まれています（${duplicatedYears.join('、')}年）`,
          details: { years: duplicatedYears },
        },
      });
      return;
    }

    const prepaidBatchId = randomUUID();
    const paymentDate = new Date(`${input.paymentDate}T00:00:00Z`);
    const endYear = input.startYear + input.years - 1;
    const notes =
      input.notes ??
      `前受金一括登録（${input.startYear}年〜${endYear}年 / ${input.receivedAmount.toLocaleString('ja-JP')}円）`;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const billing = await tx.billing.create({
          data: {
            contract_plot_id: input.contractPlotId,
            customer_id: ctx.customerId as string,
            category: 'management_fee',
            amount: row.amount,
            use_start_year: row.year,
            use_end_year: row.year,
            billing_years: 1,
            target_month: ctx.billingMonth,
            billing_date: new Date(Date.UTC(row.year, ctx.billingMonth - 1, 1)),
            status: 'paid',
            paid_amount: row.amount,
            last_payment_date: paymentDate,
            prepaid_batch_id: prepaidBatchId,
            notes,
          },
        });

        await tx.payment.create({
          data: {
            billing_id: billing.id,
            contract_plot_id: input.contractPlotId,
            customer_id: ctx.customerId as string,
            payment_date: paymentDate,
            payment_amount: row.amount,
            fee_type: '管理料',
            prepaid_batch_id: prepaidBatchId,
            notes,
          },
        });
      }

      await recalculateContractPlotPaymentStatus(tx, input.contractPlotId);
    });

    const data: CreatePrepaidBillingResponse = {
      prepaidBatchId,
      billingCount: rows.length,
      startYear: input.startYear,
      endYear,
      totalAmount: input.receivedAmount,
    };

    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/billings/prepaid/:batchId
 * 一括登録した請求と入金をまとめて論理削除する
 */
export const deletePrepaidBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { batchId } = req.params as Record<string, string>;

    const billings = await prisma.billing.findMany({
      where: { prepaid_batch_id: batchId, deleted_at: null },
      select: { id: true, contract_plot_id: true },
    });
    if (billings.length === 0) {
      throw new NotFoundError('指定の前受金登録が見つかりません');
    }

    const contractPlotIds = [...new Set(billings.map((b) => b.contract_plot_id))];
    const deletedAt = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { prepaid_batch_id: batchId, deleted_at: null },
        data: { deleted_at: deletedAt },
      });
      await tx.billing.updateMany({
        where: { prepaid_batch_id: batchId, deleted_at: null },
        data: { deleted_at: deletedAt },
      });
      for (const id of contractPlotIds) {
        await recalculateContractPlotPaymentStatus(tx, id);
      }
    });

    res.status(200).json({
      success: true,
      data: { message: `前受金の登録を取り消しました（請求${billings.length}件）` },
    });
  } catch (error) {
    next(error);
  }
};
