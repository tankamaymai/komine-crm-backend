import { Request, Response, NextFunction } from 'express';

import prisma from '../../db/prisma';
import { getVacantPlots as fetchVacantPlots } from '../services/vacantPlotService';
import type { VacantPlotsQuery } from '../../validations/plotValidation';

/**
 * GET /plots/vacant
 * 空き区画の一覧を取得（議事録 2026-07-21 §6）
 *
 * 新規顧客登録時の区画指定を手入力不可の選択式にするための選択肢を返す。
 * 実データで空き区画は約2,500件あり、単一の区画名でも最大647件（凛B）になるため、
 * 画面側は区画名で絞り、さらに区画番号で絞り込んで使う。
 */
export const getVacantPlots = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // validate ミドルウェアで型変換済み
    const { areaName, search, page, limit } = req.query as unknown as VacantPlotsQuery;

    const { items, total } = await fetchVacantPlots(prisma, {
      ...(areaName !== undefined && { areaName }),
      ...(search !== undefined && { search }),
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
