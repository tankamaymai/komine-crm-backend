import type { RowDataPacket } from 'mysql2/promise';

import { legacyQuery } from '../legacyDb';
import { cleanStr, normalizeGraveName, parseLegacyArea } from '../transforms';
import type { MigrationStep } from '../types';

interface BochiPhysicalRow extends RowDataPacket {
  grave_cd: number;
  chiku_cd: number | null;
  area_cd: number | null;
  grave_name_cd: string | null;
  map_id: number | null;
  note: string | null;
  m_area_name: string | null; // m_area.area_name（area_cd 経由の実区画名。#151）
  shiyouryou_menseki: string | null; // 使用料面積（実面積。システム確認 項目⑤）
  kanriryou_menseki: string | null; // 管理料面積（使用料面積が無い場合のフォールバック）
}

/**
 * m_bochi → PhysicalPlot
 *
 * 1 m_bochi 行 = 1 PhysicalPlot + 1 ContractPlot に分解する設計のため、
 * ここでは物理側のみ作成。grave_cd を一意の plot_number とする。
 *
 * area_name は m_bochi.area_cd → m_area.area_name（実区画名: 凛A/つながり/樹林/A〜V/数字 等）。
 * m_area に対応が無い区画（実測3件のみ）は旧形式 `chiku_cd-area_cd` にフォールバック。#151
 *
 * 異常値除外:
 *   - chiku_cd=0, area_cd=99999999 等は B-3 で発見済のテストデータ
 *   - 移行はするが notes に印を付ける（業務確認: そのまま移行）
 */
export const stepPhysicalPlot: MigrationStep = {
  name: 'physicalPlot',
  async run({ prisma, logger, idMaps, dryRun }) {
    const rows = await legacyQuery<BochiPhysicalRow>(
      `SELECT b.grave_cd, b.chiku_cd, b.area_cd, b.grave_name_cd, b.map_id, b.note,
              b.shiyouryou_menseki, b.kanriryou_menseki,
              a.area_name AS m_area_name
         FROM m_bochi b
         LEFT JOIN m_area a ON a.area_cd = b.area_cd
        WHERE b.del_flg = 0 OR b.del_flg IS NULL`
    );

    let inserted = 0;
    let skipped = 0;
    const seenPlotNumbers = new Set<string>();

    for (const row of rows) {
      const plotNumber = `legacy-${row.grave_cd}`;
      if (seenPlotNumbers.has(plotNumber)) {
        skipped++;
        continue;
      }
      seenPlotNumbers.add(plotNumber);

      // 区画名は m_area.area_name（実区画名）を優先。全角英数は半角化。
      // m_area に対応が無い区画は旧形式 chiku_cd-area_cd にフォールバック（実測3件のみ）。#151
      const areaName =
        normalizeGraveName(row.m_area_name) ??
        (row.chiku_cd != null && row.area_cd != null
          ? `${row.chiku_cd}-${row.area_cd}`
          : `unknown-${row.grave_cd}`);

      // 表示用区画番号（grave_name_cd 由来、例: "A-100"）。plot_number は
      // ユニーク制約・一括取込キーのため legacy-{grave_cd} を維持し、表示はこちら。#158
      const displayNumber = normalizeGraveName(row.grave_name_cd);

      // 物理区画の備考は m_bochi.note のみ。碑文(grave_mei)は契約備考(ContractPlot.notes)へ
      // 統合する（step05）。grave_name_cd は display_number 側で扱うため notes に入れない。
      const notes =
        [
          cleanStr(row.note),
          row.chiku_cd === 0 || row.area_cd === 99999999 ? '[test-data candidate]' : null,
        ]
          .filter(Boolean)
          .join('\n') || null;

      if (dryRun) {
        idMaps.physicalPlot.set(row.grave_cd, `dry-physical-${row.grave_cd}`);
        inserted++;
        continue;
      }

      // 冪等性: legacy_grave_cd が ContractPlot にあるが、PhysicalPlot 側にはない
      // → plot_number ユニーク制約で existing チェック
      const existing = await prisma.physicalPlot.findUnique({ where: { plot_number: plotNumber } });
      if (existing) {
        idMaps.physicalPlot.set(row.grave_cd, existing.id);
        skipped++;
        logger.debug({ grave_cd: row.grave_cd }, 'PhysicalPlot already exists');
        continue;
      }

      // 実面積はレガシーの使用料面積（無ければ管理料面積）から取得する。
      // 1 m_bochi = 1 PhysicalPlot + 1 ContractPlot の 1:1 分解のため物理面積＝契約面積。
      // どちらも数値化できない行のみ従来デフォルト 3.6 を維持（システム確認 項目⑤）。
      const areaSqm =
        parseLegacyArea(row.shiyouryou_menseki) ?? parseLegacyArea(row.kanriryou_menseki) ?? 3.6;

      const created = await prisma.physicalPlot.create({
        data: {
          plot_number: plotNumber,
          display_number: displayNumber,
          area_name: areaName,
          area_sqm: areaSqm,
          status: 'available', // ContractPlot 側で active があれば後で sold_out に更新
          map_id: row.map_id ?? null,
          notes,
        },
      });
      idMaps.physicalPlot.set(row.grave_cd, created.id);
      inserted++;
    }

    return { inserted, skipped, notes: { source_rows: rows.length } };
  },
};
