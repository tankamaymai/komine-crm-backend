import {
  calculateBillingScheduledDate,
  resolveBillingScheduledDate,
  updateCollectiveBurialCount,
  getBillingTargets,
} from '../../src/collective-burials/utils';

// Prisma Clientのモック
const mockPrisma = {
  collectiveBurial: {
    findUnique: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  buriedPerson: {
    count: jest.fn(),
  },
};

describe('collectiveBurialUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateBillingScheduledDate', () => {
    it('should calculate billing date correctly by adding years', () => {
      const capacityReachedDate = new Date('2024-01-15');
      const validityPeriodYears = 3;

      const result = calculateBillingScheduledDate(capacityReachedDate, validityPeriodYears);

      expect(result.getFullYear()).toBe(2027);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(15);
    });

    it('should handle leap year correctly', () => {
      const capacityReachedDate = new Date('2024-02-29'); // Leap year
      const validityPeriodYears = 1;

      const result = calculateBillingScheduledDate(capacityReachedDate, validityPeriodYears);

      expect(result.getFullYear()).toBe(2025);
      // JavaScriptでは2024-02-29 + 1年 = 2025-03-01になる（うるう日調整）
      expect(result.getMonth()).toBe(2); // March
      expect(result.getDate()).toBe(1);
    });

    it('should calculate correctly with 5 year validity period', () => {
      const capacityReachedDate = new Date('2020-06-30');
      const validityPeriodYears = 5;

      const result = calculateBillingScheduledDate(capacityReachedDate, validityPeriodYears);

      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(5); // June
      expect(result.getDate()).toBe(30);
    });

    it('UTC 00:00 正規化済みの入力に対し UTC 00:00 を維持する (#214)', () => {
      const capacityReachedDate = new Date('2026-06-05T00:00:00Z');

      const result = calculateBillingScheduledDate(capacityReachedDate, 33);

      // setFullYear（ローカル基準）だと TZ により時刻成分が混入しうるが、
      // UTC ベース加算では暦日が厳密に維持される
      expect(result.toISOString()).toBe('2059-06-05T00:00:00.000Z');
    });
  });

  describe('resolveBillingScheduledDate (#164: 契約日起点)', () => {
    it('契約日 + 有効期間で請求予定日を導出する', () => {
      const result = resolveBillingScheduledDate(new Date('2026-04-01T00:00:00Z'), 13);

      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe('2039-04-01T00:00:00.000Z');
    });

    it('契約日が null なら null を返す（契約日設定時に再計算する運用）', () => {
      expect(resolveBillingScheduledDate(null, 33)).toBeNull();
    });
  });

  describe('@db.Date 列への JST 暦日正規化 (#214)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('JST 早朝（年末年始境界）の上限到達で保存日付が前日・前年にずれない', async () => {
      // UTC 2026-12-31 20:00 = JST 2027-01-01 05:00
      jest.useFakeTimers().setSystemTime(new Date('2026-12-31T20:00:00Z'));

      const mockCollectiveBurial = {
        id: 'cb-1',
        contract_plot_id: 'plot-1',
        burial_capacity: 10,
        current_burial_count: 9,
        capacity_reached_date: null,
        validity_period_years: 3,
        deleted_at: null,
      };
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(mockCollectiveBurial);
      mockPrisma.buriedPerson.count.mockResolvedValue(10);
      mockPrisma.collectiveBurial.update.mockResolvedValue({ ...mockCollectiveBurial });

      await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      // JST の暦日 2027-01-01 が UTC 00:00 で保存される（2026-12-31 にならない）
      expect(updateCall.data.capacity_reached_date.toISOString()).toBe('2027-01-01T00:00:00.000Z');
      // 請求予定日は契約日起点（#164）のため埋葬数同期では設定されない
      expect(updateCall.data.billing_scheduled_date).toBeUndefined();
    });

    it('getBillingTargets の基準日も JST 暦日の UTC 00:00 に正規化される', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-12-31T20:00:00Z'));
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      await getBillingTargets(mockPrisma as any);

      const callArgs = mockPrisma.collectiveBurial.findMany.mock.calls[0][0];
      expect(callArgs.where.billing_scheduled_date.lte.toISOString()).toBe(
        '2027-01-01T00:00:00.000Z'
      );
    });
  });

  describe('updateCollectiveBurialCount', () => {
    it('should return null if collective burial does not exist', async () => {
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(null);

      const result = await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      expect(result).toBeNull();
      expect(mockPrisma.collectiveBurial.findUnique).toHaveBeenCalledWith({
        where: { contract_plot_id: 'plot-1' },
      });
      expect(mockPrisma.buriedPerson.count).not.toHaveBeenCalled();
    });

    it('should return null if collective burial is deleted', async () => {
      mockPrisma.collectiveBurial.findUnique.mockResolvedValue({
        id: 'cb-1',
        deleted_at: new Date(),
        burial_capacity: 10,
      });

      const result = await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      expect(result).toBeNull();
    });

    it('should update count without reaching capacity', async () => {
      const mockCollectiveBurial = {
        id: 'cb-1',
        contract_plot_id: 'plot-1',
        burial_capacity: 10,
        current_burial_count: 5,
        capacity_reached_date: null,
        validity_period_years: 3,
        deleted_at: null,
      };

      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(mockCollectiveBurial);
      mockPrisma.buriedPerson.count.mockResolvedValue(7); // 上限未満
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...mockCollectiveBurial,
        current_burial_count: 7,
      });

      const result = await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      expect(mockPrisma.buriedPerson.count).toHaveBeenCalledWith({
        where: {
          contract_plot_id: 'plot-1',
          deleted_at: null,
        },
      });

      expect(mockPrisma.collectiveBurial.update).toHaveBeenCalledWith({
        where: { id: 'cb-1' },
        data: {
          current_burial_count: 7,
        },
      });

      expect(result).toBeDefined();
      expect(result.current_burial_count).toBe(7);
    });

    it('should set capacity_reached_date when reaching capacity for first time', async () => {
      const mockCollectiveBurial = {
        id: 'cb-1',
        contract_plot_id: 'plot-1',
        burial_capacity: 10,
        current_burial_count: 9,
        capacity_reached_date: null, // 未到達
        validity_period_years: 3,
        deleted_at: null,
      };

      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(mockCollectiveBurial);
      mockPrisma.buriedPerson.count.mockResolvedValue(10); // ちょうど上限到達
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...mockCollectiveBurial,
        current_burial_count: 10,
        capacity_reached_date: new Date(),
      });

      await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(updateCall.data.current_burial_count).toBe(10);
      expect(updateCall.data.capacity_reached_date).toBeInstanceOf(Date);
      // 請求予定日は契約日起点（#164）のため上限到達では設定しない
      expect(updateCall.data.billing_scheduled_date).toBeUndefined();
    });

    it('should not update dates if already reached capacity', async () => {
      const mockCollectiveBurial = {
        id: 'cb-1',
        contract_plot_id: 'plot-1',
        burial_capacity: 10,
        current_burial_count: 10,
        capacity_reached_date: new Date('2024-01-01'), // 既に到達済み
        billing_scheduled_date: new Date('2027-01-01'),
        validity_period_years: 3,
        deleted_at: null,
      };

      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(mockCollectiveBurial);
      mockPrisma.buriedPerson.count.mockResolvedValue(10); // 依然として上限
      mockPrisma.collectiveBurial.update.mockResolvedValue(mockCollectiveBurial);

      await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      // 日付フィールドが更新データに含まれていないことを確認
      expect(updateCall.data.capacity_reached_date).toBeUndefined();
      expect(updateCall.data.billing_scheduled_date).toBeUndefined();
      expect(updateCall.data.current_burial_count).toBe(10);
    });

    it('should reset capacity_reached_date when falling below capacity (請求予定日は維持 #164)', async () => {
      const mockCollectiveBurial = {
        id: 'cb-1',
        contract_plot_id: 'plot-1',
        burial_capacity: 10,
        current_burial_count: 10,
        capacity_reached_date: new Date('2024-01-01'), // 到達済み
        billing_scheduled_date: new Date('2027-01-01'),
        validity_period_years: 3,
        deleted_at: null,
      };

      mockPrisma.collectiveBurial.findUnique.mockResolvedValue(mockCollectiveBurial);
      mockPrisma.buriedPerson.count.mockResolvedValue(8); // 上限を下回った
      mockPrisma.collectiveBurial.update.mockResolvedValue({
        ...mockCollectiveBurial,
        current_burial_count: 8,
        capacity_reached_date: null,
      });

      await updateCollectiveBurialCount(mockPrisma as any, 'plot-1');

      const updateCall = mockPrisma.collectiveBurial.update.mock.calls[0][0];
      expect(updateCall.data.current_burial_count).toBe(8);
      expect(updateCall.data.capacity_reached_date).toBeNull();
      // 請求予定日は契約日起点（#164）のため埋葬数の増減ではリセットしない
      expect(updateCall.data.billing_scheduled_date).toBeUndefined();
    });
  });

  describe('getBillingTargets', () => {
    it('should return collective burials with pending status and past billing date', async () => {
      const mockTargets = [
        {
          id: 'cb-1',
          contract_plot_id: 'plot-1',
          billing_status: 'pending',
          billing_scheduled_date: new Date('2024-01-01'),
          Plot: {
            id: 'plot-1',
            Contractors: [
              {
                id: 'contractor-1',
                name: '田中太郎',
              },
            ],
          },
        },
      ];

      mockPrisma.collectiveBurial.findMany.mockResolvedValue(mockTargets);

      const result = await getBillingTargets(mockPrisma as any);

      expect(mockPrisma.collectiveBurial.findMany).toHaveBeenCalled();
      const callArgs = mockPrisma.collectiveBurial.findMany.mock.calls[0][0];
      expect(callArgs.where.billing_status).toBe('pending');
      expect(callArgs.where.billing_scheduled_date.lte).toBeInstanceOf(Date);
      expect(callArgs.where.deleted_at).toBeNull();
      // 親契約が論理削除された孤児合祀を請求バッチ経路でも除外する（layer2 ガード横展開・#394）
      expect(callArgs.where.contractPlot).toEqual({ is: { deleted_at: null } });
      expect(callArgs).toMatchObject({
        include: {
          contractPlot: {
            include: {
              physicalPlot: true,
              saleContractRoles: {
                where: { deleted_at: null },
                include: {
                  customer: true,
                },
              },
            },
          },
        },
      });

      expect(result).toEqual(mockTargets);
      expect(result.length).toBe(1);
    });

    it('should return empty array if no billing targets found', async () => {
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const result = await getBillingTargets(mockPrisma as any);

      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });
  });
});
