/**
 * 合祀バグ修正の回帰テスト
 * - #202: ソフトデリート後の同一区画での再作成
 * - #203: syncBurialCount の上限割れ時の日付リセット（utils 実装へ委譲）
 * - #206: 一覧検索で論理削除済み役割の顧客名を除外
 */
import { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
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
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  contractPlot: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  buriedPerson: {
    count: jest.fn(),
    // 最終納骨者の埋葬日取得（議事録 2026-07-21 §1）。本ファイルは最終納骨者なしで検証する
    findFirst: jest.fn(),
  },
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
  createCollectiveBurial,
  syncBurialCount,
  getCollectiveBurialList,
} from '../../src/collective-burials/collectiveBurialController';
import { ValidationError } from '../../src/middleware/errorHandler';

const CB_ROW = {
  id: 'cb1',
  contract_plot_id: 'cp1',
  burial_capacity: 10,
  current_burial_count: 0,
  capacity_reached_date: null,
  validity_period_years: 33,
  billing_scheduled_date: null,
  billing_scheduled_date_manual: false,
  billing_status: 'pending',
  billing_amount: null,
  notes: null,
  deleted_at: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('collectiveBurialController — バグ修正回帰', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let responseJson: jest.Mock;
  let responseStatus: jest.Mock;
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    responseJson = jest.fn().mockReturnThis();
    responseStatus = jest.fn().mockReturnThis();
    mockResponse = { status: responseStatus, json: responseJson };
    mockNext = jest.fn();
    mockRequest = { params: {}, body: {}, query: {} };
    // 最終納骨者は未確定（＝請求予定日は契約日起点にフォールバックする）
    mockPrisma.buriedPerson.findFirst.mockResolvedValue(null);
    mockPrisma.contractPlot.findUnique.mockResolvedValue({
      contract_date: new Date('2026-04-01T00:00:00Z'),
    });
  });

  describe('createCollectiveBurial (#202)', () => {
    const validBody = {
      contractPlotId: 'cp1',
      burialCapacity: 10,
      validityPeriodYears: 33,
    };

    it('生きている合祀が既に存在する場合は ValidationError', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue({ ...CB_ROW, deleted_at: null });

      mockRequest.body = validBody;
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(mockPrisma.collectiveBurial.create).not.toHaveBeenCalled();
      expect(mockPrisma.collectiveBurial.update).not.toHaveBeenCalled();
    });

    it('ソフトデリート済みの合祀が残っている場合は新規値で復活させる（P2002回避）', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue({
        ...CB_ROW,
        current_burial_count: 5,
        capacity_reached_date: new Date('2025-01-01'),
        billing_scheduled_date: new Date('2058-01-01'),
        billing_status: 'billed',
        deleted_at: new Date('2026-05-01'),
      });
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        burial_capacity: 20,
        validity_period_years: 30,
      });

      mockRequest.body = { ...validBody, burialCapacity: 20, validityPeriodYears: 30 };
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.create).not.toHaveBeenCalled();
      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith({
        where: { id: 'cb1' },
        data: expect.objectContaining({
          burial_capacity: 20,
          current_burial_count: 0,
          validity_period_years: 30,
          capacity_reached_date: null,
          billing_scheduled_date: null,
          billing_status: 'pending',
          deleted_at: null,
        }),
      });
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('既存が無ければ従来どおり create する', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(null);
      mockPrisma.collectiveBurial.create.mockResolvedValue(CB_ROW);

      mockRequest.body = validBody;
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contract_plot_id: 'cp1',
          burial_capacity: 10,
        }),
      });
      expect(responseStatus).toHaveBeenCalledWith(201);
    });

    it('復活時に残存する埋葬者から count・上限到達日を再同期する (#281)。請求予定日は契約日起点 (#164)', async () => {
      // シナリオ: 合祀のみ削除（BuriedPerson 7名は ContractPlot 紐付けで残存）→ 同区画で再作成
      mockPrisma.contractPlot.findFirst.mockResolvedValue({
        id: 'cp1',
        contract_date: new Date('2026-04-01T00:00:00Z'),
      });
      // 1回目: 既存チェック（ソフトデリート済み行）/ 2回目: 再同期内の取得（復活済み行）
      mockPrisma.collectiveBurial.findUnique
        .mockResolvedValueOnce({ ...CB_ROW, deleted_at: new Date('2026-05-01') })
        .mockResolvedValueOnce({ ...CB_ROW, burial_capacity: 5, deleted_at: null });
      // 1回目: 復活 update / 2回目: 再同期 update
      const restoredRow = { ...CB_ROW, burial_capacity: 5, current_burial_count: 0 };
      const syncedRow = {
        ...CB_ROW,
        burial_capacity: 5,
        current_burial_count: 7,
        capacity_reached_date: new Date('2026-06-06'),
      };
      mockPrisma.collectiveBurial.update
        .mockResolvedValueOnce(restoredRow)
        .mockResolvedValueOnce(syncedRow);
      mockPrisma.buriedPerson.count.mockResolvedValue(7);

      mockRequest.body = { ...validBody, burialCapacity: 5 };
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledTimes(2);

      // 復活 update（1回目）で請求予定日が契約日起点で導出されること（#164: 2026-04-01 + 33年）
      const reviveCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(reviveCall.data.billing_scheduled_date.toISOString()).toBe('2059-04-01T00:00:00.000Z');

      // 再同期 update（2回目）が実埋葬者数で行われ、上限到達日がセットされること。
      // 請求予定日は契約日起点（#164）のため再同期では変更されない
      const syncCall = mockPrisma.collectiveBurial.update.mock.calls[1][0];
      expect(syncCall.data).toMatchObject({ current_burial_count: 7 });
      expect(syncCall.data.capacity_reached_date).toBeInstanceOf(Date);
      // 再同期でも起点は「最終納骨者の埋葬日、無ければ契約日」。本ケースは最終納骨者なしで
      // 契約日 2026-04-01 + 33年となり、復活 update と同じ値に落ち着く（上限到達日は起点にしない）
      expect(syncCall.data.billing_scheduled_date.toISOString()).toBe('2059-04-01T00:00:00.000Z');

      // レスポンスは再同期後の値（count=0 固定でない）こと
      expect(responseStatus).toHaveBeenCalledWith(201);
      const payload = responseJson.mock.calls[0][0];
      expect(payload.data.currentBurialCount).toBe(7);
    });
  });

  describe('syncBurialCount (#203)', () => {
    it('上限到達後に人数が減ったら上限到達日がリセットされる（請求予定日は契約日起点で再計算 #164）', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue({
        ...CB_ROW,
        current_burial_count: 10,
        capacity_reached_date: new Date('2025-01-01'),
        billing_scheduled_date: new Date('2058-01-01'),
      });
      // updateCollectiveBurialCount（utils）内の取得
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue({
        ...CB_ROW,
        current_burial_count: 10,
        capacity_reached_date: new Date('2025-01-01'),
        billing_scheduled_date: new Date('2058-01-01'),
      });
      mockPrisma.buriedPerson.count.mockResolvedValue(9); // 上限(10)を下回った
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        current_burial_count: 9,
        capacity_reached_date: null,
        billing_scheduled_date: new Date('2058-01-01T00:00:00Z'), // 維持される
      });

      mockRequest.params = { id: 'cb1' };
      await syncBurialCount(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            current_burial_count: 9,
            capacity_reached_date: null,
          }),
        })
      );
      // 請求予定日は「最終納骨者の埋葬日、無ければ契約日」起点で再計算される
      // （議事録 2026-07-21 §1）。本ケースは最終納骨者なし・契約日 2026-04-01 なので
      //  2026-04-01 + 33年。上限人数の増減そのものが起点になるわけではない（#164）
      const syncData = mockPrisma.collectiveBurial.update.mock.calls[0][0].data;
      expect(syncData.billing_scheduled_date.toISOString()).toBe('2059-04-01T00:00:00.000Z');
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            currentBurialCount: 9,
            capacityReached: false,
            capacityReachedDate: null,
            billingScheduledDate: '2058-01-01',
          }),
        })
      );
    });

    it('上限到達（初回）で上限到達日がセットされる（請求予定日は上限到達日起点にしない #164）', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue(CB_ROW);
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(CB_ROW);
      mockPrisma.buriedPerson.count.mockResolvedValue(10);
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        current_burial_count: 10,
        capacity_reached_date: new Date('2026-06-05'),
      });

      mockRequest.params = { id: 'cb1' };
      await syncBurialCount(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            current_burial_count: 10,
            capacity_reached_date: expect.any(Date),
          }),
        })
      );
      // 起点は最終納骨者の埋葬日（なし）→契約日 2026-04-01 + 33年。
      // 上限到達日そのものは起点にしない（#164）
      const syncData = mockPrisma.collectiveBurial.update.mock.calls[0][0].data;
      expect(syncData.billing_scheduled_date.toISOString()).toBe('2059-04-01T00:00:00.000Z');
      expect(responseJson).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ capacityReached: true }),
        })
      );
    });
  });

  describe('getCollectiveBurialList 検索 (#206)', () => {
    it('顧客名検索の some 句に deleted_at: null が付与される', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);
      mockPrisma.collectiveBurial.count.mockResolvedValue(0);

      mockRequest.query = { search: '山田' };
      await getCollectiveBurialList(mockRequest as Request, mockResponse as Response, mockNext);

      // 検索条件は contractPlot.is 配下にマージされ、親契約の論理削除ガード
      // （deleted_at: null）と OR 検索条件が共存する（#358 layer2）
      expect(mockPrisma.collectiveBurial.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contractPlot: {
              is: expect.objectContaining({
                deleted_at: null,
                OR: expect.arrayContaining([
                  expect.objectContaining({
                    saleContractRoles: {
                      some: expect.objectContaining({
                        deleted_at: null,
                      }),
                    },
                  }),
                ]),
              }),
            },
          }),
        })
      );
    });
  });
});
