/**
 * 契約区画一覧取得コントローラー
 * GET /api/v1/plots
 *
 * サーバーサイド検索・ページネーション対応
 */

import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db/prisma';

interface PlotSearchQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: 'available' | 'partially_sold' | 'sold_out';
  cemeteryType?: string;
  paymentStatus?: 'unpaid' | 'partial_paid' | 'paid' | 'overdue' | 'refunded';
  contractStatus?: 'active' | 'terminated';
  sortBy?:
    | 'plotNumber'
    | 'customerName'
    | 'contractDate'
    | 'paymentStatus'
    | 'managementFee'
    | 'createdAt';
  sortOrder?: 'asc' | 'desc';
  nameKanaPrefix?: string;
  graveKind?: number;
  graveKubun?: number;
  graveType?: number;
}

/**
 * B10: 年度別請求 status サマリ
 *
 * 旧画面01 の「受付済 / 09年 / 10年 …」を一覧では 1 列に集約する（サマリ列方式）。
 * 集計対象は管理料 (management_fee) Billing。各 Billing の対象年度は
 * `use_end_year ?? use_start_year` で判定する。
 *
 * - latestYear / latestYearStatus: 最も新しい対象年度を持つ Billing の年度と status
 * - unpaidYearCount: 未納（billed / partial_paid / overdue）の Billing 件数
 *   （pending=請求前、paid/terminated/written_off は未納に含めない）
 */
const UNPAID_BILLING_STATUSES = new Set(['billed', 'partial_paid', 'overdue']);

interface BillingForSummary {
  use_start_year: number | null;
  use_end_year: number | null;
  status: string;
}

interface BillingSummaryResult {
  hasBilling: boolean;
  latestYear: number | null;
  latestYearStatus: string | null;
  unpaidYearCount: number;
}

export const buildBillingSummary = (
  billings: BillingForSummary[] | undefined | null
): BillingSummaryResult => {
  if (!billings || billings.length === 0) {
    return { hasBilling: false, latestYear: null, latestYearStatus: null, unpaidYearCount: 0 };
  }

  let latestYear: number | null = null;
  let latestYearStatus: string | null = null;
  let unpaidYearCount = 0;

  for (const billing of billings) {
    const year = billing.use_end_year ?? billing.use_start_year ?? null;
    if (year !== null && (latestYear === null || year > latestYear)) {
      latestYear = year;
      latestYearStatus = billing.status;
    }
    if (UNPAID_BILLING_STATUSES.has(billing.status)) {
      unpaidYearCount += 1;
    }
  }

  return { hasBilling: true, latestYear, latestYearStatus, unpaidYearCount };
};

/**
 * 契約区画一覧取得（ContractPlot中心）
 * サーバーサイド検索・ページネーション対応
 */
