/// <reference types="node" />
/**
 * 使用料面積と管理料面積が食い違う契約のリストアップ（議事録 2026-07-21 §4）
 *
 * 業務要望: 「契約使用料面積」と「管理料面積」が異なるデータ（例: 1 と 1.8）が存在し、
 * 旧システム導入時の手入力ミスと推測される。開発側が対象をリストアップし、
 * 運用担当が手作業で訂正する。面積は護持費算出の根拠なので自動訂正はしない。
 *
 * 出力は Excel でそのまま作業リストにできる CSV。判断に必要な文脈
 * （区画名・契約者・契約状態・契約面積）を同じ行に載せる。
 *
 * 使い方:
 *   npm run list:area-mismatch                      # tmp/area-mismatch.csv へ出力
 *   npm run list:area-mismatch -- --out ~/list.csv  # 出力先を指定
 *
 * 注意: 差異があっても正しいデータの場合がある（議事録で確認済みの例）。
 *   - 納骨堂: 面積を測らない運用のため使用料面積0／管理料面積0.09 になる
 *   - 樹木葬: 面積を測定しないため0
 *   そのため「判断メモ」列にヒントを出し、機械的な削除・上書きはしない。
 */
import 'dotenv/config';

import { prisma } from '../src/db/prisma';
import { parseLegacyArea } from './legacy-migration/transforms';
import { resolveOutPath, writeCsvFile } from './lib/csv';

/** 議事録で「正しいデータ」と確認済みのパターンにヒントを付ける */
export function buildJudgementHint(
  areaName: string,
  usageArea: number,
  managementArea: number
): string {
  if (areaName.includes('納骨堂')) {
    return '納骨堂は面積を測らない運用（議事録で管理料面積0.09を確認済み）。正しい可能性が高い';
  }
  if (areaName === '樹林' || areaName === '樹木葬' || areaName.includes('桜')) {
    return '樹木葬系は面積を測定しない運用（議事録で確認済み）。正しい可能性が高い';
  }
  if (usageArea === 0 || managementArea === 0) {
    return '一方が0。面積を取らない契約形態か、入力漏れかの確認が必要';
  }
  return '';
}

const HEADERS = [
  '区画番号',
  '区画番号(内部)',
  '区画名',
  '契約者',
  '契約状態',
  '使用料面積(生値)',
  '管理料面積(生値)',
  '使用料面積',
  '管理料面積',
  '差(管理料-使用料)',
  '契約面積',
  '判断メモ',
  '契約区画ID',
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outPath = resolveOutPath(argv, 'area-mismatch.csv');
  console.log('[list area-mismatch] start');

  const contracts = await prisma.contractPlot.findMany({
    where: { deleted_at: null },
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
  let comparable = 0;
  let unparsable = 0;

  for (const contract of contracts) {
    const usageRaw = contract.usageFee?.area ?? null;
    const managementRaw = contract.managementFee?.area ?? null;
    // どちらか未入力なら「食い違い」ではないので対象外
    if (usageRaw === null || managementRaw === null) continue;
    comparable++;

    const usageArea = parseLegacyArea(usageRaw);
    const managementArea = parseLegacyArea(managementRaw);

    // 数値化できない表記は差異判定できないため、別途確認対象として同じCSVに出す
    if (usageArea === null || managementArea === null) {
      unparsable++;
      rows.push([
        contract.physicalPlot.display_number ?? '',
        contract.physicalPlot.plot_number,
        contract.physicalPlot.area_name,
        contract.saleContractRoles[0]?.customer.name ?? '',
        contract.contract_status,
        usageRaw,
        managementRaw,
        usageArea ?? '',
        managementArea ?? '',
        '',
        String(contract.contract_area_sqm),
        '数値として解釈できない表記。表記の確認が必要',
        contract.id,
      ]);
      continue;
    }

    if (usageArea === managementArea) continue;

    rows.push([
      contract.physicalPlot.display_number ?? '',
      contract.physicalPlot.plot_number,
      contract.physicalPlot.area_name,
      contract.saleContractRoles[0]?.customer.name ?? '',
      contract.contract_status,
      usageRaw,
      managementRaw,
      usageArea,
      managementArea,
      Math.round((managementArea - usageArea) * 1000) / 1000,
      String(contract.contract_area_sqm),
      buildJudgementHint(contract.physicalPlot.area_name, usageArea, managementArea),
      contract.id,
    ]);
  }

  // 区画名→区画番号の順で並べ、同じ区画のものが固まるようにする（手作業しやすさ優先）
  rows.sort(
    (a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0]))
  );

  const written = writeCsvFile(outPath, HEADERS, rows);
  console.log(
    `[list area-mismatch] 契約区画=${contracts.length} 両方入力あり=${comparable} ` +
      `差異=${rows.length - unparsable} 解析不能=${unparsable}`
  );
  console.log(`[list area-mismatch] 出力: ${written}`);
}

// テストから import した時は実行しない
if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[list area-mismatch] failed:', error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
