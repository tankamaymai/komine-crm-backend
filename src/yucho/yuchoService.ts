/**
 * ゆうちょ連携: 請求データ集約サービス
 *
 * 管理料だけを集め、ゆうちょ自動払込み用の請求対象データを返す。
 * 合祀に料金はないため、合祀の金額は引き落としに混ぜない。
 */

import { BillingCategory } from '@prisma/client';
import prisma from '../db/prisma';
import { getRequestLogger } from '../utils/logger';
import type { YuchoBillingItem, YuchoBillingResponse } from '../validations/yuchoValidation';
import { getAccountKana, getExcludeReason, isExportableBillingItem } from './yuchoCsv';
import { derivePayerCode, splitPayerCode } from './yuchoPayerCode';
import { getYuchoExportSettings } from './yuchoSettings';

interface FetchParams {
  year: number;
  month?: number | undefined;
  category: 'management' | 'collective' | 'all';
  status: 'unbilled' | 'billed' | 'paid' | 'all';
}

/**
 * 月文字列(例: "4", "04", "4月")を数値に変換。失敗時は null。
 */
const parseBillingMonth = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const m = value.match(/(\d{1,2})/);
  if (!m) return null;
  const num = parseInt(m[1] ?? '0', 10);
  return num >= 1 && num <= 12 ? num : null;
};

/** 毎年=1 / 五年=5 / 十年=10。未設定は毎年。0や永代は対象外。 */
export const parseFeeCycleYears = (value: string | null | undefined): number | null => {
  if (value == null || String(value).trim() === '') return 1;
  const num = parseInt(String(value).replace(/[^\d]/g, ''), 10);
  if (num === 1 || num === 5 || num === 10) return num;
  return null;
};

/** 最終請求月から年だけ取る。"202103" や "2021年3月" を許容。 */
export const parseLastBillingYear = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const trimmed = String(value).trim();
  const matched = trimmed.match(/(\d{4})[年\-./]?(\d{1,2})/);
  if (!matched) return null;
  const year = parseInt(matched[1] ?? '', 10);
  return year >= 1900 && year <= 2100 ? year : null;
};

/**
 * 選んだ年に、この管理料の番が来ているか。
 * 次回 = 前回の年 + 1/5/10。前回が読めない毎年払いは出す。5年・10年は前回が無いと出さない。
 */
export const isManagementFeeDueThisYear = (
  year: number,
  billingYearsRaw: string | null | undefined,
  lastBillingMonthRaw: string | null | undefined
): boolean => {
  const cycle = parseFeeCycleYears(billingYearsRaw);
  if (cycle == null) return false;
  const lastYear = parseLastBillingYear(lastBillingMonthRaw);
  if (lastYear == null) return cycle === 1;
  return lastYear + cycle <= year;
};

/**
 * 文字列の管理料金額を整数(円)に変換。"10,000" や "10000円" などの表記を許容。
 *
 * 金額は円単位の正整数であるべきため、数字以外（ハイフン等）は除去する（#212）。
 * 旧実装はハイフン・小数を温存していたため、'-1000'→-1000（負額）が
 * ゆうちょ振替の引落金額に出力されうる問題があった。
 * - 全角数字は半角へ正規化して扱う（#279: 全角金額が 0 円扱いになり振替対象から
 *   無言で除外されるのを防ぐ）
 * - 小数表記は整数部のみ採用する（#275: 小数点だけを除去すると '3.6'→'36' に
 *   桁結合して 10 倍の引落金額になるため）
 * 数字以外を含む値は異常データ検知のため warn ログを出す（黙って出力しない）。
 */
const parseManagementFeeAmount = (value: string | null | undefined, sourceId?: string): number => {
  if (!value) return 0;
  // 全角数字 → 半角（#279）
  const halfWidth = value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 桁区切りカンマと円表記のみ正常系として無警告で除去
  const normalized = halfWidth.replace(/[,，円\s]/g, '');
  // 小数表記は整数部のみ（#275）
  const integerPart = normalized.split('.')[0] ?? '';
  const cleaned = integerPart.replace(/[^\d]/g, '');
  if (cleaned !== normalized) {
    getRequestLogger().warn(
      { managementFeeId: sourceId, rawValue: value },
      '管理料金額に数字以外の文字が含まれています（整数部の数字のみ抽出して処理）'
    );
  }
  if (!cleaned) return 0;
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
};

