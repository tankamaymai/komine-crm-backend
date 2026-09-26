/**
 * Excel「令和8年度6月.xlsx」の空き区画一覧・販売数を、画面で見るための集計。
 *
 * 残数の表（月次報告・面積別）は別サービス。こちらは次の2枚。
 *   - 空き区画一覧 … 番号と、いま空いている広さ（㎡）
 *   - 販売数 … 6月はじまりの月ごと件数と累計、種類（区画名）ごとの件数と㎡
 *
 * 区画の増減履歴はないので、空きは「いま」の値。販売数は契約日で過去も数える。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { FISCAL_YEAR_START_MONTH } from './monthlyReportService';
import {
  PERIODS,
  UNCLASSIFIED_PERIOD,
  loadSectionPeriodMap,
  resolvePeriod,
} from './inventoryService';

type DbClient = PrismaClient | Prisma.TransactionClient;

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

function roundSqm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function compareLabel(a: string, b: string): number {
  return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
}

export interface VacantLedgerPlot {
  id: string;
  /** 画面に出す区画番号（表示用番号。無ければ内部番号） */
  label: string;
  /** いま空いている広さ。一部だけ売れている区画は残り */
  areaSqm: number;
}

export interface VacantLedgerArea {
  areaName: string;
  plots: VacantLedgerPlot[];
}

export interface VacantLedgerGroup {
  period: string;
  areas: VacantLedgerArea[];
  count: number;
}

export interface VacantLedgerData {
  asOfDate: string;
  total: number;
  groups: VacantLedgerGroup[];
}

export interface VacantSource {
  id: string;
  plotNumber: string;
  displayNumber: string | null;
  areaName: string;
  areaSqm: number;
  availableAreaSqm: number;
}

/** 会計年度（6月開始）。日付は UTC の暦で見る（契約日は日付型）。 */
export function fiscalYearOfUtcDate(date: Date): number {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return month >= FISCAL_YEAR_START_MONTH ? year : year - 1;
}

/** 6月→翌5月の順。Excel「今年度販売区画数」と同じ並び。 */
export const FISCAL_MONTHS = [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5] as const;

export function groupVacantLedger(
  plots: VacantSource[],
  sectionPeriodMap: Map<string, string>,
  asOfDate: string
): VacantLedgerData {
  const byPeriod = new Map<string, Map<string, VacantLedgerPlot[]>>();

  for (const plot of plots) {
    if (plot.availableAreaSqm <= 0) continue;
    const period = resolvePeriod(plot.areaName, sectionPeriodMap);
    const areas = byPeriod.get(period) ?? new Map<string, VacantLedgerPlot[]>();
    const list = areas.get(plot.areaName) ?? [];
    list.push({
      id: plot.id,
      label: plot.displayNumber?.trim() || plot.plotNumber,
      areaSqm: plot.availableAreaSqm,
    });
    areas.set(plot.areaName, list);
    byPeriod.set(period, areas);
  }

  const periodOrder = [
    ...PERIODS,
    ...[...byPeriod.keys()].filter((period) => !(PERIODS as readonly string[]).includes(period)),
  ];

  const groups: VacantLedgerGroup[] = periodOrder
    .filter((period) => period !== UNCLASSIFIED_PERIOD || byPeriod.has(period))
    .map((period) => {
      const areas = byPeriod.get(period);
      const areaList: VacantLedgerArea[] = areas
        ? [...areas.entries()]
            .sort((a, b) => compareLabel(a[0], b[0]))
            .map(([areaName, list]) => ({
              areaName,
              plots: [...list].sort((a, b) => compareLabel(a.label, b.label)),
            }))
        : [];
      const count = areaList.reduce((sum, area) => sum + area.plots.length, 0);
      return { period, areas: areaList, count };
    });

  return {
    asOfDate,
    total: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
  };
}

export async function getVacantLedger(prisma: DbClient): Promise<VacantLedgerData> {
  const [sectionPeriodMap, physicalPlots] = await Promise.all([
    loadSectionPeriodMap(prisma),
    prisma.physicalPlot.findMany({
      where: { deleted_at: null },
      select: {
        id: true,
        plot_number: true,
        display_number: true,
        area_name: true,
        area_sqm: true,
        contractPlots: {
          where: { deleted_at: null, contract_status: 'active' },
          select: { contract_area_sqm: true },
        },
      },
    }),
  ]);

  const sources: VacantSource[] = physicalPlots.map((plot) => {
    const areaSqm = toNumber(plot.area_sqm);
    const allocated = plot.contractPlots.reduce(
      (sum, contract) => sum + toNumber(contract.contract_area_sqm),
      0
    );
    return {
      id: plot.id,
      plotNumber: plot.plot_number,
      displayNumber: plot.display_number,
      areaName: plot.area_name,
      areaSqm,
      availableAreaSqm: roundSqm(areaSqm - allocated),
    };
  });

  return groupVacantLedger(sources, sectionPeriodMap, new Date().toISOString());
}

export interface SalesMonthCount {
  month: number;
  count: number;
  cumulative: number;
}

export interface FiscalYearSales {
  fiscalYear: number;
  months: SalesMonthCount[];
  total: number;
}

