/**
 * Excel「空き区画一覧」「販売数」の集計。
 * 期待する項目は komine-docs/区画exleファイル/令和8年度6月.xlsx の
 * 「6月末空き区画一覧」「今年度販売区画数」「年別販売区画数 (大友のみ)」。
 */
import { PrismaClient } from '@prisma/client';
import {
  buildSalesLedger,
  fiscalYearOfUtcDate,
  getSalesLedger,
  getVacantLedger,
  groupVacantLedger,
  matchesAgent,
  type SaleSource,
  type VacantSource,
} from '../../../src/plots/services/ledgerViewService';

describe('groupVacantLedger', () => {
  const map = new Map<string, string>([
    ['A', '第1期'],
    ['樹林', '第3期樹林部'],
    ['つながり', '第4期'],
  ]);

  const plot = (
    overrides: Partial<VacantSource> & Pick<VacantSource, 'id' | 'areaName'>
  ): VacantSource => ({
    plotNumber: 'legacy-1',
    displayNumber: 'A-36',
    areaSqm: 3.6,
    availableAreaSqm: 3.6,
    ...overrides,
  });

  it('番号と空いている㎡を期・区画名ごとに並べ、売り切れは出さない', () => {
    const data = groupVacantLedger(
      [
        plot({ id: '1', areaName: 'A', displayNumber: 'A-102', availableAreaSqm: 1.7 }),
        plot({ id: '2', areaName: 'A', displayNumber: 'A-36', availableAreaSqm: 3.6 }),
        plot({ id: '3', areaName: 'A', displayNumber: 'A-56', availableAreaSqm: 0 }),
        plot({ id: '4', areaName: '樹林', displayNumber: '樹林-1', availableAreaSqm: 0.6 }),
        plot({
          id: '5',
          areaName: '見知らぬ',
          displayNumber: 'X-1',
          plotNumber: 'legacy-9',
          availableAreaSqm: 1,
        }),
      ],
      map,
      '2026-09-27T00:00:00.000Z'
    );

    expect(data.total).toBe(4);
    expect(data.groups.map((group) => group.period)).toEqual([
      '第1期',
      '第2期',
      '第3期',
      '第3期樹林部',
      '第4期',
      'その他',
    ]);

    const first = data.groups.find((group) => group.period === '第1期')!;
    expect(first.count).toBe(2);
    expect(first.areas[0]?.plots.map((item) => [item.label, item.areaSqm])).toEqual([
      ['A-36', 3.6],
      ['A-102', 1.7],
    ]);

    const woods = data.groups.find((group) => group.period === '第3期樹林部')!;
    expect(woods.areas[0]?.plots[0]?.label).toBe('樹林-1');

    const other = data.groups.find((group) => group.period === 'その他')!;
    expect(other.areas[0]?.plots[0]?.label).toBe('X-1');

    const fourth = data.groups.find((group) => group.period === '第4期')!;
    expect(fourth.count).toBe(0);
  });

  it('表示用番号が空なら内部番号を出す', () => {
    const data = groupVacantLedger(
      [plot({ id: '1', areaName: 'A', displayNumber: '  ', plotNumber: 'A-1' })],
      map,
      '2026-09-27T00:00:00.000Z'
    );
    const first = data.groups.find((group) => group.period === '第1期')!;
    expect(first.areas[0]?.plots[0]?.label).toBe('A-1');
  });
});