type PayerCustomer = {
  id: string;
  name: string;
  name_kana: string;
  bank_name: string | null;
  branch_name: string | null;
  account_type: string | null;
  account_number: string | null;
  account_holder: string | null;
  yucho_symbol: string | null;
  yucho_number: string | null;
};

/**
 * 契約者(役割: contractor)を最優先、無ければ申込者(applicant)を返す。
 */
const pickPayer = (
  roles: Array<{ role: string; customer: PayerCustomer | null }>
): PayerCustomer | null => {
  const contractor = roles.find((r) => r.role === 'contractor' && r.customer);
  if (contractor) return contractor.customer;
  const applicant = roles.find((r) => r.role === 'applicant' && r.customer);
  return applicant?.customer ?? null;
};

/**
 * Customer の振込先カラムから YuchoBillingItem.billingInfo を組み立てる。
 * 主要フィールド（bank_name / branch_name / account_number）が全て空の場合は null を返す。
 * （Zengin CSV のデータ行生成判定に使われる）
 */
const buildBillingInfo = (payer: PayerCustomer | null): YuchoBillingItem['billingInfo'] => {
  if (!payer) return null;
  // ゆうちょ記号番号だけ入っているケース（銀行/支店名なし）も口座情報ありとして扱う（#170）
  if (
    !payer.bank_name &&
    !payer.branch_name &&
    !payer.account_number &&
    !payer.yucho_symbol &&
    !payer.yucho_number
  ) {
    return null;
  }
  return {
    bankName: payer.bank_name,
    branchName: payer.branch_name,
    accountType: payer.account_type,
    accountNumber: payer.account_number,
    accountHolder: payer.account_holder,
    yuchoSymbol: payer.yucho_symbol,
    yuchoNumber: payer.yucho_number,
  };
};

type YearCoverageBilling = {
  contract_plot_id: string;
  use_start_year: number | null;
  use_end_year: number | null;
  amount: number;
  paid_amount: number;
};

const coversYear = (billing: YearCoverageBilling, year: number): boolean => {
  if (billing.use_start_year == null) return false;
  const endYear = billing.use_end_year ?? billing.use_start_year;
  return billing.use_start_year <= year && endYear >= year;
};

const isYearFullyPaid = (billing: YearCoverageBilling): boolean =>
  billing.amount > 0 && billing.paid_amount >= billing.amount;

/**
 * 管理料の請求対象を取得
 *
 * 区画全体の支払済（去年までの入金）では外さない。
 * 選んだ年の管理料がまだ完納でなければ出す。請求書が未作成でも出す。
 */
