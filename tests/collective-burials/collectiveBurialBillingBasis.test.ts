/**
 * 回帰テスト: 合祀請求予定日の起点（#164 / 議事録 2026-07-21 §1）
 *
 * 起点は「最終納骨者の埋葬日、無ければ契約日」。本ファイルは最終納骨者が未確定のとき
 * 契約日起点にフォールバックする側を担保する（最終納骨日起点は
 * collectiveBurialFinalBurial.test.ts）。
 *
 * 契約日起点のフォールバックを残すのは、業務確認（2026-06-07 Q17 ほか）で
 * 「合祀は契約から一定年数後・年数はお墓のタイプで決まる」と確認されており、かつ
 * 最終納骨者が確定しない区画で請求予定日が永久に null になり請求が発火しないため。
 *
 * - 作成時: billing_scheduled_date = contract_date + validity_period_years
 * - 契約日未設定: null（契約日設定時に updatePlot が再計算）
 * - 更新時: validityPeriodYears 変更で再計算、billingScheduledDate 明示指定（例外運用）が優先
 */
import { Request, Response, NextFunction } from 'express';

const mockPrisma = {
  contractPlot: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  collectiveBurial: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  buriedPerson: {
    count: jest.fn(),
    // 最終納骨者の埋葬日取得。本ファイルは全ケース「最終納骨者なし」で契約日起点を見る
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
  updateCollectiveBurial,
} from '../../src/collective-burials/collectiveBurialController';

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

describe('合祀請求予定日の契約日フォールバック (#164)', () => {
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
    // 最終納骨者は未確定（＝契約日起点へフォールバックする）を既定にする
    mockPrisma.buriedPerson.findFirst.mockResolvedValue(null);
  });

  describe('createCollectiveBurial', () => {
    it('契約日 + 有効期間で billing_scheduled_date を導出して作成する', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({
        id: 'cp1',
        contract_date: new Date('2026-04-01T00:00:00Z'),
      });
      mockPrisma.collectiveBurial.findUnique
        .mockResolvedValueOnce(null) // 既存チェック
        .mockResolvedValueOnce({ ...CB_ROW, deleted_at: null }); // 再同期内の取得
      mockPrisma.collectiveBurial.create.mockResolvedValue(CB_ROW);
      mockPrisma.collectiveBurial.update.mockResolvedValue(CB_ROW);
      // 再同期内の請求予定日再計算で契約日を読む（findFirst と同じ値を返す）
      mockPrisma.contractPlot.findUnique.mockResolvedValue(
        await mockPrisma.contractPlot.findFirst()
      );
      mockPrisma.buriedPerson.count.mockResolvedValue(0);

      mockRequest.body = { contractPlotId: 'cp1', burialCapacity: 10, validityPeriodYears: 13 };
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const createCall = mockPrisma.collectiveBurial.create.mock.calls[0][0];
      expect(createCall.data.billing_scheduled_date.toISOString()).toBe('2039-04-01T00:00:00.000Z');
    });

    it('契約日未設定なら billing_scheduled_date は null（契約日設定時に再計算する運用）', async () => {
      mockPrisma.contractPlot.findFirst.mockResolvedValue({ id: 'cp1', contract_date: null });
      mockPrisma.collectiveBurial.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...CB_ROW, deleted_at: null });
      mockPrisma.collectiveBurial.create.mockResolvedValue(CB_ROW);
      mockPrisma.collectiveBurial.update.mockResolvedValue(CB_ROW);
      // 再同期内の請求予定日再計算で契約日を読む（findFirst と同じ値を返す）
      mockPrisma.contractPlot.findUnique.mockResolvedValue(
        await mockPrisma.contractPlot.findFirst()
      );
      mockPrisma.buriedPerson.count.mockResolvedValue(0);

      mockRequest.body = { contractPlotId: 'cp1', burialCapacity: 10, validityPeriodYears: 33 };
      await createCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const createCall = mockPrisma.collectiveBurial.create.mock.calls[0][0];
      expect(createCall.data.billing_scheduled_date).toBeNull();
    });
  });

  describe('updateCollectiveBurial', () => {
    it('validityPeriodYears 変更時は契約日起点で billing_scheduled_date を再計算する', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue({
        ...CB_ROW,
        billing_scheduled_date: new Date('2059-04-01T00:00:00Z'), // 33年で計算済み
        contractPlot: { contract_date: new Date('2026-04-01T00:00:00Z') },
      });
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        validity_period_years: 13,
        billing_scheduled_date: new Date('2039-04-01T00:00:00Z'),
        contractPlot: { physicalPlot: { plot_number: 'A-1' } },
      });

      mockRequest.params = { id: 'cb1' };
      mockRequest.body = { validityPeriodYears: 13 };
      await updateCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(updateCall.data.billing_scheduled_date.toISOString()).toBe('2039-04-01T00:00:00.000Z');
    });

    it('billingScheduledDate の明示指定（例外運用）は再計算より優先される', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue({
        ...CB_ROW,
        contractPlot: { contract_date: new Date('2026-04-01T00:00:00Z') },
      });
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        validity_period_years: 13,
        billing_scheduled_date: new Date('2035-01-01T00:00:00Z'),
        contractPlot: { physicalPlot: { plot_number: 'A-1' } },
      });

      mockRequest.params = { id: 'cb1' };
      // 例外: 決まった年数より短くする（業務確認 2026-06-07 Q17 備考）
      mockRequest.body = { validityPeriodYears: 13, billingScheduledDate: '2035-01-01' };
      await updateCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(updateCall.data.billing_scheduled_date.toISOString()).toBe('2035-01-01T00:00:00.000Z');
    });

    it('validityPeriodYears が変わらない更新では billing_scheduled_date を触らない（手動例外の保持）', async () => {
      mockPrisma.collectiveBurial.findFirst.mockResolvedValue({
        ...CB_ROW,
        billing_scheduled_date: new Date('2035-01-01T00:00:00Z'), // 手動例外
        contractPlot: { contract_date: new Date('2026-04-01T00:00:00Z') },
      });
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...CB_ROW,
        billing_scheduled_date: new Date('2035-01-01T00:00:00Z'),
        contractPlot: { physicalPlot: { plot_number: 'A-1' } },
      });

      mockRequest.params = { id: 'cb1' };
      mockRequest.body = { notes: 'メモ更新', validityPeriodYears: 33 }; // 33 → 33（変更なし）
      await updateCollectiveBurial(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(updateCall.data.billing_scheduled_date).toBeUndefined();
    });
  });
});
