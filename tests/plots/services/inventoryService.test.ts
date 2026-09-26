/**
 * inventoryService.tsのテスト
 */

import {
  categorizeSection,
  determinePlotType,
  resolvePeriod,
  areaNamesForPeriod,
  loadSectionPeriodMap,
  getOverallSummary,
  getPeriodSummaries,
  getSectionInventory,
  getAreaInventory,
} from '../../../src/plots/services/inventoryService';

// Prismaクライアントのモック
jest.mock('@prisma/client');

// テスト用の区画名マスタ（区画名 → 期）。本番マスタの代表値を抜粋。
const MASTER_ROWS = [
  { name: 'A', period: '第1期' },
  { name: 'B', period: '第1期' },
  { name: '吉相', period: '第1期' },
  { name: '吉相C', period: '第1期' },
  { name: '1', period: '第2期' },
  { name: '10', period: '第3期' },
  { name: '樹林', period: '第3期樹林部' },
  { name: '凛B', period: '第4期' },
  { name: 'るり庵テラス', period: '第4期' },
  { name: '納骨堂-天空', period: '第4期' },
];

/** physicalPlot.findMany と sectionNameMaster.findMany を備えたモック prisma */
function buildMockPrisma(masterRows: Array<{ name: string; period: string }> = MASTER_ROWS) {
  return {
    physicalPlot: { findMany: jest.fn() },
    sectionNameMaster: { findMany: jest.fn().mockResolvedValue(masterRows) },
  } as any;
}

