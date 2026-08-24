/**
 * 月次報告（区画残数）帳票の集計。
 *
 * 議事録 2026-07-21 §6 で決まった「月次報告用 Excel のレイアウトをそのまま再現し、
 * Excel でダウンロードできるようにする」の集計側。配置は monthlyReportLayout.ts、
 * 画面表示と Excel 生成はフロントが同じ JSON から行うので両者はズレない。
 *
 * ## 現時点の値であることの明示
 *
 * 帳票の原本は「2026年6月末現在」のように月末時点を示すが、physical_plots には
 * 区画の増減履歴がなく、過去時点の区画数は復元できない。よってこの API は
 * 常に「実行時点」の値を返し、`asOfDate` にその時刻を入れる。過去月を指定する
 * パラメータは意図的に持たせていない（誤った数字を出さないため）。
 *
 * ## 実データと原本 Excel の差
 *
 * physical_plots は全件が契約データ由来（legacy-）のため、一度も契約されて
 * いない空き区画に行がない。そのため区画数は原本より少なく出る（2026-08 時点で
 * 帳票対象の5ブロック合計 3,236 に対し原本 3,740）。区画マスタが
 * POST /plots/physical・/physical/bulk で埋まれば自動的に一致していく。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  MONTHLY_REPORT_BLOCKS,
  MonthlyReportRowSpec,
  OTHER_BLOCK_TITLE,
  buildLayoutIndex,
  findRow,
} from './monthlyReportLayout';

type DbClient = PrismaClient | Prisma.TransactionClient;

/** 会計年度の開始月。石の大友は5月決算なので年度は6月開始。 */
export const FISCAL_YEAR_START_MONTH = 6;

/** 面積未設定の区画に充てる既定面積（inventoryService と揃える）。 */
const DEFAULT_AREA_SQM = 3.6;

export interface MonthlyReportRow {
  /** 「区」列の表記 */
  label: string;
  totalCount: number;
  usedCount: number;
  remainingCount: number;
}

export interface MonthlyReportBlock {
  period: string;
  title: string;
  rows: MonthlyReportRow[];
  /** 「合計」行 */
  total: MonthlyReportRow;
}

export interface MonthlyReportSummary {
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  /** 今年度（6月開始）の契約件数 */
  soldThisFiscalYear: number;
  /** 累計販売区画数。契約日が入っている契約の全期間累計 */
  cumulativeSoldCount: number;
  /** 今年度の年度表記（例: 2026 は 2026年6月〜2027年5月） */
  fiscalYear: number;
}

