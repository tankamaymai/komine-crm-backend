/**
 * 月次報告（区画残数）帳票の集計。
 *
 * 期待値は原本 Excel（komine-docs/区画exleファイル/令和8年度6月.xlsx
 * シート「6月末区画残数」）の配置に照らして決めている。
 */
import { PrismaClient } from '@prisma/client';

import {
  getMonthlyReport,
  resolveFiscalYear,
  fiscalYearStart,
} from '../../../src/plots/services/monthlyReportService';
import {
  MONTHLY_REPORT_BLOCKS,
  buildLayoutIndex,
  findRow,
  sqmKey,
} from '../../../src/plots/services/monthlyReportLayout';

type MockPrisma = {
  physicalPlot: { findMany: jest.Mock };
  contractPlot: { count: jest.Mock };
};

const buildPrisma = (): MockPrisma => ({
  physicalPlot: { findMany: jest.fn().mockResolvedValue([]) },
  contractPlot: { count: jest.fn().mockResolvedValue(0) },
});
const asPrisma = (mock: MockPrisma) => mock as unknown as PrismaClient;

/** 物理区画1件。既定は「契約あり = 使用済み」。 */
function plot(overrides: {
  areaName: string;
  areaSqm?: number;
  status?: string;
  contractAreas?: number[];
}) {
  const areaSqm = overrides.areaSqm ?? 3.6;
  return {
    area_name: overrides.areaName,
    area_sqm: areaSqm,
    status: overrides.status ?? 'sold_out',
    contractPlots: (overrides.contractAreas ?? [areaSqm]).map((a) => ({ contract_area_sqm: a })),
  };
}

/** 空き区画（契約なし）。 */
const vacant = (areaName: string, areaSqm = 3.6) =>
  plot({ areaName, areaSqm, status: 'available', contractAreas: [] });

type Report = Awaited<ReturnType<typeof getMonthlyReport>>;

const findBlock = (report: Report, period: string) =>
  report.blocks.find((b) => b.period === period)!;

const findRowByLabel = (block: { rows: { label: string }[] }, label: string) =>
  block.rows.find((r) => r.label === label)!;

describe('レイアウト定義', () => {
  it('原本 Excel の5ブロックを左から順に持つ', () => {
    expect(MONTHLY_REPORT_BLOCKS.map((b) => b.period)).toEqual([
      '第1期',
      '第2期',
      '第3期',
      '第3期樹林部',
      '第4期',
    ]);
  });

  it('第1期の行順が原本どおり（吉相はCとDの間）', () => {
    const first = MONTHLY_REPORT_BLOCKS.find((b) => b.period === '第1期')!;
    expect(first.rows.map((r) => r.label)).toEqual([
      'Ａ',
      'Ｂ',
      'Ｃ',
      '吉相',
      'Ｄ',
      'Ｅ',
      'Ｆ',
      'Ｇ',
      'Ｈ',
      'Ｉ',
      'Ｊ',
      'Ｋ',
      'Ｌ',
      'Ｍ',
      'Ｎ',
      'Ｏ',
      'Ｐ',
    ]);
  });

  it('吉相行は 吉相 と 吉相C の両方を集約する（吉相テラスは含めない）', () => {
    const index = buildLayoutIndex();
    const kisso = findRow(index, '吉相', 3.6);
    expect(kisso).not.toBeNull();
    expect(findRow(index, '吉相C', 3.6)).toBe(kisso);
    expect(findRow(index, '吉相テラス', 0.17)).toBeNull();
  });

  it('つながり は㎡ごとに別の行へ振り分ける', () => {
    const index = buildLayoutIndex();
    const r15 = findRow(index, 'つながり', 1.5);
    const r24 = findRow(index, 'つながり', 2.4);
    expect(r15).not.toBeNull();
    expect(r24).not.toBeNull();
    expect(r15).not.toBe(r24);
  });

  it('つながり の定義外の㎡は名前行に混ざらず、その他へ回る', () => {
    const index = buildLayoutIndex();
    // 実データに存在する 0㎡ / 3.6㎡ / 10㎡ は帳票に行がない
    expect(findRow(index, 'つながり', 0)).toBeNull();
    expect(findRow(index, 'つながり', 3.6)).toBeNull();
    expect(findRow(index, 'つながり', 10)).toBeNull();
  });

  it('Decimal 由来の "3.000" と 3 を同じ㎡行として扱う', () => {
    expect(sqmKey(3)).toBe(sqmKey(3.0));
    const index = buildLayoutIndex();
    expect(findRow(index, 'つながり', 3.0)).toBe(findRow(index, 'つながり', 3));
  });
});