describe('inventoryService', () => {
  describe('categorizeSection', () => {
    it('樹林・天空カテゴリを正しく判定すること', () => {
      expect(categorizeSection('樹林')).toBe('樹林・天空');
      expect(categorizeSection('天空')).toBe('樹林・天空');
      expect(categorizeSection('天空K')).toBe('樹林・天空');
    });

    it('納骨堂カテゴリを正しく判定すること', () => {
      expect(categorizeSection('納骨堂-天空')).toBe('納骨堂');
      expect(categorizeSection('納骨堂-阿弥陀')).toBe('納骨堂');
    });

    it('カテゴリがない場合undefinedを返すこと', () => {
      expect(categorizeSection('A')).toBeUndefined();
      expect(categorizeSection('吉相')).toBeUndefined();
      expect(categorizeSection('1')).toBeUndefined();
      expect(categorizeSection('凛B')).toBeUndefined();
    });
  });

  describe('determinePlotType', () => {
    it('特殊区画タイプを正しく判定すること', () => {
      expect(determinePlotType('吉相', 3.6)).toBe('吉相');
      expect(determinePlotType('吉相C', 3.6)).toBe('吉相'); // 吉相系は吉相
      expect(determinePlotType('吉相テラス', 3.6)).toBe('吉相');
      expect(determinePlotType('樹林', 1.8)).toBe('樹林');
      expect(determinePlotType('樹木葬', 0.6)).toBe('樹林'); // 樹木葬は樹林
      expect(determinePlotType('天空K', 3.6)).toBe('天空');
      expect(determinePlotType('天空', 1.8)).toBe('天空');
      expect(determinePlotType('るり庵テラス', 3.6)).toBe('るり庵');
      expect(determinePlotType('るり庵Ⅱ', 1.8)).toBe('るり庵');
      expect(determinePlotType('墳墓', 3.6)).toBe('墳墓');
    });

    it('納骨堂・桜系を正しく判定すること', () => {
      expect(determinePlotType('納骨堂-天空', 3.6)).toBe('納骨堂');
      expect(determinePlotType('納骨堂-阿弥陀', 3.6)).toBe('納骨堂');
      expect(determinePlotType('桜シェア葬C', 0.6)).toBe('桜');
      expect(determinePlotType('千年桜', 0.6)).toBe('桜');
    });

    it('特別区を正しく判定すること', () => {
      expect(determinePlotType('憩', 3.6)).toBe('特別区');
      expect(determinePlotType('恵', 1.8)).toBe('特別区');
    });

    it('「想」はるり庵として分類されること', () => {
      expect(determinePlotType('想', 3.6)).toBe('るり庵');
      expect(determinePlotType('想', 1.8)).toBe('るり庵');
    });

    it('通常区画は自由タイプを返すこと', () => {
      expect(determinePlotType('A', 3.6)).toBe('自由');
      expect(determinePlotType('B', 1.8)).toBe('自由');
      expect(determinePlotType('10', 3.6)).toBe('自由');
      expect(determinePlotType('凛B', 3.6)).toBe('自由');
      expect(determinePlotType('つながり', 3.6)).toBe('自由');
    });
  });

  describe('resolvePeriod', () => {
    const map = new Map<string, string>([
      ['A', '第1期'],
      ['凛B', '第4期'],
    ]);

    it('マスタにある区画名はその期に解決すること', () => {
      expect(resolvePeriod('A', map)).toBe('第1期');
      expect(resolvePeriod('凛B', map)).toBe('第4期');
    });

    it('area_name 自体が期名ならそのまま採用すること（手動作成区画）', () => {
      expect(resolvePeriod('第1期', map)).toBe('第1期');
      expect(resolvePeriod('第3期樹林部', map)).toBe('第3期樹林部');
    });

    it('マスタにも期名にも無い区画は「その他」に解決すること', () => {
      expect(resolvePeriod('1-99999999', map)).toBe('その他');
      expect(resolvePeriod('unknown', map)).toBe('その他');
    });
  });

  describe('areaNamesForPeriod', () => {
    const map = new Map<string, string>([
      ['A', '第1期'],
      ['吉相', '第1期'],
      ['10', '第3期'],
      ['樹林', '第3期樹林部'],
    ]);

    it('指定した期の区画名と、期名そのものを返すこと', () => {
      const result = areaNamesForPeriod('第1期', map);
      expect(result.kind).toBe('include');
      if (result.kind === 'include') {
        expect(result.names.sort()).toEqual(['A', '吉相', '第1期'].sort());
      }
    });

    it('その他はマスタと期名に無い区画だけを残す除外リストになること', () => {
      const result = areaNamesForPeriod('その他', map);
      expect(result.kind).toBe('exclude');
      if (result.kind === 'exclude') {
        expect(result.names).toEqual(
          expect.arrayContaining(['A', '吉相', '10', '樹林', '第1期', '第4期'])
        );
        expect(result.names).not.toContain('unknown');
      }
    });
  });

  describe('loadSectionPeriodMap', () => {
    it('is_active な区画名マスタを name→period の Map で返すこと', async () => {
      const prisma = buildMockPrisma();
      const result = await loadSectionPeriodMap(prisma);

      expect(prisma.sectionNameMaster.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { is_active: true } })
      );
      expect(result.get('A')).toBe('第1期');
      expect(result.get('凛B')).toBe('第4期');
      expect(result.get('納骨堂-天空')).toBe('第4期');
    });
  });

  describe('getOverallSummary', () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = { physicalPlot: { findMany: jest.fn() } };
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('全体サマリーを正しく計算すること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          plot_number: 'A-1',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          plot_number: 'A-2',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
        {
          id: 'plot-3',
          plot_number: 'A-3',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
      ]);

      const result = await getOverallSummary(mockPrisma);

      expect(result.totalCount).toBe(3);
      expect(result.usedCount).toBe(2); // 1 sold_out + 0.5 partially_sold = 1.5 → Math.round → 2
      expect(result.remainingCount).toBe(1); // 3 - 2 = 1
      expect(result.usedCount + result.remainingCount).toBe(result.totalCount);
      expect(result.totalAreaSqm).toBe(10.8);
      expect(result.usageRate).toBeCloseTo(50, 0);
      expect(result.lastUpdated).toBeDefined();
    });

    it('按分による丸めが発生してもusedCount + remainingCount === totalCountを満たすこと', async () => {
      const plots = [
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `sold-${i}`,
          plot_number: `A-${i}`,
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        })),
        {
          id: 'partial',
          plot_number: 'A-50',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: `available-${i}`,
          plot_number: `A-${100 + i}`,
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        })),
      ];
      mockPrisma.physicalPlot.findMany.mockResolvedValue(plots);

      const result = await getOverallSummary(mockPrisma);

      expect(result.totalCount).toBe(100);
      expect(result.usedCount).toBe(51);
      expect(result.remainingCount).toBe(49);
      expect(result.usedCount + result.remainingCount).toBe(result.totalCount);
    });

    it('区画が存在しない場合、0を返すこと', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([]);

      const result = await getOverallSummary(mockPrisma);

      expect(result.totalCount).toBe(0);
      expect(result.usedCount).toBe(0);
      expect(result.remainingCount).toBe(0);
      expect(result.usageRate).toBe(0);
    });

    it('在庫集計クエリが active 契約のみを対象にすること (#209)', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([]);

      await getOverallSummary(mockPrisma);

      expect(mockPrisma.physicalPlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            contractPlots: expect.objectContaining({
              where: { deleted_at: null, contract_status: 'active' },
            }),
          },
        })
      );
    });

    it('契約面積が物理面積を超えても残数・残面積が負にならないこと (#205)', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          plot_number: 'A-1',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 7.2 } }],
        },
      ]);

      const result = await getOverallSummary(mockPrisma);

      expect(result.usedCount).toBe(1);
      expect(result.remainingCount).toBe(0);
      expect(result.remainingAreaSqm).toBe(0);
    });
  });

  describe('getPeriodSummaries', () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = buildMockPrisma();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('全期のサマリーを取得できること（area_name が期名の手動区画）', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: '第1期',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: '第2期',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma);

      expect(result).toHaveLength(5);
      expect(result[0].period).toBe('第1期');
      expect(result[0].totalCount).toBe(1);
      expect(result[0].remainingCount).toBe(1);
      expect(result[1].period).toBe('第2期');
      expect(result[1].usedCount).toBe(1);
    });

    it('区画名マスタ経由で期に集計されること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'p1',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
        {
          id: 'p2',
          area_name: '凛B', // → 第4期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'p3',
          area_name: '1', // → 第2期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma);

      expect(result).toHaveLength(5);
      const p1 = result.find((r) => r.period === '第1期')!;
      const p2 = result.find((r) => r.period === '第2期')!;
      const p4 = result.find((r) => r.period === '第4期')!;
      expect(p1.totalCount).toBe(1);
      expect(p1.usedCount).toBe(1);
      expect(p2.totalCount).toBe(1);
      expect(p4.totalCount).toBe(1);
      expect(p4.remainingCount).toBe(1);
    });

    it('マスタにも期名にも無い区画は「その他」に集計され、合計が全体と一致すること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'p1',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'junk',
          area_name: '1-99999999', // マスタ未登録 → その他
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma);

      // 標準5期 + その他
      expect(result).toHaveLength(6);
      const other = result.find((r) => r.period === 'その他')!;
      expect(other).toBeDefined();
      expect(other.totalCount).toBe(1);

      const sum = result.reduce((acc, r) => acc + r.totalCount, 0);
      expect(sum).toBe(2); // 全区画が漏れなく計上される
    });

    it('未分類が0件のときは「その他」を出さないこと', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'p1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma);

      expect(result).toHaveLength(5);
      expect(result.find((r) => r.period === 'その他')).toBeUndefined();
    });

    it('特定の期のみのサマリーを取得できること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
        {
          id: 'plot-2',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma, '第1期');

      expect(result).toHaveLength(1);
      expect(result[0].period).toBe('第1期');
      expect(result[0].totalCount).toBe(2);
      expect(result[0].usedCount).toBe(1);
      expect(result[0].remainingCount).toBe(1);
      expect(result[0].usageRate).toBe(50);
    });

    it('按分による丸めが発生してもusedCount + remainingCount === totalCountを満たすこと', async () => {
      const plots = [
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `sold-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        })),
        {
          id: 'partial',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: `available-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        })),
      ];
      mockPrisma.physicalPlot.findMany.mockResolvedValue(plots);

      const result = await getPeriodSummaries(mockPrisma, '第1期');

      expect(result[0].totalCount).toBe(100);
      expect(result[0].usedCount).toBe(51);
      expect(result[0].remainingCount).toBe(49);
      expect(result[0].usedCount + result[0].remainingCount).toBe(result[0].totalCount);
    });

    it('契約面積が物理面積を超えても残数が負にならないこと (#205)', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 7.2 } }],
        },
      ]);

      const result = await getPeriodSummaries(mockPrisma, '第1期');

      expect(result[0].usedCount).toBe(1);
      expect(result[0].remainingCount).toBe(0);
    });
  });

  describe('getSectionInventory', () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = buildMockPrisma();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('セクション別集計を取得できること（section = area_name = 実区画名）', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
        {
          id: 'plot-3',
          area_name: 'B',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getSectionInventory(mockPrisma);

      const sectionA = result.items.find((i) => i.section === 'A');
      expect(sectionA).toBeDefined();
      expect(sectionA!.period).toBe('第1期');
      expect(sectionA!.totalCount).toBe(2);
      expect(sectionA!.usedCount).toBe(1);

      const sectionB = result.items.find((i) => i.section === 'B');
      expect(sectionB).toBeDefined();
      expect(sectionB!.totalCount).toBe(1);
      expect(sectionB!.remainingCount).toBe(1);
    });

    it('期でフィルタリングできること（マスタ経由で解決した期で絞る）', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: '1', // → 第2期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getSectionInventory(mockPrisma, { period: '第1期' });

      // 第1期のセクション(A)のみ
      expect(result.items).toHaveLength(1);
      expect(result.items[0].section).toBe('A');

      // area_name で DB 絞り込みしていないこと（期はアプリ側で解決）
      const callArg = mockPrisma.physicalPlot.findMany.mock.calls[0][0];
      expect(callArg.where).not.toHaveProperty('area_name');
    });

    it('検索フィルタが適用されること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: '吉相',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getSectionInventory(mockPrisma, { search: '吉相' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].section).toBe('吉相');
    });

    it('ソートが適用されること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'B',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
      ]);

      const resultAsc = await getSectionInventory(mockPrisma, {
        sortBy: 'usageRate',
        sortOrder: 'asc',
      });
      const resultDesc = await getSectionInventory(mockPrisma, {
        sortBy: 'usageRate',
        sortOrder: 'desc',
      });

      expect(resultAsc.items[0].usageRate).toBeLessThanOrEqual(
        resultAsc.items[resultAsc.items.length - 1].usageRate
      );
      expect(resultDesc.items[0].usageRate).toBeGreaterThanOrEqual(
        resultDesc.items[resultDesc.items.length - 1].usageRate
      );
    });

    it('ページネーションが適用されること', async () => {
      const plots = Array.from({ length: 30 }, (_, i) => ({
        id: `plot-${i}`,
        area_name: `区画${i}`, // 30 個の異なる区画名 = 30 セクション
        area_sqm: { toNumber: () => 3.6 },
        status: 'available',
        contractPlots: [],
      }));

      mockPrisma.physicalPlot.findMany.mockResolvedValue(plots);

      const result = await getSectionInventory(mockPrisma, { page: 1, limit: 10 });

      expect(result.items.length).toBeLessThanOrEqual(10);
      expect(result.total).toBeGreaterThan(10);
    });

    it('按分による丸めが発生してもusedCount + remainingCount === totalCountを満たすこと', async () => {
      const plots = [
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `sold-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        })),
        {
          id: 'partial',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: `available-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        })),
      ];
      mockPrisma.physicalPlot.findMany.mockResolvedValue(plots);

      const result = await getSectionInventory(mockPrisma);
      const sectionA = result.items.find((i) => i.section === 'A');

      expect(sectionA).toBeDefined();
      expect(sectionA!.totalCount).toBe(100);
      expect(sectionA!.usedCount).toBe(51);
      expect(sectionA!.remainingCount).toBe(49);
      expect(sectionA!.usedCount + sectionA!.remainingCount).toBe(sectionA!.totalCount);
    });

    it('契約面積が物理面積を超えても残数が負にならないこと (#205)', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 7.2 } }],
        },
      ]);

      const result = await getSectionInventory(mockPrisma);
      const sectionA = result.items.find((i) => i.section === 'A');

      expect(sectionA!.usedCount).toBe(1);
      expect(sectionA!.remainingCount).toBe(0);
    });
  });

  describe('getAreaInventory', () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = buildMockPrisma();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('面積別集計を取得できること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'A',
          area_sqm: { toNumber: () => 1.8 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
      ]);

      const result = await getAreaInventory(mockPrisma);

      const area36 = result.items.find((i) => i.areaSqm === 3.6);
      expect(area36).toBeDefined();
      expect(area36!.period).toBe('第1期');
      expect(area36!.remainingCount).toBe(1);

      const area18 = result.items.find((i) => i.areaSqm === 1.8);
      expect(area18).toBeDefined();
      expect(area18!.usedCount).toBe(1);
    });

    it('期でフィルタリングできること（マスタ経由で解決した期で絞る）', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A', // → 第1期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: '1', // → 第2期
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getAreaInventory(mockPrisma, { period: '第2期' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].period).toBe('第2期');

      const callArg = mockPrisma.physicalPlot.findMany.mock.calls[0][0];
      expect(callArg.where).not.toHaveProperty('area_name');
    });

    it('残面積が正しく計算されること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        },
      ]);

      const result = await getAreaInventory(mockPrisma);

      const area36 = result.items.find((i) => i.areaSqm === 3.6);
      expect(area36!.remainingAreaSqm).toBe(3.6); // 1区画分の残り
    });

    it('plotTypeが正しく設定されること', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: '吉相',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
        {
          id: 'plot-2',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        },
      ]);

      const result = await getAreaInventory(mockPrisma);

      const kissou = result.items.find((i) => i.plotType === '吉相');
      expect(kissou).toBeDefined();

      const jiyuu = result.items.find((i) => i.plotType === '自由');
      expect(jiyuu).toBeDefined();
    });

    it('按分による丸めが発生してもusedCount + remainingCount === totalCountを満たすこと', async () => {
      const plots = [
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `sold-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'sold_out',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 3.6 } }],
        })),
        {
          id: 'partial',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 1.8 } }],
        },
        ...Array.from({ length: 49 }, (_, i) => ({
          id: `available-${i}`,
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'available',
          contractPlots: [],
        })),
      ];
      mockPrisma.physicalPlot.findMany.mockResolvedValue(plots);

      const result = await getAreaInventory(mockPrisma);
      const item = result.items.find((i) => i.areaSqm === 3.6 && i.plotType === '自由');

      expect(item).toBeDefined();
      expect(item!.totalCount).toBe(100);
      expect(item!.usedCount).toBe(51);
      expect(item!.remainingCount).toBe(49);
      expect(item!.usedCount + item!.remainingCount).toBe(item!.totalCount);
    });

    it('契約面積が物理面積を超えても残数・残面積が負にならないこと (#205)', async () => {
      mockPrisma.physicalPlot.findMany.mockResolvedValue([
        {
          id: 'plot-1',
          area_name: 'A',
          area_sqm: { toNumber: () => 3.6 },
          status: 'partially_sold',
          contractPlots: [{ contract_area_sqm: { toNumber: () => 7.2 } }],
        },
      ]);

      const result = await getAreaInventory(mockPrisma);
      const item = result.items.find((i) => i.areaSqm === 3.6);

      expect(item!.usedCount).toBe(1);
      expect(item!.remainingCount).toBe(0);
      expect(item!.remainingAreaSqm).toBe(0);
    });
  });
});
