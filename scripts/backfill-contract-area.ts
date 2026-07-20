/// <reference types="node" />
/**
 * 既存データの契約面積・物理区画面積 backfill スクリプト（システム確認 項目⑤）
 *
 * レガシー移行時に contract_area_sqm / area_sqm が全件 3.6 固定で投入されていたため、
 * 既に新DBへ移行済みの面積文字列（usage_fees.area = 旧 shiyouryou_menseki、
 * management_fees.area = 旧 kanriryou_menseki）から実面積を復元して上書きする。
 *
 * - 対象はレガシー移行行（contract_plots.legacy_grave_cd IS NOT NULL）のみ。
 *   手入力で作成された新規区画には触れない。
 * - 使用料面積を優先し、無ければ管理料面積。どちらも数値化不能なら現状維持。
 * - 物理区画は「非削除の契約区画がちょうど1件」の場合のみ契約面積と同値に更新
 *   （分割販売された物理区画の総面積は自動判定できないため温存）。
 * - レガシーMySQL への接続は不要（新DBのみで完結）。
 *
 * 使い方:
 *   npm run backfill:contract-area -- --dry-run   # 更新せず件数だけ確認
 *   npm run backfill:contract-area                # 実投入
 *
 * 冪等: 既に実面積が入っている行は値が同じならスキップ（再実行安全）。
 */
import 'dotenv/config';

import { prisma } from '../src/db/prisma';
import { parseLegacyArea } from './legacy-migration/transforms';

const CONCURRENCY = 25;

interface ContractUpdate {
  id: string;
  physicalPlotId: string;
  from: string;
  to: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  console.log(`[backfill contract-area] start (dryRun=${dryRun})`);

  // レガシー移行された契約区画と面積文字列を一括取得
  const contracts = await prisma.contractPlot.findMany({
    where: { deleted_at: null, legacy_grave_cd: { not: null } },
    select: {
      id: true,
      physical_plot_id: true,
      contract_area_sqm: true,
      usageFee: { select: { area: true } },
      managementFee: { select: { area: true } },
    },
  });
  console.log(`対象 contract_plots（レガシー移行行）: ${contracts.length} 件`);

  let unresolvable = 0;
  let unchanged = 0;
  const updates: ContractUpdate[] = [];
  for (const cp of contracts) {
    const target = parseLegacyArea(cp.usageFee?.area) ?? parseLegacyArea(cp.managementFee?.area);
    if (target === null) {
      unresolvable++;
      continue;
    }
    if (Number(cp.contract_area_sqm) === target) {
      unchanged++;
      continue;
    }
    updates.push({
      id: cp.id,
      physicalPlotId: cp.physical_plot_id,
      from: cp.contract_area_sqm.toString(),
      to: target,
    });
  }

  // 物理区画: 非削除契約がちょうど1件のものだけ契約面積と同値へ
  const contractCountByPhysical = new Map<string, number>();
  for (const cp of contracts) {
    contractCountByPhysical.set(
      cp.physical_plot_id,
      (contractCountByPhysical.get(cp.physical_plot_id) ?? 0) + 1
    );
  }
  const physicalUpdates = updates
    .filter((u) => contractCountByPhysical.get(u.physicalPlotId) === 1)
    .map((u) => ({ id: u.physicalPlotId, to: u.to }));
  const physicalSkippedMulti = updates.length - physicalUpdates.length;

  if (!dryRun) {
    // Supabase pooler のインタラクティブ tx は 5s 制限が厳しいため、
    // 個別 update（各自コミット）を小チャンクで並列実行する（backfill-display-number と同方針）。
    let done = 0;
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const chunk = updates.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((u) =>
          prisma.contractPlot.update({
            where: { id: u.id },
            data: { contract_area_sqm: u.to },
          })
        )
      );
      done += chunk.length;
      if (done % 500 === 0 || done === updates.length) {
        console.log(`  contract_plots updated ${done}/${updates.length}`);
      }
    }
    let pdone = 0;
    for (let i = 0; i < physicalUpdates.length; i += CONCURRENCY) {
      const chunk = physicalUpdates.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((u) =>
          prisma.physicalPlot.update({
            where: { id: u.id },
            data: { area_sqm: u.to },
          })
        )
      );
      pdone += chunk.length;
      if (pdone % 500 === 0 || pdone === physicalUpdates.length) {
        console.log(`  physical_plots updated ${pdone}/${physicalUpdates.length}`);
      }
    }
  }

  // 新面積の分布（上位10）を確認用に出力
  const dist = new Map<number, number>();
  for (const u of updates) dist.set(u.to, (dist.get(u.to) ?? 0) + 1);
  const topDist = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([area, cnt]) => ({ area, cnt }));

  console.log(
    JSON.stringify(
      {
        dryRun,
        targets: contracts.length,
        contract_updates: updates.length,
        unchanged,
        unresolvable_area_string: unresolvable,
        physical_updates: physicalUpdates.length,
        physical_skipped_multi_contract: physicalSkippedMulti,
        new_area_distribution_top10: topDist,
        sample: updates.slice(0, 10).map((u) => `${u.from} -> ${u.to}`),
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error('ERROR', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
