/**
 * 合祀を一斉に解約する月の設定と、その日を過ぎた今年の人の解約。
 */

import { Request, Response, NextFunction } from 'express';
import { ContractStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma';
import { ValidationError } from '../middleware/errorHandler';
import { todayJstAsUtcDate } from '../utils/dateUtils';
import { recordEntityUpdated } from '../plots/services/historyService';
import { updatePhysicalPlotStatus } from '../plots/utils';
import { contractStatusService } from '../plots/services/contractStatusService';
import { isReleaseDayReached, isReleaseTiming, ReleaseTiming } from './releaseTiming';
import { getReleaseTiming, shiftPendingReleaseDates } from './settingsStore';

export const getCollectiveBurialSettings = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const releaseTiming = await getReleaseTiming(prisma);
    res.status(200).json({ success: true, data: { releaseTiming } });
  } catch (error) {
    next(error);
  }
};

export const updateCollectiveBurialSettings = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const releaseTiming = (req.body as { releaseTiming?: unknown }).releaseTiming;
    if (!isReleaseTiming(releaseTiming)) {
      throw new ValidationError('解約する月は「お盆」か「10月」を選んでください');
    }
    const previous = await getReleaseTiming(prisma);
    await prisma.collectiveBurialSetting.upsert({
      where: { id: 1 },
      create: { id: 1, release_timing: releaseTiming },
      update: { release_timing: releaseTiming },
    });
    const shifted = await shiftPendingReleaseDates(prisma, previous, releaseTiming);
    res.status(200).json({
      success: true,
      data: { releaseTiming, shifted },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 今年の合祀で、選んだ日を過ぎている人の契約を解約し、区画を空きに戻す。
 * 今年より前の人は動かさない。
 */
export async function releaseDueCollectiveBurials(req: Request): Promise<number> {
  const timing: ReleaseTiming = await getReleaseTiming(prisma);
  const today = todayJstAsUtcDate();
  if (!isReleaseDayReached(today, timing)) return 0;

  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const due = await prisma.collectiveBurial.findMany({
    where: {
      deleted_at: null,
      billing_status: 'pending',
      billing_scheduled_date: { gte: yearStart, lte: today },
      contractPlot: { is: { deleted_at: null, contract_status: ContractStatus.active } },
    },
    select: {
      id: true,
      contract_plot_id: true,
      contractPlot: { select: { physical_plot_id: true, contract_status: true } },
    },
  });

  let released = 0;
  for (const row of due) {
    const didRelease = await prisma.$transaction(
      async (tx) => {
        const current = await tx.contractPlot.findUnique({
          where: { id: row.contract_plot_id, deleted_at: null },
        });
        if (!current || current.contract_status !== ContractStatus.active) return false;
        contractStatusService.validateTransition(
          current.contract_status,
          ContractStatus.terminated
        );
        await tx.contractPlot.update({
          where: { id: current.id },
          data: { contract_status: ContractStatus.terminated },
        });
        await updatePhysicalPlotStatus(tx, current.physical_plot_id);
        await recordEntityUpdated(tx, {
          entityType: 'ContractPlot',
          entityId: current.id,
          physicalPlotId: current.physical_plot_id,
          contractPlotId: current.id,
          beforeRecord: { contract_status: ContractStatus.active },
          afterRecord: { contract_status: ContractStatus.terminated },
          changeReason: '合祀の年になったため一斉解約',
          req,
        });
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    if (didRelease) released += 1;
  }
  return released;
}

export const postReleaseDueCollectiveBurials = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const released = await releaseDueCollectiveBurials(req);
    res.status(200).json({ success: true, data: { released } });
  } catch (error) {
    next(error);
  }
};
