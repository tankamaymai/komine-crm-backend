import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission, ROLES } from '../middleware/permission';
import { withLogging } from '../middleware/controllerLogger';
import {
  getPayments,
  getPaymentById,
  createPayment,
  updatePayment,
  deletePayment,
} from './paymentController';
import { settleRemaining } from './settleRemaining';

const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission([ROLES.VIEWER, ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'getList', getPayments)
);

router.post(
  '/settle-remaining',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'settleRemaining', settleRemaining)
);

router.get(
  '/:id',
  authenticate,
  requirePermission([ROLES.VIEWER, ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'getById', getPaymentById)
);

router.post(
  '/',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'create', createPayment)
);

router.put(
  '/:id',
  authenticate,
  requirePermission([ROLES.OPERATOR, ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'update', updatePayment)
);

router.delete(
  '/:id',
  authenticate,
  requirePermission([ROLES.MANAGER, ROLES.ADMIN]),
  withLogging('Payments', 'delete', deletePayment)
);

export default router;
