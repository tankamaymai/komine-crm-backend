import { PrismaClient, Prisma } from '@prisma/client';
import {
  InventorySummaryData,
  PeriodSummaryItem,
  SectionInventoryItem,
  AreaInventoryItem,
  PlotPeriod,
  PlotStatus,
  SectionSortKey,
  AreaSortKey,
  SortOrder,
} from '../../validations/inventoryValidation';

// 期の定義（区画名一覧.md / SectionNameMasterのperiodに準拠）。表示順の正本。
export const PERIODS: PlotPeriod[] = ['第1期', '第2期', '第3期', '第3期樹林部', '第4期'];

// マスタにも期名にも一致しない区画（移行のテストデータ等）の受け皿。
// 全体サマリーと期別サマリーの合計を必ず一致させるための未分類バケット。#166
export const UNCLASSIFIED_PERIOD = 'その他';

// Prisma Decimalまたは数値を数値に変換するヘルパー
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
  return isNaN(num) ? 0 : num;
}

/**
 * 区画名（area_name）→ 期 のマッピングを区画名マスタ（section_name_master）から読み込む。
 *
 * #151 で PhysicalPlot.area_name は実区画名（A / 凛B / つながり / 樹林 等）になったため、
 * 期（第N期）は area_name そのものではなくマスタ経由で解決する。マスタは業務が
 * `/api/v1/masters/section-name` から編集できるので、ここが期判定の正本になる。#166
 */
