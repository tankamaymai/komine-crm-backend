/**
 * 回帰テスト: 建立期限/建立日のマッピング修正（#326）
 *
 * step05 は以前 konryu_kigen(建立期限)/konryu_date(建立日) を
 * ContractPlot.permit_date(許可日)/start_date(開始日) に誤投入していた。
 * 正しい器は GravestoneInfo.establishment_deadline/establishment_date。
 * 許可日/開始日は契約日(contract_start)を代理投入する（komine-docs#10 Q4/Q5: 三者同義）。
 */
import type { PrismaClient } from '@prisma/client';

import { createIdMaps } from '../../../../scripts/legacy-migration/idMap';

jest.mock('../../../../scripts/legacy-migration/legacyDb', () => ({
  legacyQuery: jest.fn(),
}));

import { legacyQuery } from '../../../../scripts/legacy-migration/legacyDb';
import { stepContractPlot } from '../../../../scripts/legacy-migration/steps/05-contract-plot';
import type { MigrationContext } from '../../../../scripts/legacy-migration/types';

const mockedLegacyQuery = legacyQuery as jest.Mock;

function buildLogger(): MigrationContext['logger'] {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
  } as unknown as MigrationContext['logger'];
}

describe('step05 konryu → establishment マッピング (#326)', () => {
  beforeEach(() => {
    mockedLegacyQuery.mockReset();
  });

  it('konryu_kigen/konryu_date を GravestoneInfo へ入れ、permit_date/start_date には契約日を代理投入する', async () => {
    const contractPlotCreate = jest.fn().mockResolvedValue({ id: 'cp-1' });
    const gravestoneInfoCreate = jest.fn().mockResolvedValue({ id: 'gi-1' });

    const prisma = {
      physicalPlot: { findMany: jest.fn(), update: jest.fn() },
      contractPlot: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: contractPlotCreate,
      },
      usageFee: { create: jest.fn() },
      managementFee: { create: jest.fn() },
      gravestoneInfo: { create: gravestoneInfoCreate },
    } as unknown as PrismaClient;

    // boshi/houi_id/ichi_id/bosekiryou は無し → 建立期限/建立日のみで GravestoneInfo が作られる
    mockedLegacyQuery.mockResolvedValueOnce([
      {
        grave_cd: 500,
        danka_cd: 100,
        status: 1, // active
        contract_start: 20190401, // 契約日＝許可日＝開始日
        konryu_kigen: 20200101,
        konryu_date: 20200201,
        note: '契約備考',
        grave_mei: '碑文テキスト',
      },
    ]);

    const idMaps = createIdMaps();
    idMaps.physicalPlot.set(500, 'pp-1'); // rebuildIdMap を no-op にする

    await stepContractPlot.run({ prisma, logger: buildLogger(), idMaps, dryRun: false });

    // 許可日/開始日＝契約日(contract_start) を代理投入（konryu は入れない）。komine-docs#10 Q4/Q5
    expect(contractPlotCreate).toHaveBeenCalledTimes(1);
    const cpData = contractPlotCreate.mock.calls[0][0].data;
    expect(cpData.contract_date).toEqual(cpData.permit_date);
    expect(cpData.contract_date).toEqual(cpData.start_date);
    expect(cpData.permit_date).toBeInstanceOf(Date);
    // konryu 値（建立期限 20200101）が permit に入っていないこと
    expect((cpData.permit_date as Date).getUTCFullYear()).toBe(2019);
    // 碑文(grave_mei)は契約備考へ統合
    expect(cpData.notes).toBe('契約備考\n碑文テキスト');

    // GravestoneInfo に建立期限/建立日が入る
    expect(gravestoneInfoCreate).toHaveBeenCalledTimes(1);
    const giData = gravestoneInfoCreate.mock.calls[0][0].data;
    expect(giData.establishment_deadline).toBeInstanceOf(Date);
    expect(giData.establishment_date).toBeInstanceOf(Date);
    expect(giData.contract_plot_id).toBe('cp-1');
  });
});
