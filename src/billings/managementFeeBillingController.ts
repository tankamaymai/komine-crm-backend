/**
 * 選んだ年・月の管理料請求をまとめて作る。
 * すでにその年の請求がある人、5年・10年まとめて払う人は作らない。
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import prisma from '../db/prisma';
import { ValidationError } from '../middleware/errorHandler';
import { generateManagementFeeBillingSchema } from '../validations/billingValidation';
import { generateManagementFeeBillings } from './managementFeeBillingService';

export const generateManagementFeeBilling = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = generateManagementFeeBillingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw zodError(parsed.error);
    }

    const result = await generateManagementFeeBillings(prisma, {
      targetYear: parsed.data.year,
      month: parsed.data.month,
      apply: parsed.data.apply,
    });

    res.status(200).json({
      success: true,
      data: {
        year: result.targetYear,
        month: parsed.data.month,
        apply: parsed.data.apply,
        created: result.created,
        skippedExisting: result.skippedExisting,
        skippedPrepaid: result.skippedPrepaid,
        skippedNoAmount: result.skippedNoAmount,
        skippedNoCustomer: result.skippedNoCustomer,
        needsReview: result.needsReview,
      },
    });
  } catch (error) {
    next(error);
  }
};

const zodError = (err: ZodError): ValidationError =>
  new ValidationError(
    '年と月を確認してください',
    err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
  );
