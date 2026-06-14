import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

// Express.Request型を拡張（認証ミドルウェアで使用される型定義）
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

// モックプリズマインスタンスの作成（新モデル対応）
const mockPrisma: any = {
  physicalPlot: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  contractPlot: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  saleContract: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  saleContractRole: {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  customer: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  },
  workInfo: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  billingInfo: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  usageFee: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  managementFee: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  gravestoneInfo: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  constructionInfo: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  document: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  billing: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  familyContact: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  buriedPerson: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  history: {
    create: jest.fn(),
    createMany: jest.fn(),
  },
  collectiveBurial: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((callback: any) => Promise.resolve(callback(mockPrisma))),
};

// PrismaClientをモック化
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  Prisma: {
    // Serializable tx 化（#278）で参照される分離レベル定数
    TransactionIsolationLevel: { Serializable: 'Serializable' },
    Decimal: class MockDecimal {
      constructor(private value: number) {}
      toNumber() {
        return this.value;
      }
    },
  },
  PaymentStatus: {
    unpaid: 'unpaid',
    partial: 'partial',
    paid: 'paid',
  },
  ContractStatus: {
    vacant: 'vacant',
    active: 'active',
    terminated: 'terminated',
  },
  ContractRole: {
    applicant: 'applicant',
    contractor: 'contractor',
  },
}));

// ユーティリティ関数のモック化（buildGravestoneInfoData は実装をそのまま使用）
jest.mock('../../src/plots/utils', () => {
  const actual = jest.requireActual('../../src/plots/utils');
  return {
    validateContractArea: jest.fn(),
    updatePhysicalPlotStatus: jest.fn(),
    syncPrimaryContractorNameKana: jest.fn(),
    syncContractorNameKanaForCustomer: jest.fn(),
    buildGravestoneInfoData: actual.buildGravestoneInfoData,
  };
});

// 履歴サービスのモック化
jest.mock('../../src/plots/services/historyService', () => ({
  recordContractPlotCreated: jest.fn(),
  recordCustomerCreated: jest.fn(),
  recordContractPlotUpdated: jest.fn(),
  recordCustomerUpdated: jest.fn(),
  recordEntityCreated: jest.fn(),
  recordEntityUpdated: jest.fn(),
  recordEntityDeleted: jest.fn(),
  recordHistoryBatch: jest.fn(),
}));

import {
  getPlots,
  getPlotById,
  createPlot,
  updatePlot,
  deletePlot,
  getPlotContracts,
  createPlotContract,
  getPlotInventory,
} from '../../src/plots/controllers';
import {
  recordEntityUpdated,
  recordContractPlotUpdated,
  recordEntityDeleted,
} from '../../src/plots/services/historyService';
import {
  validateContractArea,
  updatePhysicalPlotStatus,
  syncContractorNameKanaForCustomer,
} from '../../src/plots/utils';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler';

