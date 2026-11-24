/**
 * 承諾書番号の重複。
 * ほかの契約で同じ番号があるとき、警告して本人が続けるまで保存しない。
 */
import { Prisma } from '@prisma/client';
import { ConflictError } from '../../middleware/errorHandler';

export async function assertAcceptanceNumberAvailable(
  tx: Prisma.TransactionClient,
  acceptanceNumber: string | null | undefined,
  excludeContractPlotIds: string[],
  allowDuplicate: boolean
): Promise<void> {
  const number = (acceptanceNumber ?? '').trim();
  if (!number || allowDuplicate) return;

  const existing = await tx.contractPlot.findFirst({
    where: {
      deleted_at: null,
      acceptance_number: number,
      ...(excludeContractPlotIds.length > 0 ? { id: { notIn: excludeContractPlotIds } } : {}),
    },
    select: {
      physicalPlot: { select: { display_number: true, plot_number: true } },
    },
  });
  if (!existing) return;

  const label =
    existing.physicalPlot.display_number?.trim() || existing.physicalPlot.plot_number;
  throw new ConflictError(
    `この承諾書番号は、区画 ${label} でも使われています。このまま使いますか？`
  );
}

export function allowDuplicateAcceptance(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { allowDuplicateAcceptanceNumber?: boolean }).allowDuplicateAcceptanceNumber === true
  );
}
