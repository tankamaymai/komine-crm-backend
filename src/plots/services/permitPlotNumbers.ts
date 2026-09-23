/**
 * 許可証は、同じ契約者の区画がいくつあっても1枚にまとめる。
 * ここに、その区画番号の並べ方を置く。
 */

export type PermitPlotSource = {
  areaName: string;
  displayNumber: string | null;
  plotNumber: string;
};

/** 台帳の表示と同じ「地区 番号」 */
export function formatPermitPlotLabel(plot: PermitPlotSource): string {
  const number = (plot.displayNumber || plot.plotNumber).trim();
  const area = plot.areaName.trim();
  if (area && number) return `${area} ${number}`;
  return number || area;
}

/** 地区名、その中で番号の小さい順 */
export function sortPermitPlots<T extends PermitPlotSource>(plots: T[]): T[] {
  return [...plots].sort((a, b) => {
    const byArea = a.areaName.localeCompare(b.areaName, 'ja');
    if (byArea !== 0) return byArea;
    const aNumber = a.displayNumber || a.plotNumber;
    const bNumber = b.displayNumber || b.plotNumber;
    return aNumber.localeCompare(bNumber, 'ja', { numeric: true });
  });
}

/** 1枚の許可証に書く区画番号。同じ番号は1回だけ。 */
export function joinPermitPlotNumbers(plots: PermitPlotSource[]): string {
  const labels = sortPermitPlots(plots).map(formatPermitPlotLabel);
  return [...new Set(labels.filter(Boolean))].join('、');
}
