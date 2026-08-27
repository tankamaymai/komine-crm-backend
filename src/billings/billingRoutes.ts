import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission, ROLES } from '../middleware/permission';
import { withLogging } from '../middleware/controllerLogger';
import {
  getBillings,
  getBillingsSummary,
  getBillingById,
  createBilling,
  updateBilling,
  deleteBilling,
} from './billingController';
import {
  previewPrepaidBilling,
  createPrepaidBilling,
  deletePrepaidBilling,
} from './prepaidBillingController';

const router = Router();

// 一覧取得（viewer以上）
router.get(
  '/',
  authenticate,
  requirePermission([ROLES.VIEWER, ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'getList', getBillings)
);

// サマリー集計（viewer以上）
// ※ '/:id' より先に登録すること（後だと 'summary' が :id にマッチする）
router.get(
  '/summary',
  authenticate,
  requirePermission([ROLES.VIEWER, ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'getSummary', getBillingsSummary)
);

// 前受金プレビュー（operator以上）
// ※ '/:id' より先に登録すること（後だと 'prepaid' が :id にマッチする）
router.post(
  '/prepaid/preview',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'previewPrepaid', previewPrepaidBilling)
);

// 前受金一括登録（operator以上）
router.post(
  '/prepaid',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'createPrepaid', createPrepaidBilling)
);

// 前受金一括取り消し（manager以上）
router.delete(
  '/prepaid/:batchId',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'deletePrepaid', deletePrepaidBilling)
);

// 詳細取得（viewer以上）
router.get(
  '/:id',
  authenticate,
  requirePermission([ROLES.VIEWER, ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'getById', getBillingById)
);

// 作成（operator以上）
router.post(
  '/',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'create', createBilling)
);

// 更新（operator以上）
router.put(
  '/:id',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'update', updateBilling)
);

// 削除（manager以上）
router.delete(
  '/:id',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Billings', 'delete', deleteBilling)
);

export default router;
