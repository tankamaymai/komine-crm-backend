// puppeteer 25 は ESM 専用で CommonJS の Jest から読めないため、実物を読ませない
jest.mock('puppeteer', () => ({ launch: jest.fn() }));

import request from 'supertest';
import express from 'express';
import documentRoutes from '../../src/documents/documentRoutes';
import * as documentController from '../../src/documents/documentController';

// コントローラーのモック（multerミドルウェアは実物を通す）
jest.mock('../../src/documents/documentController', () => ({
  getDocuments: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'getDocuments' })
  ),
  getDocumentById: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'getDocumentById' })
  ),
  createDocument: jest.fn((req, res) =>
    res.status(201).json({ success: true, controller: 'createDocument' })
  ),
  updateDocument: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'updateDocument' })
  ),
  deleteDocument: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'deleteDocument' })
  ),
  generatePdf: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'generatePdf' })
  ),
  regeneratePdf: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'regeneratePdf' })
  ),
  uploadDocumentFile: jest.fn((req, res) =>
    res.status(200).json({
      success: true,
      controller: 'uploadDocumentFile',
      hasFile: Boolean(req.file),
    })
  ),
  getDocumentDownloadUrl: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'getDocumentDownloadUrl' })
  ),
  getDocumentFile: jest.fn((req, res) =>
    res.status(200).json({ success: true, controller: 'getDocumentFile' })
  ),
}));

jest.mock('../../src/middleware/auth', () => ({
  authenticate: jest.fn((req, res, next) => next()),
}));

jest.mock('../../src/middleware/permission', () => ({
  requirePermission: jest.fn(() => (req: unknown, res: unknown, next: () => void) => next()),
}));

const mockDocumentController = documentController as jest.Mocked<typeof documentController>;

const DOC_UUID = '11111111-1111-4111-8111-111111111111';

describe('Document Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/documents', documentRoutes);
    jest.clearAllMocks();
  });

  describe('POST /api/v1/documents/:id/upload', () => {
    it('PDFファイルを添付するとコントローラーへ到達しreq.fileが設定される', async () => {
      const response = await request(app)
        .post(`/api/v1/documents/${DOC_UUID}/upload`)
        .attach('file', Buffer.from('%PDF-1.7 test'), {
          filename: 'test.pdf',
          contentType: 'application/pdf',
        });

      expect(response.status).toBe(200);
      expect(response.body.controller).toBe('uploadDocumentFile');
      expect(response.body.hasFile).toBe(true);
      expect(mockDocumentController.uploadDocumentFile).toHaveBeenCalledTimes(1);
    });

    it('許可されていないMIMEタイプは400を返す', async () => {
      const response = await request(app)
        .post(`/api/v1/documents/${DOC_UUID}/upload`)
        .attach('file', Buffer.from('#!/bin/sh'), {
          filename: 'evil.sh',
          contentType: 'application/x-sh',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockDocumentController.uploadDocumentFile).not.toHaveBeenCalled();
    });

    it('10MB超のファイルは400を返す', async () => {
      const response = await request(app)
        .post(`/api/v1/documents/${DOC_UUID}/upload`)
        .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), {
          filename: 'big.pdf',
          contentType: 'application/pdf',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('10MB');
      expect(mockDocumentController.uploadDocumentFile).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/documents/:id/download', () => {
    it('ダウンロードURL取得コントローラーへルーティングされる', async () => {
      const response = await request(app).get(`/api/v1/documents/${DOC_UUID}/download`);

      expect(response.status).toBe(200);
      expect(response.body.controller).toBe('getDocumentDownloadUrl');
    });
  });

  describe('GET /api/v1/documents/:id/file', () => {
    it('ファイル配信コントローラーへルーティングされる', async () => {
      const response = await request(app).get(`/api/v1/documents/${DOC_UUID}/file`);

      expect(response.status).toBe(200);
      expect(response.body.controller).toBe('getDocumentFile');
    });
  });
});
