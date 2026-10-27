/**
 * ゆうちょ自動払込みの結果ファイルを台帳に突き合わせ、引き落とせた分に入金を付ける。
 *
 * 突き合わせの候補は、引き落としファイルを出したときと同じ「選んだ年・月の管理料」の一覧。
 * 支払人コードが一致すればその区画、無ければ記号・番号・金額が一致する区画に当てる。
 * 入金はその年の管理料の請求（Billing）に付ける。請求が無い・もう払い済みの区画には付けない。
 * 何度取り込んでも、払い済みの請求には二重に付かない。
 */

import { BillingCategory, Prisma } from '@prisma/client';
import prisma from '../db/prisma';
import { recalculateBillingPayments } from '../billings/billingService';
import { isCollectibleUnpaid, remainingAmount } from '../billings/unpaidBillingSearch';
import { feeTypeFromCategory } from '../payments/billingCategoryFeeType';
import type { YuchoBillingItem } from '../validations/yuchoValidation';
import { resolveBranchAndAccount } from './yuchoCsv';
import { fetchYuchoBillingData } from './yuchoService';
import { isExistingDate } from './yuchoBusinessDay';
import {
  parseYuchoResultFile,
  YuchoResultFileError,
  YUCHO_RESULT_LABEL,
  type YuchoResultDataRecord,
} from './yuchoResultFile';

export type YuchoResultRowStatus =
  | 'will_record'
  | 'already_paid'
  | 'no_billing'
  | 'amount_mismatch'
  | 'failed'
  | 'unmatched';

export interface YuchoResultPlanRow {
  lineNo: number;
  resultCode: string;
  resultLabel: string;
  amount: number;
  kana: string;
  status: YuchoResultRowStatus;
  contractPlotId: string | null;
  billingId: string | null;
  plotNumber: string | null;
  displayNumber: string | null;
  areaName: string | null;
  customerName: string | null;
  /** 入金を付ける前の、請求の残り */
  remainingAmount: number | null;
}

export interface YuchoResultPlan {
  year: number;
  month: number;
  /** 引き落とし日（YYYY-MM-DD）。入金日になる */
  transferDate: string;
  /** ファイルの引き落とし月が、画面で選んだ月と違う */
  monthMismatch: boolean;
  rows: YuchoResultPlanRow[];
  summary: Record<YuchoResultRowStatus, { count: number; amount: number }>;
}

export interface YuchoResultApplyResult {
  plan: YuchoResultPlan;
  recordedCount: number;
  recordedAmount: number;
  /** 引き落とせなかったことを請求の備考に書いた件数 */
  notedFailedCount: number;
  /** 確認のあとに入金済みになっていた等で、付けなかった件数 */
  skippedCount: number;
}

type Client = Prisma.TransactionClient | typeof prisma;

type YearBilling = {
  id: string;
  contract_plot_id: string;
  amount: number;
  paid_amount: number;
  status: string;
  notes: string | null;
};

const PAYMENT_NOTE = 'ゆうちょ自動払込（結果ファイル取り込み）';

const pad = (value: string, width: number): string =>
  value.replace(/\D/g, '').padStart(width, '0').slice(-width);

const accountKey = (branchCode: string, accountNumber: string): string =>
  `${pad(branchCode, 3)}-${pad(accountNumber, 7)}`;

/** 結果の1行を、候補の区画1つに当てる。同じ口座・同じ金額が複数あれば、まだ当てていないものから順に */
const matchCandidates = (
  records: YuchoResultDataRecord[],
  candidates: YuchoBillingItem[]
): Map<number, YuchoBillingItem> => {
  const byPayerCode = new Map<string, YuchoBillingItem>();
  const byAccount = new Map<string, YuchoBillingItem[]>();
  for (const item of candidates) {
    if (item.payerCode) byPayerCode.set(item.payerCode, item);
    const { branchCode, accountNumber } = resolveBranchAndAccount(item);
    if (!branchCode || !accountNumber) continue;
    const key = accountKey(branchCode, accountNumber);
    byAccount.set(key, [...(byAccount.get(key) ?? []), item]);
  }

  const used = new Set<YuchoBillingItem>();
  const matched = new Map<number, YuchoBillingItem>();
  for (const record of records) {
    const byCode = record.payerCode ? byPayerCode.get(record.payerCode) : undefined;
    const sameAccount = byAccount.get(accountKey(record.branchCode, record.accountNumber)) ?? [];
    const item =
      (byCode && !used.has(byCode) ? byCode : undefined) ??
      sameAccount.find((c) => !used.has(c) && c.billingAmount === record.amount);
    if (item) {
      used.add(item);
      matched.set(record.lineNo, item);
    }
  }
  return matched;
};

