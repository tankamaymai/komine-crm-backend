/**
 * 区画区分の distinct 値取得コントローラー
 * GET /api/v1/plots/grave-classifications
 *
 * ContractPlot に存在する grave_kind / grave_kubun / grave_type と、
 * 台帳に出ている physical_plot.area_name の一意な値の一覧を返す。
 * 区画一覧画面のフィルタ select 用。
 * master 化されるまでの暫定エンドポイント。
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../db/prisma';

export const getGraveClassifications = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [kinds, kubuns, types, areas] = await Promise.all([
      prisma.contractPlot.findMany({
        where: { deleted_at: null, grave_kind: { not: null } },
        select: { grave_kind: true },
        distinct: ['grave_kind'],
        orderBy: { grave_kind: 'asc' },
      }),
      prisma.contractPlot.findMany({
        where: { deleted_at: null, grave_kubun: { not: null } },
        select: { grave_kubun: true },
        distinct: ['grave_kubun'],
        orderBy: { grave_kubun: 'asc' },
      }),
      prisma.contractPlot.findMany({
        where: { deleted_at: null, grave_type: { not: null } },
        select: { grave_type: true },
        distinct: ['grave_type'],
        orderBy: { grave_type: 'asc' },
      }),
      prisma.physicalPlot.findMany({
        where: {
          deleted_at: null,
          area_name: { not: '' },
          contractPlots: {
            some: { deleted_at: null },
          },
        },
        select: { area_name: true },
        distinct: ['area_name'],
        orderBy: { area_name: 'asc' },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        graveKinds: kinds.map((r) => r.grave_kind).filter((v): v is number => v !== null),
        graveKubuns: kubuns.map((r) => r.grave_kubun).filter((v): v is number => v !== null),
        graveTypes: types.map((r) => r.grave_type).filter((v): v is number => v !== null),
        areaNames: areas.map((r) => r.area_name).filter(Boolean),
      },
    });
  } catch (error) {
    next(error);
  }
};
