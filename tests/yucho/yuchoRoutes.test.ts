import request from 'supertest';
import express, { Express } from 'express';

jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      id: 1,
      email: 'test@example.com',
      name: 'テストユーザー',
      role: 'admin',
      is_active: true,
      supabase_uid: 'test-uid',
    };
    next();
  },
}));

jest.mock('../../src/middleware/permission', () => ({
  ROLES: { VIEWER: 'viewer', OPERATOR: 'operator', MANAGER: 'manager', ADMIN: 'admin' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../src/yucho/yuchoController', () => ({
  getYuchoBilling: jest.fn((_req, res) =>
    res.status(200).json({ success: true, data: { items: [] } })
  ),
  exportYuchoCsv: jest.fn((_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="test.csv"');
    return res.status(200).send('1\r\n8\r\n9\r\n');
  }),
  previewYuchoResultFile: jest.fn((_req, res) =>
    res.status(200).json({ success: true, data: { rows: [] } })
  ),
  applyYuchoResultFile: jest.fn((_req, res) =>
    res.status(200).json({ success: true, data: { recordedCount: 0 } })
  ),
}));

import yuchoRoutes from '../../src/yucho/yuchoRoutes';
import {
  getYuchoBilling,
  exportYuchoCsv,
  previewYuchoResultFile,
  applyYuchoResultFile,
} from '../../src/yucho/yuchoController';

describe('Yucho Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/yucho', yuchoRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/yucho/billing → 200 and calls controller', async () => {
    const res = await request(app).get('/api/v1/yucho/billing?year=2026&month=4');
    expect(res.status).toBe(200);
    expect(getYuchoBilling).toHaveBeenCalled();
    expect(res.body.success).toBe(true);
  });

  it('GET /api/v1/yucho/export → 200 with CSV content type', async () => {
    const res = await request(app).get('/api/v1/yucho/export?year=2026&month=4');
    expect(res.status).toBe(200);
    expect(exportYuchoCsv).toHaveBeenCalled();
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('POST /api/v1/yucho/result/preview → 結果ファイルの確認を呼ぶ', async () => {
    const res = await request(app)
      .post('/api/v1/yucho/result/preview')
      .send({ year: 2027, month: 3, fileBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(previewYuchoResultFile).toHaveBeenCalled();
    expect(applyYuchoResultFile).not.toHaveBeenCalled();
  });

  it('POST /api/v1/yucho/result/apply → 入金を付ける処理を呼ぶ', async () => {
    const res = await request(app)
      .post('/api/v1/yucho/result/apply')
      .send({ year: 2027, month: 3, fileBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(applyYuchoResultFile).toHaveBeenCalled();
  });
});
