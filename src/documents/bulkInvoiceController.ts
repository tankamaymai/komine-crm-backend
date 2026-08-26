/**
 * 請求書（護持費のお知らせ）の一括印刷コントローラー
 *
 * 年払い以外（十年一回・五年一回）の契約者へ、請求年が来た年に請求書をまとめて送る。
 * 3月の繁忙期に数百通を用意する運用のため、
 *
 * - まず対象一覧をプレビューして件数・金額・請求漏れを確認できる
 * - 印刷は全件を 1 ファイルの PDF に連結して返す（そのまま連続印刷できる）
 *
 * 対象判定は副作用を持たず、DB は一切更新しない。請求（Billing）レコードの
 * 起票や最終請求月の更新は別の業務操作として扱う。
 */

import { Request, Response } from 'express';
import { ZodError } from 'zod';
import prisma from '../db/prisma';
import { getRequestLogger } from '../utils/logger';
import {
  BULK_INVOICE_DEFAULT_BILLING_YEARS,
  BULK_INVOICE_DEFAULT_MONTH,
  type BulkInvoiceTarget,
  type InvoiceTemplateData,
  getDefaultSeasonGreeting,
} from '@komine/types';
import {
  bulkInvoiceTargetsQuerySchema,
  generateBulkInvoiceRequestSchema,
} from '../validations/documentValidation';
import { generateBulkInvoicePdf } from './documentService';
import {
  attachContractDetails,
  selectBillableFees,
  excludePrepaidFees,
  type BulkInvoiceContractDetail,
  type BulkInvoiceFeeRow,
  type SelectBulkInvoiceTargetsOptions,
} from './bulkInvoiceLogic';
import { type ExistingMgmtBilling } from '../billings/managementFeeBillingService';
import { BillingCategory, BillingRecordStatus } from '@prisma/client';

/**
 * 1 回の印刷で扱う上限。3月の全対象でも 300 件弱のため、これを超える指定は
 * 条件の誤りとみなす（Chromium が数百MBの HTML を抱えて落ちるのを防ぐ）。
 */
const MAX_BULK_INVOICE_COUNT = 1000;

function formatZodIssues(err: ZodError): Array<{ field: string; message: string }> {
  return err.issues.map((issue) => ({
    field: issue.path.join('.') || '',
    message: issue.message,
  }));
}

function validationError(res: Response, err: ZodError): void {
  res.status(400).json({
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'リクエストの形式が不正です',
      details: formatZodIssues(err),
    },
  });
}

/**
 * 対象判定に必要な management_fees を取得する。
 *
 * 請求年数・最終請求月は移行由来の文字列（`"毎年"` `"要確認"` などが混ざる）なので
 * DB 側では厳密に絞れない。有効な契約に限定するところまでを SQL で行い、
 * 残りは純関数側で判定する。
 *
 * 数千件を読むためスカラー列だけに絞る。宛名・区画名まで一緒に引くと
 * 全契約分の顧客レコードを転送することになり、プレビューが数秒待たされる。
 */
async function fetchFeeRows(): Promise<BulkInvoiceFeeRow[]> {
  const managementFees = await prisma.managementFee.findMany({
    where: {
      deleted_at: null,
      contractPlot: { deleted_at: null, contract_status: 'active' },
    },
    select: {
      contract_plot_id: true,
      billing_years: true,
      billing_month: true,
      last_billing_month: true,
      management_fee: true,
    },
  });

  return managementFees.map((mf) => ({
    contractPlotId: mf.contract_plot_id,
    billingYears: mf.billing_years,
    billingMonth: mf.billing_month,
    lastBillingMonth: mf.last_billing_month,
    managementFee: mf.management_fee,
  }));
}

/** 請求年が来ている区画に限って、宛名・区画名を引く */
async function fetchContractDetails(
  contractPlotIds: string[]
): Promise<BulkInvoiceContractDetail[]> {
  if (contractPlotIds.length === 0) return [];

  const contractPlots = await prisma.contractPlot.findMany({
    where: { id: { in: contractPlotIds } },
    select: {
      id: true,
      physicalPlot: {
        select: { plot_number: true, display_number: true, area_name: true },
      },
      saleContractRoles: {
        where: { deleted_at: null, role: 'contractor' },
        // 契約者ロールが複数ある区画で宛名が揺れないよう、一覧表示（#303）と
        // 同じ「最初の有効な contractor」に揃える
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: 1,
        select: {
          customer: { select: { id: true, name: true, name_kana: true } },
        },
      },
    },
  });

  return contractPlots.map((cp) => {
    const contractor = cp.saleContractRoles[0]?.customer ?? null;
    return {
      contractPlotId: cp.id,
      customerId: contractor?.id ?? null,
      customerName: contractor?.name ?? null,
      customerNameKana: contractor?.name_kana ?? null,
      areaName: cp.physicalPlot.area_name,
      plotNumber: cp.physicalPlot.plot_number,
      displayNumber: cp.physicalPlot.display_number,
    };
  });
}

/**
 * 対象候補の区画について、入金済みの管理料請求（年の判定に必要な列だけ）を引く。
 *
 * 前受金で起票した請求は入金済み（status: paid）なので、対象年がそれで既に
 * カバーされている区画は請求書を送らない。未入金の請求まで含めると、窓口で
 * 当年分だけ起票した区画へ請求書が届かなくなる（送るべき人へ届かない方が
 * 業務上の損失が大きい）。
 *
 * 全契約分ではなく絞り込み後の百数十件だけを対象にするので、
 * プレビューの応答時間への影響はほぼない。
 */
