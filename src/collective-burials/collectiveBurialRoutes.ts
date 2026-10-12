/**
 * 合祀管理ルート
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission, ROLES } from '../middleware/permission';
import { withLogging } from '../middleware/controllerLogger';
import {
  getCollectiveBurialList,
  getCollectiveBurialById,
  createCollectiveBurial,
  updateCollectiveBurial,
  updateBillingStatus,
  deleteCollectiveBurial,
  syncBurialCount,
  getStatsByYear,
} from './collectiveBurialController';
import {
  getCollectiveBurialSettings,
  postReleaseDueCollectiveBurials,
  updateCollectiveBurialSettings,
} from './collectiveBurialSettingsController';

const router = Router();

// 一覧取得（manager以上）
router.get(
  '/',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'getList', getCollectiveBurialList)
);

// 一斉解約の月（お盆 / 10月）。/:id より前に置く
router.get(
  '/settings',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'getSettings', getCollectiveBurialSettings)
);

router.put(
  '/settings',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'updateSettings', updateCollectiveBurialSettings)
);

// 今年の合祀日を過ぎた人を解約する。今年より前は対象にしない
router.post(
  '/release-due',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'releaseDue', postReleaseDueCollectiveBurials)
);

// 年別統計取得（manager以上）
router.get(
  '/stats/by-year',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'getStatsByYear', getStatsByYear)
);

// 詳細取得（manager以上）
router.get(
  '/:id',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'getById', getCollectiveBurialById)
);

// 作成（admin）
// @deprecated 合祀レコードは区画登録時にburial_capacity設定で自動管理される。
// 将来的に廃止予定。区画API（POST/PUT /plots）経由で合祀設定を行うこと。
router.post(
  '/',
  authenticate,
  requirePermission([ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'create', createCollectiveBurial)
);

// 更新（admin）
router.put(
  '/:id',
  authenticate,
  requirePermission([ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'update', updateCollectiveBurial)
);

// 請求ステータス更新（manager以上）
router.put(
  '/:id/billing-status',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'updateBillingStatus', updateBillingStatus)
);

// 埋葬人数同期（manager以上）
// @deprecated 埋葬者CRUD（PUT /plots/:id）時に自動同期されるようになった。
// 将来的に廃止予定。
router.post(
  '/:id/sync-count',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'syncBurialCount', syncBurialCount)
);

// 削除（admin）
router.delete(
  '/:id',
  authenticate,
  requirePermission([ROLES.ADMIN]),
  withLogging('CollectiveBurials', 'delete', deleteCollectiveBurial)
);

export default router;