export async function loadSectionPeriodMap(prisma: DbClient): Promise<Map<string, string>> {
  const rows = await prisma.sectionNameMaster.findMany({
    where: { is_active: true },
    select: { name: true, period: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.name, row.period);
  return map;
}

/**
 * 区画名（area_name）から期を解決する。
 *   1. area_name 自体が期名（手動作成区画の "第1期" 等）ならそのまま採用。
 *   2. 区画名マスタに登録があればその期。
 *   3. いずれにも該当しなければ「その他」（未分類バケット）。#166
 */
export function resolvePeriod(areaName: string, sectionPeriodMap: Map<string, string>): string {
  if ((PERIODS as readonly string[]).includes(areaName)) return areaName;
  return sectionPeriodMap.get(areaName) ?? UNCLASSIFIED_PERIOD;
}

/** 台帳の期フィルタ。include はその期の区画名、exclude は「その他」（マスタ外）。 */
export type PeriodAreaFilter =
  | { kind: 'include'; names: string[] }
  | { kind: 'exclude'; names: string[] };

export function areaNamesForPeriod(
  period: string,
  sectionPeriodMap: Map<string, string>
): PeriodAreaFilter {
  if (period === UNCLASSIFIED_PERIOD) {
    const names = new Set<string>([...PERIODS, ...sectionPeriodMap.keys()]);
    return { kind: 'exclude', names: [...names] };
  }
  const names = new Set<string>([period]);
  for (const [name, mapped] of sectionPeriodMap) {
    if (mapped === period) names.add(name);
  }
  return { kind: 'include', names: [...names] };
}

/**
 * セクション（区画名）を特殊区画カテゴリに分類する。
 *
 *   - 樹林 / 天空 / 天空K → 「樹林・天空」
 *   - 納骨堂系（納骨堂-天空 等） → 「納骨堂」（室内納骨で通常区画と性質が異なる）
 *   それ以外（A〜P・数字・凛A〜D・つながり・桜系 等）はカテゴリ無し（undefined）。
 */
export function categorizeSection(section: string): string | undefined {
  if (section === '樹林' || section === '天空' || section === '天空K') return '樹林・天空';
  if (section.includes('納骨堂')) return '納骨堂';
  return undefined;
}

/**
 * セクション名（区画名）から区画タイプ（面積別集計の表示用分類）を判定する。
 *
 *   - "吉相" で始まる（吉相 / 吉相C / 吉相テラス） → "吉相"
 *   - 樹林 / 樹木葬 → "樹林"
 *   - "天空" を含む（天空K等） → "天空"
 *   - "るり庵" を含む（るり庵テラス/Ⅱ/ガーデン等） / 想 → "るり庵"
 *   - "納骨堂" を含む → "納骨堂"
 *   - "桜" を含む（桜シェア葬 / 千年桜） → "桜"
 *   - 墳墓 → "墳墓"（将来用）
 *   - 憩 / 恵 → "特別区"
 *   - その他（A〜P, 1〜11, 凛A〜D, つながり 等） → "自由"
 */
export function determinePlotType(section: string, _areaSqm: number): string {
  if (section.includes('納骨堂')) return '納骨堂'; // "納骨堂-天空" を天空より先に判定
  if (section.startsWith('吉相')) return '吉相';
  if (section === '樹林' || section === '樹木葬') return '樹林';
  if (section.includes('天空')) return '天空';
  if (section.includes('るり庵')) return 'るり庵';
  if (section === '想') return 'るり庵';
  if (section.includes('桜')) return '桜';
  if (section === '墳墓') return '墳墓';
  if (section === '憩' || section === '恵') return '特別区';
  return '自由';
}

interface GetInventoryOptions {
  period?: string;
  status?: PlotStatus;
  search?: string;
  sortBy?: SectionSortKey | AreaSortKey;
  sortOrder?: SortOrder;
  page?: number;
  limit?: number;
}

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * 在庫集計に算入する契約区画の取得条件（#209）。
 * vacant の器契約（空き区画の表現方式）と terminated（解約済み）を
 * 契約済み面積から除外し、calculateAvailableArea / validateContractArea
 * （plots/utils.ts）と母数を統一する。
 */
const ACTIVE_CONTRACT_PLOTS_INCLUDE = {
  where: { deleted_at: null, contract_status: 'active' },
  select: { contract_area_sqm: true },
} as const;

/**
 * partially_sold 区画の使用割合を算出する（#205）。
 * 移行データ等で契約面積合計が物理面積を超えても 1 を上限にクランプし、
 * usedCount > totalCount による残数の負値化を防ぐ。
 */
function clampedUsedPortion(contractedArea: number, plotArea: number): number {
  if (plotArea <= 0) return 0;
  return Math.min(1, contractedArea / plotArea);
}

/**
 * 全体サマリーを取得
 */
export async function getOverallSummary(prisma: DbClient): Promise<InventorySummaryData> {
  // 全物理区画を取得（削除されていないもの）
  const physicalPlots = await prisma.physicalPlot.findMany({
    where: { deleted_at: null },
    include: {
      contractPlots: ACTIVE_CONTRACT_PLOTS_INCLUDE,
    },
  });

  let totalCount = 0;
  let usedCount = 0;
  let totalAreaSqm = 0;
  let usedAreaSqm = 0;

  for (const plot of physicalPlots) {
    totalCount += 1;
    const plotArea = plot.area_sqm ? toNumber(plot.area_sqm) : 3.6;
    totalAreaSqm += plotArea;

    // 契約面積の合計
    const contractedArea = plot.contractPlots.reduce(
      (sum, cp) => sum + toNumber(cp.contract_area_sqm),
      0
    );

    // ステータスに基づいてカウント
    if (plot.status === 'sold_out') {
      usedCount += 1;
      usedAreaSqm += plotArea;
    } else if (plot.status === 'partially_sold' && contractedArea > 0) {
      // 部分的に売却されている場合、面積比率で計算（物理面積を上限にクランプ #205）
      usedAreaSqm += Math.min(plotArea, contractedArea);
      // カウントは部分的としてカウント
      usedCount += clampedUsedPortion(contractedArea, plotArea);
    }
  }

  // 丸め整合性のため、usedCountを先に丸めてremainingCountをそこから導出する
  // （別経路でMath.roundするとused + remaining ≠ totalになるケースがある）
  const roundedTotalCount = Math.round(totalCount);
  const roundedUsedCount = Math.round(usedCount);
  const remainingCount = Math.max(0, roundedTotalCount - roundedUsedCount);
  const remainingAreaSqm = Math.max(0, totalAreaSqm - usedAreaSqm);
  const usageRate = totalCount > 0 ? (usedCount / totalCount) * 100 : 0;

  return {
    totalCount: roundedTotalCount,
    usedCount: roundedUsedCount,
    remainingCount,
    usageRate: Math.round(usageRate * 10) / 10,
    totalAreaSqm: Math.round(totalAreaSqm * 100) / 100,
    remainingAreaSqm: Math.round(remainingAreaSqm * 100) / 100,
    // issue #64 項目 #3: API は常に ISO8601 (UTC) で返す。表示整形はフロント責務。
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 期別サマリーを取得
 * 最適化: N+1クエリを1クエリに統合
 */
export async function getPeriodSummaries(
  prisma: DbClient,
  period?: string
): Promise<PeriodSummaryItem[]> {
  // 区画名 → 期 のマッピング（マスタ）を取得。area_name は実区画名なので
  // 期は area_name そのものではなくマスタ経由で解決する。#166
  const sectionPeriodMap = await loadSectionPeriodMap(prisma);

  // 全物理区画を取得（全体サマリーと同じ母数 = 期別合計が全体と一致する）
  const physicalPlots = await prisma.physicalPlot.findMany({
    where: { deleted_at: null },
    include: {
      contractPlots: ACTIVE_CONTRACT_PLOTS_INCLUDE,
    },
  });

  // 期別にグルーピング
  const plotsByPeriod = new Map<string, { totalCount: number; usedCount: number }>();

  // 標準の期は常に行として出す（0件でも表示するため先に初期化）
  for (const p of PERIODS) {
    plotsByPeriod.set(p, { totalCount: 0, usedCount: 0 });
  }

  // データを集計（各区画の期を area_name から解決）
  for (const plot of physicalPlots) {
    const plotPeriod = resolvePeriod(plot.area_name, sectionPeriodMap);
    let periodData = plotsByPeriod.get(plotPeriod);
    if (!periodData) {
      periodData = { totalCount: 0, usedCount: 0 };
      plotsByPeriod.set(plotPeriod, periodData);
    }

    periodData.totalCount += 1;
    const plotArea = plot.area_sqm ? toNumber(plot.area_sqm) : 3.6;

    const contractedArea = plot.contractPlots.reduce(
      (sum, cp) => sum + toNumber(cp.contract_area_sqm),
      0
    );

    if (plot.status === 'sold_out') {
      periodData.usedCount += 1;
    } else if (plot.status === 'partially_sold' && contractedArea > 0) {
      periodData.usedCount += clampedUsedPortion(contractedArea, plotArea);
    }
  }

  // 出力する期キーを決定。
  //   - 特定の期指定: その期のみ
  //   - 指定なし: 標準5期 + 未分類（その他）が0件超なら末尾に追加
  let outputPeriods: string[];
  if (period) {
    outputPeriods = [period];
  } else {
    outputPeriods = [...PERIODS];
    const other = plotsByPeriod.get(UNCLASSIFIED_PERIOD);
    if (other && other.totalCount > 0) outputPeriods.push(UNCLASSIFIED_PERIOD);
  }

  // 結果を配列に変換
  const results: PeriodSummaryItem[] = outputPeriods.map((p) => {
    const data = plotsByPeriod.get(p) ?? { totalCount: 0, usedCount: 0 };
    // 丸め整合性のため、usedCountを先に丸めてremainingCountをそこから導出
    const roundedTotalCount = Math.round(data.totalCount);
    const roundedUsedCount = Math.round(data.usedCount);
    const remainingCount = Math.max(0, roundedTotalCount - roundedUsedCount);
    const usageRate = data.totalCount > 0 ? (data.usedCount / data.totalCount) * 100 : 0;

    return {
      period: p,
      totalCount: roundedTotalCount,
      usedCount: roundedUsedCount,
      remainingCount,
      usageRate: Math.round(usageRate * 10) / 10,
    };
  });

  return results;
}

/**
 * セクション別集計を取得
 */
export async function getSectionInventory(
  prisma: DbClient,
  options: GetInventoryOptions = {}
): Promise<{ items: SectionInventoryItem[]; total: number }> {
  const {
    period,
    status,
    search,
    sortBy = 'period',
    sortOrder = 'asc',
    page = 1,
    limit = 20,
  } = options;

  // 区画名 → 期 のマッピング（マスタ）を取得。#166
  const sectionPeriodMap = await loadSectionPeriodMap(prisma);

  // 条件に合う物理区画を取得（期は area_name から解決するため DB では絞らない）
  const whereClause: Prisma.PhysicalPlotWhereInput = {
    deleted_at: null,
  };

  if (status) {
    whereClause.status = status;
  }

  const physicalPlots = await prisma.physicalPlot.findMany({
    where: whereClause,
    include: {
      contractPlots: ACTIVE_CONTRACT_PLOTS_INCLUDE,
    },
  });

  // セクション別に集計（section = area_name = 実区画名）
  const sectionMap = new Map<
    string,
    {
      period: string;
      section: string;
      totalCount: number;
      usedCount: number;
      category?: string;
    }
  >();

  for (const plot of physicalPlots) {
    const section = plot.area_name;
    const plotPeriod = resolvePeriod(section, sectionPeriodMap);

    // 期フィルタ（マスタ経由で解決した期で絞る）
    if (period && plotPeriod !== period) continue;

    const key = section;
    const plotArea = plot.area_sqm ? toNumber(plot.area_sqm) : 3.6;

    const contractedArea = plot.contractPlots.reduce(
      (sum, cp) => sum + toNumber(cp.contract_area_sqm),
      0
    );

    let usedPortion = 0;
    if (plot.status === 'sold_out') {
      usedPortion = 1;
    } else if (plot.status === 'partially_sold' && contractedArea > 0) {
      usedPortion = clampedUsedPortion(contractedArea, plotArea);
    }

    if (sectionMap.has(key)) {
      const existing = sectionMap.get(key)!;
      existing.totalCount += 1;
      existing.usedCount += usedPortion;
    } else {
      sectionMap.set(key, {
        period: plotPeriod,
        section,
        totalCount: 1,
        usedCount: usedPortion,
        category: categorizeSection(section),
      });
    }
  }

  // 結果を配列に変換
  let items: SectionInventoryItem[] = Array.from(sectionMap.values()).map((item) => {
    // 丸め整合性のため、usedCountを先に丸めてremainingCountをそこから導出
    const roundedTotalCount = Math.round(item.totalCount);
    const roundedUsedCount = Math.round(item.usedCount);
    const remainingCount = Math.max(0, roundedTotalCount - roundedUsedCount);
    const usageRate = item.totalCount > 0 ? (item.usedCount / item.totalCount) * 100 : 0;

    return {
      period: item.period,
      section: item.section,
      totalCount: roundedTotalCount,
      usedCount: roundedUsedCount,
      remainingCount,
      usageRate: Math.round(usageRate * 10) / 10,
      category: item.category,
    };
  });

  // 検索フィルタ
  if (search) {
    const searchLower = search.toLowerCase();
    items = items.filter(
      (item) =>
        item.period.toLowerCase().includes(searchLower) ||
        item.section.toLowerCase().includes(searchLower) ||
        (item.category && item.category.toLowerCase().includes(searchLower))
    );
  }

  // ソート
  items.sort((a, b) => {
    let comparison = 0;
    switch (sortBy as SectionSortKey) {
      case 'period':
        comparison = a.period.localeCompare(b.period);
        break;
      case 'section':
        comparison = a.section.localeCompare(b.section);
        break;
      case 'totalCount':
        comparison = a.totalCount - b.totalCount;
        break;
      case 'usedCount':
        comparison = a.usedCount - b.usedCount;
        break;
      case 'remainingCount':
        comparison = a.remainingCount - b.remainingCount;
        break;
      case 'usageRate':
        comparison = a.usageRate - b.usageRate;
        break;
      default:
        comparison = a.period.localeCompare(b.period);
    }
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const total = items.length;

  // ページネーション
  const startIndex = (page - 1) * limit;
  const paginatedItems = items.slice(startIndex, startIndex + limit);

  return { items: paginatedItems, total };
}

/**
 * 面積別集計を取得
 */
export async function getAreaInventory(
  prisma: DbClient,
  options: GetInventoryOptions = {}
): Promise<{ items: AreaInventoryItem[]; total: number }> {
  const { period, search, sortBy = 'period', sortOrder = 'asc', page = 1, limit = 20 } = options;

  // 区画名 → 期 のマッピング（マスタ）を取得。#166
  const sectionPeriodMap = await loadSectionPeriodMap(prisma);

  // 条件に合う物理区画を取得（期は area_name から解決するため DB では絞らない）
  const whereClause: Prisma.PhysicalPlotWhereInput = {
    deleted_at: null,
  };

  const physicalPlots = await prisma.physicalPlot.findMany({
    where: whereClause,
    include: {
      contractPlots: ACTIVE_CONTRACT_PLOTS_INCLUDE,
    },
  });

  // 面積・期・タイプ別に集計
  const areaMap = new Map<
    string,
    {
      period: string;
      areaSqm: number;
      plotType: string;
      totalCount: number;
      usedCount: number;
      totalAreaSqm: number;
      usedAreaSqm: number;
    }
  >();

  for (const plot of physicalPlots) {
    const section = plot.area_name;
    const plotPeriod = resolvePeriod(section, sectionPeriodMap);

    // 期フィルタ（マスタ経由で解決した期で絞る）
    if (period && plotPeriod !== period) continue;

    const plotArea = plot.area_sqm ? toNumber(plot.area_sqm) : 3.6;
    const plotType = determinePlotType(section, plotArea);
    const key = `${plotPeriod}-${plotArea}-${plotType}`;

    const contractedArea = plot.contractPlots.reduce(
      (sum, cp) => sum + toNumber(cp.contract_area_sqm),
      0
    );

    let usedPortion = 0;
    let usedAreaForPlot = 0;
    if (plot.status === 'sold_out') {
      usedPortion = 1;
      usedAreaForPlot = plotArea;
    } else if (plot.status === 'partially_sold' && contractedArea > 0) {
      usedPortion = clampedUsedPortion(contractedArea, plotArea);
      usedAreaForPlot = Math.min(plotArea, contractedArea);
    }

    if (areaMap.has(key)) {
      const existing = areaMap.get(key)!;
      existing.totalCount += 1;
      existing.usedCount += usedPortion;
      existing.totalAreaSqm += plotArea;
      existing.usedAreaSqm += usedAreaForPlot;
    } else {
      areaMap.set(key, {
        period: plotPeriod,
        areaSqm: plotArea,
        plotType,
        totalCount: 1,
        usedCount: usedPortion,
        totalAreaSqm: plotArea,
        usedAreaSqm: usedAreaForPlot,
      });
    }
  }

  // 結果を配列に変換
  let items: AreaInventoryItem[] = Array.from(areaMap.values()).map((item) => {
    // 丸め整合性のため、usedCountを先に丸めてremainingCountをそこから導出
    const roundedTotalCount = Math.round(item.totalCount);
    const roundedUsedCount = Math.round(item.usedCount);
    const remainingCount = Math.max(0, roundedTotalCount - roundedUsedCount);
    const remainingAreaSqm = Math.max(0, item.totalAreaSqm - item.usedAreaSqm);

    return {
      period: item.period,
      areaSqm: item.areaSqm,
      totalCount: roundedTotalCount,
      usedCount: roundedUsedCount,
      remainingCount,
      remainingAreaSqm: Math.round(remainingAreaSqm * 100) / 100,
      plotType: item.plotType,
    };
  });

  // 検索フィルタ
  if (search) {
    const searchLower = search.toLowerCase();
    items = items.filter(
      (item) =>
        item.period.toLowerCase().includes(searchLower) ||
        item.plotType.toLowerCase().includes(searchLower) ||
        item.areaSqm.toString().includes(searchLower)
    );
  }

  // ソート
  items.sort((a, b) => {
    let comparison = 0;
    switch (sortBy as AreaSortKey) {
      case 'period':
        comparison = a.period.localeCompare(b.period);
        break;
      case 'areaSqm':
        comparison = a.areaSqm - b.areaSqm;
        break;
      case 'totalCount':
        comparison = a.totalCount - b.totalCount;
        break;
      case 'usedCount':
        comparison = a.usedCount - b.usedCount;
        break;
      case 'remainingCount':
        comparison = a.remainingCount - b.remainingCount;
        break;
      case 'remainingAreaSqm':
        comparison = a.remainingAreaSqm - b.remainingAreaSqm;
        break;
      case 'plotType':
        comparison = a.plotType.localeCompare(b.plotType);
        break;
      default:
        comparison = a.period.localeCompare(b.period);
    }
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const total = items.length;

  // ページネーション
  const startIndex = (page - 1) * limit;
  const paginatedItems = items.slice(startIndex, startIndex + limit);

  return { items: paginatedItems, total };
}