async function fetchPaidBillings(
  contractPlotIds: string[]
): Promise<Map<string, ExistingMgmtBilling[]>> {
  if (contractPlotIds.length === 0) return new Map();

  const billings = await prisma.billing.findMany({
    where: {
      contract_plot_id: { in: contractPlotIds },
      deleted_at: null,
      category: BillingCategory.management_fee,
      status: BillingRecordStatus.paid,
    },
    select: { contract_plot_id: true, use_start_year: true, use_end_year: true },
  });

  const map = new Map<string, ExistingMgmtBilling[]>();
  for (const b of billings) {
    const list = map.get(b.contract_plot_id) ?? [];
    list.push({ use_start_year: b.use_start_year, use_end_year: b.use_end_year });
    map.set(b.contract_plot_id, list);
  }
  return map;
}

/** 一括印刷の対象一覧を組み立てる */
async function loadTargets(options: SelectBulkInvoiceTargetsOptions): Promise<BulkInvoiceTarget[]> {
  const candidates = selectBillableFees(await fetchFeeRows(), options);
  // 前受済みの年は請求書を送らない（#6）。最終請求月だけでは前受を判定できない
  const fees = excludePrepaidFees(
    candidates,
    await fetchPaidBillings(candidates.map((f) => f.contractPlotId))
  );
  const details = await fetchContractDetails(fees.map((f) => f.contractPlotId));
  return attachContractDetails(fees, details);
}

function toSelectOptions(input: {
  year: number;
  month?: number | undefined;
  billingYears?: number[] | undefined;
  includeOverdue?: boolean | undefined;
}): SelectBulkInvoiceTargetsOptions {
  return {
    year: input.year,
    // month は「絞り込まない」を null で表す。未指定時は運用の既定（3月）に寄せる
    month: input.month ?? BULK_INVOICE_DEFAULT_MONTH,
    billingYears: input.billingYears ?? [...BULK_INVOICE_DEFAULT_BILLING_YEARS],
    includeOverdue: input.includeOverdue ?? true,
  };
}

/**
 * GET /api/v1/documents/bulk-invoice/targets
 * 一括印刷の対象一覧（プレビュー）
 */
export const getBulkInvoiceTargets = async (req: Request, res: Response): Promise<void> => {
  const parsed = bulkInvoiceTargetsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return;
  }

  const targets = await loadTargets(toSelectOptions(parsed.data));

  res.status(200).json({
    success: true,
    data: {
      targets,
      total: targets.length,
      totalAmount: targets.reduce((sum, t) => sum + t.amount, 0),
    },
  });
};

/**
 * 対象1件を「護持費のお知らせ」テンプレートのデータに変換する。
 *
 * 季節の挨拶は印刷日ではなく請求月に合わせる（3月に送る書面が「盛夏の候」に
 * ならないよう、テンプレート側の当月フォールバックには任せない）。
 */
function toInvoiceTemplateData(target: BulkInvoiceTarget): InvoiceTemplateData {
  const noticeMonth = target.billingMonth ?? BULK_INVOICE_DEFAULT_MONTH;
  return {
    customerName: target.customerName,
    yearCount: target.billingYears,
    amount: target.amount,
    nextNoticeDate: target.nextNoticeDate,
    seasonGreeting: getDefaultSeasonGreeting(new Date(target.targetYear, noticeMonth - 1, 1)),
  };
}

/**
 * POST /api/v1/documents/bulk-invoice/generate
 * 対象の請求書を 1 ファイルの PDF に連結して返す
 */
export const generateBulkInvoice = async (req: Request, res: Response): Promise<void> => {
  const logger = getRequestLogger();

  const parsed = generateBulkInvoiceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return;
  }
  const { contractPlotIds, textStylePreset, ...query } = parsed.data;

  const allTargets = await loadTargets(toSelectOptions(query));
  const selectedIds = contractPlotIds ? new Set(contractPlotIds) : null;
  const targets = selectedIds
    ? allTargets.filter((t) => selectedIds.has(t.contractPlotId))
    : allTargets;

  if (targets.length === 0) {
    res.status(400).json({
      success: false,
      error: { code: 'NO_TARGETS', message: '印刷対象がありません' },
    });
    return;
  }

  if (targets.length > MAX_BULK_INVOICE_COUNT) {
    res.status(400).json({
      success: false,
      error: {
        code: 'TOO_MANY_TARGETS',
        message: `一度に印刷できるのは ${MAX_BULK_INVOICE_COUNT} 件までです（対象 ${targets.length} 件）`,
      },
    });
    return;
  }

  const pdfResult = await generateBulkInvoicePdf(
    targets.map(toInvoiceTemplateData),
    textStylePreset ? { textStylePreset } : undefined
  );

  if (!pdfResult.success || !pdfResult.buffer) {
    logger.error({ count: targets.length, err: pdfResult.error }, 'Bulk invoice PDF failed');
    res.status(500).json({
      success: false,
      error: {
        code: 'PDF_GENERATION_ERROR',
        message: pdfResult.error || 'PDF生成に失敗しました',
      },
    });
    return;
  }

  const month = String(query.month ?? BULK_INVOICE_DEFAULT_MONTH).padStart(2, '0');

  res.status(200).json({
    success: true,
    data: {
      pdf: pdfResult.buffer.toString('base64'),
      mimeType: 'application/pdf',
      fileName: `護持費のお知らせ_${query.year}${month}_${targets.length}件.pdf`,
      fileSize: pdfResult.buffer.length,
      count: targets.length,
    },
  });
};
