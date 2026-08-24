/**
 * 区画図用オーバーレイ（予約日あり・未本契約 → 予約中）
 */
import { PrismaClient } from '@prisma/client';

import { getPlotMapOverlays } from '../../../src/plots/services/plotMapService';

type MockPrisma = { physicalPlot: { findMany: jest.Mock } };

const buildPrisma = (): MockPrisma => ({ physicalPlot: { findMany: jest.fn() } });
const asPrisma = (mock: MockPrisma) => mock as unknown as PrismaClient;

function contract(
  overrides: {
    status?: string;
    reservationDate?: Date | null;
    contractorName?: string | null;
    id?: string;
    area?: number;
  } = {}
) {
  const name = overrides.contractorName === undefined ? '疋田太郎' : overrides.contractorName;
  return {
    id: overrides.id ?? 'cp-1',
    contract_status: overrides.status ?? 'active',
    reservation_date: overrides.reservationDate ?? null,
    contract_area_sqm: overrides.area ?? 1,
    saleContractRoles: name ? [{ customer: { name } }] : [],
  };
}

function physical(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pp-1',
    plot_number: 'legacy-1',
    display_number: '1-97',
    area_name: '1',
    area_sqm: 1,
    contractPlots: [],
    ...overrides,
  };
}

describe('getPlotMapOverlays', () => {
  it('契約のない物理区画は vacant', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([physical()]);

    const items = await getPlotMapOverlays(asPrisma(prisma), { mapId: '2-1' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      displayNumber: '1-97',
      overlayStatus: 'vacant',
      contractorName: null,
      contractPlotId: null,
    });
  });

  it('active 契約は contracted で契約者名を返す', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      physical({ contractPlots: [contract({ status: 'active', contractorName: '柴田花子' })] }),
    ]);

    const [item] = await getPlotMapOverlays(asPrisma(prisma), { mapId: '2-1' });

    expect(item.overlayStatus).toBe('contracted');
    expect(item.contractorName).toBe('柴田花子');
    expect(item.contractPlotId).toBe('cp-1');
  });

  it('予約日があり active でなければ reserved', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      physical({
        contractPlots: [
          contract({
            status: 'vacant',
            reservationDate: new Date('2026-04-01'),
            contractorName: '遠山',
          }),
        ],
      }),
    ]);

    const [item] = await getPlotMapOverlays(asPrisma(prisma), { mapId: '2-1' });

    expect(item.overlayStatus).toBe('reserved');
    expect(item.reservationDate).toBe('2026-04-01');
    expect(item.contractorName).toBe('遠山');
  });

  it('解約済みのみなら vacant', async () => {
    const prisma = buildPrisma();
    prisma.physicalPlot.findMany.mockResolvedValue([
      physical({
        contractPlots: [contract({ status: 'terminated', contractorName: '石田' })],
      }),
    ]);

    const [item] = await getPlotMapOverlays(asPrisma(prisma), { mapId: '2-1' });

    expect(item.overlayStatus).toBe('vacant');
    expect(item.contractorName).toBeNull();
  });
});
