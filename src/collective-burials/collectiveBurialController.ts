/**
 * 合祀管理コントローラー
 */

import { Request, Response, NextFunction } from 'express';
import { BillingStatus } from '@prisma/client';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import prisma from '../db/prisma';
import {
  updateCollectiveBurialCount,
  resolveBillingScheduledDate,
  findFinalBurialDate,
} from './utils';

/** リクエストボディの型（Express の req.body は any のため、境界で明示的に型付けする） */
interface CreateCollectiveBurialBody {
  contractPlotId?: string;
  burialCapacity?: number;
  validityPeriodYears?: number;
  billingAmount?: number | null;
  notes?: string | null;
}

interface UpdateCollectiveBurialBody {
  burialCapacity?: number;
  validityPeriodYears?: number;
  capacityReachedDate?: string | null;
  billingScheduledDate?: string | null;
  billingStatus?: string;
  billingAmount?: number | null;
  notes?: string | null;
}

interface UpdateBillingStatusBody {
  billingStatus?: BillingStatus;
  billingAmount?: number;
}

/**
 * 合祀一覧取得
 */
export const getCollectiveBurialList = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const {
      page = '1',
      limit = '50',
      search,
      billingStatus,
      year,
      sortBy = 'billing_scheduled_date',
      sortOrder = 'asc',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // 検索条件の構築
    // 親契約が論理削除済みの「孤児合祀」を常に除外する（#358 layer2・防御的二重担保）。
    // deletePlot 側のカスケード漏れで active のまま残った合祀が一覧に出ないようにする。
    const where: Record<string, unknown> = {
      deleted_at: null,
      contractPlot: { is: { deleted_at: null } },
    };

    // 請求ステータスフィルター
    if (billingStatus && ['pending', 'billed', 'paid'].includes(billingStatus as string)) {
      where['billing_status'] = billingStatus as BillingStatus;
    }

    // 年フィルター（請求予定年）
    if (year) {
      const yearNum = parseInt(year as string, 10);
      if (!isNaN(yearNum)) {
        where['billing_scheduled_date'] = {
          gte: new Date(`${yearNum}-01-01`),
          lt: new Date(`${yearNum + 1}-01-01`),
        };
      }
    }

    // 検索クエリ（顧客名、区画番号で検索）
    // contractPlot フィルタは上で deleted_at:null を設定済みのため、検索条件は
    // その is 配下にマージして親契約の論理削除ガードを保持する。
    if (search) {
      where['contractPlot'] = {
        is: {
          deleted_at: null,
          OR: [
            {
              physicalPlot: {
                plot_number: { contains: search as string, mode: 'insensitive' },
              },
            },
            {
              saleContractRoles: {
                some: {
                  // 論理削除済みの旧役割（解約・差し替えで外れた顧客）を検索対象から除外（#206）
                  deleted_at: null,
                  customer: {
                    OR: [
                      { name: { contains: search as string, mode: 'insensitive' } },
                      { name_kana: { contains: search as string, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            },
          ],
        },
      };
    }

    // ソート条件
    const validSortFields = ['billing_scheduled_date', 'current_burial_count', 'created_at'];
    const sortField = validSortFields.includes(sortBy as string)
      ? (sortBy as string)
      : 'billing_scheduled_date';
    const order = sortOrder === 'desc' ? 'desc' : 'asc';

    // データ取得
    const [items, totalCount] = await Promise.all([
      prisma.collectiveBurial.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { [sortField]: order },
        include: {
          contractPlot: {
            include: {
              physicalPlot: true,
              saleContractRoles: {
                where: { deleted_at: null, role: { in: ['applicant', 'contractor'] } },
                include: {
                  customer: true,
                },
              },
              buriedPersons: {
                where: { deleted_at: null },
                select: { id: true, name: true, burial_date: true },
              },
            },
          },
        },
      }),
      prisma.collectiveBurial.count({ where }),
    ]);

    // レスポンス形式に変換
    const formattedItems = items.map((item) => {
      const roles = item.contractPlot.saleContractRoles;
      const applicant = (
        roles.find((r) => r.role === 'applicant') ?? roles.find((r) => r.role === 'contractor')
      )?.customer;
      return {
        id: item.id,
        contractPlotId: item.contract_plot_id,
        plotNumber: item.contractPlot.physicalPlot.plot_number,
        displayNumber: item.contractPlot.physicalPlot.display_number,
        areaName: item.contractPlot.physicalPlot.area_name,
        contractDate: item.contractPlot.contract_date?.toISOString().split('T')[0] ?? null,
        applicantName: applicant?.name || null,
        applicantNameKana: applicant?.name_kana || null,
        burialCapacity: item.burial_capacity,
        currentBurialCount: item.current_burial_count,
        capacityReachedDate: item.capacity_reached_date?.toISOString().split('T')[0] || null,
        validityPeriodYears: item.validity_period_years,
        billingScheduledDate: item.billing_scheduled_date?.toISOString().split('T')[0] || null,
        billingStatus: item.billing_status,
        billingAmount: item.billing_amount,
        notes: item.notes,
        buriedPersons: item.contractPlot.buriedPersons.map((bp) => ({
          id: bp.id,
          name: bp.name,
          burialDate: bp.burial_date?.toISOString().split('T')[0] || null,
        })),
        createdAt: item.created_at.toISOString(),
        updatedAt: item.updated_at.toISOString(),
      };
    });

    res.status(200).json({
      success: true,
      data: {
        items: formattedItems,
        pagination: {
          page: pageNum,
          limit: limitNum,
          totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 合祀詳細取得
 */
export const getCollectiveBurialById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    const collectiveBurial = await prisma.collectiveBurial.findFirst({
      // 親契約が論理削除済みの孤児合祀は詳細でも参照不能にする（#358 layer2）
      where: { id, deleted_at: null, contractPlot: { is: { deleted_at: null } } },
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
            buriedPersons: {
              where: { deleted_at: null },
              orderBy: { burial_date: 'desc' },
            },
          },
        },
      },
    });

    if (!collectiveBurial) {
      throw new NotFoundError('合祀情報が見つかりません');
    }

    const roles = collectiveBurial.contractPlot.saleContractRoles;
    const applicant = (
      roles.find((r) => r.role === 'applicant') ?? roles.find((r) => r.role === 'contractor')
    )?.customer;

    res.status(200).json({
      success: true,
      data: {
        id: collectiveBurial.id,
        contractPlotId: collectiveBurial.contract_plot_id,
        plotNumber: collectiveBurial.contractPlot.physicalPlot.plot_number,
        displayNumber: collectiveBurial.contractPlot.physicalPlot.display_number,
        areaName: collectiveBurial.contractPlot.physicalPlot.area_name,
        contractDate:
          collectiveBurial.contractPlot.contract_date?.toISOString().split('T')[0] ?? null,
        applicant: applicant
          ? {
              id: applicant.id,
              name: applicant.name,
              nameKana: applicant.name_kana,
              phone: applicant.phone_number,
              email: applicant.email,
              postalCode: applicant.postal_code,
              address: applicant.address,
            }
          : null,
        burialCapacity: collectiveBurial.burial_capacity,
        currentBurialCount: collectiveBurial.current_burial_count,
        capacityReachedDate:
          collectiveBurial.capacity_reached_date?.toISOString().split('T')[0] || null,
        validityPeriodYears: collectiveBurial.validity_period_years,
        billingScheduledDate:
          collectiveBurial.billing_scheduled_date?.toISOString().split('T')[0] || null,
        billingStatus: collectiveBurial.billing_status,
        billingAmount: collectiveBurial.billing_amount,
        notes: collectiveBurial.notes,
        buriedPersons: collectiveBurial.contractPlot.buriedPersons.map((bp) => ({
          id: bp.id,
          name: bp.name,
          nameKana: bp.name_kana,
          relationship: bp.relationship,
          deathDate: bp.death_date?.toISOString().split('T')[0] || null,
          age: bp.age,
          gender: bp.gender,
          burialDate: bp.burial_date?.toISOString().split('T')[0] || null,
          notes: bp.notes,
        })),
        createdAt: collectiveBurial.created_at.toISOString(),
        updatedAt: collectiveBurial.updated_at.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 合祀情報作成
 */
export const createCollectiveBurial = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { contractPlotId, burialCapacity, validityPeriodYears, billingAmount, notes } =
      req.body as CreateCollectiveBurialBody;

    // バリデーション
    if (!contractPlotId) {
      throw new ValidationError('契約区画IDは必須です');
    }
    if (!burialCapacity || burialCapacity < 1) {
      throw new ValidationError('埋葬上限人数は1以上の整数で指定してください');
    }
    if (!validityPeriodYears || validityPeriodYears < 1) {
      throw new ValidationError('有効期間（年）は1以上の整数で指定してください');
    }

    // 契約区画の存在確認
    const contractPlot = await prisma.contractPlot.findFirst({
      where: { id: contractPlotId, deleted_at: null },
    });

    if (!contractPlot) {
      throw new NotFoundError('契約区画が見つかりません');
    }

    // 既存の合祀情報の確認
    // contract_plot_id は deleted_at を含まない単独 @unique のため、
    // ソフトデリート済みの行が残っていると create が P2002 になる（#202）。
    // 生きている行のみ重複エラーとし、ソフトデリート済み行は復活させる。
    const existingCollectiveBurial = await prisma.collectiveBurial.findUnique({
      where: { contract_plot_id: contractPlotId },
    });

    if (existingCollectiveBurial && !existingCollectiveBurial.deleted_at) {
      throw new ValidationError('この契約区画には既に合祀情報が登録されています');
    }

    // 請求予定日は契約日起点で導出する（#164）。契約日未設定なら null（契約日設定時に再計算）
    const billingScheduledDate = resolveBillingScheduledDate(
      contractPlot.contract_date,
      validityPeriodYears
    );

    // 合祀情報作成（ソフトデリート済み行があれば新規値で復活させる）
    const collectiveBurial = existingCollectiveBurial
      ? await prisma.collectiveBurial.update({
          where: { id: existingCollectiveBurial.id },
          data: {
            burial_capacity: burialCapacity,
            current_burial_count: 0,
            validity_period_years: validityPeriodYears,
            capacity_reached_date: null,
            billing_scheduled_date: billingScheduledDate,
            billing_status: 'pending',
            billing_amount: billingAmount || null,
            notes: notes || null,
            deleted_at: null,
          },
        })
      : await prisma.collectiveBurial.create({
          data: {
            contract_plot_id: contractPlotId,
            burial_capacity: burialCapacity,
            current_burial_count: 0,
            validity_period_years: validityPeriodYears,
            billing_scheduled_date: billingScheduledDate,
            billing_status: 'pending',
            billing_amount: billingAmount || null,
            notes: notes || null,
          },
        });

    // 実埋葬者から件数・上限到達日を再同期する（#281）。
    // BuriedPerson は ContractPlot 紐付けのため合祀のソフトデリートでは消えない。
    // 復活時に 0 固定のままだと「count=0 なのに埋葬者一覧に実データが並ぶ」矛盾が出る。
    // （請求予定日は契約日起点（#164）のため同期では変更されない）
    const synced = await updateCollectiveBurialCount(prisma, contractPlotId);
    const result = synced ?? collectiveBurial;

    res.status(201).json({
      success: true,
      data: {
        id: result.id,
        contractPlotId: result.contract_plot_id,
        burialCapacity: result.burial_capacity,
        currentBurialCount: result.current_burial_count,
        validityPeriodYears: result.validity_period_years,
        billingStatus: result.billing_status,
        billingAmount: result.billing_amount,
        notes: result.notes,
        createdAt: result.created_at.toISOString(),
        updatedAt: result.updated_at.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 合祀情報更新
 */
export const updateCollectiveBurial = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const {
      burialCapacity,
      validityPeriodYears,
      capacityReachedDate,
      billingScheduledDate,
      billingStatus,
      billingAmount,
      notes,
    } = req.body as UpdateCollectiveBurialBody;

    // 存在確認（契約日起点の請求予定日再計算用に contractPlot も取得 #164）
    const existing = await prisma.collectiveBurial.findFirst({
      where: { id, deleted_at: null },
      include: { contractPlot: { select: { contract_date: true } } },
    });

    if (!existing) {
      throw new NotFoundError('合祀情報が見つかりません');
    }

    // バリデーション
    if (burialCapacity !== undefined && burialCapacity < 1) {
      throw new ValidationError('埋葬上限人数は1以上の整数で指定してください');
    }
    if (validityPeriodYears !== undefined && validityPeriodYears < 1) {
      throw new ValidationError('有効期間（年）は1以上の整数で指定してください');
    }
    if (billingStatus && !['pending', 'billed', 'paid'].includes(billingStatus)) {
      throw new ValidationError('無効な請求ステータスです');
    }

    // 更新データの構築
    const updateData: Record<string, unknown> = {};
    if (burialCapacity !== undefined) updateData['burial_capacity'] = burialCapacity;
    if (validityPeriodYears !== undefined)
      updateData['validity_period_years'] = validityPeriodYears;
    if (capacityReachedDate !== undefined) {
      updateData['capacity_reached_date'] = capacityReachedDate
        ? new Date(capacityReachedDate)
        : null;
    }
    if (billingScheduledDate !== undefined) {
      // 手動指定（例外運用: 決まった年数より短くする等、業務確認 2026-06-07 Q17）を優先。
      // 以後は埋葬者の変更に追随した自動再計算で上書きしないよう手動フラグを立てる。
      // 日付を null でクリアした場合は自動算出へ戻す意図と解釈しフラグを下ろす。
      updateData['billing_scheduled_date'] = billingScheduledDate
        ? new Date(billingScheduledDate)
        : null;
      updateData['billing_scheduled_date_manual'] = billingScheduledDate !== null;
    } else if (
      validityPeriodYears !== undefined &&
      validityPeriodYears !== existing.validity_period_years &&
      !existing.billing_scheduled_date_manual
    ) {
      // 有効期間が変わった場合は請求予定日を再計算する。
      // 起点は「最終納骨者の埋葬日、無ければ契約日」（議事録 2026-07-21 §1 / #164）
      updateData['billing_scheduled_date'] = resolveBillingScheduledDate(
        existing.contractPlot.contract_date,
        validityPeriodYears,
        await findFinalBurialDate(prisma, existing.contract_plot_id)
      );
    }
    if (billingStatus !== undefined) updateData['billing_status'] = billingStatus;
    if (billingAmount !== undefined) updateData['billing_amount'] = billingAmount;
    if (notes !== undefined) updateData['notes'] = notes;

    // 更新実行
    const updated = await prisma.collectiveBurial.update({
      where: { id },
      data: updateData,
      include: {
        contractPlot: {
          include: {
            physicalPlot: true,
          },
        },
      },
    });

    res.status(200).json({
      success: true,
      data: {
        id: updated.id,
        contractPlotId: updated.contract_plot_id,
        plotNumber: updated.contractPlot.physicalPlot.plot_number,
        displayNumber: updated.contractPlot.physicalPlot.display_number,
        burialCapacity: updated.burial_capacity,
        currentBurialCount: updated.current_burial_count,
        capacityReachedDate: updated.capacity_reached_date?.toISOString().split('T')[0] || null,
        validityPeriodYears: updated.validity_period_years,
        billingScheduledDate: updated.billing_scheduled_date?.toISOString().split('T')[0] || null,
        billingStatus: updated.billing_status,
        billingAmount: updated.billing_amount,
        notes: updated.notes,
        createdAt: updated.created_at.toISOString(),
        updatedAt: updated.updated_at.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 請求ステータス更新
 */
export const updateBillingStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const { billingStatus, billingAmount } = req.body as UpdateBillingStatusBody;

    // バリデーション
    if (!billingStatus || !['pending', 'billed', 'paid'].includes(billingStatus)) {
      throw new ValidationError('有効な請求ステータス（pending, billed, paid）を指定してください');
    }

    // 存在確認
    const existing = await prisma.collectiveBurial.findFirst({
      where: { id, deleted_at: null },
    });

    if (!existing) {
      throw new NotFoundError('合祀情報が見つかりません');
    }

    // 更新
    const updated = await prisma.collectiveBurial.update({
      where: { id },
      data: {
        billing_status: billingStatus,
        ...(billingAmount !== undefined && { billing_amount: billingAmount }),
      },
    });

    res.status(200).json({
      success: true,
      data: {
        id: updated.id,
        billingStatus: updated.billing_status,
        billingAmount: updated.billing_amount,
        updatedAt: updated.updated_at.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 合祀情報削除（論理削除）
 */
export const deleteCollectiveBurial = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    // 存在確認
    const existing = await prisma.collectiveBurial.findFirst({
      where: { id, deleted_at: null },
    });

    if (!existing) {
      throw new NotFoundError('合祀情報が見つかりません');
    }

    // 論理削除
    await prisma.collectiveBurial.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    res.status(200).json({
      success: true,
      data: {
        message: '合祀情報を削除しました',
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 埋葬人数同期（BuriedPersonsから自動集計）
 */
export const syncBurialCount = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;

    // 合祀情報取得
    const collectiveBurial = await prisma.collectiveBurial.findFirst({
      where: { id, deleted_at: null },
    });

    if (!collectiveBurial) {
      throw new NotFoundError('合祀情報が見つかりません');
    }

    // 集計・上限判定・日付セット/リセットは utils の単一実装へ委譲する（#203）。
    // 旧実装は上限到達時のセットのみで、人数が上限を下回った際に
    // capacity_reached_date / billing_scheduled_date をリセットせず、
    // ゆうちょ請求対象抽出（billing_scheduled_date ベース）に誤って載っていた。
    const updated = await updateCollectiveBurialCount(prisma, collectiveBurial.contract_plot_id);

    if (!updated) {
      // 直前に存在確認済みのため通常到達しない（競合削除時の保険）
      throw new NotFoundError('合祀情報が見つかりません');
    }

    res.status(200).json({
      success: true,
      data: {
        id: updated.id,
        currentBurialCount: updated.current_burial_count,
        burialCapacity: updated.burial_capacity,
        capacityReached: updated.current_burial_count >= updated.burial_capacity,
        capacityReachedDate: updated.capacity_reached_date?.toISOString().split('T')[0] || null,
        billingScheduledDate: updated.billing_scheduled_date?.toISOString().split('T')[0] || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 年別統計取得
 */
export const getStatsByYear = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 請求予定年ごとの集計
    // 金額（total_amount / paid_amount）もサーバ側で集計し、
    // ページ制限された items の reduce による過少表示を防ぐ（frontend #226）。
    const stats = await prisma.$queryRaw<
      Array<{
        year: number;
        count: bigint;
        pending_count: bigint;
        billed_count: bigint;
        paid_count: bigint;
        total_amount: bigint;
        paid_amount: bigint;
      }>
    >`
      SELECT
        EXTRACT(YEAR FROM billing_scheduled_date)::integer as year,
        COUNT(*)::bigint as count,
        COUNT(CASE WHEN billing_status = 'pending' THEN 1 END)::bigint as pending_count,
        COUNT(CASE WHEN billing_status = 'billed' THEN 1 END)::bigint as billed_count,
        COUNT(CASE WHEN billing_status = 'paid' THEN 1 END)::bigint as paid_count,
        COALESCE(SUM(billing_amount), 0)::bigint as total_amount,
        COALESCE(SUM(CASE WHEN billing_status = 'paid' THEN billing_amount END), 0)::bigint as paid_amount
      FROM collective_burials
      WHERE deleted_at IS NULL
        AND billing_scheduled_date IS NOT NULL
      GROUP BY EXTRACT(YEAR FROM billing_scheduled_date)
      ORDER BY year
    `;

    res.status(200).json({
      success: true,
      data: stats.map((s) => ({
        year: s.year,
        count: Number(s.count),
        pendingCount: Number(s.pending_count),
        billedCount: Number(s.billed_count),
        paidCount: Number(s.paid_count),
        totalAmount: Number(s.total_amount),
        paidAmount: Number(s.paid_amount),
      })),
    });
  } catch (error) {
    next(error);
  }
};
