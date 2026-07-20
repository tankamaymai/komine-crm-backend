import type { Prisma } from '@prisma/client';
import type { RowDataPacket } from 'mysql2/promise';

import { legacyQuery } from '../legacyDb';
import { rebuildIdMap } from '../lib/id-map-loader';
import { assertIdMapsReady } from '../lib/invariants';
import { cleanStr, parseLegacyArea, parseLegacyDate } from '../transforms';
import type { MigrationStep } from '../types';

// 旧 sykbnn 区分コード → 新マスタ code（seedMasters.ts と一致させること）
//   計算区分 KBNNO=2026 (0=面積×単価 / 1=任意設定)
//   税区分   KBNNO=2027 (0=内税 / 1=外税)
//   請求区分 KBNNO=2028 (0=なし / 1=あり / 2=永代)
const CALC_TYPE_MAP: Record<number, string> = { 0: 'AREA', 1: 'FIXED' };
const TAX_TYPE_MAP: Record<number, string> = { 0: 'INCLUSIVE', 1: 'EXCLUSIVE' };
const BILLING_TYPE_MAP: Record<number, string> = { 0: 'NONE', 1: 'PRESENT', 2: 'PERPETUAL' };

// 旧int値をマスタ code に変換。対応表に無い値は誤 resolve 回避のため legacy- prefix で温存する。
function mapFeeCode(
  map: Record<number, string>,
  prefix: string,
  value: number | null | undefined
): string | null {
  if (value == null) return null;
  return map[value] ?? `legacy-${prefix}-${value}`;
}

// 支払方法(shiharai)は旧 sykbnn に対応 KBNNO が無く長らく意味未特定だったが、
// 業務確認（issue #108, 2026-06-08）で旧int値の意味が確定した:
//   0 = 銀行振込(BANK_TRANSFER) / 1 = 口座振替(ACCOUNT_TRANSFER) / 2 = 永代＝支払なし(null)
// payment_method_master と一致する code に remap する（seedMasters.ts 参照）。
const SHIHARAI_MAP: Record<number, string | null> = {
  0: 'BANK_TRANSFER',
  1: 'ACCOUNT_TRANSFER',
  2: null, // 永代（管理料のみ・定期支払なし）→ 支払方法ではないため null
};
export function mapShiharai(value: number | null | undefined): string | null {
  if (value == null) return null;
  // 対応表に無い想定外値のみ、誤変換を避けて legacy- prefix で温存する。
  return Object.prototype.hasOwnProperty.call(SHIHARAI_MAP, value)
    ? SHIHARAI_MAP[value]
    : `legacy-shiharai-${value}`;
}

interface BochiContractRow extends RowDataPacket {
  grave_cd: number;
  danka_cd: number | null;
  status: number | null;
  grave_kind: number | null;
  grave_kubun: number | null;
  grave_type: number | null;
  request_date: number | null;
  contract_start: number | null;
  contract_end: number | null;
  konryu_kigen: number | null;
  konryu_date: number | null;
  reserve_date: number | null;
  shiyouryou: number | null;
  shiyouryou_menseki: string | null;
  shiyouryou_tanka: number | null;
  shiyouryou_keisan: number | null;
  shiyouryou_zei: number | null;
  shiyouryou_shiharai: number | null;
  shiyouryou_seikyu: number | null;
  shiyouryou_seikyunen: number | null;
  shiyouryou_seikyutsuki: number | null;
  kanriryou: number | null;
  kanriryou_menseki: string | null;
  kanriryou_tanka: number | null;
  kanriryou_keisan: number | null;
  kanriryou_zei: number | null;
  kanriryou_shiharai: number | null;
  kanriryou_seikyu: number | null;
  kanriryou_seikyunen: number | null;
  kanriryou_seikyutsuki: number | null;
  kanriryou_last_sei_date: number | null;
  bosekiryou: number | null;
  boshi: string | null;
  houi_id: number | null;
  ichi_id: number | null;
  note: string | null;
  // t_danka からの JOIN 結果（承諾番号・承諾日）
  // m_bochi.danka_cd → t_danka.danka_cd で 1:1（同一 danka_cd が複数 m_bochi に紐づく場合も値は同一）
  auth_no: number | null;
  auth_date: number | null;
}

/**
 * status (m_bochi.status) → ContractStatus
 * 業務確認済 (2026-05-12):
 *   1 → active / 0 → vacant / NULL → 移行時除外
 */
function mapContractStatus(status: number | null): 'active' | 'vacant' | null {
  if (status === 1) return 'active';
  if (status === 0) return 'vacant';
  return null;
}

/**
 * m_bochi → ContractPlot + UsageFee + ManagementFee + GravestoneInfo
 *
 * 設計方針:
 *   - status=NULL の 106 件は移行時除外
 *   - grave_kind/kubun/type は整理せずそのまま保持
 *   - UsageFee/ManagementFee/GravestoneInfo は関連データがある時のみ作成（1:1 オプション）
 *   - PhysicalPlot.status は別途 sold_out に更新（active が紐付いた場合）
 */
