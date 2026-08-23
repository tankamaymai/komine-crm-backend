import request from 'supertest';
import express, { Express } from 'express';
import { z } from 'zod';
import plotRoutes from '../../src/plots/plotRoutes';

// モックミドルウェア
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req: any, res: any, next: any) => {
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
  requirePermission: (roles: string[]) => (req: any, res: any, next: any) => next(),
}));

jest.mock('../../src/middleware/validation', () => {
  const { z } = require('zod');
  return {
    validate: (schemas: any) => (req: any, res: any, next: any) => next(),
    uuidSchema: z.string().uuid(),
    dateSchema: z.string(),
    optionalDateSchema: z.string().optional().or(z.literal('')),
    emailSchema: z.string().email(),
    phoneSchema: z.string().optional().or(z.literal('')),
    paginationSchema: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  };
});

// モックコントローラー
jest.mock('../../src/plots/controllers', () => ({
  getPlots: jest.fn((req, res) => res.status(200).json({ success: true, data: [] })),
  getGraveClassifications: jest.fn((req, res) =>
    res.status(200).json({
      success: true,
      data: { graveKinds: [], graveKubuns: [], graveTypes: [] },
    })
  ),
  getPlotById: jest.fn((req, res) => res.status(200).json({ success: true, data: {} })),
  createPlot: jest.fn((req, res) => res.status(201).json({ success: true, data: {} })),
  updatePlot: jest.fn((req, res) => res.status(200).json({ success: true, data: {} })),
  deletePlot: jest.fn((req, res) => res.status(200).json({ success: true })),
  getPlotContracts: jest.fn((req, res) => res.status(200).json({ success: true, data: {} })),
  createPlotContract: jest.fn((req, res) => res.status(201).json({ success: true, data: {} })),
  getPlotInventory: jest.fn((req, res) => res.status(200).json({ success: true, data: {} })),
  // 在庫管理API
  getInventorySummary: jest.fn((req, res) => res.status(200).json({ success: true, data: {} })),
  getInventoryPeriods: jest.fn((req, res) =>
    res.status(200).json({ success: true, data: { periods: [] } })
  ),
  getInventorySections: jest.fn((req, res) =>
    res.status(200).json({ success: true, data: { items: [], pagination: {} } })
  ),
  getInventoryAreas: jest.fn((req, res) =>
    res.status(200).json({ success: true, data: { items: [], pagination: {} } })
  ),
  // 空き区画一覧（議事録 2026-07-21 §6: 区画指定を選択式にする）
  getVacantPlots: jest.fn((req, res) =>
    res.status(200).json({ success: true, data: { items: [], pagination: {} } })
  ),
  // 空き区画（物理区画のみ）先行登録（システム確認 項目⑦）。
  // 一括登録が単発側へ吸われていないことを検証するために必要
  createPhysicalPlot: jest.fn((req, res) => res.status(201).json({ success: true, data: {} })),
  // 空き区画の範囲一括登録（議事録 2026-07-21 §6）
  createPhysicalPlotsBulk: jest.fn((req, res) =>
    res.status(201).json({
      success: true,
      data: { created: [], createdCount: 0, skipped: [], skippedCount: 0 },
    })
  ),
  // 履歴API
  getPlotHistory: jest.fn((req, res) =>
    res.status(200).json({ success: true, data: { items: [], total: 0 } })
  ),
}));

import {
  getPlots,
  getGraveClassifications,
  getPlotById,
  createPlot,
  updatePlot,
  deletePlot,
  getPlotContracts,
  createPlotContract,
  getPlotInventory,
  getVacantPlots,
  createPhysicalPlot,
  createPhysicalPlotsBulk,
} from '../../src/plots/controllers';

