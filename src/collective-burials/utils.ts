import { PrismaClient, Prisma, CollectiveBurial } from '@prisma/client';
import { todayJstAsUtcDate, addYearsUtc } from '../utils/dateUtils';

/**
 * 起点日 + 有効期間で請求予定日を計算する（起点日の決定は {@link resolveCountdownBaseDate}）。
 *
 * 「埋葬上限到達日」を起点にする旧設計は廃止済み（#164、業務確認 2026-06-07）。
 * 埋葬者数に依存すると上限未到達の区画で請求予定日が永久に null になり請求が発火しないため。
 * 議事録 2026-07-21 §1 で最終納骨日起点が要望されたが、これは上限人数ではなく
 * 運用側が明示する is_final_burial で判定するので同じ問題は起きない。
 *
 * @param baseDate 起点日（最終納骨日 or 契約日。UTC 00:00 正規化済みの Date を渡すこと #214）
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
 * 合祀カウントダウンの起点日を解決する（議事録 2026-07-21 §1）。
 *
 * 最終納骨者（BuriedPerson.is_final_burial）の埋葬日があればそれを起点にする。
 * 最終納骨者が未確定、または埋葬日が未入力なら契約日起点（#164 の従来動作）へ
 * フォールバックする。フォールバックを残すのは、最終納骨者が確定しない区画で
 * 請求予定日が永久に null になり請求が発火しなくなるのを避けるため。
 *
 * @param contractDate 契約日（UTC 00:00 正規化済み）
 * @param finalBurialDate 最終納骨者の埋葬日（未確定なら null）
 */
export const resolveCountdownBaseDate = (
  contractDate: Date | null,
  finalBurialDate: Date | null
): Date | null => finalBurialDate ?? contractDate;

/**
 * 起点日と有効期間から請求予定日を導出する。
 *
 * 起点は「最終納骨者の埋葬日、無ければ契約日」（{@link resolveCountdownBaseDate}）。
 *
 * @param contractDate 契約日（未設定なら null → 起点が無ければ請求予定日も null。
 *   契約日が後から設定された時点で再計算する運用）
 * @param validityPeriodYears 有効期間（年単位）
 * @param finalBurialDate 最終納骨者の埋葬日。既定 null（＝契約日起点）で、
 *   最終納骨者を扱わない既存呼び出しの挙動を変えない
 */
export const resolveBillingScheduledDate = (
  contractDate: Date | null,
  validityPeriodYears: number,
  finalBurialDate: Date | null = null
): Date | null => {
  const baseDate = resolveCountdownBaseDate(contractDate, finalBurialDate);
  return baseDate ? calculateBillingScheduledDate(baseDate, validityPeriodYears) : null;
};

/**
 * 最終納骨者の埋葬日を取得する。
 *
 * 最終納骨者は1契約区画につき1人までに制限しているが、レガシー投入等で複数存在した場合は
 * 最も遅い埋葬日を採る（合祀は最後の納骨から数えるため、早い方を採ると前倒しになる）。
 *
 * @returns 最終納骨者が未確定、または埋葬日が未入力なら null
 */
export const findFinalBurialDate = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  contractPlotId: string
): Promise<Date | null> => {
  const finalBurial = await prisma.buriedPerson.findFirst({
    where: {
      contract_plot_id: contractPlotId,
      is_final_burial: true,
      deleted_at: null,
      burial_date: { not: null },
    },
    select: { burial_date: true },
    orderBy: { burial_date: 'desc' },
  });
  return finalBurial?.burial_date ?? null;
};

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
  // capacity_reached_date は埋葬状況の記録としてのみ管理し、請求予定日には使わない（#164）。
  // 議事録 2026-07-21 §1 のとおり「4人契約だが3人で終了」があるため、上限到達では
  // 最終納骨を判定できない。カウントダウンの起点は is_final_burial で確定させる。
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

  // 3.5. 請求予定日を「最終納骨者の埋葬日、無ければ契約日」起点で再計算する
  //      （議事録 2026-07-21 §1）。埋葬者の追加・削除・最終納骨者フラグの変更に追随させる。
  //
  //      再計算しない条件:
  //        - billing_scheduled_date_manual: 業務が予定日を手動指定した（例外運用 Q17）
  //        - billing_status !== pending: 既に請求済/支払済。発行済み請求の根拠日を
  //          後から動かすと突き合わせができなくなる
  if (
    !collectiveBurial.billing_scheduled_date_manual &&
    collectiveBurial.billing_status === 'pending'
  ) {
    const contractPlot = await prisma.contractPlot.findUnique({
      where: { id: plotId },
      select: { contract_date: true },
    });
    updateData.billing_scheduled_date = resolveBillingScheduledDate(
      contractPlot?.contract_date ?? null,
      collectiveBurial.validity_period_years,
      await findFinalBurialDate(prisma, plotId)
    );
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
