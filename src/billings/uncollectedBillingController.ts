/**
 * 未収金一覧向けの護持費未払い請求検索。
 *
 * 名前は任意（空なら全員）。ページ送りする。窓口入金の GET /unpaid とは別。
 */

import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import {
  BillingCategory,
  listUncollectedBillingsQuerySchema,
  type UnpaidBillingItem,
} from '@komine/types';
import prisma from '../db/prisma';
import { ValidationError } from '../middleware/errorHandler';
import { displayYear, isCollectibleUnpaid, jstYear, remainingAmount } from './unpaidBillingSearch';

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

const nameOrConditions = (q: string): Prisma.BillingWhereInput[] => [
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

const yearOrConditions = (year: number): Prisma.BillingWhereInput[] => [
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

const toUnpaidItem = (row: UnpaidBillingRow, q: string | undefined): UnpaidBillingItem => {
  const contractor =
    row.contractPlot?.saleContractRoles.find((r) => r.role === 'contractor')?.customer?.name ??
    null;
  const buried = q
    ? row.contractPlot?.buriedPersons.find(
        (p) => containsIgnoreCase(p.name, q) || containsIgnoreCase(p.name_kana, q)
      )
    : undefined;

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

const displayNumberOf = (row: UnpaidBillingRow): string | null =>
  row.contractPlot?.physicalPlot?.display_number ?? null;

const compareCollectible = (a: UnpaidBillingRow, b: UnpaidBillingRow): number => {
  const remainingDiff =
    remainingAmount(b.amount, b.paid_amount) - remainingAmount(a.amount, a.paid_amount);
  if (remainingDiff !== 0) return remainingDiff;

  const da = displayNumberOf(a);
  const db = displayNumberOf(b);
  if (da == null && db == null) return 0;
  if (da == null) return 1;
  if (db == null) return -1;
  if (da < db) return -1;
  if (da > db) return 1;
  return 0;
};

/**
 * GET /api/v1/billings/uncollected
 * 護持費の未払い請求を全員分一覧する（名前は任意・ページ送り）
 */
export const getUncollectedBillings = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parsed = listUncollectedBillingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const { q, year, page, limit } = parsed.data;

    const where: Prisma.BillingWhereInput = {
      deleted_at: null,
      status: { notIn: ['paid', 'terminated', 'written_off'] },
      category: 'management_fee',
    };

    const nameOr = q ? nameOrConditions(q) : undefined;
    const yearOr = year !== undefined ? yearOrConditions(year) : undefined;

    if (nameOr && yearOr) {
      where.AND = [{ OR: yearOr }, { OR: nameOr }];
    } else if (nameOr) {
      where.OR = nameOr;
    } else if (yearOr) {
      where.OR = yearOr;
    }

    const rows = await prisma.billing.findMany({
      where,
      include: includeUnpaidRelations,
    });

    const collectible = rows
      .filter((row) => {
        const remaining = remainingAmount(row.amount, row.paid_amount);
        return (
          isCollectibleUnpaid(row.status, remaining) &&
          remaining >= 1 &&
          row.category === 'management_fee'
        );
      })
      .sort(compareCollectible);

    const totalCount = collectible.length;
    const start = (page - 1) * limit;
    const items = collectible.slice(start, start + limit).map((row) => toUnpaidItem(row, q));

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
