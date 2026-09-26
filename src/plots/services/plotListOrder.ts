import { resolvePeriod } from './inventoryService';

/** 台帳を開いたときの並び。第1期が先頭、どれにも入らない区画は末尾。 */
const PERIOD_RANK: Record<string, number> = {
  第1期: 1,
  第2期: 2,
  第3期: 3,
  第3期樹林部: 4,
  第4期: 5,
};

export interface LedgerOrderKey {
  id: string;
  areaName: string;
  displayNumber: string | null;
  plotNumber: string;
}

function periodRank(areaName: string, sectionPeriodMap: Map<string, string>): number {
  return PERIOD_RANK[resolvePeriod(areaName, sectionPeriodMap)] ?? 6;
}

/**
 * 台帳の初期順。期（第1期→その他）→エリア→表示用区画番号→区画番号。
 * 表示用番号が空の行は、昇順でも降順でも末尾に残す。
 */
export function compareLedgerOrder(
  a: LedgerOrderKey,
  b: LedgerOrderKey,
  sectionPeriodMap: Map<string, string>,
  sortOrder: 'asc' | 'desc' = 'asc'
): number {
  const dir = sortOrder === 'desc' ? -1 : 1;
  const byPeriod =
    periodRank(a.areaName, sectionPeriodMap) - periodRank(b.areaName, sectionPeriodMap);
  if (byPeriod !== 0) return byPeriod * dir;

  const byArea = a.areaName.localeCompare(b.areaName, 'ja', { numeric: true });
  if (byArea !== 0) return byArea * dir;

  if (a.displayNumber == null && b.displayNumber != null) return 1;
  if (a.displayNumber != null && b.displayNumber == null) return -1;
  if (a.displayNumber != null && b.displayNumber != null) {
    const byDisplay = a.displayNumber.localeCompare(b.displayNumber, 'ja', { numeric: true });
    if (byDisplay !== 0) return byDisplay * dir;
  }

  const byPlot = a.plotNumber.localeCompare(b.plotNumber, 'ja', { numeric: true });
  if (byPlot !== 0) return byPlot * dir;
  return a.id.localeCompare(b.id);
}
