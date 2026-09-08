import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { settleRemainingSchema } from '@komine/types';
import prisma from '../db/prisma';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { recalculateBillingPayments } from '../billings/billingService';
import { isCollectibleUnpaid, remainingAmount } from '../billings/unpaidBillingSearch';
import { feeTypeFromCategory } from './billingCategoryFeeType';
import { formatPayment, includeRelations } from './paymentController';

export const todayJstDateString = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export const settleRemaining = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = settleRemainingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    const { billingId } = parsed.data;

    const created = await prisma.$transaction(
      async (tx) => {
        const billing = await tx.billing.findFirst({
          where: { id: billingId, deleted_at: null },
        });
        if (!billing) throw new NotFoundError('指定の請求が見つかりません');

        const remaining = remainingAmount(billing.amount, billing.paid_amount);
        if (remaining < 1 || !isCollectibleUnpaid(billing.status, remaining)) {
          throw new ValidationError('すでに入金されています。もう一度探してください');
        }

        const payment = await tx.payment.create({
          data: {
            billing_id: billing.id,
            customer_id: billing.customer_id,
            contract_plot_id: billing.contract_plot_id,
            payment_date: new Date(`${todayJstDateString()}T00:00:00Z`),
            payment_amount: remaining,
            fee_type: feeTypeFromCategory(billing.category),
          },
          include: includeRelations,
        });

        await recalculateBillingPayments(tx, billing.id);
        return payment;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ success: true, data: formatPayment(created) });
  } catch (error) {
    next(error);
  }
};
