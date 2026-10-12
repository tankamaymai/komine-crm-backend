import { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_RELEASE_TIMING,
  isReleaseTiming,
  ReleaseTiming,
  shiftDateToReleaseTiming,
} from './releaseTiming';

type Db = PrismaClient | Prisma.TransactionClient;

export async function getReleaseTiming(prisma: Db): Promise<ReleaseTiming> {
  const row = await prisma.collectiveBurialSetting.findUnique({ where: { id: 1 } });
  if (row && isReleaseTiming(row.release_timing)) return row.release_timing;
  return DEFAULT_RELEASE_TIMING;
}

/**
 * 未請求の合祀日を、選んだ月日に揃える。年は変えない。
 * 月日が前の設定と同じものだけ動かすので、個別に指定した日は残る。
 */
export async function shiftPendingReleaseDates(
  prisma: Db,
  previous: ReleaseTiming,
  next: ReleaseTiming
): Promise<number> {
  if (previous === next) return 0;
  const pending = await prisma.collectiveBurial.findMany({
    where: {
      deleted_at: null,
      billing_status: 'pending',
      billing_scheduled_date: { not: null },
    },
    select: { id: true, billing_scheduled_date: true },
  });
  const prev = { month: previous === 'obon' ? 7 : 9, day: previous === 'obon' ? 13 : 1 };
  let updated = 0;
  for (const row of pending) {
    const date = row.billing_scheduled_date;
    if (!date) continue;
    if (date.getUTCMonth() !== prev.month || date.getUTCDate() !== prev.day) continue;
    await prisma.collectiveBurial.update({
      where: { id: row.id },
      data: { billing_scheduled_date: shiftDateToReleaseTiming(date, next) },
    });
    updated += 1;
  }
  return updated;
}