const coversYear = (
  b: { use_start_year: number | null; use_end_year: number | null },
  year: number
) =>
  b.use_start_year != null &&
  b.use_start_year <= year &&
  (b.use_end_year ?? b.use_start_year) >= year;

const findYearBillings = async (
  client: Client,
  plotIds: string[],
  year: number
): Promise<Map<string, YearBilling[]>> => {
  const map = new Map<string, YearBilling[]>();
  if (plotIds.length === 0) return map;
  const billings = await client.billing.findMany({
    where: {
      deleted_at: null,
      terminated: false,
      category: BillingCategory.management_fee,
      contract_plot_id: { in: plotIds },
    },
    select: {
      id: true,
      contract_plot_id: true,
      amount: true,
      paid_amount: true,
      status: true,
      notes: true,
      use_start_year: true,
      use_end_year: true,
    },
    orderBy: { created_at: 'asc' },
  });
  for (const b of billings) {
    if (!coversYear(b, year)) continue;
    map.set(b.contract_plot_id, [...(map.get(b.contract_plot_id) ?? []), b]);
  }
  return map;
};

const emptySummary = (): YuchoResultPlan['summary'] => ({
  will_record: { count: 0, amount: 0 },
  already_paid: { count: 0, amount: 0 },
  no_billing: { count: 0, amount: 0 },
  amount_mismatch: { count: 0, amount: 0 },
  failed: { count: 0, amount: 0 },
  unmatched: { count: 0, amount: 0 },
});

const buildPlan = async (
  client: Client,
  params: { year: number; month: number; file: Buffer }
): Promise<YuchoResultPlan> => {
  const { year, month } = params;
  const parsed = parseYuchoResultFile(params.file);
  if (!isExistingDate(year, parsed.transferMonth, parsed.transferDay)) {
    throw new YuchoResultFileError(
      `${year}年${parsed.transferMonth}月${parsed.transferDay}日はありません。年の選び方を確かめてください`
    );
  }

  const { items } = await fetchYuchoBillingData({
    year,
    month,
    category: 'management',
    status: 'all',
  });
  const matched = matchCandidates(parsed.records, items);
  const billingsByPlot = await findYearBillings(
    client,
    [...new Set([...matched.values()].map((item) => item.contractPlotId))],
    year
  );
  // 同じ請求に2行が当たっても、残りを超えて付けない
  const remainingByBilling = new Map<string, number>();

  const rows: YuchoResultPlanRow[] = parsed.records.map((record) => {
    const item = matched.get(record.lineNo) ?? null;
    const billings = item ? (billingsByPlot.get(item.contractPlotId) ?? []) : [];
    const billing =
      billings.find((b) =>
        isCollectibleUnpaid(
          b.status,
          remainingByBilling.get(b.id) ?? remainingAmount(b.amount, b.paid_amount)
        )
      ) ??
      billings[0] ??
      null;
    const remaining = billing
      ? (remainingByBilling.get(billing.id) ?? remainingAmount(billing.amount, billing.paid_amount))
      : null;

    let status: YuchoResultRowStatus;
    if (!item) status = 'unmatched';
    else if (record.resultCode !== '0') status = 'failed';
    else if (!billing || remaining == null) status = 'no_billing';
    else if (!isCollectibleUnpaid(billing.status, remaining)) status = 'already_paid';
    else if (record.amount > remaining) status = 'amount_mismatch';
    else status = 'will_record';

    if (status === 'will_record' && billing && remaining != null) {
      remainingByBilling.set(billing.id, remaining - record.amount);
    }

    return {
      lineNo: record.lineNo,
      resultCode: record.resultCode,
      resultLabel: YUCHO_RESULT_LABEL[record.resultCode] ?? 'その他',
      amount: record.amount,
      kana: record.kana,
      status,
      contractPlotId: item?.contractPlotId ?? null,
      billingId: billing?.id ?? null,
      plotNumber: item?.plotNumber ?? null,
      displayNumber: item?.displayNumber ?? null,
      areaName: item?.areaName ?? null,
      customerName: item?.customerName ?? null,
      remainingAmount: remaining,
    };
  });

  const summary = emptySummary();
  for (const row of rows) {
    summary[row.status].count += 1;
    summary[row.status].amount += row.amount;
  }

  const mm = String(parsed.transferMonth).padStart(2, '0');
  const dd = String(parsed.transferDay).padStart(2, '0');
  return {
    year,
    month,
    transferDate: `${year}-${mm}-${dd}`,
    monthMismatch: parsed.transferMonth !== month,
    rows,
    summary,
  };
};

