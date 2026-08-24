import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import prisma from '../db/prisma';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import {
  createPaymentSchema,
  updatePaymentSchema,
  listPaymentsQuerySchema,
} from '../validations/paymentValidation';
import { recalculateBillingPayments } from '../billings/billingService';
import { resolvePaymentFeeTypeLabel } from './feeTypeLabels';

type PaymentWithRelations = Prisma.PaymentGetPayload<{
  include: {
    billing: {
      select: {
        id: true;
        category: true;
        amount: true;
        billing_date: true;
        status: true;
        use_start_year: true;
        target_month: true;
        customer: { select: { id: true; name: true; name_kana: true } };
      };
    };
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

const formatPayment = (p: PaymentWithRelations) => ({
  id: p.id,
  billingId: p.billing_id,
  customerId: p.customer_id,
  contractPlotId: p.contract_plot_id,
  scheduledDate: p.scheduled_date?.toISOString().split('T')[0] ?? null,
  scheduledAmount: p.scheduled_amount,
  paymentDate: p.payment_date?.toISOString().split('T')[0] ?? null,
  paymentAmount: p.payment_amount,
  // レガシーセンチネル（legacy-fee-2023000X）を使用料/管理料へ解決して返す（#334）
  feeType: resolvePaymentFeeTypeLabel(p.fee_type),
  applicationType: p.application_type,
  billingType: p.billing_type,
  staffInCharge: p.staff_in_charge,
  notes: p.notes,
  legacyNyukinCd: p.legacy_nyukin_cd,
  billing: p.billing
    ? {
        id: p.billing.id,
        category: p.billing.category,
        amount: p.billing.amount,
        billingDate: p.billing.billing_date?.toISOString().split('T')[0] ?? null,
        status: p.billing.status,
        // 請求の対象期間。"2026-03" 形式。どちらか欠けていれば null
        billingYearMonth:
          p.billing.use_start_year !== null && p.billing.target_month !== null
            ? `${p.billing.use_start_year}-${String(p.billing.target_month).padStart(2, '0')}`
            : null,
      }
    : null,
  // 入金の顧客は直リンク（Payment.customer）優先、無ければ請求経由（Billing.customer）。
  // 請求経由の入金でも名前が出るようにする（名前で探す運用のため）
  customer: p.customer
    ? { id: p.customer.id, name: p.customer.name, nameKana: p.customer.name_kana }
    : p.billing?.customer
      ? {
          id: p.billing.customer.id,
          name: p.billing.customer.name,
          nameKana: p.billing.customer.name_kana,
        }
      : null,
  plotNumber: p.contractPlot?.physicalPlot.plot_number ?? null,
  displayNumber: p.contractPlot?.physicalPlot.display_number ?? null,
  areaName: p.contractPlot?.physicalPlot.area_name ?? null,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
});

const includeRelations = {
  billing: {
    select: {
      id: true,
      category: true,
      amount: true,
      billing_date: true,
      status: true,
      // 請求の対象期間。「2026年3月分」の表示・絞り込みに使う
      use_start_year: true,
      target_month: true,
      // 請求経由の入金は顧客が Billing 側にある（実データで入金12,505件のうち
      // 12,372件が billing_id を持つ）。ここを返さないと名前で一覧を組めない
      customer: { select: { id: true, name: true, name_kana: true } },
    },
  },
  customer: { select: { id: true, name: true, name_kana: true } },
  contractPlot: {
    select: {
      id: true,
      physicalPlot: {
        select: { id: true, plot_number: true, display_number: true, area_name: true },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

/**
 * 入金一覧取得
 */
export const getPayments = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = listPaymentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const q = parsed.data;
    const skip = (q.page - 1) * q.limit;

    const where: Prisma.PaymentWhereInput = { deleted_at: null };
    if (q.billingId) where.billing_id = q.billingId;
    if (q.customerId) where.customer_id = q.customerId;
    if (q.contractPlotId) where.contract_plot_id = q.contractPlotId;
    if (q.orphan === true) where.billing_id = null;
    if (q.orphan === false) where.billing_id = { not: null };
    if (q.paymentDateFrom || q.paymentDateTo) {
      where.payment_date = {
        ...(q.paymentDateFrom && { gte: new Date(`${q.paymentDateFrom}T00:00:00Z`) }),
        ...(q.paymentDateTo && { lte: new Date(`${q.paymentDateTo}T23:59:59Z`) }),
      };
    }

    // 顧客名で絞る（議事録 2026-07-21 §7）。
    // 入金の顧客は Payment.customer（直リンク）と Billing.customer（請求経由）の
    // 2経路がある。片方だけ見ると取りこぼすため OR で両方を対象にする。
    // 漢字・カナの両方で引けるようにする（議事録 §3）
    if (q.name) {
      const nameMatch = {
        OR: [
          { name: { contains: q.name, mode: 'insensitive' as const } },
          { name_kana: { contains: q.name, mode: 'insensitive' as const } },
        ],
      };
      where.OR = [{ customer: nameMatch }, { billing: { customer: nameMatch } }];
    }

    // 請求年月で絞る（議事録 2026-07-21 §7）。
    // 請求を出した日ではなく請求の対象期間（use_start_year + target_month）で絞る。
    // 「2026年3月分の請求」を探す用途のため
    if (q.billingYearMonth) {
      const [year, month] = q.billingYearMonth.split('-');
      where.billing = {
        use_start_year: Number(year),
        target_month: Number(month),
      };
    }

    const [items, totalCount] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: q.limit,
        orderBy: { [q.sortBy]: q.sortOrder },
        include: includeRelations,
      }),
      prisma.payment.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        items: items.map(formatPayment),
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
 * 入金詳細取得
 */
export const getPaymentById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const payment = await prisma.payment.findFirst({
      where: { id, deleted_at: null },
      include: includeRelations,
    });
    if (!payment) throw new NotFoundError('入金が見つかりません');

    res.status(200).json({ success: true, data: formatPayment(payment) });
  } catch (error) {
    next(error);
  }
};

/**
 * 入金作成
 *
 * billing_id 紐付けがある場合: 紐付け先 Billing を再集計する。
 * 孤児入金（billing_id なし）: customer_id or contract_plot_id のいずれかが必須（schema レベル）。
 */
export const createPayment = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    // 紐付け先の存在チェック
    let billing: { id: string; contract_plot_id: string; customer_id: string | null } | null = null;
    if (input.billingId) {
      billing = await prisma.billing.findFirst({
        where: { id: input.billingId, deleted_at: null },
        select: { id: true, contract_plot_id: true, customer_id: true },
      });
      if (!billing) throw new NotFoundError('指定の請求が見つかりません');

      // 入金集計は Billing 経由（billing.contract_plot_id）で行われるため、
      // Payment 側に別区画/別顧客を記録すると表示と集計が乖離する（#213）。
      // 不一致は明示エラーとし、未指定時は billing 側の値で正規化する。
      if (input.contractPlotId && input.contractPlotId !== billing.contract_plot_id) {
        throw new ValidationError('指定された契約区画が請求の契約区画と一致しません');
      }
      if (input.customerId && billing.customer_id && input.customerId !== billing.customer_id) {
        throw new ValidationError('指定された顧客が請求の顧客と一致しません');
      }
    }
    if (input.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: input.customerId, deleted_at: null },
        select: { id: true },
      });
      if (!customer) throw new NotFoundError('指定の顧客が見つかりません');
    }
    if (input.contractPlotId) {
      const plot = await prisma.contractPlot.findFirst({
        where: { id: input.contractPlotId, deleted_at: null },
        select: { id: true },
      });
      if (!plot) throw new NotFoundError('指定の契約区画が見つかりません');
    }

    const created = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          billing_id: input.billingId ?? null,
          // billing 紐付け時は billing 側の値で正規化（区画コンテキストの
          // 入金一覧と集計の一致を不変条件として強制する #213）
          customer_id: billing ? billing.customer_id : (input.customerId ?? null),
          contract_plot_id: billing ? billing.contract_plot_id : (input.contractPlotId ?? null),
          scheduled_date: toDateOrNull(input.scheduledDate),
          scheduled_amount: input.scheduledAmount ?? null,
          payment_date: toDateOrNull(input.paymentDate),
          payment_amount: input.paymentAmount,
          fee_type: input.feeType ?? null,
          application_type: input.applicationType ?? null,
          billing_type: input.billingType ?? null,
          staff_in_charge: input.staffInCharge ?? null,
          notes: input.notes ?? null,
        },
        include: includeRelations,
      });
      if (input.billingId) {
        await recalculateBillingPayments(tx, input.billingId);
      }
      return payment;
    });

    res.status(201).json({ success: true, data: formatPayment(created) });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid body'));
      return;
    }
    next(error);
  }
};

