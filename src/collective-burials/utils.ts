import { PrismaClient, Prisma, CollectiveBurial } from '@prisma/client';
import { todayJstAsUtcDate, addYearsUtc } from '../utils/dateUtils';

/**
 * 請求予定日を計算
 *
 * 起点は契約日（#164、業務確認 2026-06-07: 合祀は契約から一定年数後・年数はお墓のタイプで決まる。
 * 旧設計の「埋葬上限到達日」起点は廃止 — 埋葬者数に依存すると上限未到達の区画で
 * 請求予定日が永久に null になり請求が発火しない）。
 *
 * @param baseDate 起点日（契約日。UTC 00:00 正規化済みの Date を渡すこと #214）
 * @param validityPeriodYears 有効期間（年単位）
 * @returns 請求予定日（UTC 00:00 を維持）
 */
export const calculateBillingScheduledDate = (
  baseDate: Date,
  validityPeriodYears: number
): Date => {
  // setFullYear（ローカル時刻ベース）は JST 環境で @db.Date 保存時に
  // 前日へずれるため、UTC ベースで年加算する（#214）
  return addYearsUtc(baseDate, validityPeriodYears);
};

/**
 * 契約日と有効期間から請求予定日を導出する（#164: 契約日起点）
 *
 * @param contractDate 契約日（未設定なら null → 請求予定日も null。
 *   契約日が後から設定された時点で再計算する運用）
 * @param validityPeriodYears 有効期間（年単位）
 */
export const resolveBillingScheduledDate = (
  contractDate: Date | null,
  validityPeriodYears: number
): Date | null =>
  contractDate ? calculateBillingScheduledDate(contractDate, validityPeriodYears) : null;

/**
 * 合祀情報の埋葬人数と関連日付を自動更新
 * @param prisma Prismaクライアント（トランザクション対応）
 * @param plotId 区画ID
 * @returns 更新された合祀情報（存在しない場合はnull）
 */
export const updateCollectiveBurialCount = async (
  prisma: PrismaClient | Prisma.TransactionClient, // トランザクション内のprismaも受け入れる
  plotId: string
): Promise<CollectiveBurial | null> => {
  // 1. 合祀情報を取得
  const collectiveBurial = await prisma.collectiveBurial.findUnique({
    where: { contract_plot_id: plotId },
  });

  if (!collectiveBurial || collectiveBurial.deleted_at) {
    return null; // 合祀情報が存在しない場合は何もしない
  }

  // 2. 現在の埋葬人数を計算（論理削除されていないBuriedPersonのみカウント）
  const currentCount = await prisma.buriedPerson.count({
    where: {
      contract_plot_id: plotId,
      deleted_at: null,
    },
  });

  // 3. 上限到達判定と日付記録
  // 請求予定日は契約日起点（#164）のため埋葬数では変更しない。
  // capacity_reached_date は埋葬状況の記録としてのみ管理する。
  const capacityReached = currentCount >= collectiveBurial.burial_capacity;
  const wasCapacityReached = collectiveBurial.capacity_reached_date !== null;

  const updateData: Prisma.CollectiveBurialUpdateInput = {
    current_burial_count: currentCount,
  };

  if (capacityReached && !wasCapacityReached) {
    // 上限到達（初回）: 上限到達日を記録
    // @db.Date 列への保存のため JST 暦日を UTC 00:00 に正規化（#214）
    updateData.capacity_reached_date = todayJstAsUtcDate();
  } else if (!capacityReached && wasCapacityReached) {
    // 上限を下回った: 到達日をリセット
    updateData.capacity_reached_date = null;
  }

  // 4. 合祀情報を更新
  const updated = await prisma.collectiveBurial.update({
    where: { id: collectiveBurial.id },
    data: updateData,
  });

  return updated;
};

/**
 * 合祀情報の請求対象を取得
 * @param prisma Prismaクライアント
 * @returns 請求対象の合祀情報リスト
 */
export const getBillingTargets = async (prisma: PrismaClient) => {
  // billing_scheduled_date は @db.Date（UTC 00:00 として読まれる）のため、
  // 比較基準日も JST 暦日の UTC 00:00 に正規化して境界を一致させる（#214）
  const today = todayJstAsUtcDate();

  return await prisma.collectiveBurial.findMany({
    where: {
      billing_status: 'pending',
      billing_scheduled_date: {
        lte: today, // 請求予定日が今日以前
      },
      deleted_at: null,
      // 親契約が論理削除された孤児合祀（#358 以前の削除由来）を請求対象から除外する。
      // getCollectiveBurialList/ById（layer2 ガード #361）と同じ不変条件を請求バッチ経路にも揃え、
      // 削除済み契約の合祀が billed に遷移して「成功」レポートされるのを防ぐ。
      contractPlot: { is: { deleted_at: null } },
    },
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
};
