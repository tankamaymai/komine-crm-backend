/**
 * ゆうちょ連携ルート
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission, ROLES } from '../middleware/permission';
import { withLogging } from '../middleware/controllerLogger';
import {
  getYuchoBilling,
  exportYuchoCsv,
  previewYuchoResultFile,
  applyYuchoResultFile,
} from './yuchoController';

const router = Router();

// 請求対象データ取得（manager以上）
router.get(
  '/billing',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Yucho', 'getBilling', getYuchoBilling)
);

// CSV エクスポート（manager以上）
router.get(
  '/export',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Yucho', 'exportCsv', exportYuchoCsv)
);

// 引き落とし結果ファイルの中身を確かめる（書き込まない。manager以上）
router.post(
  '/result/preview',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Yucho', 'previewResult', previewYuchoResultFile)
);

// 引き落とせた分に入金を付ける（manager以上）
router.post(
  '/result/apply',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Yucho', 'applyResult', applyYuchoResultFile)
);

export default router;
