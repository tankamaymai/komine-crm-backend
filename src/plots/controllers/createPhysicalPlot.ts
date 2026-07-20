/**
 * 空き区画（物理区画のみ）先行登録コントローラー
 * POST /api/v1/plots/physical
 *
 * 旧システムの「区画を先ず作り、そこに契約者情報を入れる」運用に対応する
 * （システム確認 項目⑦）。契約者・契約情報なしで物理区画だけを登録し、
 * 在庫（区画残数管理）に「空き」として現れるようにする。
 *
 * 後から契約が決まったら、既存の POST /plots（physicalPlot.id 指定）または
 * POST /plots/:id/contracts で契約を紐づける。
 */
import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db/prisma';
import { ConflictError } from '../../middleware/errorHandler';

interface CreatePhysicalPlotInput {
  plotNumber: string;
  displayNumber?: string | null;
  areaName: string;
  areaSqm?: number;
  mapId?: number | null;
  notes?: string | null;
}

export const createPhysicalPlot = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = req.body as CreatePhysicalPlotInput;

    // plot_number はユニークキー（一括取込キー兼用）。論理削除済みを含めて重複を禁止する。
    const existing = await prisma.physicalPlot.findUnique({
      where: { plot_number: input.plotNumber },
    });
    if (existing) {
      throw new ConflictError('この区画番号は既に登録されています');
    }

    const created = await prisma.physicalPlot.create({
      data: {
        plot_number: input.plotNumber,
        display_number: input.displayNumber || null,
        area_name: input.areaName,
        area_sqm: new Prisma.Decimal(input.areaSqm ?? 3.6),
        status: 'available',
        map_id: input.mapId ?? null,
        notes: input.notes || null,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: created.id,
        plotNumber: created.plot_number,
        displayNumber: created.display_number,
        areaName: created.area_name,
        areaSqm: created.area_sqm.toNumber(),
        status: created.status,
        notes: created.notes,
        createdAt: created.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
};
