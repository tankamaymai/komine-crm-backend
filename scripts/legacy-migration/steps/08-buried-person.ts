import type { RowDataPacket } from 'mysql2/promise';

import { legacyQuery } from '../legacyDb';
import { rebuildIdMap } from '../lib/id-map-loader';
import { assertIdMapsReady } from '../lib/invariants';
import { loadRelationshipNameMap, resolveRelationship } from '../lib/relationship-resolver';
import { cleanStr, joinName, parseGender, parseLegacyDate } from '../transforms';
import type { MigrationStep } from '../types';

interface MaisouRow extends RowDataPacket {
  maisou_cd: number;
  danka_cd: number | null;
  grave_cd: number | null;
  kaimyou: string | null; // 戒名
  kaimyou_kana: string | null;
  birthday: number | null;
  meinichi: number | null; // 命日
  kyounen: number | null; // 享年
  maisousha_sei: string | null;
  maisousha_sei_kana: string | null;
  maisousha_mei: string | null;
  maisousha_mei_kana: string | null;
  sex_flg: number | null;
  siboubasyo: string | null; // 死亡場所
  siin: string | null; // 死因
  shuuha: number | null; // 宗派
  request_day: number | null; // 届出日
  moshu_sei: string | null;
  moshu_mei: string | null;
  moshu_zokugara: number | null;
  maisou_date: number | null; // 埋葬日
  note: string | null;
}

/**
 * t_maisou → BuriedPerson
 *
 * - 命日 75% / 生年月日 81% 空 → そのまま空で移行（業務確認 Q6）
 * - chief_mourner_name は moshu_sei + moshu_mei を結合
 * - shuuha (int) → religion (string) は単純な int→string 変換
 */
export const stepBuriedPerson: MigrationStep = {
  name: 'buriedPerson',
  dependsOn: ['contractPlot'],
  async run({ prisma, logger, idMaps, dryRun }) {
    // dry-run でも resume 用に再構築（読み取り専用・冪等、full dry-run では no-op）
    await rebuildIdMap(prisma, idMaps, 'contractPlot', logger);
    assertIdMapsReady('buriedPerson', idMaps, ['contractPlot']);

    // 喪主続柄（moshu_zokugara）を続柄マスタ名へ解決するための対応表（#394）。
    // family_contacts と同じ resolver を共有し、生int/未解決センチネルの露出を防ぐ。
    const relationshipNameMap = await loadRelationshipNameMap(prisma);

    const rows = await legacyQuery<MaisouRow>(
      `SELECT maisou_cd, danka_cd, grave_cd, kaimyou, kaimyou_kana,
              birthday, meinichi, kyounen,
              maisousha_sei, maisousha_sei_kana, maisousha_mei, maisousha_mei_kana,
              sex_flg, siboubasyo, siin, shuuha, request_day,
              moshu_sei, moshu_mei, moshu_zokugara, maisou_date, note
         FROM t_maisou WHERE del_flg = 0 OR del_flg IS NULL`
    );

    let inserted = 0;
    let skipped = 0;
    let skipExisting = 0;
    let skipMissingName = 0;
    let skipNoGraveCd = 0;
    let skipContractPlotNotMapped = 0;

    for (const row of rows) {
      const name = joinName(row.maisousha_sei, row.maisousha_mei) ?? cleanStr(row.kaimyou);
      if (!name) {
        skipped++;
        skipMissingName++;
        continue;
      }

      const contractPlotId =
        row.grave_cd != null ? idMaps.contractPlot.get(row.grave_cd) : undefined;
      if (!contractPlotId) {
        logger.debug(
          { maisou_cd: row.maisou_cd, grave_cd: row.grave_cd },
          'No contract plot mapped'
        );
        skipped++;
        if (row.grave_cd == null) skipNoGraveCd++;
        else skipContractPlotNotMapped++;
        continue;
      }

      if (dryRun) {
        inserted++;
        continue;
      }

      // 冪等性（#220）: 再実行時は legacy_maisou_cd で既存をスキップ
      const existing = await prisma.buriedPerson.findUnique({
        where: { legacy_maisou_cd: row.maisou_cd },
      });
      if (existing) {
        skipped++;
        skipExisting++;
        continue;
      }

      await prisma.buriedPerson.create({
        data: {
          contract_plot_id: contractPlotId,
          legacy_maisou_cd: row.maisou_cd,
          name,
          name_kana: joinName(row.maisousha_sei_kana, row.maisousha_mei_kana),
          birth_date: parseLegacyDate(row.birthday),
          death_date: parseLegacyDate(row.meinichi),
          age: row.kyounen ?? null,
          gender: parseGender(row.sex_flg),
          burial_date: parseLegacyDate(row.maisou_date),
          posthumous_name: cleanStr(row.kaimyou),
          report_date: parseLegacyDate(row.request_day),
          // 宗派マスタは不要確定（業務確認済）。レガシー shuuha int は解決先が無く、
          // `legacy-shuuha-N` センチネルをそのまま入れると UI に露出する（#333）。
          // shuuha=0 は「未設定」。解決先が無いため全件 null 保存にする。
          religion: null,
          death_place: cleanStr(row.siboubasyo),
          cause_of_death: cleanStr(row.siin),
          chief_mourner_name: joinName(row.moshu_sei, row.moshu_mei),
          // 続柄マスタ名へ解決（#394）。未解決/null は resolveRelationship が空文字を返すため
          // `|| null` で nullable 列の「未設定」を null に統一する（旧 legacy-zokugara-* センチネル廃止）。
          chief_mourner_relationship:
            resolveRelationship(
              row.moshu_zokugara != null ? String(row.moshu_zokugara) : '',
              relationshipNameMap
            ) || null,
          notes: cleanStr(row.note),
        },
      });
      inserted++;
    }

    return {
      inserted,
      skipped,
      notes: {
        source_rows: rows.length,
        skip_missing_name: skipMissingName,
        skip_no_grave_cd: skipNoGraveCd,
        skip_existing: skipExisting,
        skip_contract_plot_not_mapped: skipContractPlotNotMapped,
      },
    };
  },
};