export const previewYuchoResult = (params: { year: number; month: number; file: Buffer }) =>
  buildPlan(prisma, params);

export const failedNoteLine = (transferDate: string, label: string): string =>
  `ゆうちょ引き落とし不能 ${transferDate}（${label}）`;

/** 1回のまとまりで書く行数 */
const APPLY_CHUNK_SIZE = 50;

/**
 * 本番の画面は裏側の返事を30秒しか待てない。件数の多い月は画面が lineFrom / lineTo で
 * 少しずつ分けて呼ぶ。範囲を省くと全行。
 */
export const applyYuchoResult = async (params: {
  year: number;
  month: number;
  file: Buffer;
  lineFrom?: number | undefined;
  lineTo?: number | undefined;
}): Promise<YuchoResultApplyResult> => {
  const plan = await buildPlan(prisma, params);
  const paymentDate = new Date(`${plan.transferDate}T00:00:00Z`);
  const from = params.lineFrom ?? 1;
  const to = params.lineTo ?? Number.POSITIVE_INFINITY;
  const targets = plan.rows.filter(
    (row) =>
      row.lineNo >= from &&
      row.lineNo <= to &&
      (row.status === 'will_record' || row.status === 'failed') &&
      row.billingId
  );
  let recordedCount = 0;
  let recordedAmount = 0;
  let notedFailedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < targets.length; i += APPLY_CHUNK_SIZE) {
    await prisma.$transaction(
      async (tx) => {
        for (const row of targets.slice(i, i + APPLY_CHUNK_SIZE)) {
          const billing = await tx.billing.findFirst({
            where: { id: row.billingId!, deleted_at: null },
            select: {
              id: true,
              customer_id: true,
              contract_plot_id: true,
              category: true,
              amount: true,
              paid_amount: true,
              status: true,
              notes: true,
            },
          });
          if (!billing) {
            skippedCount += 1;
            continue;
          }

          if (row.status === 'will_record') {
            // 確認のあとに窓口などで入金されていたら付けない（二重入金を防ぐ）
            const remaining = remainingAmount(billing.amount, billing.paid_amount);
            if (!isCollectibleUnpaid(billing.status, remaining) || row.amount > remaining) {
              skippedCount += 1;
              continue;
            }
            await tx.payment.create({
              data: {
                billing_id: billing.id,
                customer_id: billing.customer_id,
                contract_plot_id: billing.contract_plot_id,
                payment_date: paymentDate,
                payment_amount: row.amount,
                fee_type: feeTypeFromCategory(billing.category),
                notes: PAYMENT_NOTE,
              },
            });
            await recalculateBillingPayments(tx, billing.id);
            recordedCount += 1;
            recordedAmount += row.amount;
            continue;
          }

          const line = failedNoteLine(plan.transferDate, row.resultLabel);
          if (billing.notes?.includes(line)) continue;
          await tx.billing.update({
            where: { id: billing.id },
            data: { notes: billing.notes ? `${billing.notes}\n${line}` : line },
          });
          notedFailedCount += 1;
        }
      },
      { timeout: 120_000 }
    );
  }

  return { plan, recordedCount, recordedAmount, notedFailedCount, skippedCount };
};
