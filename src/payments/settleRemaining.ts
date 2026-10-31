import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { settleRemainingSchema } from '@komine/types';
import prisma from '../db/prisma';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import { recalculateBillingPayments } from '../billings/billingService';
import { isCollectibleUnpaid, remainingAmount } from '../billings/unpaidBillingSearch';
import { feeTypeFromCategory } from './billingCategoryFeeType';

const ALREADY_PAID = 'すでに入金されています。もう一度探してください';
const AMOUNT_TOO_HIGH = '残っている金額までにしてください';
const REMAINING_CHANGED = '残額が変わっています。もう一度探してください';
const NEED_NEXT_DATE = '次に払う日を書いてください';
const NEED_PAYMENT_DATE = 'もらった日を書いてください';
const FUTURE_PAYMENT_DATE =
  'もらった日は今日以前にしてください。これからの日は次に払う日に書いてください';
const NEED_POSITIVE_AMOUNT = '今回の金額は1円以上にしてください';
const NEXT_DATE_WRONG_KIND = 'この種類には次に払う日を残せません';

export const todayJstDateString = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

const utcDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

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
    const { billingId, paymentAmount, paymentDate, nextPaymentDate, seenRemaining } = parsed.data;

    const result = await prisma.$transaction(
      async (tx) => {
        const billing = await tx.billing.findFirst({
          where: { id: billingId, deleted_at: null },
        });
        if (!billing) throw new NotFoundError('指定の請求が見つかりません');

        const remaining = remainingAmount(billing.amount, billing.paid_amount);
        if (remaining < 1 || !isCollectibleUnpaid(billing.status, remaining)) {
          throw new ValidationError(ALREADY_PAID);
        }

        const isManagement = billing.category === 'management_fee';
        if (!isManagement && nextPaymentDate) {
          throw new ValidationError(NEXT_DATE_WRONG_KIND);
        }
        if (paymentAmount > remaining) {
          throw new ValidationError(
            seenRemaining !== undefined && seenRemaining !== remaining
              ? REMAINING_CHANGED
              : AMOUNT_TOO_HIGH
          );
        }
        if (!isManagement && paymentAmount < 1) {
          throw new ValidationError(NEED_POSITIVE_AMOUNT);
        }
        if (isManagement && paymentAmount < remaining && !nextPaymentDate) {
          throw new ValidationError(NEED_NEXT_DATE);
        }
        if (paymentAmount >= 1 && !paymentDate) {
          throw new ValidationError(NEED_PAYMENT_DATE);
        }
        if (paymentAmount >= 1 && paymentDate && paymentDate > todayJstDateString()) {
          throw new ValidationError(FUTURE_PAYMENT_DATE);
        }

        if (paymentAmount >= 1 && paymentDate) {
          await tx.payment.create({
            data: {
              billing_id: billing.id,
              customer_id: billing.customer_id,
              contract_plot_id: billing.contract_plot_id,
              payment_date: utcDate(paymentDate),
              payment_amount: paymentAmount,
              fee_type: feeTypeFromCategory(billing.category),
            },
          });
          await recalculateBillingPayments(tx, billing.id);
        }

        const remainingAfter = remaining - paymentAmount;
        const keptNextDate =
          isManagement && remainingAfter >= 1 && nextPaymentDate ? nextPaymentDate : null;
        if (keptNextDate) {
          await tx.billing.update({
            where: { id: billing.id },
            data: { next_payment_date: utcDate(keptNextDate) },
          });
        }

        return {
          remainingAmount: remainingAfter,
          nextPaymentDate: keptNextDate,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
