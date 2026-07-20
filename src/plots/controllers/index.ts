/**
 * Plot Controllers Index
 * すべてのプロットコントローラー関数をエクスポート
 */

export { getPlots } from './getPlots';
export { getGraveClassifications } from './getGraveClassifications';
export { getPlotById } from './getPlotById';
export { createPlot } from './createPlot';
export { createPhysicalPlot } from './createPhysicalPlot';
export { updatePlot } from './updatePlot';
export { deletePlot } from './deletePlot';
export { restoreContract } from './restoreContract';
export { terminateContract } from './terminateContract';
export { changeContractor } from './changeContractor';
export { getPlotContracts } from './getPlotContracts';
export { createPlotContract } from './createPlotContract';
export { getPlotInventory } from './getPlotInventory';

// 在庫管理API
export { getInventorySummary } from './getInventorySummary';
export { getInventoryPeriods } from './getInventoryPeriods';
export { getInventorySections } from './getInventorySections';
export { getInventoryAreas } from './getInventoryAreas';

// 履歴管理API
export { getPlotHistory } from './getPlotHistory';
