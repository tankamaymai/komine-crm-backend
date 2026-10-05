/**
 * 管理料の年度請求(Billing)自動生成サービス（#196）
 *
 * 管理料は「毎年・年度末(3月)に1年分を請求する定期課金」が基本モデル（実データで確認:
 * management_fees.billing_month は 3 が最多、入金も 2026 まで毎年ほぼ一定で繰り返し発生）。
 * 設定テーブル(ManagementFee)はあるが請求(Billing)が未起票だと「未入金・管理料あり・請求タブ空」
 * になるため、対象年度の管理料 Billing を設定から冪等に生成する。
 *
 * 対象: contract_status=active かつ管理料設定(amount 解釈可)を持つ契約区画。
 * 冪等（#391）: 同一区画・同一カテゴリ(management_fee)の既存請求が対象年を**カバー**していればスキップ。
 *   - use_start_year == targetYear（年次の同一年）
 *   - use_start_year <= targetYear <= use_end_year（5年/10年前納のレンジ被覆。レガシー移行請求は
 *     use_start_year=2022, use_end_year=2026 のようにレンジを持つ — #196 実データ確認）
 *   等値一致のみだと前納レンジを取り逃して支払済年度に二重請求してしまう（#391 の主因）。
 * 要確認（#391）: 既存請求の use_start_year が NULL（年が判定不能）の区画は、対象年を含むか
 *   機械判定できないため**自動生成せず** needsReview として別カウントに出す（二重請求の予防）。
 * 前納ガード: ManagementFee.billing_years > 1（5年/10年一括前納）は二重請求回避のため既定でスキップし
 *   ログに出す（前納の次回請求年判定は業務確認が必要なため、既定では自動起票しない）。
 *   includePrepaid=true で対象に含められる。
 *
 * 使用料(usage_fee)は契約時一括のため本バッチの対象外。
 */
import { PrismaClient, ContractStatus, BillingCategory } from '@prisma/client';
import { recalculateContractPlotPaymentStatus } from '../plots/services/paymentStatusService';

/** billing_month 未設定時の既定（年度末 3 月。実データで最多）。 */
export const DEFAULT_BILLING_MONTH = 3;

export interface GenerateManagementBillingOptions {
  /** 対象年度（西暦・use_start_year に入る） */
  targetYear: number;
  /**
   * 請求月。指定した月の人だけ作る。
   * 請求月が空・読めない人は 3月 として扱う（このサービスの既定と同じ）。
   * 未指定なら全月。
   */
  month?: number;
  /** true で実際に Billing を作成。false は dry-run（件数のみ算出） */
  apply: boolean;
  /** 複数年一括前納(billing_years>1)も対象に含める（既定 false=二重請求回避でスキップ） */
  includePrepaid?: boolean;
}

export interface GenerateManagementBillingResult {
  targetYear: number;
  scanned: number;
  created: number;
  skippedExisting: number;
  skippedPrepaid: number;
  skippedNoAmount: number;
  skippedNoCustomer: number;
  /** 請求月が指定月と違うため見送った区画数 */
  skippedOtherMonth: number;
  /** 既存請求の use_start_year が NULL で対象年の被覆を判定できず、自動生成を見送った区画数（#391） */
  needsReview: number;
  createdPlotIds: string[];
  /** 要確認（use_start_year NULL の既存請求あり）区画 ID（#391） */
  needsReviewPlotIds: string[];
}

/** 既存管理料請求の年情報（被覆判定に必要な最小限） */
export interface ExistingMgmtBilling {
  use_start_year: number | null;
  use_end_year: number | null;
}

export type ExistingCoverage = 'covered' | 'needs_review' | 'none';

/**
 * 既存の管理料請求群が targetYear をカバーしているか判定する（DB 非依存の純関数 / #391）。
 *
 *  - covered: use_start_year == targetYear、または
 *             use_start_year <= targetYear <= use_end_year（前納レンジ被覆）の請求がある。
 *  - needs_review: 上記カバーは無いが、use_start_year が NULL の請求が1件以上ある
 *                  （対象年を含むか機械判定できない → 自動生成を見送り要確認に回す）。
 *  - none: カバーも NULL 請求も無い → 新規生成対象。
 */
export function existingBillingCoverage(
  billings: ExistingMgmtBilling[],
  targetYear: number
): ExistingCoverage {
  let hasNullYear = false;
  for (const b of billings) {
    if (b.use_start_year == null) {
      hasNullYear = true;
      continue;
    }
    if (b.use_start_year === targetYear) return 'covered';
    // 前納レンジ被覆: 終了年が無ければ開始年単年とみなす。
    const endYear = b.use_end_year ?? b.use_start_year;
    if (b.use_start_year <= targetYear && endYear >= targetYear) return 'covered';
  }
  return hasNullYear ? 'needs_review' : 'none';
}