describe('Plot Controller (ContractPlot Model)', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseJson: jest.Mock;
  let responseStatus: jest.Mock;
  let mockNext: jest.Mock;

  beforeEach(() => {
    responseJson = jest.fn().mockReturnThis();
    responseStatus = jest.fn().mockReturnThis();

    mockRequest = {
      params: {},
      body: {},
      query: {},
      user: {
        id: 1,
        name: 'テストユーザー',
        email: 'test@example.com',
        role: 'admin',
        is_active: true,
        supabase_uid: 'test-uid',
      },
    };

    mockResponse = {
      status: responseStatus,
      json: responseJson,
    };

    mockNext = jest.fn();
    // モックのリセット
    jest.clearAllMocks();
    (validateContractArea as jest.Mock).mockResolvedValue({ isValid: true });
    (updatePhysicalPlotStatus as jest.Mock).mockResolvedValue(undefined);
    // $transactionモックの再設定（clearAllMocksでクリアされるため）
    mockPrisma.$transaction.mockImplementation((callback: any) =>
      Promise.resolve(callback(mockPrisma))
    );
    // roles 入替/作成経路の assertAssignableCustomer ガード（#394）はデフォルトで
    // 割り当て可能な顧客（論理削除なし・未解約）を返す。拒否ケースは個別テストで上書き。
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: 'c-assignable',
      deleted_at: null,
      is_terminated: false,
    });
  });

  describe('getPlots', () => {
    it('should return list of contract plots', async () => {
      const mockContractPlots = [
        {
          id: 'cp1',
          physical_plot_id: 'pp1',
          contract_area_sqm: new Prisma.Decimal(3.6),
          location_description: 'A区画',
          created_at: new Date('2024-01-01'),
          updated_at: new Date('2024-01-01'),
          deleted_at: null,
          contract_date: new Date('2024-01-01'),
          price: 1000000,
          payment_status: 'paid',
          physicalPlot: {
            id: 'pp1',
            plot_number: 'A-01',
            area_name: '一般墓地A',
            area_sqm: new Prisma.Decimal(3.6),
            status: 'sold_out',
            notes: null,
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            deleted_at: null,
          },
          saleContractRoles: [
            {
              id: 'scr1',
              role: 'contractor',
              customer: {
                id: 'c1',
                name: '山田太郎',
                name_kana: 'ヤマダタロウ',
                phone_number: '0312345678',
                address: '東京都渋谷区',
              },
            },
          ],
          managementFee: null,
        },
      ];

      mockPrisma.contractPlot.findMany.mockResolvedValue(mockContractPlots);
      mockPrisma.contractPlot.count.mockResolvedValue(1);

      mockRequest.query = { page: '1', limit: '10' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.contractPlot.findMany).toHaveBeenCalled();
      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            data: expect.any(Array),
            pagination: expect.any(Object),
          }),
        })
      );
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({
                id: 'cp1',
                plotNumber: 'A-01',
                customerName: '山田太郎',
                customerRole: 'contractor',
              }),
            ]),
          }),
        })
      );
    });

    it('should sort by contractor name kana via DB-side paging when sortBy=customerName (#216 → #282)', async () => {
      const buildListRow = (id: string, nameKana: string) => ({
        id,
        physical_plot_id: `pp-${id}`,
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        deleted_at: null,
        contract_date: new Date('2024-01-01'),
        price: null,
        payment_status: 'unpaid',
        physicalPlot: {
          plot_number: `A-${id}`,
          area_name: '第1期',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'sold_out',
        },
        saleContractRoles: [
          {
            id: `scr-${id}`,
            role: 'contractor',
            customer: {
              id: `c-${id}`,
              name: '氏名',
              name_kana: nameKana,
              phone_number: null,
              address: null,
              notes: null,
            },
          },
        ],
        buriedPersons: [],
        managementFee: null,
        billings: [],
      });

      // DB 側ソート済みのページ分のみ返る（スナップショット列 orderBy + skip/take #282）
      mockPrisma.contractPlot.findMany.mockResolvedValueOnce([
        buildListRow('cp2', 'アオキ'),
        buildListRow('cp4', 'サトウ'),
        buildListRow('cp1', 'ヤマダ'),
      ]);
      mockPrisma.contractPlot.count.mockResolvedValue(4);

      mockRequest.query = { page: '1', limit: '3', sortBy: 'customerName', sortOrder: 'asc' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(responseStatus).toHaveBeenCalledWith(200);
      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.data.map((p: { id: string }) => p.id)).toEqual(['cp2', 'cp4', 'cp1']);
      // total は count から（旧実装は全件ロードから導出していた）
      expect(payload.data.pagination.total).toBe(4);

      // 全件ロード＋アプリ側ソートではなく、スナップショット列への
      // orderBy + skip/take で DB 側ページングしていることを固定する（#282）
      expect(mockPrisma.contractPlot.findMany).toHaveBeenCalledTimes(1);
      const query = mockPrisma.contractPlot.findMany.mock.calls[0][0];
      // テストはコントローラ直叩きのため limit は query 生文字列のまま渡る
      expect(Number(query.skip)).toBe(0);
      expect(Number(query.take)).toBe(3);
      expect(query.orderBy).toEqual([
        { primary_contractor_name_kana: { sort: 'asc', nulls: 'last' } },
        { id: 'asc' },
      ]);
    });

    it('should keep nulls last for desc order too (#216 → #282)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValueOnce([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10', sortBy: 'customerName', sortOrder: 'desc' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      // 契約者なし（null）は降順でも末尾固定
      const query = mockPrisma.contractPlot.findMany.mock.calls[0][0];
      expect(query.orderBy).toEqual([
        { primary_contractor_name_kana: { sort: 'desc', nulls: 'last' } },
        { id: 'asc' },
      ]);
    });

    it('sortBy=plotNumber は display_number 優先＋plot_number フォールバックの複合 orderBy にする (#388)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValueOnce([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10', sortBy: 'plotNumber', sortOrder: 'asc' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      const query = mockPrisma.contractPlot.findMany.mock.calls[0][0];
      // 画面表示中の display_number を基準にする（legacy plot_number 基準の乖離を解消）
      expect(query.orderBy).toEqual([
        { physicalPlot: { display_number: { sort: 'asc', nulls: 'last' } } },
        { physicalPlot: { plot_number: 'asc' } },
        { id: 'asc' },
      ]);
    });

    it('sortBy=plotNumber 降順でも display_number 未設定は末尾固定（nulls:last）にする (#388)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValueOnce([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10', sortBy: 'plotNumber', sortOrder: 'desc' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      const query = mockPrisma.contractPlot.findMany.mock.calls[0][0];
      expect(query.orderBy).toEqual([
        { physicalPlot: { display_number: { sort: 'desc', nulls: 'last' } } },
        { physicalPlot: { plot_number: 'desc' } },
        { id: 'asc' },
      ]);
    });

    it('一覧 include の saleContractRoles を snapshot と同一順序（created_at asc, id asc）で取得する (#303)', async () => {
      // 同一区画に contractor ロールが複数ある場合、orderBy 無しでは DB 返却順が
      // 任意のため、ソートキー（snapshot は created_at asc の顧客）と表示名
      // （find の先頭一致）が別人になりうる。表示側を snapshot の選択順に揃える
      mockPrisma.contractPlot.findMany.mockResolvedValueOnce([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      const query = mockPrisma.contractPlot.findMany.mock.calls[0][0];
      expect(query.include.saleContractRoles.orderBy).toEqual([
        { created_at: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('should filter by contractStatus when specified (#200)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10', contractStatus: 'terminated' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.contractPlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contract_status: 'terminated',
          }),
        })
      );
    });

    it('should exclude vacant plots by default (#167)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: '1', limit: '10' };

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.contractPlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contract_status: { not: 'vacant' },
          }),
        })
      );
    });

    it('should calculate next billing date from last_billing_month', async () => {
      const mockContractPlots = [
        {
          id: 'cp1',
          physical_plot_id: 'pp1',
          contract_area_sqm: new Prisma.Decimal(3.6),
          location_description: 'A区画',
          created_at: new Date('2024-01-01'),
          updated_at: new Date('2024-01-01'),
          deleted_at: null,
          contract_date: new Date('2024-01-01'),
          price: 1000000,
          payment_status: 'paid',
          physicalPlot: {
            plot_number: 'A-01',
            area_name: '一般墓地A',
            area_sqm: new Prisma.Decimal(3.6),
            status: 'sold_out',
          },
          saleContractRoles: [
            {
              id: 'scr1',
              role: 'contractor',
              customer: {
                name: '山田太郎',
                name_kana: 'ヤマダタロウ',
                phone_number: '0312345678',
                address: '東京都渋谷区',
              },
            },
          ],
          managementFee: {
            management_fee: '12000',
            last_billing_month: '2024年3月',
          },
        },
      ];

      mockPrisma.contractPlot.findMany.mockResolvedValue(mockContractPlots);
      mockPrisma.contractPlot.count.mockResolvedValue(1);

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({
                nextBillingDate: expect.any(Date),
                managementFee: '12000',
              }),
            ]),
          }),
        })
      );
    });

    it('should handle contract plots without sale contract', async () => {
      const mockContractPlots = [
        {
          id: 'cp1',
          physical_plot_id: 'pp1',
          contract_area_sqm: new Prisma.Decimal(3.6),
          location_description: 'A区画',
          created_at: new Date('2024-01-01'),
          updated_at: new Date('2024-01-01'),
          contract_date: new Date('2024-01-01'),
          price: 1000000, // Int型
          payment_status: 'unpaid',
          physicalPlot: {
            plot_number: 'A-01',
            area_name: '一般墓地A',
            area_sqm: new Prisma.Decimal(3.6),
            status: 'available',
          },
          saleContractRoles: [],
          managementFee: null,
        },
      ];

      mockPrisma.contractPlot.findMany.mockResolvedValue(mockContractPlots);
      mockPrisma.contractPlot.count.mockResolvedValue(1);

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({
                id: 'cp1',
                customerName: null,
                customerNameKana: null,
                customerPhoneNumber: null,
                customerAddress: null,
                customerRole: null,
                contractDate: new Date('2024-01-01'),
                price: 1000000,
                paymentStatus: 'unpaid',
              }),
            ]),
          }),
        })
      );
    });

    it('should return empty array when no contract plots exist', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            data: [],
            pagination: expect.any(Object),
          }),
        })
      );
    });

    it('should apply grave_kind / grave_kubun / grave_type filters when provided', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = {
        page: 1,
        limit: 10,
        graveKind: 1,
        graveKubun: 3,
        graveType: 2,
      } as any;

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.contractPlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            grave_kind: 1,
            grave_kubun: 3,
            grave_type: 2,
          }),
        })
      );
    });

    it('should not apply grave classification filters when omitted', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: 1, limit: 10 } as any;

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      const whereArg = mockPrisma.contractPlot.findMany.mock.calls[0][0].where;
      expect(whereArg).not.toHaveProperty('grave_kind');
      expect(whereArg).not.toHaveProperty('grave_kubun');
      expect(whereArg).not.toHaveProperty('grave_type');
    });

    it('should exclude vacant (空き区画) from both list and count (#167)', async () => {
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.count.mockResolvedValue(0);

      mockRequest.query = { page: 1, limit: 10 } as any;

      await getPlots(mockRequest as Request, mockResponse as Response, mockNext);

      const findManyWhere = mockPrisma.contractPlot.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.contractPlot.count.mock.calls[0][0].where;

      // 一覧・件数の両方に vacant 除外条件が効いていること
      expect(findManyWhere).toMatchObject({ contract_status: { not: 'vacant' } });
      expect(countWhere).toMatchObject({ contract_status: { not: 'vacant' } });
    });
  });

  describe('getPlotById', () => {
    it('should return contract plot details', async () => {
      const mockContractPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: 'A区画',
        inscription: '連絡は長男へ',
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        deleted_at: null,
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        contract_status: 'active',
        payment_status: 'paid',
        reservation_date: null,
        request_date: new Date('2023-12-01'),
        acceptance_number: null,
        permit_date: null,
        start_date: null,
        notes: null,
        grave_kind: 1,
        grave_kubun: 2,
        grave_type: 3,
        legacy_grave_cd: 101,
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'sold_out',
          map_id: 7,
          notes: null,
        },
        buriedPersons: [
          {
            id: 'bp1',
            name: '山田次郎',
            name_kana: 'ヤマダジロウ',
            relationship: '子',
            birth_date: null,
            death_date: null,
            age: null,
            gender: null,
            burial_date: null,
            posthumous_name: null,
            report_date: null,
            religion: null,
            death_place: null,
            cause_of_death: null,
            chief_mourner_name: null,
            chief_mourner_relationship: null,
            validity_period_years_override: 10, // 区画既定より短い個別指定（komine-docs#10 項目8）
            notes: null,
          },
        ],
        familyContacts: [],
        gravestoneInfo: null,
        constructionInfos: [],
        collectiveBurial: null,
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            role_start_date: null,
            role_end_date: null,
            notes: null,
            customer: {
              id: 'c1',
              name: '山田太郎',
              name_kana: 'ヤマダタロウ',
              birth_date: null,
              gender: null,
              postal_code: '150-0001',
              address: '東京都渋谷区',
              registered_address: null,
              phone_number: '0312345678',
              fax_number: null,
              email: null,
              notes: null,
              workInfo: null,
              billingInfo: null,
            },
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockContractPlot);
      mockRequest.params = { id: 'cp1' };

      await getPlotById(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.contractPlot.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'cp1' }),
        })
      );
      expect(responseStatus).toHaveBeenCalledWith(200);
      // PlotDetailResponse の必須フィールド欠落を回帰検知する（#199）
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            id: 'cp1',
            contractStatus: 'active',
            paymentStatus: 'paid',
            requestDate: new Date('2023-12-01'),
            inscription: '連絡は長男へ',
            graveKind: 1,
            graveKubun: 2,
            graveType: 3,
            legacyGraveCd: 101,
            physicalPlot: expect.objectContaining({
              id: 'pp1',
              mapId: 7,
            }),
            buriedPersons: expect.arrayContaining([
              expect.objectContaining({
                id: 'bp1',
                validityPeriodYearsOverride: 10,
              }),
            ]),
          }),
        })
      );
    });

    it('should return 404 when contract plot not found', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(null);
      mockRequest.params = { id: 'non-existent' };

      await getPlotById(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(NotFoundError));
    });
  });

  describe('createPlot', () => {
    it('should create new contract plot with all related data', async () => {
      const mockInput = {
        physicalPlot: {
          plotNumber: 'A-01',
          areaName: '一般墓地A',
          areaSqm: 3.6,
        },
        contractPlot: {
          contractAreaSqm: 3.6,
          saleStatus: 'contracted',
          inscription: '連絡は長男へ',
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

      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      };
      const mockCustomer = { id: 'c1', name: '山田太郎' };
      const mockContractPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
      };
      const mockCreatedContractPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
        created_at: new Date(),
        updated_at: new Date(),
        physicalPlot: mockPhysicalPlot,
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: mockCustomer,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.physicalPlot.create.mockResolvedValue(mockPhysicalPlot);
      mockPrisma.customer.create.mockResolvedValue(mockCustomer);
      mockPrisma.contractPlot.create.mockResolvedValue(mockContractPlot);
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1', customer: mockCustomer });
      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockCreatedContractPlot);

      mockRequest.body = mockInput;

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(validateContractArea).toHaveBeenCalled();
      expect(updatePhysicalPlotStatus).toHaveBeenCalled();
      // 碑文(inscription)が contractPlot.create の data に渡る（komine-docs#10 項目1）
      expect(mockPrisma.contractPlot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ inscription: '連絡は長男へ' }),
        })
      );
      expect(responseStatus).toHaveBeenCalledWith(201);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should use existing physical plot when id is provided', async () => {
      const mockInput = {
        physicalPlot: {
          id: 'pp1',
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

      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_sqm: new Prisma.Decimal(7.2),
      };
      const mockCustomer = { id: 'c1' };
      const mockContractPlot = { id: 'cp1' };
      const mockSaleContract = { id: 'sc1' };

      mockPrisma.physicalPlot.findUnique.mockResolvedValue(mockPhysicalPlot);
      mockPrisma.customer.create.mockResolvedValue(mockCustomer);
      mockPrisma.contractPlot.create.mockResolvedValue(mockContractPlot);
      mockPrisma.saleContract.create.mockResolvedValue(mockSaleContract);
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
        created_at: new Date(),
        updated_at: new Date(),
        physicalPlot: mockPhysicalPlot,
        saleContractRoles: [{ id: 'scr1', role: 'contractor', customer: mockCustomer }],
        usageFee: null,
        managementFee: null,
      });

      mockRequest.body = mockInput;

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.physicalPlot.findUnique).toHaveBeenCalled();
      expect(mockPrisma.physicalPlot.create).not.toHaveBeenCalled();
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('should return 400 when required fields are missing', async () => {
      mockRequest.body = {
        physicalPlot: {},
        // contractPlot, saleContract, customer が欠けている
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should return 400 when contract area is zero or negative', async () => {
      mockRequest.body = {
        physicalPlot: {
          plotNumber: 'A-01',
          areaName: '一般墓地A',
        },
        contractPlot: {
          contractAreaSqm: 0,
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

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should return 400 when contract area validation fails', async () => {
      (validateContractArea as jest.Mock).mockResolvedValue({
        isValid: false,
        message: '契約面積が物理区画の面積を超えています',
      });

      mockPrisma.physicalPlot.create.mockResolvedValue({ id: 'pp1' });

      mockRequest.body = {
        physicalPlot: {
          plotNumber: 'A-01',
          areaName: '一般墓地A',
          areaSqm: 3.6,
        },
        contractPlot: {
          contractAreaSqm: 10.0, // 超過
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

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should create work info when provided (BillingInfo は新スキーマで廃止)', async () => {
      const mockInput = {
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
        workInfo: {
          companyName: 'テスト株式会社',
          companyNameKana: 'テストカブシキガイシャ',
          workPostalCode: '100-0001',
          workAddress: '東京都千代田区',
          workPhoneNumber: '0311111111',
          dmSetting: 'allow',
          addressType: 'work',
        },
      };

      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1' });
      mockPrisma.saleContract.create.mockResolvedValue({ id: 'sc1' });
      mockPrisma.workInfo.create.mockResolvedValue({ id: 'wi1' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
        created_at: new Date(),
        updated_at: new Date(),
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'sold_out',
        },
        saleContractRoles: [
          { id: 'scr1', role: 'contractor', customer: { id: 'c1', name: '山田太郎' } },
        ],
        usageFee: null,
        managementFee: null,
      });

      mockRequest.body = mockInput;

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.workInfo.create).toHaveBeenCalled();
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('should create usage fee and management fee when provided', async () => {
      const mockInput = {
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
        usageFee: {
          calculationType: 'area',
          taxType: 'included',
          usageFee: 50000,
          area: 3.6,
          unitPrice: 13888.89,
          paymentMethod: 'cash',
        },
        managementFee: {
          calculationType: 'area',
          taxType: 'included',
          billingType: 'annual',
          billingYears: 1,
          area: 3.6,
          billingMonth: '4月',
          managementFee: 12000,
          unitPrice: 3333.33,
          lastBillingMonth: '2024年4月',
          paymentMethod: 'bank_transfer',
        },
      };

      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1' });
      mockPrisma.saleContract.create.mockResolvedValue({ id: 'sc1' });
      mockPrisma.usageFee.create.mockResolvedValue({ id: 'uf1' });
      mockPrisma.managementFee.create.mockResolvedValue({ id: 'mf1' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
        created_at: new Date(),
        updated_at: new Date(),
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'sold_out',
        },
        saleContractRoles: [
          { id: 'scr1', role: 'contractor', customer: { id: 'c1', name: '山田太郎' } },
        ],
        usageFee: null,
        managementFee: null,
      });

      mockRequest.body = mockInput;

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.usageFee.create).toHaveBeenCalled();
      expect(mockPrisma.managementFee.create).toHaveBeenCalled();
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('should create applicant as separate customer + role when provided', async () => {
      const mockInput = {
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
          postalCode: '1500001',
          address: '東京都渋谷区',
          phoneNumber: '0312345678',
        },
        applicant: {
          name: '山田花子',
          nameKana: 'ヤマダハナコ',
          postalCode: '1500001',
          address: '東京都渋谷区',
          phoneNumber: '0312345679',
        },
      };

      const mockContractor = { id: 'c1', name: '山田太郎' };
      const mockApplicant = { id: 'c2', name: '山田花子' };

      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create
        .mockResolvedValueOnce(mockContractor)
        .mockResolvedValueOnce(mockApplicant);
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1' });
      mockPrisma.saleContractRole.create
        .mockResolvedValueOnce({ id: 'scr1', role: 'contractor', customer_id: 'c1' })
        .mockResolvedValueOnce({ id: 'scr2', role: 'applicant', customer_id: 'c2' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'unpaid',
        created_at: new Date(),
        updated_at: new Date(),
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'sold_out',
        },
        saleContractRoles: [
          { id: 'scr1', role: 'contractor', customer: mockContractor },
          { id: 'scr2', role: 'applicant', customer: mockApplicant },
        ],
        usageFee: null,
        managementFee: null,
      });

      mockRequest.body = mockInput;

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.customer.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.saleContractRole.create).toHaveBeenCalledTimes(2);
      const roleCalls = (mockPrisma.saleContractRole.create as jest.Mock).mock.calls.map(
        (c: any[]) => c[0].data.role
      );
      expect(roleCalls).toContain('contractor');
      expect(roleCalls).toContain('applicant');
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('should return error when plotNumber and areaName are missing for new physical plot', async () => {
      mockRequest.body = {
        physicalPlot: {
          areaSqm: 3.6,
          // plotNumber and areaName missing
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

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('updatePlot', () => {
    it('should return error when contract area exceeds physical plot area', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: {
          id: 'pp1',
          area_sqm: new Prisma.Decimal(7.2),
        },
        saleContractRoles: [
          {
            id: 'scr1',
            customer: {
              id: 'c1',
              workInfo: null,
              billingInfo: null,
            },
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([
        {
          id: 'cp2',
          contract_area_sqm: new Prisma.Decimal(3.0),
        },
      ]);

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        contractPlot: {
          contractAreaSqm: 5.0, // Total would be 8.0 > 7.2
        },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('changeReason がある場合、履歴記録に changeReason を渡す（#261）', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        location_description: null,
        contract_date: null,
        price: 1000,
        payment_status: 'unpaid',
        reservation_date: null,
        acceptance_number: null,
        permit_date: null,
        start_date: null,
        uncollected_amount: 0,
        notes: null,
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-1',
          area_name: '第1期',
          area_sqm: new Prisma.Decimal(3.6),
          status: 'available',
          notes: null,
        },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
        collectiveBurial: null,
        gravestoneInfo: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.physicalPlot.update.mockResolvedValue({
        ...mockExistingPlot.physicalPlot,
        notes: '更新メモ',
      });
      mockPrisma.contractPlot.update.mockResolvedValue({
        ...mockExistingPlot,
        price: 2000,
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        physicalPlot: { notes: '更新メモ' },
        saleContract: { price: 2000 },
        changeReason: '名義変更',
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      // PhysicalPlot の履歴に changeReason が渡る
      expect(recordEntityUpdated).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityType: 'PhysicalPlot',
          changeReason: '名義変更',
        })
      );
      // ContractPlot の履歴（位置引数の末尾）にも changeReason が渡る
      expect(recordContractPlotUpdated).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'pp1',
        'cp1',
        expect.anything(),
        '名義変更'
      );
    });

    it('should create applicant Customer + role when applicant provided and no existing applicant', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.customer.create.mockResolvedValue({ id: 'c2', name: '山田花子' });
      mockPrisma.saleContractRole.create.mockResolvedValue({
        id: 'scr2',
        role: 'applicant',
        customer_id: 'c2',
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        applicant: {
          name: '山田花子',
          nameKana: 'ヤマダハナコ',
        },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: '山田花子', name_kana: 'ヤマダハナコ' }),
        })
      );
      expect(mockPrisma.saleContractRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'applicant', customer_id: 'c2' }),
        })
      );
    });

    it('should update existing applicant Customer when applicant role already exists', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
          {
            id: 'scr2',
            role: 'applicant',
            customer: { id: 'c2', name: '山田花子' },
            customer_id: 'c2',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.customer.update.mockResolvedValue({ id: 'c2', name: '山田花江' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        applicant: { name: '山田花江' },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c2' },
          data: expect.objectContaining({ name: '山田花江' }),
        })
      );
      expect(mockPrisma.saleContractRole.create).not.toHaveBeenCalled();
      // 申込者として編集した顧客が他区画の契約者を兼ねるケース（共有 Customer）の
      // snapshot 陳腐化を防ぐため、氏名変更時は顧客起点の再同期も呼ばれる（#301）
      expect(syncContractorNameKanaForCustomer).toHaveBeenCalledWith(expect.anything(), 'c2');
    });

    it('契約者氏名・カナの更新で顧客起点の snapshot 再同期が呼ばれる (#301)', async () => {
      // 共有契約者（同一 Customer が複数区画の契約者）の氏名編集は、編集対象の
      // 区画だけ再同期すると他区画の primary_contractor_name_kana が陳腐化し、
      // 五十音ソート位置と表示名が乖離する
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null, billingInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.customer.update.mockResolvedValue({ id: 'c1', name: '山田改' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        customer: { name: '山田改', nameKana: 'ヤマダカイ' },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c1' },
          data: expect.objectContaining({ name: '山田改', name_kana: 'ヤマダカイ' }),
        })
      );
      expect(syncContractorNameKanaForCustomer).toHaveBeenCalledWith(expect.anything(), 'c1');
    });

    it('契約者の氏名以外（電話番号等）の更新では顧客起点の再同期は呼ばれない (#301)', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null, billingInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.customer.update.mockResolvedValue({ id: 'c1' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        customer: { phoneNumber: '0312345678' },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.customer.update).toHaveBeenCalled();
      expect(syncContractorNameKanaForCustomer).not.toHaveBeenCalled();
    });

    it('should soft-delete applicant role when applicant=null', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
          {
            id: 'scr2',
            role: 'applicant',
            customer: { id: 'c2', name: '山田花子' },
            customer_id: 'c2',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.update.mockResolvedValue({ id: 'scr2' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { applicant: null };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.saleContractRole.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'scr2' },
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        })
      );
    });

    it('should preserve applicant role when roles array without applicant is sent (#201)', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
          {
            id: 'scr2',
            role: 'applicant',
            customer: { id: 'c2', name: '山田花子' },
            customer_id: 'c2',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.findMany.mockResolvedValue([
        {
          id: 'scr1',
          role: 'contractor',
          customer_id: 'c1',
        },
      ]);
      mockPrisma.saleContractRole.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.saleContractRole.create.mockResolvedValue({
        id: 'scr3',
        role: 'contractor',
        customer_id: 'c3',
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        saleContract: {
          roles: [{ role: 'contractor', customerId: 'c3' }],
        },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      // applicant を除外した削除・再作成になっていること
      expect(mockPrisma.saleContractRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contract_plot_id: 'cp1',
            deleted_at: null,
            role: { not: 'applicant' },
          }),
        })
      );
      expect(mockPrisma.saleContractRole.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: { not: 'applicant' },
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should replace all roles including applicant when roles array contains applicant (#201)', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.saleContractRole.create.mockResolvedValue({
        id: 'scr2',
        role: 'applicant',
        customer_id: 'c2',
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        saleContract: {
          roles: [
            { role: 'contractor', customerId: 'c1' },
            { role: 'applicant', customerId: 'c2' },
          ],
        },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      // applicant を含む場合は従来どおり全件入替（role 条件なし）
      expect(mockPrisma.saleContractRole.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            contract_plot_id: 'cp1',
            deleted_at: null,
          },
        })
      );
      expect(mockPrisma.saleContractRole.create).toHaveBeenCalledTimes(2);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('roles 入替で解約済み顧客を契約者指定すると拒否し role を作成しない (#394)', async () => {
      const mockExistingPlot = {
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
        saleContractRoles: [
          {
            id: 'scr1',
            role: 'contractor',
            customer: { id: 'c1', workInfo: null },
            customer_id: 'c1',
            deleted_at: null,
          },
        ],
        usageFee: null,
        managementFee: null,
      };

      mockPrisma.contractPlot.findUnique.mockResolvedValue(mockExistingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.findMany.mockResolvedValue([]);
      mockPrisma.saleContractRole.updateMany.mockResolvedValue({ count: 0 });
      // 指定 customerId は解約済み（is_terminated）→ assertAssignableCustomer が拒否する
      mockPrisma.customer.findUnique.mockResolvedValue({
        id: 'terminated-1',
        deleted_at: null,
        is_terminated: true,
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        saleContract: {
          roles: [{ role: 'contractor', customerId: 'terminated-1' }],
        },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
      expect(mockPrisma.saleContractRole.create).not.toHaveBeenCalled();
    });
  });

  describe('合祀請求予定日の再計算トリガー (issue #313)', () => {
    // フォームは契約日を常時送信するため、「存在」判定だと保存のたびに
    // 手動例外（Q17例外運用）の billing_scheduled_date が上書きされる。
    // 「実値の変化」でのみ再計算することを検証する。
    const CONTRACT_DATE = '2020-04-01';
    const buildExistingPlot = () => ({
      id: 'cp1',
      physical_plot_id: 'pp1',
      contract_area_sqm: new Prisma.Decimal(3.6),
      contract_date: new Date(CONTRACT_DATE),
      physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
      saleContractRoles: [
        {
          id: 'scr1',
          role: 'contractor',
          customer: { id: 'c1', workInfo: null },
          customer_id: 'c1',
          deleted_at: null,
        },
      ],
      usageFee: null,
      managementFee: null,
      collectiveBurial: {
        id: 'cb1',
        contract_plot_id: 'cp1',
        burial_capacity: 10,
        validity_period_years: 33,
        // 手動例外値（契約日起点の導出値 2053-04-01 とは異なる）
        billing_scheduled_date: new Date('2040-01-01'),
        deleted_at: null,
      },
    });

    it('契約日が変わらないフォーム保存では billing_scheduled_date を再計算しない（手動例外の保持）', async () => {
      const existingPlot = buildExistingPlot();
      mockPrisma.contractPlot.findUnique.mockResolvedValue(existingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.update.mockResolvedValue({
        ...existingPlot,
        contract_date: new Date(CONTRACT_DATE),
      });

      mockRequest.params = { id: 'cp1' };
      // フォームの実挙動: 契約日を変更していなくても常時送信される
      mockRequest.body = {
        saleContract: { contractDate: CONTRACT_DATE },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.update).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('契約日が実際に変わった場合は billing_scheduled_date を契約日起点で再計算する', async () => {
      const existingPlot = buildExistingPlot();
      mockPrisma.contractPlot.findUnique.mockResolvedValue(existingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.update.mockResolvedValue({
        ...existingPlot,
        contract_date: new Date('2021-04-01'),
      });
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(existingPlot.collectiveBurial);
      mockPrisma.collectiveBurial.update.mockResolvedValue({});

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        saleContract: { contractDate: '2021-04-01' },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      // 新契約日 2021-04-01 + 有効期間 33 年 = 2054-04-01
      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cb1' },
          data: { billing_scheduled_date: new Date('2054-04-01') },
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('契約日が未設定から設定された場合も再計算する', async () => {
      const existingPlot = { ...buildExistingPlot(), contract_date: null };
      mockPrisma.contractPlot.findUnique.mockResolvedValue(existingPlot);
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.contractPlot.update.mockResolvedValue({
        ...existingPlot,
        contract_date: new Date(CONTRACT_DATE),
      });
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(existingPlot.collectiveBurial);
      mockPrisma.collectiveBurial.update.mockResolvedValue({});

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        saleContract: { contractDate: CONTRACT_DATE },
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cb1' },
          data: { billing_scheduled_date: new Date('2053-04-01') },
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('GravestoneInfo persistence (issue #154)', () => {
    const gravestoneInput = {
      gravestoneBase: '石基A',
      enclosurePosition: '北東',
      gravestoneDealer: '小嶺石材',
      gravestoneType: '和型',
      surroundingArea: '0.5㎡',
      gravestoneCost: 500000,
      establishmentDeadline: '2025-03-31',
      establishmentDate: '2025-01-15',
      gravestoneInscription: '南無阿弥陀仏',
      directionId: 2,
      positionId: 3,
    };

    it('createPlot は gravestoneInfo を snake_case で永続化する', async () => {
      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1', name: '山田太郎' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1', physical_plot_id: 'pp1' });
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1', customer: { id: 'c1' } });
      mockPrisma.gravestoneInfo.create.mockResolvedValue({ id: 'g1' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
        },
        saleContractRoles: [],
        usageFee: null,
        managementFee: null,
        collectiveBurial: null,
      });

      mockRequest.body = {
        physicalPlot: { plotNumber: 'A-01', areaName: '一般墓地A', areaSqm: 3.6 },
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: { contractDate: '2024-01-01' },
        customer: {
          name: '山田太郎',
          nameKana: 'ヤマダタロウ',
          postalCode: '150-0001',
          address: '東京都渋谷区',
          phoneNumber: '0312345678',
        },
        gravestoneInfo: gravestoneInput,
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.gravestoneInfo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contract_plot_id: 'cp1',
            gravestone_base: '石基A',
            enclosure_position: '北東',
            gravestone_dealer: '小嶺石材',
            gravestone_type: '和型',
            surrounding_area: '0.5㎡',
            gravestone_cost: 500000,
            establishment_deadline: new Date('2025-03-31'),
            establishment_date: new Date('2025-01-15'),
            gravestone_inscription: '南無阿弥陀仏',
            direction_id: 2,
            position_id: 3,
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    const buildExistingPlot = (gravestoneInfo: unknown) => ({
      id: 'cp1',
      physical_plot_id: 'pp1',
      contract_area_sqm: new Prisma.Decimal(3.6),
      physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
      saleContractRoles: [
        {
          id: 'scr1',
          role: 'contractor',
          customer: { id: 'c1', workInfo: null },
          deleted_at: null,
        },
      ],
      usageFee: null,
      managementFee: null,
      collectiveBurial: null,
      gravestoneInfo,
    });

    it('updatePlot は既存 gravestoneInfo が無い場合に create する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(buildExistingPlot(null));
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.gravestoneInfo.create.mockResolvedValue({ id: 'g1' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { gravestoneInfo: gravestoneInput };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.gravestoneInfo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contract_plot_id: 'cp1', gravestone_base: '石基A' }),
        })
      );
      expect(mockPrisma.gravestoneInfo.update).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は既存 gravestoneInfo がある場合に update する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(
        buildExistingPlot({
          id: 'g1',
          gravestone_base: '旧',
          enclosure_position: null,
          gravestone_dealer: null,
          gravestone_type: null,
          surrounding_area: null,
          gravestone_cost: null,
          establishment_deadline: null,
          establishment_date: null,
          gravestone_inscription: null,
          direction_id: null,
          position_id: null,
        })
      );
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.gravestoneInfo.update.mockResolvedValue({
        id: 'g1',
        gravestone_base: '石基A',
        enclosure_position: '北東',
        gravestone_dealer: '小嶺石材',
        gravestone_type: '和型',
        surrounding_area: '0.5㎡',
        gravestone_cost: 500000,
        establishment_deadline: new Date('2025-03-31'),
        establishment_date: new Date('2025-01-15'),
        gravestone_inscription: '南無阿弥陀仏',
        direction_id: 2,
        position_id: 3,
      });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { gravestoneInfo: gravestoneInput };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.gravestoneInfo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'g1' },
          data: expect.objectContaining({ gravestone_base: '石基A', direction_id: 2 }),
        })
      );
      expect(mockPrisma.gravestoneInfo.create).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は gravestoneInfo: null で既存を削除する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(
        buildExistingPlot({
          id: 'g1',
          gravestone_base: '旧',
          gravestone_dealer: null,
          gravestone_type: null,
          direction_id: null,
          position_id: null,
        })
      );
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.gravestoneInfo.delete.mockResolvedValue({ id: 'g1' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { gravestoneInfo: null };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.gravestoneInfo.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('createPlotContract は gravestoneInfo を永続化する', async () => {
      mockPrisma.physicalPlot.findUnique.mockResolvedValue({ id: 'pp1' });
      (validateContractArea as jest.Mock).mockResolvedValue({ isValid: true });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1' });
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1' });
      mockPrisma.gravestoneInfo.create.mockResolvedValue({ id: 'g1' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(3.6) },
        saleContractRoles: [],
      });

      mockRequest.params = { id: 'pp1' };
      mockRequest.body = {
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: {},
        customer: { name: '田中', nameKana: 'タナカ' },
        gravestoneInfo: gravestoneInput,
      };

      await createPlotContract(mockRequest as Request, mockResponse as Response);

      expect(mockPrisma.gravestoneInfo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contract_plot_id: 'cp1', gravestone_base: '石基A' }),
        })
      );
    });
  });

  describe('FamilyContact persistence (issue #219)', () => {
    const familyContactInput = {
      emergencyContactFlag: true,
      name: '山田花子',
      nameKana: 'ヤマダハナコ',
      relationship: '配偶者',
      postalCode: '150-0001',
      address: '東京都渋谷区1-1-1',
      phoneNumber: '0312345678',
      email: 'hanako@example.com',
      contactMethod: 'phone',
      notes: '日中連絡可',
    };

    const buildExistingPlotForFc = () => ({
      id: 'cp1',
      physical_plot_id: 'pp1',
      contract_area_sqm: new Prisma.Decimal(3.6),
      physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(7.2) },
      saleContractRoles: [
        {
          id: 'scr1',
          role: 'contractor',
          customer: { id: 'c1', workInfo: null },
          deleted_at: null,
        },
      ],
      usageFee: null,
      managementFee: null,
      collectiveBurial: null,
      gravestoneInfo: null,
    });

    it('createPlot は familyContacts を snake_case で永続化する', async () => {
      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1', name: '山田太郎' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1', physical_plot_id: 'pp1' });
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1', customer: { id: 'c1' } });
      mockPrisma.familyContact.create.mockResolvedValue({ id: 'fc1' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: {
          id: 'pp1',
          plot_number: 'A-01',
          area_name: '一般墓地A',
          area_sqm: new Prisma.Decimal(3.6),
        },
        saleContractRoles: [],
        usageFee: null,
        managementFee: null,
        collectiveBurial: null,
      });

      mockRequest.body = {
        physicalPlot: { plotNumber: 'A-01', areaName: '一般墓地A', areaSqm: 3.6 },
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: { contractDate: '2024-01-01' },
        customer: {
          name: '山田太郎',
          nameKana: 'ヤマダタロウ',
          postalCode: '150-0001',
          address: '東京都渋谷区',
          phoneNumber: '0312345678',
        },
        familyContacts: [familyContactInput],
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contract_plot_id: 'cp1',
            emergency_contact_flag: true,
            name: '山田花子',
            name_kana: 'ヤマダハナコ',
            relationship: '配偶者',
            postal_code: '150-0001',
            address: '東京都渋谷区1-1-1',
            phone_number: '0312345678',
            email: 'hanako@example.com',
            contact_method: 'phone',
            notes: '日中連絡可',
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('createPlot は氏名・続柄が空の familyContact をスキップする', async () => {
      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        area_sqm: new Prisma.Decimal(3.6),
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1', physical_plot_id: 'pp1' });
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1', customer: { id: 'c1' } });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(3.6) },
        saleContractRoles: [],
      });

      mockRequest.body = {
        physicalPlot: { plotNumber: 'A-01', areaName: '一般墓地A', areaSqm: 3.6 },
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: {},
        customer: { name: '山田太郎', nameKana: 'ヤマダタロウ' },
        familyContacts: [{ name: '', relationship: '' }],
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.create).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は新規 familyContact（id なし）を create する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(buildExistingPlotForFc());
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.familyContact.findMany.mockResolvedValue([]);
      mockPrisma.familyContact.create.mockResolvedValue({ id: 'fc1' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { familyContacts: [familyContactInput] };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contract_plot_id: 'cp1',
            name: '山田花子',
            relationship: '配偶者',
            phone_number: '0312345678',
          }),
        })
      );
      expect(mockPrisma.familyContact.update).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は既存 familyContact（id あり）を update する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(buildExistingPlotForFc());
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.familyContact.findMany.mockResolvedValue([
        {
          id: 'fc1',
          name: '旧名',
          name_kana: null,
          birth_date: null,
          relationship: '父',
          phone_number: '0300000000',
          emergency_contact_flag: false,
          postal_code: null,
          address: null,
          phone_number_2: null,
          fax_number: null,
          email: null,
          registered_address: null,
          mailing_type: null,
          work_company_name: null,
          work_company_name_kana: null,
          work_address: null,
          work_phone_number: null,
          contact_method: null,
          notes: null,
        },
      ]);
      mockPrisma.familyContact.update.mockResolvedValue({ id: 'fc1' });

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { familyContacts: [{ id: 'fc1', ...familyContactInput }] };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'fc1' },
          data: expect.objectContaining({ name: '山田花子', relationship: '配偶者' }),
        })
      );
      expect(mockPrisma.familyContact.create).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は入力に含まれない既存 familyContact を soft-delete する', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(buildExistingPlotForFc());
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.familyContact.findMany.mockResolvedValue([
        {
          id: 'fc1',
          name: '削除対象',
          relationship: '兄',
          phone_number: '0311112222',
        },
      ]);
      mockPrisma.familyContact.updateMany.mockResolvedValue({ count: 1 });

      mockRequest.params = { id: 'cp1' };
      // 空配列を送ると既存全件が削除対象になる
      mockRequest.body = { familyContacts: [] };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['fc1'] } },
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('updatePlot は familyContacts 未指定なら既存を一切触らない', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(buildExistingPlotForFc());
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = { contractPlot: { contractAreaSqm: 3.6 } };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.familyContact.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.familyContact.create).not.toHaveBeenCalled();
      expect(mockPrisma.familyContact.updateMany).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('BuriedPerson persistence (issue #330)', () => {
    const buriedPersonInput = {
      name: '山田一郎',
      nameKana: 'ヤマダイチロウ',
      relationship: '父',
      deathDate: '2020-05-10',
      burialDate: '2020-05-20',
      posthumousName: '釈浄一',
      religion: '浄土真宗',
      deathPlace: '東京都病院',
      causeOfDeath: '老衰',
      chiefMournerName: '山田太郎',
      chiefMournerRelationship: '長男',
      validityPeriodYearsOverride: 13,
      notes: '備考',
    };

    const setupCreateMocks = () => {
      mockPrisma.physicalPlot.create.mockResolvedValue({
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'sold_out',
      });
      mockPrisma.customer.create.mockResolvedValue({ id: 'c1', name: '山田太郎' });
      mockPrisma.contractPlot.create.mockResolvedValue({ id: 'cp1', physical_plot_id: 'pp1' });
      mockPrisma.saleContractRole.create.mockResolvedValue({ id: 'scr1', customer: { id: 'c1' } });
      mockPrisma.buriedPerson.create.mockResolvedValue({ id: 'bp1', name: '山田一郎' });
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(3.6) },
        saleContractRoles: [],
      });
    };

    it('createPlot は buriedPersons を snake_case で永続化する', async () => {
      setupCreateMocks();

      mockRequest.body = {
        physicalPlot: { plotNumber: 'A-01', areaName: '一般墓地A', areaSqm: 3.6 },
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: {},
        customer: { name: '山田太郎', nameKana: 'ヤマダタロウ' },
        buriedPersons: [buriedPersonInput],
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.buriedPerson.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contract_plot_id: 'cp1',
            name: '山田一郎',
            name_kana: 'ヤマダイチロウ',
            relationship: '父',
            posthumous_name: '釈浄一',
            religion: '浄土真宗',
            death_place: '東京都病院',
            cause_of_death: '老衰',
            chief_mourner_name: '山田太郎',
            chief_mourner_relationship: '長男',
            validity_period_years_override: 13,
            notes: '備考',
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('createPlot は氏名が空の buriedPerson をスキップする', async () => {
      setupCreateMocks();

      mockRequest.body = {
        physicalPlot: { plotNumber: 'A-01', areaName: '一般墓地A', areaSqm: 3.6 },
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: {},
        customer: { name: '山田太郎', nameKana: 'ヤマダタロウ' },
        buriedPersons: [{ name: '   ' }],
      };

      await createPlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.buriedPerson.create).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    // --- #383: updatePlot で移行投入済みの4項目（死亡場所/死因/喪主名/喪主続柄）を
    //     保存のたびに null 上書き破壊しないこと（部分更新化） ---
    const setupUpdateBuriedPersonMocks = () => {
      // 既存埋葬者を 1 件返し、入力 id と突合させて update パスに入れる
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        physicalPlot: { id: 'pp1', area_sqm: new Prisma.Decimal(3.6) },
        saleContractRoles: [{ id: 'scr1', customer: { id: 'c1', workInfo: null } }],
        usageFee: null,
        managementFee: null,
      });
      mockPrisma.contractPlot.findMany.mockResolvedValue([]);
      mockPrisma.buriedPerson.findMany.mockResolvedValue([
        {
          id: 'bp1',
          name: '山田一郎',
          death_place: '東京都病院', // 移行投入済みの値
          cause_of_death: '老衰',
          chief_mourner_name: '山田太郎',
          chief_mourner_relationship: '長男',
        },
      ]);
      mockPrisma.buriedPerson.update.mockResolvedValue({ id: 'bp1' });
    };

    it('updatePlot は4項目未指定なら update data に含めず移行値を破壊しない（#383）', async () => {
      setupUpdateBuriedPersonMocks();

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        // 死亡場所/死因/喪主名/喪主続柄は未指定（編集フォームがラウンドトリップしない）
        buriedPersons: [{ id: 'bp1', name: '山田一郎', relationship: '父' }],
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockPrisma.buriedPerson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bp1' },
          data: expect.not.objectContaining({
            death_place: expect.anything(),
            cause_of_death: expect.anything(),
            chief_mourner_name: expect.anything(),
            chief_mourner_relationship: expect.anything(),
          }),
        })
      );
    });

    it('updatePlot は4項目指定なら update data に反映する（#383）', async () => {
      setupUpdateBuriedPersonMocks();

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        buriedPersons: [
          {
            id: 'bp1',
            name: '山田一郎',
            deathPlace: '大阪府病院',
            causeOfDeath: '心不全',
            chiefMournerName: '山田次郎',
            chiefMournerRelationship: '次男',
          },
        ],
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockPrisma.buriedPerson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bp1' },
          data: expect.objectContaining({
            death_place: '大阪府病院',
            cause_of_death: '心不全',
            chief_mourner_name: '山田次郎',
            chief_mourner_relationship: '次男',
          }),
        })
      );
    });

    it('updatePlot は4項目空文字なら null 化して反映する（#383）', async () => {
      setupUpdateBuriedPersonMocks();

      mockRequest.params = { id: 'cp1' };
      mockRequest.body = {
        buriedPersons: [
          {
            id: 'bp1',
            name: '山田一郎',
            deathPlace: '',
            causeOfDeath: '',
            chiefMournerName: '',
            chiefMournerRelationship: '',
          },
        ],
      };

      await updatePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockPrisma.buriedPerson.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bp1' },
          data: expect.objectContaining({
            death_place: null,
            cause_of_death: null,
            chief_mourner_name: null,
            chief_mourner_relationship: null,
          }),
        })
      );
    });
  });

  describe('deletePlot', () => {
    it('should return 404 when contract plot not found', async () => {
      mockPrisma.contractPlot.findUnique.mockResolvedValue(null);
      mockRequest.params = { id: 'non-existent' };

      await deletePlot(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(NotFoundError));
    });

    it('契約区画削除時に合祀・埋葬者・契約役割など子レコードを論理削除する (#358)', async () => {
      setupDeleteCascadeMocks();
      mockRequest.params = { id: 'cp1' };

      await deletePlot(mockRequest as Request, mockResponse as Response, mockNext);

      // 合祀（今回の孤児レコードの主因）が論理削除されること
      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cb1' },
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        })
      );
      // 契約役割が論理削除されること（顧客削除判定の正確性のため）
      expect(mockPrisma.saleContractRole.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'scr1' },
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        })
      );
      // 埋葬者・墓石・工事・家族連絡先・書類・請求・入金も論理削除されること
      expect(mockPrisma.buriedPerson.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bp1' } })
      );
      expect(mockPrisma.billing.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bl1' } })
      );
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'pm1' } })
      );
      // 各子に DELETE 履歴が記録されること
      expect(recordEntityDeleted).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ entityType: 'CollectiveBurial', entityId: 'cb1' })
      );
      expect(responseStatus).toHaveBeenCalledWith(200);
    });

    // deletePlot のカスケード対象を網羅したモック準備
    function setupDeleteCascadeMocks(): void {
      mockPrisma.contractPlot.findUnique.mockResolvedValue({
        id: 'cp1',
        physical_plot_id: 'pp1',
        contract_area_sqm: new Prisma.Decimal(3.6),
        contract_date: new Date('2024-01-01'),
        price: 1000000,
        payment_status: 'paid',
        physicalPlot: { id: 'pp1' },
        saleContractRoles: [
          { id: 'scr1', customer: { id: 'c1', name: '山田太郎', workInfo: null } },
        ],
        usageFee: null,
        managementFee: null,
      });
      mockPrisma.contractPlot.update.mockResolvedValue({ id: 'cp1' });
      // 顧客の他契約参照チェック（contract_plot_id: { not } 付き）は「他に無い」、
      // カスケードの役割検索（contract_plot_id 等値）は scr1 を返す
      mockPrisma.saleContractRole.findMany.mockImplementation((args: any) => {
        if (args?.where?.contract_plot_id?.not) return Promise.resolve([]);
        return Promise.resolve([{ id: 'scr1' }]);
      });
      mockPrisma.customer.update.mockResolvedValue({ id: 'c1' });
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([{ id: 'cb1' }]);
      mockPrisma.collectiveBurial.update.mockResolvedValue({ id: 'cb1' });
      mockPrisma.buriedPerson.findMany.mockResolvedValue([{ id: 'bp1' }]);
      mockPrisma.buriedPerson.update.mockResolvedValue({ id: 'bp1' });
      mockPrisma.gravestoneInfo.findMany.mockResolvedValue([{ id: 'gs1' }]);
      mockPrisma.gravestoneInfo.update.mockResolvedValue({ id: 'gs1' });
      mockPrisma.constructionInfo.findMany.mockResolvedValue([{ id: 'ci1' }]);
      mockPrisma.constructionInfo.update.mockResolvedValue({ id: 'ci1' });
      mockPrisma.familyContact.findMany.mockResolvedValue([{ id: 'fc1' }]);
      mockPrisma.familyContact.update.mockResolvedValue({ id: 'fc1' });
      mockPrisma.saleContractRole.update.mockResolvedValue({ id: 'scr1' });
      mockPrisma.document.findMany.mockResolvedValue([{ id: 'doc1' }]);
      mockPrisma.document.update.mockResolvedValue({ id: 'doc1' });
      mockPrisma.billing.findMany.mockResolvedValue([{ id: 'bl1' }]);
      mockPrisma.billing.update.mockResolvedValue({ id: 'bl1' });
      mockPrisma.payment.findMany.mockResolvedValue([{ id: 'pm1' }]);
      mockPrisma.payment.update.mockResolvedValue({ id: 'pm1' });
    }
  });

  describe('getPlotContracts', () => {
    it('should return all contracts for a physical plot', async () => {
      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(7.2),
        status: 'partial',
        contractPlots: [
          {
            id: 'cp1',
            contract_area_sqm: new Prisma.Decimal(3.6),
            location_description: 'A区画-1',
            created_at: new Date('2024-01-01'),
            contract_date: new Date('2024-01-01'),
            price: 1000000,
            payment_status: 'paid',
            saleContractRoles: [
              {
                id: 'scr1',
                role: 'contractor',
                customer: {
                  id: 'c1',
                  name: '山田太郎',
                  name_kana: 'ヤマダタロウ',
                  phone_number: '0312345678',
                },
              },
            ],
            usageFee: null,
            managementFee: null,
          },
        ],
      };

      mockPrisma.physicalPlot.findUnique.mockResolvedValue(mockPhysicalPlot);
      mockRequest.params = { id: 'pp1' };

      await getPlotContracts(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            physicalPlot: expect.any(Object),
            contracts: expect.any(Array),
            summary: expect.objectContaining({
              totalContracts: 1,
              totalAllocatedArea: 3.6,
            }),
          }),
        })
      );
    });

    it('should return 404 when physical plot not found', async () => {
      mockPrisma.physicalPlot.findUnique.mockResolvedValue(null);
      mockRequest.params = { id: 'non-existent' };

      await getPlotContracts(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(404);
    });
  });

  describe('createPlotContract', () => {
    it('should return 404 when physical plot not found', async () => {
      mockPrisma.physicalPlot.findUnique.mockResolvedValue(null);
      mockRequest.params = { id: 'non-existent' };
      mockRequest.body = {};

      await createPlotContract(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(404);
    });

    it('should return 400 when contract area validation fails', async () => {
      (validateContractArea as jest.Mock).mockResolvedValue({
        isValid: false,
        message: '契約面積が利用可能面積を超えています',
      });

      mockPrisma.physicalPlot.findUnique.mockResolvedValue({ id: 'pp1' });
      mockRequest.params = { id: 'pp1' };
      mockRequest.body = {
        contractPlot: {
          contractAreaSqm: 10.0,
        },
        saleContract: {},
        customer: {},
      };

      await createPlotContract(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(400);
    });

    it('面積検証は Serializable トランザクション内で行われること（#278）', async () => {
      (validateContractArea as jest.Mock).mockResolvedValue({
        isValid: false,
        message: '契約面積が利用可能面積を超えています',
      });

      mockPrisma.physicalPlot.findUnique.mockResolvedValue({ id: 'pp1' });
      mockRequest.params = { id: 'pp1' };
      mockRequest.body = {
        contractPlot: { contractAreaSqm: 10.0 },
        saleContract: {},
        customer: {},
      };

      await createPlotContract(mockRequest as Request, mockResponse as Response);

      // 検証〜作成の check-then-act を tx 内へ移したことを固定する
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      // tx クライアント（モックでは mockPrisma 自身）で検証している
      expect(validateContractArea).toHaveBeenCalledWith(mockPrisma, 'pp1', 10.0);
    });

    it('直列化競合（P2034）は 409 CONFLICT を返すこと（#278）', async () => {
      mockPrisma.physicalPlot.findUnique.mockResolvedValue({ id: 'pp1' });
      mockPrisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
      mockRequest.params = { id: 'pp1' };
      mockRequest.body = {
        contractPlot: { contractAreaSqm: 3.6 },
        saleContract: {},
        customer: {},
      };

      await createPlotContract(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(409);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'CONFLICT' }),
        })
      );
    });
  });

  describe('getPlotInventory', () => {
    it('should return inventory status for physical plot', async () => {
      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(7.2),
        status: 'partial',
        contractPlots: [
          {
            id: 'cp1',
            contract_area_sqm: new Prisma.Decimal(3.6),
            contract_status: 'active',
            saleContractRoles: [
              {
                id: 'scr1',
                role: 'contractor',
                customer: {
                  name: '山田太郎',
                },
              },
            ],
          },
        ],
      };

      mockPrisma.physicalPlot.findUnique.mockResolvedValue(mockPhysicalPlot);
      mockRequest.params = { id: 'pp1' };

      await getPlotInventory(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            inventory: expect.objectContaining({
              totalArea: 7.2,
              allocatedArea: 3.6,
              availableArea: 3.6,
              utilizationRate: 50,
              status: 'partial',
            }),
          }),
        })
      );
    });

    it('should treat vacant placeholder contracts as available (#209)', async () => {
      // 空き区画は ContractPlot 無しでなく contract_status='vacant' の器契約で表現される。
      // vacant の面積を割当済みに含めると空き区画が sold_out と誤判定される。
      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(3.6),
        status: 'available',
        contractPlots: [
          {
            id: 'cp1',
            contract_area_sqm: new Prisma.Decimal(3.6),
            contract_status: 'vacant',
            saleContractRoles: [],
          },
        ],
      };

      mockPrisma.physicalPlot.findUnique.mockResolvedValue(mockPhysicalPlot);
      mockRequest.params = { id: 'pp1' };

      await getPlotInventory(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(200);
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inventory: expect.objectContaining({
              allocatedArea: 0,
              availableArea: 3.6,
              status: 'available',
            }),
            // 表示用一覧には vacant 契約も contractStatus 付きで含まれる
            contracts: [expect.objectContaining({ id: 'cp1', contractStatus: 'vacant' })],
          }),
        })
      );
    });

    it('should exclude terminated contracts from allocated area (#209)', async () => {
      const mockPhysicalPlot = {
        id: 'pp1',
        plot_number: 'A-01',
        area_name: '一般墓地A',
        area_sqm: new Prisma.Decimal(7.2),
        status: 'partial',
        contractPlots: [
          {
            id: 'cp1',
            contract_area_sqm: new Prisma.Decimal(3.6),
            contract_status: 'active',
            saleContractRoles: [],
          },
          {
            id: 'cp2',
            contract_area_sqm: new Prisma.Decimal(3.6),
            contract_status: 'terminated',
            saleContractRoles: [],
          },
        ],
      };

      mockPrisma.physicalPlot.findUnique.mockResolvedValue(mockPhysicalPlot);
      mockRequest.params = { id: 'pp1' };

      await getPlotInventory(mockRequest as Request, mockResponse as Response);

      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inventory: expect.objectContaining({
              allocatedArea: 3.6, // active のみ
              availableArea: 3.6,
              status: 'partial',
            }),
          }),
        })
      );
    });

    it('should return 404 when physical plot not found', async () => {
      mockPrisma.physicalPlot.findUnique.mockResolvedValue(null);
      mockRequest.params = { id: 'non-existent' };

      await getPlotInventory(mockRequest as Request, mockResponse as Response);

      expect(responseStatus).toHaveBeenCalledWith(404);
    });
  });
});
