/**
 * 書類管理ルート定義
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { withLogging } from '../middleware/controllerLogger';
import {
  getDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument,
  generatePdf,
  regeneratePdf,
  uploadDocumentFile,
  getDocumentDownloadUrl,
  getDocumentFile,
} from './documentController';
import { getBulkInvoiceTargets, generateBulkInvoice } from './bulkInvoiceController';
import { documentFileUpload } from './uploadMiddleware';

const router = Router();

// 請求書の一括印刷（'/:id' より先に定義。後だと 'bulk-invoice' が :id にマッチする）
router.get(
  '/bulk-invoice/targets',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Documents', 'getBulkInvoiceTargets', getBulkInvoiceTargets)
);

router.post(
  '/bulk-invoice/generate',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  withLogging('Documents', 'generateBulkInvoice', generateBulkInvoice)
);

// 書類一覧取得
router.get(
  '/',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Documents', 'getDocuments', getDocuments)
);

// PDF生成（一覧より先に定義）
router.post(
  '/generate-pdf',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  withLogging('Documents', 'generatePdf', generatePdf)
);

// 書類詳細取得
router.get(
  '/:id',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Documents', 'getDocumentById', getDocumentById)
);

// 書類作成
router.post(
  '/',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  withLogging('Documents', 'createDocument', createDocument)
);

// 書類更新
router.put(
  '/:id',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  withLogging('Documents', 'updateDocument', updateDocument)
);

// 書類削除
router.delete(
  '/:id',
  authenticate,
  requirePermission(['manager', 'admin']),
  withLogging('Documents', 'deleteDocument', deleteDocument)
);

// PDF再生成（保存されたtemplate_dataからオンデマンド再生成）
router.post(
  '/:id/regenerate-pdf',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  withLogging('Documents', 'regeneratePdf', regeneratePdf)
);

// ファイルアップロード（multipart/form-data, fileフィールド）
router.post(
  '/:id/upload',
  authenticate,
  requirePermission(['operator', 'manager', 'admin']),
  documentFileUpload,
  withLogging('Documents', 'uploadDocumentFile', uploadDocumentFile)
);

// ダウンロードURL取得
router.get(
  '/:id/download',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Documents', 'getDocumentDownloadUrl', getDocumentDownloadUrl)
);

// ファイル本体配信（認証付きダウンロード）
router.get(
  '/:id/file',
  authenticate,
  requirePermission(['viewer', 'operator', 'manager', 'admin']),
  withLogging('Documents', 'getDocumentFile', getDocumentFile)
);

export default router;
