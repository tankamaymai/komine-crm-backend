import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        is_active: boolean;
        supabase_uid: string;
      };
    }
  }
}

const mockPrisma: any = {
  collectiveBurial: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('@prisma/client', () => ({
  BillingStatus: { pending: 'pending', billed: 'billed', paid: 'paid' },
  PrismaClient: jest.fn(),
}));

import {
  getCollectiveBurialList,
  getCollectiveBurialById,
  getStatsByYear,
} from '../../src/collective-burials/collectiveBurialController';

describe('collectiveBurialController — 契約者名フォールバック (issue #50)', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseJson: jest.Mock;
  let mockNext: jest.Mock;

  function buildBurial(
    roles: Array<{ role: 'applicant' | 'contractor'; name: string; name_kana: string }>
  ) {
    return {
      id: 'cb1',
      contract_plot_id: 'cp1',
      burial_capacity: 10,
      current_burial_count: 3,
      capacity_reached_date: null,
      validity_period_years: 33,
      billing_scheduled_date: null,
      billing_scheduled_date_manual: false,
      billing_status: 'pending',
      billing_amount: null,
      notes: null,
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01'),
      contractPlot: {
        contract_date: new Date('2025-04-01'),
        physicalPlot: {
          plot_number: 'A-01',
          area_name: '合祀区画',
        },
        saleContractRoles: roles.map((r, idx) => ({
          role: r.role,
          customer: {
            id: `customer-${idx}`,
            name: r.name,
            name_kana: r.name_kana,
            phone_number: null,
            email: null,
            postal_code: null,
            address: null,
            billingInfo: null,
          },
        })),
        buriedPersons: [],
      },
    };
  }

  beforeEach(() => {
    responseJson = jest.fn().mockReturnThis();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: responseJson,
    };
    mockRequest = { params: {}, query: {} };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('getCollectiveBurialList', () => {
    it('applicantがいればapplicantの名前を返す', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([
        buildBurial([
          { role: 'applicant', name: '申込太郎', name_kana: 'モウシコミタロウ' },
          { role: 'contractor', name: '契約花子', name_kana: 'ケイヤクハナコ' },
        ]),
      ]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(1);

      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.items[0].applicantName).toBe('申込太郎');
      expect(payload.data.items[0].applicantNameKana).toBe('モウシコミタロウ');
    });

    it('applicantがいなくてもcontractorがいればcontractorの名前を返す', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([
        buildBurial([{ role: 'contractor', name: '契約花子', name_kana: 'ケイヤクハナコ' }]),
      ]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(1);

      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.items[0].applicantName).toBe('契約花子');
      expect(payload.data.items[0].applicantNameKana).toBe('ケイヤクハナコ');
    });

    it('画面の区画番号で探し、表示番号がある区画の裏側番号は見ない', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(0);
      mockRequest.query = { search: '51' };

      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const where = mockPrisma.collectiveBurial.findMany.mock.calls[0][0].where;
      expect(where.contractPlot.is.OR[0].physicalPlot).toEqual({
        OR: [
          { display_number: { contains: '51', mode: 'insensitive' } },
          {
            AND: [
              { OR: [{ display_number: null }, { display_number: '' }] },
              { plot_number: { contains: '51', mode: 'insensitive' } },
            ],
          },
        ],
      });
    });

    it('一覧は1000件まで一度に取り、それを超える指定は1000に丸める', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(0);

      mockRequest.query = { limit: '1000' };
      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );
      expect(mockPrisma.collectiveBurial.findMany.mock.calls[0][0].take).toBe(1000);

      mockRequest.query = { limit: '5000' };
      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );
      expect(mockPrisma.collectiveBurial.findMany.mock.calls[1][0].take).toBe(1000);
    });

    it('手で入れた合祀日だと分かる印を返す', async () => {
      const burial = buildBurial([]);
      burial.billing_scheduled_date_manual = true;
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([burial]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(1);

      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.items[0].billingScheduledDateManual).toBe(true);
    });

    it('どのロールも無い場合はnullを返す', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([buildBurial([])]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(1);

      await getCollectiveBurialList(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.items[0].applicantName).toBeNull();
      expect(payload.data.items[0].applicantNameKana).toBeNull();
    });
  });

  describe('getCollectiveBurialById', () => {
    it('applicantがいなくてもcontractorをフォールバックに使う', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue(
        buildBurial([{ role: 'contractor', name: '契約花子', name_kana: 'ケイヤクハナコ' }])
      );
      mockRequest.params = { id: 'cb1' };

      await getCollectiveBurialById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.applicant).not.toBeNull();
      expect(payload.data.applicant.name).toBe('契約花子');
    });

    it('applicantとcontractorの両方があればapplicantを優先する', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue(
        buildBurial([
          { role: 'contractor', name: '契約花子', name_kana: 'ケイヤクハナコ' },
          { role: 'applicant', name: '申込太郎', name_kana: 'モウシコミタロウ' },
        ])
      );
      mockRequest.params = { id: 'cb1' };

      await getCollectiveBurialById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.applicant.name).toBe('申込太郎');
    });
  });

  describe('getStatsByYear — 金額集計 (frontend #226)', () => {
    it('金額（totalAmount/paidAmount）をサーバ集計の値として返す', async () => {
      // $queryRaw はサーバ側で集計済みの bigint を返す
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          year: 2027,
          count: 100n,
          pending_count: 60n,
          billed_count: 25n,
          paid_count: 15n,
          total_amount: 5000000n,
          paid_amount: 1200000n,
        },
      ]);

      await getStatsByYear(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const payload = responseJson.mock.calls[0][0];
      expect(payload.success).toBe(true);
      const row = payload.data[0];
      // 件数は既存どおり
      expect(row.year).toBe(2027);
      expect(row.count).toBe(100);
      expect(row.pendingCount).toBe(60);
      expect(row.billedCount).toBe(25);
      expect(row.paidCount).toBe(15);
      // 金額は bigint → number に変換して返す
      expect(row.totalAmount).toBe(5000000);
      expect(row.paidAmount).toBe(1200000);
      expect(typeof row.totalAmount).toBe('number');
      expect(typeof row.paidAmount).toBe('number');
    });

    it('集計が0件（金額がCOALESCEで0）の場合も number 0 を返す', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          year: 2028,
          count: 3n,
          pending_count: 3n,
          billed_count: 0n,
          paid_count: 0n,
          total_amount: 0n,
          paid_amount: 0n,
        },
      ]);

      await getStatsByYear(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const row = responseJson.mock.calls[0][0].data[0];
      expect(row.totalAmount).toBe(0);
      expect(row.paidAmount).toBe(0);
    });

    it('複数年でもそれぞれ金額を集計して返す', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          year: 2027,
          count: 2n,
          pending_count: 2n,
          billed_count: 0n,
          paid_count: 0n,
          total_amount: 200000n,
          paid_amount: 0n,
        },
        {
          year: 2028,
          count: 1n,
          pending_count: 0n,
          billed_count: 0n,
          paid_count: 1n,
          total_amount: 300000n,
          paid_amount: 300000n,
        },
      ]);

      await getStatsByYear(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      const data = responseJson.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(data[0].totalAmount).toBe(200000);
      expect(data[0].paidAmount).toBe(0);
      expect(data[1].totalAmount).toBe(300000);
      expect(data[1].paidAmount).toBe(300000);
    });

    it('クエリエラー時は next に渡す', async () => {
      const error = new Error('db error');
      mockPrisma.$queryRaw.mockRejectedValue(error);

      await getStatsByYear(
        mockRequest as Request,
        mockResponse as Response,
        mockNext as NextFunction
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
