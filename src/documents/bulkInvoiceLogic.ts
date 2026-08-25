/**
 * 請求書（護持費のお知らせ）一括印刷の対象抽出ロジック
 *
 * 年払い以外（十年一回・五年一回）の契約者は、請求年が来た年にだけ請求書を送る。
 * どこまで請求済みかは `management_fees.last_billing_month`（YYYYMM）が唯一の情報源で、
 *
 *     次回の請求年 = 最終請求月の年 + 請求年数
 *
 * で判定する。移行データには `"0"` `"毎年"` `"要確認"` のような非数値が混ざるため、
 * 読めない値は「対象年を決められない」とみなして必ず除外する（誤送付を避けるため、
 * 迷ったら落とす側に倒す）。
 *
 * DB 非依存の純関数として切り出し、単体テストで対象判定を固定する。
 */

import type { BulkInvoiceTarget } from '@komine/types';

/**
 * 対象年の判定に必要な management_fees の項目。
 *
 * 宛名や区画名を含まないのは、全契約分（数千件）を読むのがこの段階だけで、
 * 表示用の情報まで一緒に引くと転送量が跳ね上がるため。
 */
export interface BulkInvoiceFeeRow {
  contractPlotId: string;
  /** 請求年数。移行データのため文字列（`"10"` `"5"` `"毎年"` など） */
  billingYears: string | null;
  /** 請求月。移行データのため文字列（`"3"` `"0"` `"4月"` など） */
  billingMonth: string | null;
  /** 最終請求月 `"202103"` */
  lastBillingMonth: string | null;
  /** 管理料。移行データのため文字列 */
  managementFee: string | null;
}

/** 対象が確定してから引く、宛名・区画の表示情報 */
export interface BulkInvoiceContractDetail {
  contractPlotId: string;
  customerId: string | null;
  customerName: string | null;
  customerNameKana: string | null;
  areaName: string | null;
  plotNumber: string | null;
  displayNumber: string | null;
}

/** management_fees + 契約区画 + 契約者を結合した、対象判定に必要な生データ */
export interface BulkInvoiceSourceRow extends BulkInvoiceFeeRow, BulkInvoiceContractDetail {}

/** 請求年が来ていると判定された 1 件（宛名はまだ付いていない） */
export interface BulkInvoiceBillableFee {
  contractPlotId: string;
  billingYears: number;
  billingMonth: number | null;
  /** 最終請求月 `"2021-03"` */
  lastBillingMonth: string | null;
  targetYear: number;
  amount: number;
  nextNoticeDate: string;
  overdue: boolean;
}

export interface SelectBulkInvoiceTargetsOptions {
  /** 請求対象年 */
  year: number;
  /** 請求月。null なら月で絞り込まない */
  month: number | null;
  /** 対象とする請求年数 */
  billingYears: number[];
  /** 対象年より前の請求漏れも含める */
  includeOverdue: boolean;
}

