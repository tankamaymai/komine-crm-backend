/**
 * 空き区画一覧サービス（議事録 2026-07-21 §6）
 *
 * 空き判定は在庫系（getPlotInventory / validateContractArea）と同じ active 限定基準（#209）。
 * ここがズレると「一覧では空きなのに登録すると面積超過で弾かれる」状態になる。
 */
import { PrismaClient } from '@prisma/client';

import { getVacantPlots } from '../../../src/plots/services/vacantPlotService';

type MockPrisma = { physicalPlot: { findMany: jest.Mock } };

const buildPrisma = (): MockPrisma => ({ physicalPlot: { findMany: jest.fn() } });
const asPrisma = (mock: MockPrisma) => mock as unknown as PrismaClient;

/** 物理区画1件ぶんのモック行 */
function plot(
  id: string,
  areaSqm: number,
  activeAreas: number[],
  overrides: Partial<{ areaName: string; plotNumber: string; displayNumber: string | null }> = {}
) {
  return {
    id,
    plot_number: overrides.plotNumber ?? `legacy-${id}`,
    display_number: overrides.displayNumber === undefined ? id : overrides.displayNumber,
    area_name: overrides.areaName ?? 'A',
    area_sqm: areaSqm,
    contractPlots: activeAreas.map((area) => ({ contract_area_sqm: area })),
  };
}

describe('getVacantPlots', () => {
  it('空き面積が残っている区画を返す', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot('A-1', 3.6, [])]);

    const { items, total } = await getVacantPlots(asPrisma(prisma));

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: 'A-1',
      displayNumber: 'A-1',
      areaSqm: 3.6,
      availableAreaSqm: 3.6,
    });
  });

  it('完売区画は返さない', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot('A-1', 3.6, [3.6])]);

    const { items, total } = await getVacantPlots(asPrisma(prisma));

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('一部販売済みは残り面積を空きとして返す', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot('A-1', 3.6, [1.8])]);

    const { items } = await getVacantPlots(asPrisma(prisma));

    expect(items[0]?.availableAreaSqm).toBe(1.8);
  });

  // vacant の器契約・terminated は DB 側の include で除外される。
  // include 条件が active 限定であること自体を固定する（#209 の基準ズレ防止）
  it('割当済み面積は active 契約のみで算定する', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([]);

    await getVacantPlots(asPrisma(prisma));

    const arg = prisma.physicalPlot.findMany.mock.calls[0][0];
    expect(arg.include.contractPlots.where).toEqual({
      deleted_at: null,
      contract_status: 'active',
    });
  });

  // 3.6 - 1.2 - 2.4 は浮動小数で 0 にならず 4.4e-16 になる。丸めないと完売区画が空きに混じる
  it('浮動小数の誤差で完売区画を空きに混ぜない', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot('A-1', 3.6, [1.2, 2.4])]);

    const { items } = await getVacantPlots(asPrisma(prisma));

    expect(items).toHaveLength(0);
  });

  it('契約面積合計が総面積を超えても空きにしない', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot('A-1', 3.6, [3.6, 1.8])]);

    expect((await getVacantPlots(asPrisma(prisma))).items).toHaveLength(0);
  });

  it('区画名で DB 側から絞る', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([]);

    await getVacantPlots(asPrisma(prisma), { areaName: '凛B' });

    expect(prisma.physicalPlot.findMany.mock.calls[0][0].where).toMatchObject({
      deleted_at: null,
      area_name: '凛B',
    });
  });

  it('区画番号は表示番号と内部番号の両方を部分一致で探す', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([]);

    await getVacantPlots(asPrisma(prisma), { search: '56' });

    expect(prisma.physicalPlot.findMany.mock.calls[0][0].where.OR).toEqual([
      { display_number: { contains: '56', mode: 'insensitive' } },
      { plot_number: { contains: '56', mode: 'insensitive' } },
    ]);
  });

  it('区画名→表示番号の順に並べる', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot('B-2', 3.6, [], { areaName: 'B', displayNumber: 'B-2' }),
      plot('A-2', 3.6, [], { areaName: 'A', displayNumber: 'A-2' }),
      plot('A-1', 3.6, [], { areaName: 'A', displayNumber: 'A-1' }),
    ]);

    const { items } = await getVacantPlots(asPrisma(prisma));

    expect(items.map((i) => i.displayNumber)).toEqual(['A-1', 'A-2', 'B-2']);
  });

  it('表示番号が未設定なら内部番号で並べる', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot('x', 3.6, [], { displayNumber: null, plotNumber: 'legacy-2' }),
      plot('y', 3.6, [], { displayNumber: null, plotNumber: 'legacy-1' }),
    ]);

    const { items } = await getVacantPlots(asPrisma(prisma));

    expect(items.map((i) => i.plotNumber)).toEqual(['legacy-1', 'legacy-2']);
  });

  // 空き判定は取得後に行うため、ページングも取得後になる（total は空き件数）
  it('空き件数に対してページングする', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot('A-1', 3.6, []),
      plot('A-2', 3.6, [3.6]), // 完売なので total に数えない
      plot('A-3', 3.6, []),
      plot('A-4', 3.6, []),
    ]);

    const { items, total } = await getVacantPlots(asPrisma(prisma), { page: 2, limit: 2 });

    expect(total).toBe(3);
    expect(items.map((i) => i.displayNumber)).toEqual(['A-4']);
  });

  it('Decimal 型（toString を持つ値）でも数値として扱える', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      {
        id: 'A-1',
        plot_number: 'A-1',
        display_number: 'A-1',
        area_name: 'A',
        area_sqm: { toString: () => '3.6' },
        contractPlots: [{ contract_area_sqm: { toString: () => '1.8' } }],
      },
    ]);

    const { items } = await getVacantPlots(asPrisma(prisma));

    expect(items[0]?.availableAreaSqm).toBe(1.8);
  });
});
