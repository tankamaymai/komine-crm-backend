/**
 * 空き区画の一覧取得（議事録 2026-07-21 §6）
 *
 * 業務要望: 新規顧客登録時の区画指定で、手入力による重複や存在しない区画の登録を
 * 防ぐため手入力を不可とし、空き区画のリストから選択させる。
 *
 * 空き判定は在庫系（getPlotInventory / validateContractArea）と同じ基準に揃える:
 *   空き面積 = 物理区画の総面積 − active 契約の契約面積合計
 * vacant の器契約（空き区画の表現方式）と terminated（解約済み）は割当に数えない（#209）。
 * ここがズレると「一覧では空きなのに登録すると面積超過で弾かれる」状態になる。
 */
import { PrismaClient, Prisma } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

/** 割当済み面積の算定対象。空き判定を在庫系と一致させるため active 限定（#209） */
const ACTIVE_CONTRACT_PLOTS_INCLUDE = {
  where: { deleted_at: null, contract_status: 'active' },
  select: { contract_area_sqm: true },
} as const;

export interface VacantPlotItem {
  id: string;
  /** ユニークキー。移行データは legacy-{grave_cd} のため表示には使わない */
  plotNumber: string;
  /** 表示用区画番号（レガシー grave_name_cd 由来）。未設定なら null */
  displayNumber: string | null;
  areaName: string;
  areaSqm: number;
  /** 空き面積。部分販売済みの区画は残り面積になる */
  availableAreaSqm: number;
}

export interface GetVacantPlotsOptions {
  /** 区画名（エリア）の完全一致。約2500件あるため画面側で必ず絞ってから使う想定 */
  areaName?: string;
  /** 区画番号の部分一致（display_number / plot_number） */
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * 空き面積が残っている物理区画を返す。
 *
 * 絞り込み（区画名・区画番号）は DB 側で行い、空き判定とページングは取得後に行う。
 * 空き面積は active 契約の合計に依存し SQL の WHERE では表現しづらいため、
 * 既存の在庫集計（inventoryService）と同じ方式に揃えた。区画名で絞れば
 * 最大でも数百件（実データ最大は凛B の 647件）に収まる。
 */
export async function getVacantPlots(
  prisma: DbClient,
  options: GetVacantPlotsOptions = {}
): Promise<{ items: VacantPlotItem[]; total: number }> {
  const { areaName, search, page = 1, limit = 50 } = options;

  const where: Prisma.PhysicalPlotWhereInput = { deleted_at: null };
  if (areaName) where.area_name = areaName;
  if (search) {
    where.OR = [
      { display_number: { contains: search, mode: 'insensitive' } },
      { plot_number: { contains: search, mode: 'insensitive' } },
    ];
  }

  const physicalPlots = await prisma.physicalPlot.findMany({
    where,
    include: { contractPlots: ACTIVE_CONTRACT_PLOTS_INCLUDE },
  });

  const vacant: VacantPlotItem[] = [];
  for (const plot of physicalPlots) {
    const areaSqm = Number(plot.area_sqm);
    const allocated = plot.contractPlots.reduce(
      (sum, contract) => sum + Number(contract.contract_area_sqm),
      0
    );
    // 面積は3桁小数まで扱う。浮動小数の誤差で 0 が 1e-15 等になり
    // 完売区画が空きとして出るのを防ぐため丸めてから判定する
    const availableAreaSqm = Math.round((areaSqm - allocated) * 1000) / 1000;
    if (availableAreaSqm <= 0) continue;

    vacant.push({
      id: plot.id,
      plotNumber: plot.plot_number,
      displayNumber: plot.display_number,
      areaName: plot.area_name,
      areaSqm,
      availableAreaSqm,
    });
  }

  // 区画名 → 表示番号の順。選択肢として人が探す順序に合わせる
  vacant.sort(
    (a, b) =>
      a.areaName.localeCompare(b.areaName) ||
      (a.displayNumber ?? a.plotNumber).localeCompare(b.displayNumber ?? b.plotNumber)
  );

  const start = (page - 1) * limit;
  return { items: vacant.slice(start, start + limit), total: vacant.length };
}