export const stepContractPlot: MigrationStep = {
  name: 'contractPlot',
  dependsOn: ['physicalPlot'],
  async run({ prisma, logger, idMaps, dryRun }) {
    // dry-run でも resume 用に再構築（読み取り専用・冪等、full dry-run では no-op #224）
    await rebuildIdMap(prisma, idMaps, 'physicalPlot', logger);
    assertIdMapsReady('contractPlot', idMaps, ['physicalPlot']);

    const rows = await legacyQuery<BochiContractRow>(
      `SELECT b.grave_cd, b.danka_cd, b.status, b.grave_kind, b.grave_kubun, b.grave_type,
              b.request_date, b.contract_start, b.contract_end, b.konryu_kigen, b.konryu_date, b.reserve_date,
              b.shiyouryou, b.shiyouryou_menseki, b.shiyouryou_tanka, b.shiyouryou_keisan, b.shiyouryou_zei,
              b.shiyouryou_shiharai, b.shiyouryou_seikyu, b.shiyouryou_seikyunen, b.shiyouryou_seikyutsuki,
              b.kanriryou, b.kanriryou_menseki, b.kanriryou_tanka, b.kanriryou_keisan, b.kanriryou_zei,
              b.kanriryou_shiharai, b.kanriryou_seikyu, b.kanriryou_seikyunen, b.kanriryou_seikyutsuki,
              b.kanriryou_last_sei_date,
              b.bosekiryou, b.boshi, b.houi_id, b.ichi_id, b.note,
              d.auth_no, d.auth_date
         FROM m_bochi b
         LEFT JOIN t_danka d ON d.danka_cd = b.danka_cd AND (d.del_flg = 0 OR d.del_flg IS NULL)
        WHERE b.del_flg = 0 OR b.del_flg IS NULL`
    );

    let inserted = 0;
    let skipped = 0;
    let usageFeeInserted = 0;
    let managementFeeInserted = 0;
    let gravestoneInserted = 0;
    const physicalPlotsToMarkSold = new Set<string>();

    for (const row of rows) {
      const contractStatus = mapContractStatus(row.status);
      if (contractStatus === null) {
        skipped++; // status=NULL は除外
        continue;
      }

      const physicalPlotId = idMaps.physicalPlot.get(row.grave_cd);
      if (!physicalPlotId) {
        logger.warn({ grave_cd: row.grave_cd }, 'No physical plot mapped, skipping contract');
        skipped++;
        continue;
      }

      if (dryRun) {
        idMaps.contractPlot.set(row.grave_cd, `dry-contract-${row.grave_cd}`);
        inserted++;
        if (row.shiyouryou) usageFeeInserted++;
        if (row.kanriryou) managementFeeInserted++;
        // 実挿入条件（下記 GravestoneInfo.create のガード）と一致させる（#326）
        if (
          row.boshi ||
          row.houi_id != null ||
          row.ichi_id != null ||
          row.bosekiryou != null ||
          row.konryu_kigen != null ||
          row.konryu_date != null
        )
          gravestoneInserted++;
        continue;
      }

      // 冪等性チェック
      const existing = await prisma.contractPlot.findFirst({
        where: { legacy_grave_cd: row.grave_cd, deleted_at: null },
      });
      if (existing) {
        idMaps.contractPlot.set(row.grave_cd, existing.id);
        skipped++;
        continue;
      }

      // 業務確認（komine-docs#10 Q4/Q5）: 許可日＝開始年月日＝「入金完了しシステム入力した日」で
      // 三者は同義。レガシーに専用列は無く、契約日(contract_start)を代理値とする（建立期限/建立日は
      // GravestoneInfo へ別途格納済み #326）。新規入力分はスタッフが必要に応じ調整する。
      const contractDate = parseLegacyDate(row.contract_start);

      // 契約面積はレガシーの使用料面積（無ければ管理料面積）から取得。
      // どちらも数値化できない行のみ従来デフォルト 3.6（システム確認 項目⑤）。
      const contractAreaSqm =
        parseLegacyArea(row.shiyouryou_menseki) ?? parseLegacyArea(row.kanriryou_menseki) ?? 3.6;

      const data: Prisma.ContractPlotCreateInput = {
        physicalPlot: { connect: { id: physicalPlotId } },
        contract_area_sqm: contractAreaSqm,
        contract_status: contractStatus,
        payment_status: 'unpaid', // Step 10 (Billing) 後に再計算する余地あり
        grave_kind: row.grave_kind,
        grave_kubun: row.grave_kubun,
        grave_type: row.grave_type,
        legacy_grave_cd: row.grave_cd,
        contract_date: contractDate,
        price: row.shiyouryou ?? null,
        request_date: parseLegacyDate(row.request_date),
        reservation_date: parseLegacyDate(row.reserve_date),
        acceptance_number: row.auth_no != null ? String(row.auth_no) : null,
        acceptance_date: parseLegacyDate(row.auth_date),
        // 許可日/開始日＝契約日（上記コメント参照、komine-docs#10 Q4/Q5）
        permit_date: contractDate,
        start_date: contractDate,
        notes: cleanStr(row.note),
      };

      const contractPlot = await prisma.contractPlot.create({ data });
      idMaps.contractPlot.set(row.grave_cd, contractPlot.id);
      inserted++;

      if (contractStatus === 'active') {
        physicalPlotsToMarkSold.add(physicalPlotId);
      }

      // UsageFee（使用料関連のいずれかが入っていれば作成）
      if (
        row.shiyouryou !== null ||
        row.shiyouryou_menseki ||
        row.shiyouryou_tanka !== null ||
        row.shiyouryou_keisan !== null
      ) {
        await prisma.usageFee.create({
          data: {
            contract_plot_id: contractPlot.id,
            calculation_type: mapFeeCode(CALC_TYPE_MAP, 'keisan', row.shiyouryou_keisan),
            tax_type: mapFeeCode(TAX_TYPE_MAP, 'zei', row.shiyouryou_zei),
            billing_type: mapFeeCode(BILLING_TYPE_MAP, 'seikyu', row.shiyouryou_seikyu),
            billing_years: row.shiyouryou_seikyunen?.toString() ?? null,
            area: cleanStr(row.shiyouryou_menseki),
            unit_price: row.shiyouryou_tanka?.toString() ?? null,
            usage_fee: row.shiyouryou?.toString() ?? null,
            payment_method: mapShiharai(row.shiyouryou_shiharai),
          },
        });
        usageFeeInserted++;
      }

      // ManagementFee
      if (
        row.kanriryou !== null ||
        row.kanriryou_menseki ||
        row.kanriryou_tanka !== null ||
        row.kanriryou_keisan !== null
      ) {
        await prisma.managementFee.create({
          data: {
            contract_plot_id: contractPlot.id,
            calculation_type: mapFeeCode(CALC_TYPE_MAP, 'keisan', row.kanriryou_keisan),
            tax_type: mapFeeCode(TAX_TYPE_MAP, 'zei', row.kanriryou_zei),
            billing_type: mapFeeCode(BILLING_TYPE_MAP, 'seikyu', row.kanriryou_seikyu),
            billing_years: row.kanriryou_seikyunen?.toString() ?? null,
            area: cleanStr(row.kanriryou_menseki),
            billing_month: row.kanriryou_seikyutsuki?.toString() ?? null,
            management_fee: row.kanriryou?.toString() ?? null,
            unit_price: row.kanriryou_tanka?.toString() ?? null,
            last_billing_month: row.kanriryou_last_sei_date?.toString() ?? null,
            payment_method: mapShiharai(row.kanriryou_shiharai),
          },
        });
        managementFeeInserted++;
      }

      // GravestoneInfo（boshi/houi_id/ichi_id/bosekiryou/konryu_kigen/konryu_date のどれかがあれば作成）
      // 建立期限(konryu_kigen)/建立日(konryu_date) は establishment_deadline/establishment_date が正しい器（#326）。
      if (
        row.boshi ||
        row.houi_id != null ||
        row.ichi_id != null ||
        row.bosekiryou != null ||
        row.konryu_kigen != null ||
        row.konryu_date != null
      ) {
        await prisma.gravestoneInfo.create({
          data: {
            contract_plot_id: contractPlot.id,
            gravestone_inscription: cleanStr(row.boshi),
            // 0 は「未設定」センチネル（方位マスタ code=1〜8 / 位置 code=1〜3、0 は無い）。
            // 0 を残すと UI で「旧コード: 0」が露出するため null に正規化する（#333）。
            direction_id: row.houi_id || null,
            position_id: row.ichi_id || null,
            gravestone_cost: row.bosekiryou ?? null,
            establishment_deadline: parseLegacyDate(row.konryu_kigen),
            establishment_date: parseLegacyDate(row.konryu_date),
          },
        });
        gravestoneInserted++;
      }
    }

    // 完売した PhysicalPlot は sold_out に更新
    if (!dryRun) {
      for (const id of physicalPlotsToMarkSold) {
        await prisma.physicalPlot.update({
          where: { id },
          data: { status: 'sold_out' },
        });
      }
    }

    return {
      inserted,
      skipped,
      notes: {
        source_rows: rows.length,
        usage_fee_inserted: usageFeeInserted,
        management_fee_inserted: managementFeeInserted,
        gravestone_inserted: gravestoneInserted,
        physical_plots_marked_sold: physicalPlotsToMarkSold.size,
      },
    };
  },
};