export const getPlots = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      cemeteryType,
      paymentStatus,
      contractStatus,
      sortBy,
      sortOrder = 'asc',
      nameKanaPrefix,
      graveKind,
      graveKubun,
      graveType,
    } = req.query as unknown as PlotSearchQuery;

    // ページネーション計算
    const skip = (page - 1) * limit;
    const take = limit;

    // 検索条件の構築
    // 台帳問い合わせ（/plots）には契約のない空き区画（contract_status='vacant'）を表示しない。
    // 空き区画は区画残数管理（/plot-availability, inventory系）にのみ表示する（#167）。
    // active / terminated は過去・現在の契約がある区画のため従来どおり一覧へ含める。
    const whereCondition: Prisma.ContractPlotWhereInput = {
      deleted_at: null,
      contract_status: { not: 'vacant' },
    };

    // フリーテキスト検索（区画番号、顧客名、顧客名カナ、電話番号、住所）
    if (search) {
      whereCondition.OR = [
        {
          physicalPlot: {
            plot_number: { contains: search, mode: 'insensitive' },
          },
        },
        {
          physicalPlot: {
            display_number: { contains: search, mode: 'insensitive' },
          },
        },
        {
          saleContractRoles: {
            some: {
              deleted_at: null,
              customer: {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { name_kana: { contains: search, mode: 'insensitive' } },
                  { phone_number: { contains: search } },
                  { address: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
        {
          buriedPersons: {
            some: {
              deleted_at: null,
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { name_kana: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }

    // ステータスフィルター
    if (status) {
      whereCondition.physicalPlot = {
        ...((whereCondition.physicalPlot as object) || {}),
        status,
      };
    }

    // 墓地タイプフィルター
    if (cemeteryType) {
      whereCondition.physicalPlot = {
        ...((whereCondition.physicalPlot as object) || {}),
        area_name: { contains: cemeteryType, mode: 'insensitive' },
      };
    }

    // 入金ステータスフィルター
    if (paymentStatus) {
      whereCondition.payment_status = paymentStatus;
    }

    // 契約ステータスフィルター（#200）
    // スキーマで active / terminated に限定済みのため、既定の vacant 除外と矛盾しない
    if (contractStatus) {
      whereCondition.contract_status = contractStatus;
    }

    // 区分フィルター（grave_kind / grave_kubun / grave_type）
    if (graveKind !== undefined) {
      whereCondition.grave_kind = graveKind;
    }
    if (graveKubun !== undefined) {
      whereCondition.grave_kubun = graveKubun;
    }
    if (graveType !== undefined) {
      whereCondition.grave_type = graveType;
    }

    // フリガナ先頭文字フィルター（あいうえおタブ用）
    if (nameKanaPrefix) {
      // カタカナの行範囲マッピング
      const kanaRanges: Record<string, [string, string]> = {
        ア: ['ア', 'オ'],
        カ: ['カ', 'コ'],
        サ: ['サ', 'ソ'],
        タ: ['タ', 'ト'],
        ナ: ['ナ', 'ノ'],
        ハ: ['ハ', 'ホ'],
        マ: ['マ', 'モ'],
        ヤ: ['ヤ', 'ヨ'],
        ラ: ['ラ', 'ロ'],
        ワ: ['ワ', 'ン'],
      };
      const range = kanaRanges[nameKanaPrefix];
      if (range) {
        whereCondition.saleContractRoles = {
          some: {
            deleted_at: null,
            customer: {
              name_kana: { gte: range[0], lte: range[1] + '\uffff' },
            },
          },
        };
      }
    }

    // ソート条件の構築
    let orderByCondition:
      | Prisma.ContractPlotOrderByWithRelationInput
      | Prisma.ContractPlotOrderByWithRelationInput[];
    switch (sortBy) {
      case 'plotNumber':
        // 区画番号ソートは画面に表示している display_number（#158）を基準にする。
        // 移行 plot_number は `legacy-{grave_cd}` 文字列で表示順と乖離するため、
        // display_number 優先 → plot_number フォールバック → id の複合 orderBy にする。
        // display_number 未設定（本番 6255 件中 1 件のみ）は nulls:'last' で末尾固定し、
        // 同値時の安定性のため id を最終キーに付与してページ跨ぎ順序を固定する（#388）。
        orderByCondition = [
          { physicalPlot: { display_number: { sort: sortOrder, nulls: 'last' } } },
          { physicalPlot: { plot_number: sortOrder } },
          { id: 'asc' },
        ];
        break;
      case 'contractDate':
        orderByCondition = { contract_date: sortOrder };
        break;
      case 'paymentStatus':
        orderByCondition = { payment_status: sortOrder };
        break;
      case 'managementFee':
        orderByCondition = { managementFee: { management_fee: sortOrder } };
        break;
      case 'createdAt':
        orderByCondition = { created_at: sortOrder };
        break;
      default:
        orderByCondition = { created_at: 'desc' };
    }

    // 一覧表示用の include（通常ソート・契約者名ソート共通）
    const listInclude = {
      physicalPlot: {
        select: {
          plot_number: true,
          display_number: true,
          area_name: true,
          area_sqm: true,
          status: true,
        },
      },
      saleContractRoles: {
        where: { deleted_at: null },
        // 表示名の contractor 選択を snapshot（syncPrimaryContractorNameKana）の
        // 「最初の有効な contractor ロール（created_at asc, id asc）」と同一順序に
        // 揃える（#303）。orderBy 無しだと DB 返却順が任意のため、同一区画に
        // contractor ロールが複数ある場合にソートキーのカナと表示名が別人になる。
        orderBy: [{ created_at: 'asc' as const }, { id: 'asc' as const }],
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              name_kana: true,
              phone_number: true,
              address: true,
              notes: true,
            },
          },
        },
      },
      buriedPersons: {
        where: { deleted_at: null },
        select: {
          name: true,
          name_kana: true,
        },
      },
      managementFee: true,
      // B10: 年度別請求 status サマリ用。管理料 Billing のみ集計対象
      billings: {
        where: { category: 'management_fee', deleted_at: null },
        select: {
          use_start_year: true,
          use_end_year: true,
          status: true,
        },
      },
    } satisfies Prisma.ContractPlotInclude;

    let total: number;
    let contractPlots: Prisma.ContractPlotGetPayload<{ include: typeof listInclude }>[];

    if (sortBy === 'customerName') {
      // 契約者名ソート（#216 → #282）
      // 旧実装は whereCondition 一致の全件 id + 契約者カナをロードしアプリ側で
      // 五十音ソートしており、数千区画ではページ送りの度にデータセット全体を
      // メモリ展開していた。ロール・顧客の書込み経路で同期するスナップショット列
      // primary_contractor_name_kana への orderBy + skip/take で DB 側ページングに置換。
      // 契約者なし（null）は昇順・降順問わず末尾固定（旧実装と同挙動）。
      // ※並び順は Intl.Collator('ja') から DB 照合順（カナはコードポイント順 ≒ 五十音順）に変わる。
      [total, contractPlots] = await Promise.all([
        prisma.contractPlot.count({ where: whereCondition }),
        prisma.contractPlot.findMany({
          where: whereCondition,
          skip,
          take,
          orderBy: [
            {
              primary_contractor_name_kana: {
                sort: sortOrder === 'desc' ? 'desc' : 'asc',
                nulls: 'last',
              },
            },
            // 同カナ・契約者なし同士のページ跨ぎ順序を安定化
            { id: 'asc' },
          ],
          include: listInclude,
        }),
      ]);
    } else {
      // 総件数とデータを並列で取得
      [total, contractPlots] = await Promise.all([
        prisma.contractPlot.count({ where: whereCondition }),
        prisma.contractPlot.findMany({
          where: whereCondition,
          skip,
          take,
          include: listInclude,
          orderBy: orderByCondition,
        }),
      ]);
    }

    const plotList = contractPlots.map((contractPlot) => {
      // 次回請求日の計算（last_billing_monthから1ヶ月後を計算）
      let nextBillingDate: Date | null = null;
      if (contractPlot.managementFee?.last_billing_month) {
        const match = contractPlot.managementFee.last_billing_month.match(/(\d{4})年(\d{1,2})月/);
        if (match && match[1] && match[2]) {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]);
          // 次の月の1日。ローカルTZ の new Date(year, month, 1) だと toISOString で
          // 前月末日の UTC datetime に化け、非JST環境やソート集計で月境界がずれる
          // ため UTC で構築する（#277、#214 の UTC 正規化と同方針）
          nextBillingDate = new Date(Date.UTC(year, month, 1));
        }
      }

      // 主契約者（role='contractor'）を取得（後方互換性のため）
      const primaryRole = contractPlot.saleContractRoles?.find(
        (role) => role.role === 'contractor'
      );
      const primaryCustomer = primaryRole?.customer;

      return {
        // 契約区画情報
        id: contractPlot.id,
        contractAreaSqm: contractPlot.contract_area_sqm.toNumber(),
        locationDescription: contractPlot.location_description,

        // 物理区画情報（表示用）
        plotNumber: contractPlot.physicalPlot.plot_number,
        displayNumber: contractPlot.physicalPlot.display_number,
        areaName: contractPlot.physicalPlot.area_name,
        physicalPlotAreaSqm: contractPlot.physicalPlot.area_sqm.toNumber(),
        physicalPlotStatus: contractPlot.physicalPlot.status,

        // 販売契約情報（ContractPlotに統合済み）
        contractDate: contractPlot.contract_date,
        price: contractPlot.price, // Int型なのでそのまま
        paymentStatus: contractPlot.payment_status,

        // 顧客情報（主契約者のみ - 後方互換性）
        customerName: primaryCustomer?.name || null,
        customerNameKana: primaryCustomer?.name_kana || null,
        customerPhoneNumber: primaryCustomer?.phone_number || null,
        customerAddress: primaryCustomer?.address || null,
        customerRole: primaryRole?.role || null,

        // 全ての役割情報（リスト表示用の最小限情報）
        roles:
          contractPlot.saleContractRoles?.map((role) => ({
            role: role.role,
            customer: {
              id: role.customer.id,
              name: role.customer.name,
            },
          })) || [],

        // 備考
        contractNotes: contractPlot.notes || null,
        customerNotes: primaryCustomer?.notes || null,

        // 埋葬者名（一覧表示用）
        buriedPersonNames:
          contractPlot.buriedPersons?.map((bp: { name: string }) => bp.name).filter(Boolean) || [],

        // 取扱（販売代理店）
        agentName: contractPlot.agent_name || null,

        // 許可番号
        permitNumber: contractPlot.permit_number || null,

        // 料金情報
        nextBillingDate,
        managementFee: contractPlot.managementFee?.management_fee || null,
        uncollectedAmount: contractPlot.uncollected_amount,

        // 請求状況サマリ（B10: 年度別請求 status の集約列）
        billingSummary: buildBillingSummary(contractPlot.billings),

        // メタ情報
        createdAt: contractPlot.created_at,
        updatedAt: contractPlot.updated_at,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        data: plotList,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
