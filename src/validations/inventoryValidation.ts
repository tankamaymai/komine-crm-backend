import { z } from 'zod';

// 期の定義（区画名一覧.md / SectionNameMasterのperiodに準拠）
export const PlotPeriodEnum = z.enum(['第1期', '第2期', '第3期', '第3期樹林部', '第4期']);
export type PlotPeriod = z.infer<typeof PlotPeriodEnum>;

// ステータスの定義
export const PlotStatusEnum = z.enum(['available', 'partially_sold', 'sold_out']);
export type PlotStatus = z.infer<typeof PlotStatusEnum>;

// ソートキー（セクション別）
export const SectionSortKeyEnum = z.enum([
  'period',
  'section',
  'totalCount',
  'usedCount',
  'remainingCount',
  'usageRate',
]);
export type SectionSortKey = z.infer<typeof SectionSortKeyEnum>;

// ソートキー（面積別）
export const AreaSortKeyEnum = z.enum([
  'period',
  'areaSqm',
  'totalCount',
  'usedCount',
  'remainingCount',
  'remainingAreaSqm',
  'plotType',
]);
export type AreaSortKey = z.infer<typeof AreaSortKeyEnum>;

// ソート順
export const SortOrderEnum = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderEnum>;

// 全体サマリー用クエリスキーマ（パラメータなし）
export const inventorySummaryQuerySchema = z.object({});

// 期別サマリー用クエリスキーマ
export const inventoryPeriodsQuerySchema = z.object({
  // 期フィルタ。area_name → 期 はマスタ経由で解決されるため、標準5期に加え
  // 「その他」（未分類）も受け付ける。未知値はマッチ0件として扱う。#166
  period: z.string().min(1).max(20).optional(),
});

// セクション別集計用クエリスキーマ
export const inventorySectionsQuerySchema = z.object({
  // 期フィルタ。area_name → 期 はマスタ経由で解決されるため、標準5期に加え
  // 「その他」（未分類）も受け付ける。未知値はマッチ0件として扱う。#166
  period: z.string().min(1).max(20).optional(),
  status: PlotStatusEnum.optional(),
  search: z.string().optional(),
  sortBy: SectionSortKeyEnum.optional().default('period'),
  sortOrder: SortOrderEnum.optional().default('asc'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

// 面積別集計用クエリスキーマ
export const inventoryAreasQuerySchema = z.object({
  // 期フィルタ。area_name → 期 はマスタ経由で解決されるため、標準5期に加え
  // 「その他」（未分類）も受け付ける。未知値はマッチ0件として扱う。#166
  period: z.string().min(1).max(20).optional(),
  search: z.string().optional(),
  sortBy: AreaSortKeyEnum.optional().default('period'),
  sortOrder: SortOrderEnum.optional().default('asc'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

// レスポンス型定義
export interface InventorySummaryData {
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  usageRate: number;
  totalAreaSqm: number;
  remainingAreaSqm: number;
  lastUpdated: string;
}

export interface PeriodSummaryItem {
  // 標準5期に加え「その他」（未分類）が入りうるため string。#166
  period: string;
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  usageRate: number;
}

export interface InventoryPeriodsData {
  periods: PeriodSummaryItem[];
}

export interface SectionInventoryItem {
  period: string;
  section: string;
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  usageRate: number;
  category?: string;
}

export interface InventorySectionsData {
  items: SectionInventoryItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AreaInventoryItem {
  period: string;
  areaSqm: number;
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  remainingAreaSqm: number;
  plotType: string;
}

export interface InventoryAreasData {
  items: AreaInventoryItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// 月次報告（区画残数）帳票用クエリスキーマ
// asOf 相当のパラメータは意図的に持たない。physical_plots に区画の増減履歴が
// ないため過去時点の区画数を復元できず、指定できると誤った数字を出してしまう。
export const inventoryMonthlyReportQuerySchema = z.object({
  // 帳票のレイアウトに載らない区画を「その他」ブロックとして含めるか。
  // 既定 true。false にすると税理士提出物と同じ5ブロックのみになる。
  includeOther: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .describe('レイアウト外の区画を「その他」ブロックとして含めるか'),
});
