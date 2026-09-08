/**
 * 窓口入金向けの未払い請求検索。
 *
 * 名前・区画番号で絞り、残額のある請求だけを返す。件数が多すぎるときは
 * 名前を長くしてもらう（上限 50 件）。残額入金（settle）はここでは扱わない。
 */

import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import {
  BillingCategory,
  listUnpaidBillingsQuerySchema,
  type UnpaidBillingItem,
} from '@komine/types';
import prisma from '../db/prisma';
import { ValidationError } from '../middleware/errorHandler';
import {
  displayYear,
  isCollectibleUnpaid,
  jstYear,
  remainingAmount,
  TOO_MANY_UNPAID,
} from './unpaidBillingSearch';

const nameContains = (q: string) => ({
  contains: q,
  mode: 'insensitive' as const,
});

const containsIgnoreCase = (value: string | null | undefined, q: string): boolean =>
  !!value && value.toLocaleLowerCase().includes(q.toLocaleLowerCase());

type UnpaidBillingRow = Prisma.BillingGetPayload<{
  include: {
    customer: { select: { id: true; name: true; name_kana: true } };
    contractPlot: {
      select: {
        physicalPlot: {
          select: { plot_number: true; display_number: true; area_name: true };
        };
        saleContractRoles: {
          select: { role: true; customer: { select: { name: true; name_kana: true } } };
        };
        buriedPersons: { select: { name: true; name_kana: true } };
      };
    };
  };
}>;

const includeUnpaidRelations = {
  customer: { select: { id: true, name: true, name_kana: true } },
  contractPlot: {
    select: {
      physicalPlot: {
        select: { plot_number: true, display_number: true, area_name: true },
      },
      saleContractRoles: {
        where: { deleted_at: null, role: 'contractor' },
        select: {
          role: true,
          customer: { select: { name: true, name_kana: true } },
        },
      },
      buriedPersons: {
        where: { deleted_at: null },
        select: { name: true, name_kana: true },
      },
    },
  },
} satisfies Prisma.BillingInclude;

const toUnpaidItem = (row: UnpaidBillingRow, q: string): UnpaidBillingItem => {
  const contractor =
    row.contractPlot?.saleContractRoles.find((r) => r.role === 'contractor')?.customer?.name ??
    null;
  const buried = row.contractPlot?.buriedPersons.find(
    (p) => containsIgnoreCase(p.name, q) || containsIgnoreCase(p.name_kana, q)
  );

  return {
    billingId: row.id,
    contractPlotId: row.contract_plot_id,
    customerId: row.customer_id ?? row.customer?.id ?? null,
    contractorName: contractor ?? row.customer?.name ?? null,
    buriedPersonName: buried?.name ?? null,
    plotNumber: row.contractPlot?.physicalPlot?.plot_number ?? null,
    displayNumber: row.contractPlot?.physicalPlot?.display_number ?? null,
    category: row.category as BillingCategory,
    year: displayYear(row.use_start_year, row.use_end_year, jstYear(row.billing_date)),
    remainingAmount: remainingAmount(row.amount, row.paid_amount),
  };
};

/**
 * GET /api/v1/billings/unpaid
 * 窓口で残額を探すための未払い請求一覧
 */
export const getUnpaidBillings = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = listUnpaidBillingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const { q, year, category } = parsed.data;

    const nameOr: Prisma.BillingWhereInput[] = [
      {
        customer: {
          OR: [{ name: nameContains(q) }, { name_kana: nameContains(q) }],
        },
      },
      {
        contractPlot: {
          saleContractRoles: {
            some: {
              deleted_at: null,
              role: 'contractor',
              customer: {
                OR: [{ name: nameContains(q) }, { name_kana: nameContains(q) }],
              },
            },
          },
        },
      },
      {
        contractPlot: {
          buriedPersons: {
            some: {
              deleted_at: null,
              OR: [{ name: nameContains(q) }, { name_kana: nameContains(q) }],
            },
          },
        },
      },
      {
        contractPlot: {
          physicalPlot: {
            OR: [{ plot_number: nameContains(q) }, { display_number: nameContains(q) }],
          },
        },
      },
    ];

    const where: Prisma.BillingWhereInput = {
      deleted_at: null,
      status: { notIn: ['paid', 'terminated', 'written_off'] },
      OR: nameOr,
    };

    if (category) {
      where.category = category;
    }

    if (year !== undefined) {
      const yearOr: Prisma.BillingWhereInput[] = [
        { use_start_year: year },
        { use_end_year: year },
        {
          AND: [
            { use_start_year: null },
            { use_end_year: null },
            {
              billing_date: {
                gte: new Date(`${year}-01-01T00:00:00.000Z`),
                lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
              },
            },
          ],
        },
      ];
      delete where.OR;
      where.AND = [{ OR: yearOr }, { OR: nameOr }];
    }

    const rows = await prisma.billing.findMany({
      where,
      take: 51,
      include: includeUnpaidRelations,
    });

    const collectible = rows.filter((row) => {
      const remaining = remainingAmount(row.amount, row.paid_amount);
      return isCollectibleUnpaid(row.status, remaining) && remaining >= 1;
    });

    if (collectible.length >= 51) {
      throw new ValidationError(TOO_MANY_UNPAID);
    }

    const items = collectible.map((row) => toUnpaidItem(row, q));
    res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    next(error);
  }
};