/**
 * 入金更新
 *
 * billing_id を変更した場合は、変更前後両方の Billing を再集計する。
 */
export const updatePayment = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const parsed = updatePaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const input = parsed.data;

    const existing = await prisma.payment.findFirst({ where: { id, deleted_at: null } });
    if (!existing) throw new NotFoundError('入金が見つかりません');

    // billing 紐付けの設定/変更時は、区画・顧客の整合を検証し billing 側へ正規化する（#213）
    let connectedBilling: {
      id: string;
      contract_plot_id: string;
      customer_id: string | null;
    } | null = null;
    if (input.billingId) {
      connectedBilling = await prisma.billing.findFirst({
        where: { id: input.billingId, deleted_at: null },
        select: { id: true, contract_plot_id: true, customer_id: true },
      });
      if (!connectedBilling) throw new NotFoundError('指定の請求が見つかりません');

      const effectiveContractPlotId =
        input.contractPlotId !== undefined ? input.contractPlotId : existing.contract_plot_id;
      if (
        effectiveContractPlotId &&
        effectiveContractPlotId !== connectedBilling.contract_plot_id
      ) {
        throw new ValidationError('指定された契約区画が請求の契約区画と一致しません');
      }
      const effectiveCustomerId =
        input.customerId !== undefined ? input.customerId : existing.customer_id;
      if (
        effectiveCustomerId &&
        connectedBilling.customer_id &&
        effectiveCustomerId !== connectedBilling.customer_id
      ) {
        throw new ValidationError('指定された顧客が請求の顧客と一致しません');
      }
    }

    const data: Prisma.PaymentUpdateInput = {};
    if (input.billingId !== undefined) {
      data.billing = input.billingId ? { connect: { id: input.billingId } } : { disconnect: true };
    }
    if (input.customerId !== undefined) {
      data.customer = input.customerId
        ? { connect: { id: input.customerId } }
        : { disconnect: true };
    }
    if (input.contractPlotId !== undefined) {
      data.contractPlot = input.contractPlotId
        ? { connect: { id: input.contractPlotId } }
        : { disconnect: true };
    }
    // billing 紐付け時は区画・顧客を billing 側の値で正規化（未指定でも揃える）
    if (connectedBilling) {
      data.contractPlot = { connect: { id: connectedBilling.contract_plot_id } };
      if (connectedBilling.customer_id) {
        data.customer = { connect: { id: connectedBilling.customer_id } };
      }
    }
    if (input.scheduledDate !== undefined) data.scheduled_date = toDateOrNull(input.scheduledDate);
    if (input.scheduledAmount !== undefined) data.scheduled_amount = input.scheduledAmount;
    if (input.paymentDate !== undefined) data.payment_date = toDateOrNull(input.paymentDate);
    if (input.paymentAmount !== undefined) data.payment_amount = input.paymentAmount;
    if (input.feeType !== undefined) data.fee_type = input.feeType;
    if (input.applicationType !== undefined) data.application_type = input.applicationType;
    if (input.billingType !== undefined) data.billing_type = input.billingType;
    if (input.staffInCharge !== undefined) data.staff_in_charge = input.staffInCharge;
    if (input.notes !== undefined) data.notes = input.notes;

    const updated = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.update({ where: { id }, data, include: includeRelations });

      // 影響を受ける Billing 群を再集計（変更前後で異なる場合は両方）
      const affectedBillingIds = new Set<string>();
      if (existing.billing_id) affectedBillingIds.add(existing.billing_id);
      if (payment.billing_id) affectedBillingIds.add(payment.billing_id);
      for (const bId of affectedBillingIds) {
        await recalculateBillingPayments(tx, bId);
      }
      return payment;
    });

    res.status(200).json({ success: true, data: formatPayment(updated) });
  } catch (error) {
    if (error instanceof ZodError) {
      next(new ValidationError(error.issues[0]?.message ?? 'Invalid body'));
      return;
    }
    next(error);
  }
};

/**
 * 入金削除（論理削除）
 *
 * 紐付く Billing を削除後に再集計する。
 */
export const deletePayment = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const existing = await prisma.payment.findFirst({ where: { id, deleted_at: null } });
    if (!existing) throw new NotFoundError('入金が見つかりません');

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: { deleted_at: new Date() },
      });
      if (existing.billing_id) {
        await recalculateBillingPayments(tx, existing.billing_id);
      }
    });

    res.status(200).json({ success: true, data: { message: '入金を削除しました' } });
  } catch (error) {
    next(error);
  }
};
