/**
 * 空き区画の範囲一括登録コントローラー
 * POST /api/v1/plots/physical/bulk
 *
 * 議事録 2026-07-21 §6: 「将来的に区画を増設した場合に備え、『何番から何番まで』と
 * 範囲を指定して空き区画を一括で登録できる機能」への対応。
 *
 * 単発の POST /plots/physical と同じく、契約者・契約情報なしで物理区画だけを作り、
 * 在庫（区画残数管理）に「空き」として現れるようにする。
 */
import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

import prisma from '../../db/prisma';
import { buildPlotNumbersInRange, splitByExisting } from '../services/bulkPhysicalPlotService';
import type { CreatePhysicalPlotsBulkInput } from '../../validations/plotValidation';

export const createPhysicalPlotsBulk = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const input = req.body as CreatePhysicalPlotsBulkInput;

    // 範囲の妥当性と件数上限はここで弾かれる（ValidationError → 400）
    const candidates = buildPlotNumbersInRange({
      areaName: input.areaName,
      prefix: input.prefix,
      startNumber: input.startNumber,
      endNumber: input.endNumber,
    });

    // plot_number は deleted_at を含まない単独 @unique のため、論理削除済みも重複扱いにする
    const existing = await prisma.physicalPlot.findMany({
      where: { plot_number: { in: candidates.map((c) => c.plotNumber) } },
      select: { plot_number: true },
    });
    const { toCreate, skipped } = splitByExisting(
      candidates,
      existing.map((e) => e.plot_number)
    );

    const areaSqm = new Prisma.Decimal(input.areaSqm ?? 3.6);

    if (toCreate.length > 0) {
      await prisma.physicalPlot.createMany({
        data: toCreate.map((pair) => ({
          plot_number: pair.plotNumber,
          display_number: pair.displayNumber,
          area_name: input.areaName,
          area_sqm: areaSqm,
          status: 'available' as const,
          map_id: input.mapId ?? null,
          notes: input.notes || null,
        })),
        // 事前照会と挿入の間に他の登録が入る競合への保険。
        // 何をスキップしたかは事前照会の結果で報告するため、ここでは黙って落とす。
        skipDuplicates: true,
      });
    }

    // createMany は作成レコードを返さないため、登録された行を読み直して返す
    const created =
      toCreate.length > 0
        ? await prisma.physicalPlot.findMany({
            where: { plot_number: { in: toCreate.map((c) => c.plotNumber) } },
            orderBy: { plot_number: 'asc' },
          })
        : [];

    res.status(201).json({
      success: true,
      data: {
        created: created.map((plot) => ({
          id: plot.id,
          plotNumber: plot.plot_number,
          displayNumber: plot.display_number,
          areaName: plot.area_name,
          areaSqm: plot.area_sqm.toNumber(),
          status: plot.status,
          notes: plot.notes,
          createdAt: plot.created_at,
        })),
        createdCount: created.length,
        skipped,
        skippedCount: skipped.length,
      },
    });
  } catch (error) {
    next(error);
  }
};
