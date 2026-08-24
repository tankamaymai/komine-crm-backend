import { Router } from 'express';
import {
  getPlots,
  getGraveClassifications,
  getPlotById,
  createPlot,
  createPhysicalPlot,
  updatePlot,
  deletePlot,
  restoreContract,
  terminateContract,
  changeContractor,
  getPlotContracts,
  createPlotContract,
  getPlotInventory,
  getInventorySummary,
  getInventoryPeriods,
  getInventorySections,
  getInventoryAreas,
  getVacantPlots,
  getPlotMap,
  getPlotHistory,
} from './controllers';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validation';
import { withLogging } from '../middleware/controllerLogger';
import {
  plotSearchQuerySchema,
  plotIdParamsSchema,
  createPlotSchema,
  createPhysicalPlotSchema,
  updatePlotSchema,
  createPlotContractSchema,
  restoreContractSchema,
  terminateContractSchema,
  changeContractorSchema,
  vacantPlotsQuerySchema,
} from '../validations/plotValidation';
import {
  inventorySummaryQuerySchema,
  inventoryPeriodsQuerySchema,
  inventorySectionsQuerySchema,
  inventoryAreasQuerySchema,
} from '../validations/inventoryValidation';
import { plotMapQuerySchema } from '../validations/plotMapValidation';

const router = Router();

// 区画情報一覧取得
router.get(
  '/',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: plotSearchQuerySchema }),
  withLogging('Plots', 'getPlots', getPlots)
);

// 区画区分（grave_kind/kubun/type）の distinct 値取得（フィルタ select 用）
router.get(
  '/grave-classifications',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Plots', 'getGraveClassifications', getGraveClassifications)
);

// ==========================================
// 在庫管理API（/inventory/* は /:id より先に定義）
// ==========================================

// 在庫全体サマリー取得
router.get(
  '/inventory/summary',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: inventorySummaryQuerySchema }),
  withLogging('Plots', 'getInventorySummary', getInventorySummary)
);

// 期別サマリー取得
router.get(
  '/inventory/periods',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: inventoryPeriodsQuerySchema }),
  withLogging('Plots', 'getInventoryPeriods', getInventoryPeriods)
);

// セクション別集計取得
router.get(
  '/inventory/sections',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: inventorySectionsQuerySchema }),
  withLogging('Plots', 'getInventorySections', getInventorySections)
);

// 面積別集計取得
router.get(
  '/inventory/areas',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: inventoryAreasQuerySchema }),
  withLogging('Plots', 'getInventoryAreas', getInventoryAreas)
);

// 区画図用オーバーレイ（区ごとの配置に契約・予約を重ねる）
router.get(
  '/inventory/map',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: plotMapQuerySchema }),
  withLogging('Plots', 'getPlotMap', getPlotMap)
);

// 空き区画一覧取得（議事録 2026-07-21 §6: 区画指定を手入力不可の選択式にする）
// 注意: '/:id' より前に定義すること。後だと id='vacant' として解釈される
router.get(
  '/vacant',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ query: vacantPlotsQuerySchema }),
  withLogging('Plots', 'getVacantPlots', getVacantPlots)
);

// ==========================================
// 区画情報CRUD
// ==========================================

// 区画情報詳細取得
router.get(
  '/:id',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema }),
  withLogging('Plots', 'getPlotById', getPlotById)
);

// 区画情報登録
router.post(
  '/',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ body: createPlotSchema }),
  withLogging('Plots', 'createPlot', createPlot)
);

// 空き区画（物理区画のみ）先行登録（システム確認 項目⑦）
// 旧システムの「区画を先ず作り、後から契約者を入れる」運用に対応
router.post(
  '/physical',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ body: createPhysicalPlotSchema }),
  withLogging('Plots', 'createPhysicalPlot', createPhysicalPlot)
);

// 区画情報更新
router.put(
  '/:id',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema, body: updatePlotSchema }),
  withLogging('Plots', 'updatePlot', updatePlot)
);

// 区画情報削除（論理削除）
router.delete(
  '/:id',
  authenticate,
  requirePermission(['manager', 'admin']),
  validate({ params: plotIdParamsSchema }),
  withLogging('Plots', 'deletePlot', deletePlot)
);

// 契約解約（active → terminated #236。論理削除と異なり解約後も参照・復活可能）
router.post(
  '/:id/terminate',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema, body: terminateContractSchema }),
  withLogging('Plots', 'terminateContract', terminateContract)
);

// 契約復活（terminated → active、誤操作リカバリ用）
router.post(
  '/:id/restore',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema, body: restoreContractSchema }),
  withLogging('Plots', 'restoreContract', restoreContract)
);

// 名義変更（契約はそのままで契約者roleを交代 #310。解約→新契約の区画再利用とは別経路）
router.post(
  '/:id/change-contractor',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema, body: changeContractorSchema }),
  withLogging('Plots', 'changeContractor', changeContractor)
);

// 物理区画の契約一覧取得
router.get(
  '/:id/contracts',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema }),
  withLogging('Plots', 'getPlotContracts', getPlotContracts)
);

// 物理区画に新規契約追加
router.post(
  '/:id/contracts',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema, body: createPlotContractSchema }),
  withLogging('Plots', 'createPlotContract', createPlotContract)
);

// 物理区画の在庫状況取得
router.get(
  '/:id/inventory',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema }),
  withLogging('Plots', 'getPlotInventory', getPlotInventory)
);

// 区画の変更履歴取得
router.get(
  '/:id/history',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  validate({ params: plotIdParamsSchema }),
  withLogging('Plots', 'getPlotHistory', getPlotHistory)
);

export default router;