export interface MonthlyReportData {
  /** 集計を実行した時刻（ISO8601 UTC） */
  asOfDate: string;
  blocks: MonthlyReportBlock[];
  /** レイアウトに載らない区画を集めたブロック。0件なら null */
  otherBlock: MonthlyReportBlock | null;
  summary: MonthlyReportSummary;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof (value as { toNumber: () => number }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * 会計年度（6月開始）を求める。2026-06-01 〜 2027-05-31 は 2026 年度。
 */
export function resolveFiscalYear(date: Date): number {
  const month = date.getMonth() + 1;
  return month >= FISCAL_YEAR_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
}

/** 会計年度の開始日（その年度の6月1日）。 */
export function fiscalYearStart(fiscalYear: number): Date {
  return new Date(Date.UTC(fiscalYear, FISCAL_YEAR_START_MONTH - 1, 1));
}

/**
 * 「使用数」に加算する量を求める。
 *
 * sold_out は 1、partially_sold は契約面積の割合（物理面積を上限にクランプ）。
 * inventoryService.clampedUsedPortion と同じ規則にして、他の在庫画面と
 * 数字が食い違わないようにする。#205
 */
function usedPortion(status: string, contractedArea: number, plotArea: number): number {
  if (status === 'sold_out') return 1;
  if (status !== 'partially_sold' || contractedArea <= 0) return 0;
  if (plotArea <= 0) return 0;
  return Math.min(1, contractedArea / plotArea);
}

/** 端数を持つ集計値から表示用の行を作る。 */
function finalizeRow(label: string, totalCount: number, usedCount: number): MonthlyReportRow {
  // 区画数 = 使用数 + 残数 が必ず成り立つよう、使用数を丸めてから残数を導く。
  // 別々に丸めると partially_sold がある期で合計が合わなくなる。
  const total = Math.round(totalCount);
  const used = Math.round(usedCount);
  return { label, totalCount: total, usedCount: used, remainingCount: Math.max(0, total - used) };
}

interface Accumulator {
  totalCount: number;
  usedCount: number;
}

const emptyAcc = (): Accumulator => ({ totalCount: 0, usedCount: 0 });

/**
 * 月次報告帳票のデータを取得する。
 *
 * @param options.includeOther レイアウトに載らない区画を「その他」ブロックとして返すか。
 *                             false のときブロック合計は全区画数より少なくなる。
 */
export async function getMonthlyReport(
  prisma: DbClient,
  options: { includeOther?: boolean } = {}
): Promise<MonthlyReportData> {
  const { includeOther = true } = options;
  const index = buildLayoutIndex(MONTHLY_REPORT_BLOCKS);

  const physicalPlots = await prisma.physicalPlot.findMany({
    where: { deleted_at: null },
    select: {
      area_name: true,
      area_sqm: true,
      status: true,
      contractPlots: {
        // vacant の器契約と terminated を除く（#209。他の在庫集計と母数を揃える）
        where: { deleted_at: null, contract_status: 'active' },
        select: { contract_area_sqm: true },
      },
    },
  });

  const perRow = new Map<MonthlyReportRowSpec, Accumulator>();
  // その他ブロックは区画名ごとに1行
  const perOtherArea = new Map<string, Accumulator>();

  for (const plot of physicalPlots) {
    const plotArea = plot.area_sqm ? toNumber(plot.area_sqm) : DEFAULT_AREA_SQM;
    const contractedArea = plot.contractPlots.reduce(
      (sum, cp) => sum + toNumber(cp.contract_area_sqm),
      0
    );
    const used = usedPortion(plot.status, contractedArea, plotArea);

    const row = findRow(index, plot.area_name, plotArea);
    let acc: Accumulator;
    if (row) {
      acc = perRow.get(row) ?? emptyAcc();
      perRow.set(row, acc);
    } else {
      acc = perOtherArea.get(plot.area_name) ?? emptyAcc();
      perOtherArea.set(plot.area_name, acc);
    }

    acc.totalCount += 1;
    acc.usedCount += used;
  }

  const blocks: MonthlyReportBlock[] = MONTHLY_REPORT_BLOCKS.map((spec) => {
    // 0件の区画も行として残す（帳票の枠を再現するため。登録漏れにも気づける）
    const rows = spec.rows.map((rowSpec) => {
      const acc = perRow.get(rowSpec) ?? emptyAcc();
      return finalizeRow(rowSpec.label, acc.totalCount, acc.usedCount);
    });
    const blockTotal = spec.rows.reduce<Accumulator>((sum, rowSpec) => {
      const acc = perRow.get(rowSpec) ?? emptyAcc();
      return {
        totalCount: sum.totalCount + acc.totalCount,
        usedCount: sum.usedCount + acc.usedCount,
      };
    }, emptyAcc());
    return {
      period: spec.period,
      title: spec.title,
      rows,
      total: finalizeRow('合計', blockTotal.totalCount, blockTotal.usedCount),
    };
  });

  let otherBlock: MonthlyReportBlock | null = null;
  if (includeOther && perOtherArea.size > 0) {
    // 件数降順。同数の並びは区画名のコードポイント順で決める。localeCompare は
    // Node の ICU ビルドによって結果が変わりうるので使わない（CI は 20.x と 22.x）
    const sorted = [...perOtherArea.entries()].sort(
      (a, b) => b[1].totalCount - a[1].totalCount || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    const otherTotal = sorted.reduce<Accumulator>(
      (sum, [, acc]) => ({
        totalCount: sum.totalCount + acc.totalCount,
        usedCount: sum.usedCount + acc.usedCount,
      }),
      emptyAcc()
    );
    otherBlock = {
      period: OTHER_BLOCK_TITLE,
      title: OTHER_BLOCK_TITLE,
      rows: sorted.map(([areaName, acc]) => finalizeRow(areaName, acc.totalCount, acc.usedCount)),
      total: finalizeRow('合計', otherTotal.totalCount, otherTotal.usedCount),
    };
  }

  // 総区画数・使用区画数・残区画数は帳票と同じくブロック合計から導く。
  // （その他を含めない設定なら、その分は総区画数からも外れる）
  const shownBlocks = otherBlock ? [...blocks, otherBlock] : blocks;
  const totalCount = shownBlocks.reduce((sum, b) => sum + b.total.totalCount, 0);
  const usedCount = shownBlocks.reduce((sum, b) => sum + b.total.usedCount, 0);

  const now = new Date();
  const fiscalYear = resolveFiscalYear(now);
  const [soldThisFiscalYear, cumulativeSoldCount] = await Promise.all([
    prisma.contractPlot.count({
      where: {
        deleted_at: null,
        contract_status: 'active',
        contract_date: { gte: fiscalYearStart(fiscalYear) },
      },
    }),
    // 累計販売区画数: 契約日が入っている契約の全期間累計。解約済みも「販売した」
    // 実績なので contract_status で絞らない（vacant の器契約は契約日を持たない）。
    prisma.contractPlot.count({
      where: { deleted_at: null, contract_date: { not: null } },
    }),
  ]);

  return {
    asOfDate: now.toISOString(),
    blocks,
    otherBlock,
    summary: {
      totalCount,
      usedCount,
      remainingCount: Math.max(0, totalCount - usedCount),
      soldThisFiscalYear,
      cumulativeSoldCount,
      fiscalYear,
    },
  };
}