const fetchManagementBillingItems = async (params: FetchParams): Promise<YuchoBillingItem[]> => {
  const { year, month, status } = params;

  const fees = await prisma.managementFee.findMany({
    where: {
      deleted_at: null,
      contractPlot: {
        deleted_at: null,
        contract_status: 'active',
      },
    },
    include: {
      contractPlot: {
        include: {
          physicalPlot: true,
          saleContractRoles: {
            where: { deleted_at: null },
            include: {
              customer: true,
            },
          },
        },
      },
    },
  });

  const plotIds = [...new Set(fees.map((fee) => fee.contract_plot_id))];
  const yearBillings =
    plotIds.length === 0
      ? []
      : await prisma.billing.findMany({
          where: {
            deleted_at: null,
            terminated: false,
            category: BillingCategory.management_fee,
            contract_plot_id: { in: plotIds },
          },
          select: {
            contract_plot_id: true,
            use_start_year: true,
            use_end_year: true,
            amount: true,
            paid_amount: true,
          },
        });

  const paidThisYear = new Set(
    yearBillings
      .filter((billing) => coversYear(billing, year) && isYearFullyPaid(billing))
      .map((billing) => billing.contract_plot_id)
  );

  const items: YuchoBillingItem[] = [];
  for (const fee of fees) {
    const billingMonth = parseBillingMonth(fee.billing_month);
    // 月指定がある場合は一致するもののみ
    if (month != null && billingMonth !== month) continue;
    // 月指定なし(年単位)の場合は billing_month が設定されているもののみ
    if (month == null && billingMonth == null) continue;
    if (!isManagementFeeDueThisYear(year, fee.billing_years, fee.last_billing_month)) continue;

    const thisYearPaid = paidThisYear.has(fee.contract_plot_id);
    if (status === 'unbilled' || status === 'billed') {
      if (thisYearPaid) continue;
    } else if (status === 'paid') {
      if (!thisYearPaid) continue;
    }

    const amount = parseManagementFeeAmount(fee.management_fee, fee.id);
    if (amount <= 0) continue;

    const payer = pickPayer(fee.contractPlot.saleContractRoles);

    // 請求予定日 = 指定年 + billing_month の月末
    const scheduledDate =
      billingMonth != null
        ? (new Date(Date.UTC(year, billingMonth, 0)).toISOString().split('T')[0] ?? null)
        : null;

    items.push({
      category: 'management',
      sourceId: fee.id,
      contractPlotId: fee.contract_plot_id,
      plotNumber: fee.contractPlot.physicalPlot.plot_number,
      displayNumber: fee.contractPlot.physicalPlot.display_number,
      areaName: fee.contractPlot.physicalPlot.area_name,
      contractDate: fee.contractPlot.contract_date?.toISOString().split('T')[0] ?? '',
      customerId: payer?.id ?? null,
      customerName: payer?.name ?? null,
      customerNameKana: payer?.name_kana ?? null,
      billingAmount: amount,
      billingStatus: thisYearPaid ? 'paid' : 'pending',
      scheduledDate,
      billingMonth,
      billingInfo: buildBillingInfo(payer),
    });
  }

  return items;
};

/**
 * 請求対象を取得して整形・サマリ計算する。
 * 合祀は料金を取らないので、category が collective のときは空で返す。
 */
export const fetchYuchoBillingData = async (params: FetchParams): Promise<YuchoBillingResponse> => {
  const promises: Array<Promise<YuchoBillingItem[]>> = [];
  if (params.category === 'management' || params.category === 'all') {
    promises.push(fetchManagementBillingItems(params));
  }

  const results = await Promise.all(promises);
  const items = results.flat().map((item) => {
    const payerCode = derivePayerCode(item.customerId, item.contractPlotId);
    const split = splitPayerCode(payerCode);
    return {
      ...item,
      payerCode,
      payerCode1: split?.payerCode1 ?? null,
      payerCode2: split?.payerCode2 ?? null,
      accountKana: getAccountKana(item) || null,
      exportable: isExportableBillingItem(item),
      excludeReason: getExcludeReason(item),
    };
  });

  // 区画番号順でソート
  items.sort((a, b) => a.plotNumber.localeCompare(b.plotNumber));

  // CSV（振替ファイル）へ実際に出力される項目と、口座未登録で除外される項目を分離。
  // exportableCount は buildZenginCsv のデータ行数と一致する（同一 predicate を共用）。
  const exportableItems = items.filter(isExportableBillingItem);
  const excludedNoAccountCount = items.filter(
    (i) => i.billingAmount > 0 && !isExportableBillingItem(i)
  ).length;

  const summary = {
    totalCount: items.length,
    totalAmount: items.reduce((sum, i) => sum + i.billingAmount, 0),
    exportableCount: exportableItems.length,
    exportableAmount: exportableItems.reduce((sum, i) => sum + i.billingAmount, 0),
    excludedNoAccountCount,
    byCategory: {
      management: {
        count: items.filter((i) => i.category === 'management').length,
        amount: items
          .filter((i) => i.category === 'management')
          .reduce((sum, i) => sum + i.billingAmount, 0),
      },
      collective: {
        count: items.filter((i) => i.category === 'collective').length,
        amount: items
          .filter((i) => i.category === 'collective')
          .reduce((sum, i) => sum + i.billingAmount, 0),
      },
    },
  };

  return {
    period: { year: params.year, month: params.month ?? null },
    items,
    summary,
    exportSettings: getYuchoExportSettings(),
  };
};