/** `"202603"` を年月に分解する。桁数・月が不正なら null */
export function parseYearMonth(
  raw: string | null | undefined
): { year: number; month: number } | null {
  if (!raw || !/^\d{6}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  if (month < 1 || month > 12) return null;

  return { year, month };
}

/** 次回の請求年（= 最終請求月の年 + 請求年数）。最終請求月が読めなければ null */
export function computeNextBillingYear(
  lastBillingMonth: string | null | undefined,
  billingYears: number
): number | null {
  const parsed = parseYearMonth(lastBillingMonth);
  return parsed ? parsed.year + billingYears : null;
}

/** 請求書本文の「次回の◯◯には」に入れる年月表記 */
export function formatNextNoticeDate(year: number, month: number | null): string {
  return month === null ? `${year}年` : `${year}年${month}月`;
}

/** 移行データの緩い文字列を整数に変換する。数字だけで構成されていなければ null */
function parseLooseInt(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * 請求年が来ている護持費を抽出する。management_fees だけで判定できる段階。
 */
export function selectBillableFees(
  rows: BulkInvoiceFeeRow[],
  options: SelectBulkInvoiceTargetsOptions
): BulkInvoiceBillableFee[] {
  const allowedYears = new Set(options.billingYears);
  const fees: BulkInvoiceBillableFee[] = [];

  for (const row of rows) {
    const billingYears = parseLooseInt(row.billingYears);
    if (billingYears === null || !allowedYears.has(billingYears)) continue;

    const billingMonth = parseLooseInt(row.billingMonth);
    const normalizedMonth =
      billingMonth !== null && billingMonth >= 1 && billingMonth <= 12 ? billingMonth : null;
    if (options.month !== null && normalizedMonth !== options.month) continue;

    const targetYear = computeNextBillingYear(row.lastBillingMonth, billingYears);
    if (targetYear === null) continue;

    const overdue = targetYear < options.year;
    if (targetYear !== options.year && !(overdue && options.includeOverdue)) continue;

    const amount = parseLooseInt(row.managementFee);
    if (amount === null || amount <= 0) continue;

    const lastBillingMonth = parseYearMonth(row.lastBillingMonth);

    fees.push({
      contractPlotId: row.contractPlotId,
      billingYears,
      billingMonth: normalizedMonth,
      lastBillingMonth: lastBillingMonth
        ? `${lastBillingMonth.year}-${String(lastBillingMonth.month).padStart(2, '0')}`
        : null,
      targetYear,
      amount,
      nextNoticeDate: formatNextNoticeDate(targetYear + billingYears, normalizedMonth),
      overdue,
    });
  }

  return fees;
}

/**
 * 宛名・区画情報を合流させ、封入しやすいよう区画順に並べて返す。
 *
 * 宛名が引けない区画は請求書を送れないため落とす。
 */
export function attachContractDetails(
  fees: BulkInvoiceBillableFee[],
  details: BulkInvoiceContractDetail[]
): BulkInvoiceTarget[] {
  const byContractPlotId = new Map(details.map((d) => [d.contractPlotId, d]));
  const targets: BulkInvoiceTarget[] = [];

  for (const fee of fees) {
    const detail = byContractPlotId.get(fee.contractPlotId);
    const customerName = (detail?.customerName ?? '').trim();
    if (customerName === '') continue;

    targets.push({
      ...fee,
      customerId: detail?.customerId ?? null,
      customerName,
      customerNameKana: detail?.customerNameKana ?? null,
      areaName: detail?.areaName ?? null,
      plotNumber: detail?.plotNumber ?? null,
      displayNumber: detail?.displayNumber ?? null,
    });
  }

  return targets.sort(compareByPlotOrder);
}

/**
 * 一括印刷の対象を抽出し、封入しやすいよう区画順に並べて返す。
 */
export function selectBulkInvoiceTargets(
  rows: BulkInvoiceSourceRow[],
  options: SelectBulkInvoiceTargetsOptions
): BulkInvoiceTarget[] {
  return attachContractDetails(selectBillableFees(rows, options), rows);
}

/**
 * 区画順（区名 → 区画番号）。番号は "2" が "10" より先に来るよう数値順で比較する。
 *
 * 表示番号を先に見るのは、封入時に突き合わせるのが台帳と同じ「区画番号」であるため。
 * 内部の plot_number は移行データだと `legacy-671` のような通番で、この順に並べても
 * 現場の並びとは一致しない。
 */
function compareByPlotOrder(a: BulkInvoiceTarget, b: BulkInvoiceTarget): number {
  const compare = (x: string | null, y: string | null): number =>
    (x ?? '').localeCompare(y ?? '', 'ja', { numeric: true });

  return (
    compare(a.areaName, b.areaName) ||
    compare(a.displayNumber, b.displayNumber) ||
    compare(a.plotNumber, b.plotNumber) ||
    a.contractPlotId.localeCompare(b.contractPlotId)
  );
}
