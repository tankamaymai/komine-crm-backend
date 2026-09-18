/**
 * 前受金一括処理の対象年・金額を決める純関数（#6）
 *
 * 管理料を複数年分まとめて前払いする顧客に対し、受領額を年ごとに割り付け、
 * どの年から起票するかを決める。DB に触れないので、割り付けと年の判定だけを
 * 単体テストで固定できる（documents/bulkInvoiceLogic.ts と同じ分け方）。
 *
 * 二重請求は業務上いちばん困るため、既存の管理料請求がカバーしている年は
 * 必ず「重複」として印を付け、呼び出し側で登録を止められるようにする。
 */

import type { PrepaidBillingYearRow } from '@komine/types';
import { existingBillingCoverage, type ExistingMgmtBilling } from './managementFeeBillingService';

/**
 * 受領額を年数で割り付ける。端数は初年度に寄せる。
 *
 * 均等割の切り捨てで生じる差額を初年度に足すことで、合計は必ず受領額と一致する。
 * 300,000 円 ÷ 30 年なら全年 10,000 円、310,000 円 ÷ 30 年なら
 * 初年度 10,343 円・以降 10,333 円になる。
 */
export function allocateAmounts(receivedAmount: number, years: number): number[] {
  if (years <= 0) return [];

  const base = Math.floor(receivedAmount / years);
  const remainder = receivedAmount - base * years;

  return Array.from({ length: years }, (_, i) => (i === 0 ? base + remainder : base));
}

/**
 * 前受を開始する年を推定する。
 *
 * 既存の管理料請求のうち最も新しい対象年の翌年を返す。既存請求が無ければ当年度。
 * `use_start_year` が NULL の請求が混ざっている区画は対象年を機械判定できないため
 * `estimated: false` を返し、窓口での手入力を促す（managementFeeBillingService の
 * needsReview と同じく、二重請求を防ぐ側に倒す）。
 */
export function estimateStartYear(
  billings: ExistingMgmtBilling[],
  currentYear: number
): { startYear: number; estimated: boolean } {
  if (billings.some((b) => b.use_start_year == null)) {
    return { startYear: currentYear, estimated: false };
  }

  let latest: number | null = null;
  for (const b of billings) {
    const end = b.use_end_year ?? b.use_start_year;
    if (end != null && (latest == null || end > latest)) latest = end;
  }

  return { startYear: latest == null ? currentYear : latest + 1, estimated: true };
}

/**
 * 開始年から年ごとの内訳を組み立て、既存請求との重なりを印として付ける。
 *
 * 年が入っていない既存請求がある区画では、その年が請求済みかを機械判定できない
 * （`existingBillingCoverage` の `needs_review`）。該当は 1,854 区画中 15 区画と
 * 少なく、一律に登録を止めると窓口が詰まるため、重複とは分けて「要確認」として
 * 返し、登録の可否は画面の警告を見た窓口の判断に委ねる。
 */
export function buildYearRows(
  startYear: number,
  amounts: number[],
  existing: ExistingMgmtBilling[]
): PrepaidBillingYearRow[] {
  return amounts.map((amount, i) => {
    const year = startYear + i;
    const coverage = existingBillingCoverage(existing, year);
    return {
      year,
      amount,
      duplicated: coverage === 'covered',
      needsReview: coverage === 'needs_review',
    };
  });
}

/** 重複している年だけを取り出す */
export function findDuplicatedYears(rows: PrepaidBillingYearRow[]): number[] {
  return rows.filter((r) => r.duplicated).map((r) => r.year);
}

/** 請求済みか判定できない年だけを取り出す */
export function findNeedsReviewYears(rows: PrepaidBillingYearRow[]): number[] {
  return rows.filter((r) => r.needsReview).map((r) => r.year);
}