describe('会計年度（6月開始・5月決算）', () => {
  it('6月〜12月はその年の年度', () => {
    expect(resolveFiscalYear(new Date('2026-06-01T00:00:00Z'))).toBe(2026);
    expect(resolveFiscalYear(new Date('2026-12-31T00:00:00Z'))).toBe(2026);
  });

  it('1月〜5月は前年の年度', () => {
    expect(resolveFiscalYear(new Date('2026-01-01T00:00:00Z'))).toBe(2025);
    expect(resolveFiscalYear(new Date('2026-05-31T00:00:00Z'))).toBe(2025);
  });

  it('年度開始日はその年度の6月1日', () => {
    expect(fiscalYearStart(2026).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('getMonthlyReport', () => {
  it('区画名そのままの行に集計する', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: 'A' }),
      plot({ areaName: 'A' }),
      vacant('A'),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const rowA = findRowByLabel(findBlock(report, '第1期'), 'Ａ');

    expect(rowA).toEqual({ label: 'Ａ', totalCount: 3, usedCount: 2, remainingCount: 1 });
  });

  it('吉相 と 吉相C を1行にまとめる', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: '吉相' }),
      plot({ areaName: '吉相C' }),
      vacant('吉相C'),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const kisso = findRowByLabel(findBlock(report, '第1期'), '吉相');

    expect(kisso).toEqual({ label: '吉相', totalCount: 3, usedCount: 2, remainingCount: 1 });
  });

  it('つながり を㎡別の行に振り分ける', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: 'つながり', areaSqm: 1.5 }),
      vacant('つながり', 1.5),
      plot({ areaName: 'つながり', areaSqm: 2.4 }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const block = findBlock(report, '第4期');

    expect(findRowByLabel(block, '1.5')).toMatchObject({ totalCount: 2, usedCount: 1 });
    expect(findRowByLabel(block, '2.4')).toMatchObject({ totalCount: 1, usedCount: 1 });
  });

  it('データが0件の行も枠として残す（区画の登録漏れに気づけるように）', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const block = findBlock(report, '第3期');

    expect(block.rows.map((r) => r.label)).toEqual(['10', '11']);
    expect(block.rows.every((r) => r.totalCount === 0)).toBe(true);
    expect(block.total).toEqual({
      label: '合計',
      totalCount: 0,
      usedCount: 0,
      remainingCount: 0,
    });
  });

  it('ブロックの合計行は行の合計になる', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: '10' }),
      plot({ areaName: '10' }),
      vacant('11'),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(findBlock(report, '第3期').total).toEqual({
      label: '合計',
      totalCount: 3,
      usedCount: 2,
      remainingCount: 1,
    });
  });

  it('レイアウト外の区画は その他 ブロックに件数降順で入る', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: '凛A' }),
      plot({ areaName: '凛B' }),
      plot({ areaName: '凛B' }),
      vacant('納骨堂-天空', 0.09),
      plot({ areaName: 'A' }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(report.otherBlock).not.toBeNull();
    expect(report.otherBlock!.rows.map((r) => r.label)).toEqual(['凛B', '凛A', '納骨堂-天空']);
    expect(report.otherBlock!.total).toMatchObject({ totalCount: 4, usedCount: 3 });
  });

  it('その他 に入る区画がなければ otherBlock は null', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([plot({ areaName: 'A' })]);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(report.otherBlock).toBeNull();
  });

  it('includeOther=false のときレイアウト外を落とし、総区画数からも外す', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: 'A' }),
      plot({ areaName: '凛A' }),
      plot({ areaName: '凛B' }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma), { includeOther: false });

    expect(report.otherBlock).toBeNull();
    expect(report.summary.totalCount).toBe(1);
  });

  it('総区画数・使用区画数・残区画数はブロック合計から導く', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: 'A' }),
      vacant('B'),
      plot({ areaName: '樹林', areaSqm: 0.6 }),
      plot({ areaName: '凛A' }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(report.summary.totalCount).toBe(4);
    expect(report.summary.usedCount).toBe(3);
    expect(report.summary.remainingCount).toBe(1);
    // 総区画数 = 使用区画数 + 残区画数 が必ず成り立つ（帳票の左下集計と同じ関係）
    expect(report.summary.usedCount + report.summary.remainingCount).toBe(
      report.summary.totalCount
    );
  });

  it('partially_sold は面積比で使用数に入り、区画数=使用数+残数 を保つ', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      // 3.6㎡ のうち 1.8㎡ 契約 → 0.5
      plot({ areaName: 'A', status: 'partially_sold', contractAreas: [1.8] }),
      plot({ areaName: 'A', status: 'partially_sold', contractAreas: [1.8] }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const rowA = findRowByLabel(findBlock(report, '第1期'), 'Ａ');

    expect(rowA.totalCount).toBe(2);
    expect(rowA.usedCount).toBe(1);
    expect(rowA.usedCount + rowA.remainingCount).toBe(rowA.totalCount);
  });

  it('契約面積が物理面積を超えても使用数は区画数を超えない（#205）', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      plot({ areaName: 'A', status: 'partially_sold', areaSqm: 3.6, contractAreas: [7.2] }),
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));
    const rowA = findRowByLabel(findBlock(report, '第1期'), 'Ａ');

    expect(rowA.usedCount).toBe(1);
    expect(rowA.remainingCount).toBe(0);
  });

  it('active 以外の契約区画は取得対象から外す（#209）', async () => {
    const prisma = buildPrisma();
    // vacant の器契約はサービスに届かない = 契約なしと同じ扱いになる
    prisma.physicalPlot.findMany.mockResolvedValue([vacant('A')]);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(prisma.physicalPlot.findMany.mock.calls[0][0].select.contractPlots.where).toEqual({
      deleted_at: null,
      contract_status: 'active',
    });
    expect(findRowByLabel(findBlock(report, '第1期'), 'Ａ').usedCount).toBe(0);
  });

  it('今年度販売区画数は年度開始日以降の active 契約を数える', async () => {
    const prisma = buildPrisma();
    prisma.contractPlot.count.mockResolvedValueOnce(12).mockResolvedValueOnce(3129);

    const report = await getMonthlyReport(asPrisma(prisma));

    expect(report.summary.soldThisFiscalYear).toBe(12);
    expect(report.summary.cumulativeSoldCount).toBe(3129);
    expect(prisma.contractPlot.count.mock.calls[0][0].where).toEqual({
      deleted_at: null,
      contract_status: 'active',
      contract_date: { gte: fiscalYearStart(report.summary.fiscalYear) },
    });
  });

  it('集計時点を asOfDate に入れる（過去月の再現はしない）', async () => {
    const prisma = buildPrisma();
    const before = Date.now();

    const report = await getMonthlyReport(asPrisma(prisma));

    const asOf = new Date(report.asOfDate).getTime();
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
  });

  it('面積未設定の区画は 3.6㎡ として扱う（inventoryService と同じ既定）', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      { area_name: 'つながり', area_sqm: null, status: 'available', contractPlots: [] },
    ]);

    const report = await getMonthlyReport(asPrisma(prisma));

    // つながり の 3.6㎡ は帳票に行がないので その他 へ
    expect(report.otherBlock!.rows.map((r) => r.label)).toEqual(['つながり']);
  });
});