/** 文字列の管理料(VarChar)から金額intを取り出す。数字以外を除去。0/解釈不能は null。 */
export function parseFeeAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** billing_month(VarChar)から 1..12 の月を取り出す。範囲外/未設定は既定 3 月。 */
export function parseBillingMonth(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_BILLING_MONTH;
  const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
  return n >= 1 && n <= 12 ? n : DEFAULT_BILLING_MONTH;
}

/** billing_years(VarChar)から請求年数を取り出す。未設定/0/解釈不能は 1（年次）。 */
export function parseBillingYears(raw: string | null | undefined): number {
  if (raw == null) return 1;
  const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function generateManagementFeeBillings(
  prisma: PrismaClient,
  opts: GenerateManagementBillingOptions
): Promise<GenerateManagementBillingResult> {
  const { targetYear, apply, includePrepaid = false, month } = opts;
  const result: GenerateManagementBillingResult = {
    targetYear,
    scanned: 0,
    created: 0,
    skippedExisting: 0,
    skippedPrepaid: 0,
    skippedNoAmount: 0,
    skippedNoCustomer: 0,
    skippedOtherMonth: 0,
    needsReview: 0,
    createdPlotIds: [],
    needsReviewPlotIds: [],
  };

  const contracts = await prisma.contractPlot.findMany({
    where: {
      deleted_at: null,
      contract_status: ContractStatus.active,
      managementFee: { is: { deleted_at: null } },
    },
    select: {
      id: true,
      managementFee: {
        select: { management_fee: true, billing_month: true, billing_years: true },
      },
      saleContractRoles: {
        where: { deleted_at: null, role: { in: ['contractor', 'applicant'] } },
        select: { role: true, customer_id: true },
      },
      // 管理料の既存請求（冪等判定）。等値だけだと前納レンジ／use_start_year NULL を
      // 取り逃すため、active な管理料請求を全件取得しコード側でレンジ被覆を判定する（#391）。
      billings: {
        where: {
          deleted_at: null,
          category: BillingCategory.management_fee,
        },
        select: { use_start_year: true, use_end_year: true },
      },
    },
  });

  for (const c of contracts) {
    result.scanned++;
    const mf = c.managementFee;
    if (!mf) continue;

    const amount = parseFeeAmount(mf.management_fee);
    if (amount == null) {
      result.skippedNoAmount++;
      continue;
    }

    const billingMonth = parseBillingMonth(mf.billing_month);
    if (month != null && billingMonth !== month) {
      result.skippedOtherMonth++;
      continue;
    }

    // 冪等（#391）: 既存の管理料請求が対象年をカバー（等値 or 前納レンジ被覆）していればスキップ。
    // use_start_year NULL の既存請求しか無い区画は被覆判定不能 → 自動生成せず要確認に回す。
    const coverage = existingBillingCoverage(c.billings, targetYear);
    if (coverage === 'covered') {
      result.skippedExisting++;
      continue;
    }
    if (coverage === 'needs_review') {
      result.needsReview++;
      result.needsReviewPlotIds.push(c.id);
      continue;
    }

    // 前納ガード: 複数年一括は既定で対象外（二重請求回避）
    if (parseBillingYears(mf.billing_years) > 1 && !includePrepaid) {
      result.skippedPrepaid++;
      continue;
    }

    // 請求先顧客は契約者優先・なければ申込者
    const roles = c.saleContractRoles;
    const target =
      roles.find((r) => r.role === 'contractor') ?? roles.find((r) => r.role === 'applicant');
    if (!target) {
      result.skippedNoCustomer++;
      continue;
    }

    const billingDate = new Date(Date.UTC(targetYear, billingMonth - 1, 1));

    if (apply) {
      await prisma.$transaction(async (tx) => {
        await tx.billing.create({
          data: {
            contract_plot_id: c.id,
            customer_id: target.customer_id,
            category: BillingCategory.management_fee,
            amount,
            use_start_year: targetYear,
            use_end_year: targetYear,
            billing_years: 1,
            target_month: billingMonth,
            billing_date: billingDate,
            status: 'billed',
          },
        });
        // 請求が増えたので派生 payment_status を再計算（#162）
        await recalculateContractPlotPaymentStatus(tx, c.id);
      });
    }

    result.created++;
    result.createdPlotIds.push(c.id);
  }

  return result;
}