export interface TypeSalesRow {
  /** 区画名（樹林、想、るり庵テラスなど）。Excelの「区画」列 */
  areaName: string;
  count: number;
  areaSqm: number;
}

export interface TypeSalesMonth {
  month: number;
  rows: TypeSalesRow[];
}

export interface CalendarYearTypeSales {
  year: number;
  months: TypeSalesMonth[];
  totalCount: number;
  totalAreaSqm: number;
}

export interface SalesLedgerData {
  asOfDate: string;
  /** 絞り込んだ取扱。null は全取扱 */
  agentFilter: string | null;
  /** データに入っている取扱の名前（空のものは除く、最大30件） */
  agentNames: string[];
  fiscalYears: FiscalYearSales[];
  typeSales: CalendarYearTypeSales[];
}

export interface SaleSource {
  contractDate: Date;
  areaName: string;
  areaSqm: number;
  agentName: string | null;
}

export function matchesAgent(agentName: string | null, filter: string | undefined): boolean {
  const needle = filter?.trim();
  if (!needle) return true;
  if (!agentName) return false;
  return agentName.toLocaleLowerCase('ja').includes(needle.toLocaleLowerCase('ja'));
}

function calendarYearMonth(fiscalYear: number, month: number): { year: number; month: number } {
  const year = month >= FISCAL_YEAR_START_MONTH ? fiscalYear : fiscalYear + 1;
  return { year, month };
}

export function buildSalesLedger(
  sales: SaleSource[],
  options: { now: Date; agent?: string }
): SalesLedgerData {
  const agentNames = [
    ...new Set(
      sales.map((sale) => sale.agentName?.trim()).filter((name): name is string => Boolean(name))
    ),
  ]
    .sort(compareLabel)
    .slice(0, 30);

  const needle = options.agent?.trim() || undefined;
  const filtered = sales.filter((sale) => matchesAgent(sale.agentName, needle));

  const currentFiscal = fiscalYearOfUtcDate(options.now);
  const fiscalYears = [currentFiscal, currentFiscal - 1].map((fiscalYear) => {
    let cumulative = 0;
    const months = FISCAL_MONTHS.map((month) => {
      const { year } = calendarYearMonth(fiscalYear, month);
      const count = filtered.filter((sale) => {
        return (
          sale.contractDate.getUTCFullYear() === year &&
          sale.contractDate.getUTCMonth() + 1 === month
        );
      }).length;
      cumulative += count;
      return { month, count, cumulative };
    });
    return {
      fiscalYear,
      months,
      total: cumulative,
    };
  });

  const currentYear = options.now.getUTCFullYear();
  const typeSales = [currentYear, currentYear - 1].map((year) => {
    const byMonth = new Map<number, Map<string, { count: number; areaSqm: number }>>();
    for (const sale of filtered) {
      if (sale.contractDate.getUTCFullYear() !== year) continue;
      const month = sale.contractDate.getUTCMonth() + 1;
      const areas = byMonth.get(month) ?? new Map();
      const row = areas.get(sale.areaName) ?? { count: 0, areaSqm: 0 };
      row.count += 1;
      row.areaSqm = roundSqm(row.areaSqm + sale.areaSqm);
      areas.set(sale.areaName, row);
      byMonth.set(month, areas);
    }
    const months: TypeSalesMonth[] = [...byMonth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([month, areas]) => ({
        month,
        rows: [...areas.entries()]
          .sort((a, b) => compareLabel(a[0], b[0]))
          .map(([areaName, row]) => ({
            areaName,
            count: row.count,
            areaSqm: row.areaSqm,
          })),
      }));
    const totalCount = months.reduce(
      (sum, month) => sum + month.rows.reduce((inner, row) => inner + row.count, 0),
      0
    );
    const totalAreaSqm = roundSqm(
      months.reduce(
        (sum, month) => sum + month.rows.reduce((inner, row) => inner + row.areaSqm, 0),
        0
      )
    );
    return { year, months, totalCount, totalAreaSqm };
  });

  return {
    asOfDate: options.now.toISOString(),
    agentFilter: needle ?? null,
    agentNames,
    fiscalYears,
    typeSales,
  };
}

export async function getSalesLedger(
  prisma: DbClient,
  options: { agent?: string; now?: Date } = {}
): Promise<SalesLedgerData> {
  const rows = await prisma.contractPlot.findMany({
    where: {
      deleted_at: null,
      contract_date: { not: null },
      contract_status: { not: 'vacant' },
    },
    select: {
      contract_date: true,
      contract_area_sqm: true,
      agent_name: true,
      physicalPlot: { select: { area_name: true, deleted_at: true } },
    },
  });

  const sales: SaleSource[] = [];
  for (const row of rows) {
    if (!row.contract_date || row.physicalPlot.deleted_at) continue;
    sales.push({
      contractDate: row.contract_date,
      areaName: row.physicalPlot.area_name,
      areaSqm: toNumber(row.contract_area_sqm),
      agentName: row.agent_name,
    });
  }

  return buildSalesLedger(sales, { now: options.now ?? new Date(), agent: options.agent });
}