describe('buildSalesLedger', () => {
  const now = new Date('2026-09-15T00:00:00.000Z');

  const sale = (
    overrides: Partial<SaleSource> & Pick<SaleSource, 'contractDate' | 'areaName'>
  ): SaleSource => ({
    areaSqm: 0.6,
    agentName: '石の大友',
    ...overrides,
  });

  it('6月はじまりで月の件数と、そこまでの合計を出す', () => {
    expect(fiscalYearOfUtcDate(now)).toBe(2026);
    const data = buildSalesLedger(
      [
        sale({ contractDate: new Date('2026-06-10T00:00:00.000Z'), areaName: '樹林' }),
        sale({ contractDate: new Date('2026-06-20T00:00:00.000Z'), areaName: '想', areaSqm: 0.45 }),
        sale({ contractDate: new Date('2026-07-01T00:00:00.000Z'), areaName: '樹林' }),
        sale({ contractDate: new Date('2025-06-01T00:00:00.000Z'), areaName: '憩', areaSqm: 0.2 }),
      ],
      { now }
    );

    const current = data.fiscalYears[0]!;
    expect(current.fiscalYear).toBe(2026);
    expect(current.months.map((month) => month.month)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5,
    ]);
    expect(current.months[0]).toEqual({ month: 6, count: 2, cumulative: 2 });
    expect(current.months[1]).toEqual({ month: 7, count: 1, cumulative: 3 });
    expect(current.total).toBe(3);

    const previous = data.fiscalYears[1]!;
    expect(previous.fiscalYear).toBe(2025);
    expect(previous.months[0]).toEqual({ month: 6, count: 1, cumulative: 1 });
  });

  it('種類別は暦年の月ごとに区画名・件数・㎡を出す', () => {
    const data = buildSalesLedger(
      [
        sale({
          contractDate: new Date('2026-01-05T00:00:00.000Z'),
          areaName: '樹林',
          areaSqm: 0.6,
        }),
        sale({
          contractDate: new Date('2026-01-20T00:00:00.000Z'),
          areaName: '樹林',
          areaSqm: 0.6,
        }),
        sale({ contractDate: new Date('2026-01-20T00:00:00.000Z'), areaName: '想', areaSqm: 0.45 }),
        sale({
          contractDate: new Date('2025-02-01T00:00:00.000Z'),
          areaName: 'るり庵テラス',
          areaSqm: 1,
        }),
      ],
      { now }
    );

    const year2026 = data.typeSales[0]!;
    expect(year2026.year).toBe(2026);
    expect(year2026.months).toEqual([
      {
        month: 1,
        rows: [
          { areaName: '樹林', count: 2, areaSqm: 1.2 },
          { areaName: '想', count: 1, areaSqm: 0.45 },
        ],
      },
    ]);
    expect(year2026.totalCount).toBe(3);
    expect(year2026.totalAreaSqm).toBe(1.65);

    expect(data.typeSales[1]?.months[0]?.rows[0]?.areaName).toBe('るり庵テラス');
  });

  it('取扱に「大友」が含まれる契約だけ数え、名前の一覧は全体から出す', () => {
    const data = buildSalesLedger(
      [
        sale({
          contractDate: new Date('2026-06-01T00:00:00.000Z'),
          areaName: '樹林',
          agentName: '石の大友',
        }),
        sale({
          contractDate: new Date('2026-06-02T00:00:00.000Z'),
          areaName: '樹林',
          agentName: '別の石材店',
        }),
      ],
      { now, agent: '大友' }
    );

    expect(data.agentFilter).toBe('大友');
    expect(data.agentNames).toEqual(['石の大友', '別の石材店']);
    expect(data.fiscalYears[0]?.total).toBe(1);
    expect(matchesAgent(null, '大友')).toBe(false);
    expect(matchesAgent('石の大友', '  ')).toBe(true);
  });
});

describe('getVacantLedger / getSalesLedger', () => {
  it('契約で埋まった区画は空き一覧に出さず、一部売りは残り㎡だけ出す', async () => {
    const prisma = {
      sectionNameMaster: {
        findMany: jest.fn().mockResolvedValue([{ name: 'A', period: '第1期' }]),
      },
      physicalPlot: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'full',
            plot_number: 'legacy-1',
            display_number: 'A-1',
            area_name: 'A',
            area_sqm: 3.6,
            contractPlots: [{ contract_area_sqm: 3.6 }],
          },
          {
            id: 'part',
            plot_number: 'legacy-2',
            display_number: 'A-2',
            area_name: 'A',
            area_sqm: 3.6,
            contractPlots: [{ contract_area_sqm: 2.7 }],
          },
        ]),
      },
    };

    const data = await getVacantLedger(prisma as unknown as PrismaClient);
    const first = data.groups.find((group) => group.period === '第1期')!;
    expect(first.areas[0]?.plots).toEqual([{ id: 'part', label: 'A-2', areaSqm: 0.9 }]);
  });

  it('空きの器契約は販売数に数えず、解約済みでも契約日があれば数える', async () => {
    const prisma = {
      contractPlot: {
        findMany: jest.fn().mockResolvedValue([
          {
            contract_date: new Date('2026-06-01T00:00:00.000Z'),
            contract_area_sqm: 0.6,
            agent_name: '石の大友',
            physicalPlot: { area_name: '樹林', deleted_at: null },
          },
        ]),
      },
    };

    const data = await getSalesLedger(prisma as unknown as PrismaClient, {
      now: new Date('2026-09-15T00:00:00.000Z'),
      agent: '大友',
    });
    expect(prisma.contractPlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contract_status: { not: 'vacant' },
          contract_date: { not: null },
        }),
      })
    );
    expect(data.fiscalYears[0]?.total).toBe(1);
    expect(data.typeSales[0]?.totalAreaSqm).toBe(0.6);
  });
});