describe('Plot Routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/plots', plotRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/plots', () => {
    it('should call getPlots controller', async () => {
      const response = await request(app).get('/api/v1/plots');

      expect(response.status).toBe(200);
      expect(getPlots).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/v1/plots/grave-classifications', () => {
    it('should call getGraveClassifications controller', async () => {
      const response = await request(app).get('/api/v1/plots/grave-classifications');

      expect(response.status).toBe(200);
      expect(getGraveClassifications).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({ graveKinds: [], graveKubuns: [], graveTypes: [] });
    });
  });

  describe('GET /api/v1/plots/vacant', () => {
    it('should call getVacantPlots controller', async () => {
      const response = await request(app).get('/api/v1/plots/vacant');

      expect(response.status).toBe(200);
      expect(getVacantPlots).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });

    // '/vacant' が '/:id' より後に定義されると id='vacant' として getPlotById に流れる。
    // ルート順序の回帰を検知する
    it('should not fall through to getPlotById', async () => {
      await request(app).get('/api/v1/plots/vacant');

      expect(getPlotById).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/plots/physical/bulk', () => {
    it('should call createPhysicalPlotsBulk controller', async () => {
      const response = await request(app)
        .post('/api/v1/plots/physical/bulk')
        .send({ areaName: 'C', startNumber: 1, endNumber: 3 });

      expect(response.status).toBe(201);
      expect(createPhysicalPlotsBulk).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });

    // '/physical' と '/physical/bulk' は別パス。単発側に吸われないことを固定する
    it('should not fall through to createPhysicalPlot', async () => {
      await request(app)
        .post('/api/v1/plots/physical/bulk')
        .send({ areaName: 'C', startNumber: 1, endNumber: 3 });

      expect(createPhysicalPlot).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/plots/:id', () => {
    it('should call getPlotById controller', async () => {
      const response = await request(app).get('/api/v1/plots/test-id');

      expect(response.status).toBe(200);
      expect(getPlotById).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/v1/plots', () => {
    it('should call createPlot controller', async () => {
      const mockData = {
        physicalPlot: {
          plotNumber: 'A-01',
          areaName: '一般墓地A',
          areaSqm: 3.6,
        },
        contractPlot: {
          contractAreaSqm: 3.6,
        },
        saleContract: {
          contractDate: '2024-01-01',
          price: 1000000,
        },
        customer: {
          name: '山田太郎',
          nameKana: 'ヤマダタロウ',
          postalCode: '150-0001',
          address: '東京都渋谷区',
          phoneNumber: '0312345678',
        },
      };

      const response = await request(app).post('/api/v1/plots').send(mockData);

      expect(response.status).toBe(201);
      expect(createPlot).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('PUT /api/v1/plots/:id', () => {
    it('should call updatePlot controller', async () => {
      const mockData = {
        contractPlot: {
          saleStatus: 'completed',
        },
      };

      const response = await request(app).put('/api/v1/plots/test-id').send(mockData);

      expect(response.status).toBe(200);
      expect(updatePlot).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('DELETE /api/v1/plots/:id', () => {
    it('should call deletePlot controller', async () => {
      const response = await request(app).delete('/api/v1/plots/test-id');

      expect(response.status).toBe(200);
      expect(deletePlot).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/v1/plots/:id/contracts', () => {
    it('should call getPlotContracts controller', async () => {
      const response = await request(app).get('/api/v1/plots/test-id/contracts');

      expect(response.status).toBe(200);
      expect(getPlotContracts).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/v1/plots/:id/contracts', () => {
    it('should call createPlotContract controller', async () => {
      const mockData = {
        contractPlot: {
          contractAreaSqm: 3.6,
        },
        saleContract: {
          contractDate: '2024-01-01',
          price: 1000000,
        },
        customer: {
          name: '田中花子',
          nameKana: 'タナカハナコ',
          postalCode: '150-0001',
          address: '東京都渋谷区',
          phoneNumber: '0312345678',
        },
      };

      const response = await request(app).post('/api/v1/plots/test-id/contracts').send(mockData);

      expect(response.status).toBe(201);
      expect(createPlotContract).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/v1/plots/:id/inventory', () => {
    it('should call getPlotInventory controller', async () => {
      const response = await request(app).get('/api/v1/plots/test-id/inventory');

      expect(response.status).toBe(200);
      expect(getPlotInventory).toHaveBeenCalled();
      expect(response.body.success).toBe(true);
    });
  });
});
