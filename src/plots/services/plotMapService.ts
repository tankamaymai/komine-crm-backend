/**
 * 区画図用: 区の物理区画に契約・予約を重ねる
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { PLOT_MAP_SPECS, PlotMapId } from './plotMapSpecs';

export type { PlotMapId };

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface PlotMapOverlayItem {
  id: string;
  plotNumber: string;
  displayNumber: string | null;
  areaName: string;
  areaSqm: number;
  overlayStatus: 'vacant' | 'reserved' | 'contracted';
  contractorName: string | null;
  reservationDate: string | null;
  contractPlotId: string | null;
}

function toIsoDate(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

function contractorName(roles: Array<{ customer: { name: string } | null }>): string | null {
  return roles[0]?.customer?.name ?? null;
}

export async function getPlotMapOverlays(
  prisma: DbClient,
  options: { mapId: PlotMapId }
): Promise<PlotMapOverlayItem[]> {
  const spec = PLOT_MAP_SPECS[options.mapId];
  if (!spec) return [];

  const plots = await prisma.physicalPlot.findMany({
    where: {
      deleted_at: null,
      OR: [
        { area_name: { in: spec.areaNames } },
        ...spec.displayPrefixes.map((prefix) => ({
          display_number: { startsWith: prefix, mode: 'insensitive' as const },
        })),
      ],
    },
    include: {
      contractPlots: {
        where: { deleted_at: null },
        select: {
          id: true,
          contract_status: true,
          reservation_date: true,
          contract_area_sqm: true,
          saleContractRoles: {
            where: { deleted_at: null, role: 'contractor' },
            select: { customer: { select: { name: true } } },
          },
        },
      },
    },
  });

  return plots.map((plot) => {
    const active = plot.contractPlots.find((contract) => contract.contract_status === 'active');
    const reserved = plot.contractPlots.find(
      (contract) =>
        contract.reservation_date != null &&
        contract.contract_status !== 'active' &&
        contract.contract_status !== 'terminated'
    );

    if (active) {
      return {
        id: plot.id,
        plotNumber: plot.plot_number,
        displayNumber: plot.display_number,
        areaName: plot.area_name,
        areaSqm: Number(plot.area_sqm),
        overlayStatus: 'contracted',
        contractorName: contractorName(active.saleContractRoles),
        reservationDate: toIsoDate(active.reservation_date),
        contractPlotId: active.id,
      };
    }

    if (reserved) {
      return {
        id: plot.id,
        plotNumber: plot.plot_number,
        displayNumber: plot.display_number,
        areaName: plot.area_name,
        areaSqm: Number(plot.area_sqm),
        overlayStatus: 'reserved',
        contractorName: contractorName(reserved.saleContractRoles),
        reservationDate: toIsoDate(reserved.reservation_date),
        contractPlotId: reserved.id,
      };
    }

    return {
      id: plot.id,
      plotNumber: plot.plot_number,
      displayNumber: plot.display_number,
      areaName: plot.area_name,
      areaSqm: Number(plot.area_sqm),
      overlayStatus: 'vacant',
      contractorName: null,
      reservationDate: null,
      contractPlotId: null,
    };
  });
}
