/// <reference types="node" />
/**
 * 分割販売区画の独自表記のリストアップ（議事録 2026-07-21 §4）
 *
 * 業務要望: 「Kの八の四分の三」や「二分の一」を「/2」と書くなど独自ルールで
 * 入力されているため、システムが面積を自動計算できない。開発側が対象をリストアップし、
 * 運用担当が手作業で訂正する。あわせて「できるだけ手がかからない方法」の要望に応え、
 * 表記を機械的に分解して区画数・持分を出す。
 *
 * ## 判断材料の出し方（重要）
 *
 * 想定面積を「持分合計 × 3.6㎡」のような固定の基準面積で出してはいけない。
 * 基準面積は区画種別でまったく違い（納骨堂は0.09㎡、樹木葬は面積を測らない＝0。
 * いずれも議事録で正しいデータと確認済み）、固定値だと正常データに巨大な差分が付いて
 * 作業リストの上位を汚す。
 *
 * 代わりに記録値だけから導ける「1区画あたりの面積 = 契約面積 ÷ 持分合計」を出す。
 * 運用側は「1区画あたり3.6なら通常区画として妥当」「0.09なら納骨堂として妥当」と
 * 即断できる。面積の正解は区画内訳Excelが正なので**自動訂正はしない**。
 *
 * 優先すべきは持分表記（"/2" や "N分のM"）を含む行。分母が示す基準面積が分からないと
 * 計算できないのはこちらで、単純な複数区画まとめ（"1・7・13・20"）は基準面積が
 * 決まれば計算できる。
 *
 * 使い方:
 *   npm run list:split-plot-notation                       # 持分表記のある行のみ
 *   npm run list:split-plot-notation -- --all              # 複数区画まとめも含める
 *   npm run list:split-plot-notation -- --out ~/list.csv   # 出力先を指定
 */
import 'dotenv/config';

import { prisma } from '../src/db/prisma';
import { parseLegacyArea } from './legacy-migration/transforms';
import { resolveOutPath, writeCsvFile } from './lib/csv';
import { describeShares, parseSplitPlotNotation } from './lib/splitPlotNotation';

/**
 * 契約面積を持分合計で割り、1区画あたりの面積を出す。
 *
 * 基準面積を決め打ちせず記録値から導くための計算。持分合計が0や不明なら null。
 */
export function calculateAreaPerPlot(
  contractAreaSqm: number,
  totalShare: number | null
): number | null {
  if (totalShare === null || totalShare <= 0) return null;
  return Math.round((contractAreaSqm / totalShare) * 1000) / 1000;
}

const HEADERS = [
  '要確認',
  '区画番号(表示)',
  '区画番号(内部)',
  '区画名',
  '契約者',
  '契約状態',
  'まとめ区画数',
  '持分の内訳',
  '持分合計(区画分)',
  '契約面積(記録値)',
  '1区画あたり面積',
  '使用料面積(記録値)',
  '管理料面積(記録値)',
  '契約区画ID',
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const includeWholeGroupings = argv.includes('--all');
  const outPath = resolveOutPath(argv, 'split-plot-notation.csv');
  console.log(`[list split-plot-notation] start (--all=${includeWholeGroupings})`);

  const contracts = await prisma.contractPlot.findMany({
    where: { deleted_at: null, physicalPlot: { display_number: { not: null } } },
    select: {
      id: true,
      contract_area_sqm: true,
      contract_status: true,
      physicalPlot: { select: { plot_number: true, display_number: true, area_name: true } },
      usageFee: { select: { area: true } },
      managementFee: { select: { area: true } },
      saleContractRoles: {
        where: { deleted_at: null, role: 'contractor' },
        select: { customer: { select: { name: true } } },
        take: 1,
      },
    },
  });

  const rows: unknown[][] = [];
  let fractionalCount = 0;
  let wholeGroupingCount = 0;

  for (const contract of contracts) {
    const displayNumber = contract.physicalPlot.display_number;
    const notation = parseSplitPlotNotation(displayNumber);
    if (!notation.isSplitNotation) continue;

    // 持分表記（"/2" や "N分のM"）を含むか。基準面積が分からないと計算できないのはこちら
    const hasFractionalShare = notation.tokens.some((token) => token.share !== 1);
    if (hasFractionalShare) fractionalCount++;
    else wholeGroupingCount++;

    if (!hasFractionalShare && !includeWholeGroupings) continue;

    const recordedSqm = Number(contract.contract_area_sqm);

    rows.push([
      hasFractionalShare ? '持分表記あり' : '複数区画まとめ',
      displayNumber,
      contract.physicalPlot.plot_number,
      contract.physicalPlot.area_name,
      contract.saleContractRoles[0]?.customer.name ?? '',
      contract.contract_status,
      notation.plotCount,
      describeShares(notation),
      notation.totalShare ?? '',
      recordedSqm,
      calculateAreaPerPlot(recordedSqm, notation.totalShare) ?? '',
      parseLegacyArea(contract.usageFee?.area ?? null) ?? contract.usageFee?.area ?? '',
      parseLegacyArea(contract.managementFee?.area ?? null) ?? contract.managementFee?.area ?? '',
      contract.id,
    ]);
  }

  // 持分表記ありを先頭に。その中は区画名→区画番号順で固めて手作業しやすくする
  rows.sort((a, b) => {
    const priorityA = a[0] === '持分表記あり' ? 0 : 1;
    const priorityB = b[0] === '持分表記あり' ? 0 : 1;
    return (
      priorityA - priorityB ||
      String(a[3]).localeCompare(String(b[3])) ||
      String(a[1]).localeCompare(String(b[1]))
    );
  });

  const written = writeCsvFile(outPath, HEADERS, rows);
  console.log(
    `[list split-plot-notation] 契約区画=${contracts.length} ` +
      `持分表記あり=${fractionalCount} 複数区画まとめ=${wholeGroupingCount} 出力=${rows.length}`
  );
  console.log(`[list split-plot-notation] 出力: ${written}`);
  if (!includeWholeGroupings && wholeGroupingCount > 0) {
    console.log(
      `[list split-plot-notation] 複数区画まとめ ${wholeGroupingCount} 件は既定で除外。` +
        '含めるには --all を付けてください'
    );
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[list split-plot-notation] failed:', error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
