/**
 * 回帰テスト: 移行ステップの冪等性（#220, #221, #222）
 *
 * step07/08/09 はレガシー自然キー（legacy_family_cd / legacy_maisou_cd /
 * legacy_construction_id）で既存をスキップし、step06 の別人申込者パスは
 * applicant ロールの存在で Customer 生成ごとスキップする。
 * --truncate なしの再実行で重複INSERTされないことを検証する。
 */
import type { PrismaClient } from '@prisma/client';

import { createIdMaps } from '../../../../scripts/legacy-migration/idMap';

jest.mock('../../../../scripts/legacy-migration/legacyDb', () => ({
  legacyQuery: jest.fn(),
}));

import { legacyQuery } from '../../../../scripts/legacy-migration/legacyDb';
import { stepFamilyContact } from '../../../../scripts/legacy-migration/steps/07-family-contact';
import { stepBuriedPerson } from '../../../../scripts/legacy-migration/steps/08-buried-person';
import { stepConstructionInfo } from '../../../../scripts/legacy-migration/steps/09-construction-info';
import { stepSaleContractRole } from '../../../../scripts/legacy-migration/steps/06-sale-contract-role';
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

describe('移行ステップの冪等性 (#220)', () => {
  beforeEach(() => {
    mockedLegacyQuery.mockReset();
  });

  it('stepFamilyContact: legacy_family_cd が既存ならスキップし重複INSERTしない', async () => {
    const familyContactCreate = jest.fn();
    const prisma = {
      customer: { findMany: jest.fn().mockResolvedValue([{ id: 'cust-1', legacy_danka_cd: 100 }]) },
      contractPlot: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cp-1', legacy_grave_cd: 500 }]),
      },
      familyContact: {
        create: familyContactCreate,
        findUnique: jest.fn().mockResolvedValue({ id: 'fc-existing', legacy_family_cd: 1 }),
      },
      relationshipMaster: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    mockedLegacyQuery
      .mockResolvedValueOnce([{ danka_cd: 100, grave_cd: 500 }])
      // 解約者 danka（del_flg=2）ルックアップ（#311）
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          family_cd: 1,
          danka_cd: 100,
          family_sei: '山田',
          family_mei: '太郎',
          addr1: null,
          addr2: null,
          addr3: null,
          job_addr1: null,
          job_addr2: null,
          job_addr3: null,
        },
      ]);

    const idMaps = createIdMaps();
    const result = await stepFamilyContact.run({
      prisma,
      logger: buildLogger(),
      idMaps,
      dryRun: false,
    });

    expect(familyContactCreate).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.notes?.['skip_existing']).toBe(1);
  });

  it('stepBuriedPerson: legacy_maisou_cd が既存ならスキップし重複INSERTしない', async () => {
    const buriedPersonCreate = jest.fn();
    const prisma = {
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      contractPlot: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cp-1', legacy_grave_cd: 500 }]),
      },
      buriedPerson: {
        create: buriedPersonCreate,
        findUnique: jest.fn().mockResolvedValue({ id: 'bp-existing', legacy_maisou_cd: 7 }),
      },
      // step08 は喪主続柄を続柄マスタ名へ解決するため findMany を参照する（#394）
      relationshipMaster: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    mockedLegacyQuery.mockResolvedValueOnce([
      {
        maisou_cd: 7,
        danka_cd: 100,
        grave_cd: 500,
        maisousha_sei: '山田',
        maisousha_mei: '花子',
      },
    ]);

    const idMaps = createIdMaps();
    const result = await stepBuriedPerson.run({
      prisma,
      logger: buildLogger(),
      idMaps,
      dryRun: false,
    });

    expect(buriedPersonCreate).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.notes?.['skip_existing']).toBe(1);
  });

  it('stepConstructionInfo: legacy_construction_id が既存ならスキップし重複INSERTしない', async () => {
    const constructionInfoCreate = jest.fn();
    const prisma = {
      contractPlot: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cp-1', legacy_grave_cd: 500 }]),
      },
      constructionInfo: {
        create: constructionInfoCreate,
        findUnique: jest.fn().mockResolvedValue({ id: 'ci-existing', legacy_construction_id: 9 }),
      },
      contractorMaster: { upsert: jest.fn() },
    } as unknown as PrismaClient;

    mockedLegacyQuery.mockResolvedValueOnce([
      {
        construction_id: 9,
        grave_cd: 500,
        danka_cd: 100,
        gyousha_cd: null,
        construction_type: null,
      },
    ]);

    const idMaps = createIdMaps();
    const result = await stepConstructionInfo.run({
      prisma,
      logger: buildLogger(),
      idMaps,
      dryRun: false,
    });

    expect(constructionInfoCreate).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.notes?.['skip_existing']).toBe(1);
  });
});

describe('step06 別人申込者パスの冪等性 (#221, #222)', () => {
  beforeEach(() => {
    mockedLegacyQuery.mockReset();
  });

  const buildPrisma = (overrides: Record<string, unknown> = {}) =>
    ({
      customer: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cust-1', legacy_danka_cd: 100 }]),
        create: jest.fn().mockResolvedValue({ id: 'applicant-1' }),
      },
      contractPlot: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cp-1', legacy_grave_cd: 500 }]),
      },
      saleContractRole: {
        upsert: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      // 主契約者カナの一括 backfill（#282）が使う raw クエリ
      $executeRaw: jest.fn().mockResolvedValue(0),
      ...overrides,
    }) as unknown as PrismaClient;

  // 契約者(owner)と申込者(request)が別人の行
  const differentPersonRow = {
    danka_cd: 100,
    grave_cd: 500,
    request_sei: '佐藤',
    request_sei_kana: 'サトウ',
    request_mei: '次郎',
    request_mei_kana: 'ジロウ',
    request_zip: 1500001,
    request_addr1: '東京都',
    request_addr2: '渋谷区',
    request_addr3: null,
    request_tel1: '0312345678',
    owner_sei: '山田',
    owner_mei: '太郎',
  };

  it('applicant ロールが未存在なら申込者Customerを legacy_applicant_danka_cd 付きで作成する', async () => {
    const prisma = buildPrisma();
    mockedLegacyQuery.mockResolvedValueOnce([differentPersonRow]);

    const idMaps = createIdMaps();
    await stepSaleContractRole.run({ prisma, logger: buildLogger(), idMaps, dryRun: false });

    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '佐藤 次郎',
          legacy_applicant_danka_cd: 100,
        }),
      })
    );
    expect(prisma.saleContractRole.create).toHaveBeenCalledTimes(1);
  });

  it('applicant ロールが既存なら申込者Customerを生成しない（再実行で重複しない）', async () => {
    const prisma = buildPrisma({
      saleContractRole: {
        upsert: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: 'role-existing', role: 'applicant' }),
        create: jest.fn(),
      },
    });
    mockedLegacyQuery.mockResolvedValueOnce([differentPersonRow]);

    const idMaps = createIdMaps();
    const result = await stepSaleContractRole.run({
      prisma,
      logger: buildLogger(),
      idMaps,
      dryRun: false,
    });

    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.saleContractRole.create).not.toHaveBeenCalled();
    // 件数整合のため applicant はカウントされる（再実行でも合計が一致する）
    expect(result.inserted).toBeGreaterThan(0);
  });
});

describe('dry-run resume の追加ケース (#224)', () => {
  beforeEach(() => {
    mockedLegacyQuery.mockReset();
  });

  it('stepContractPlot: dry-run で idMap が空でも physicalPlot を新DBから再構築し throw しない', async () => {
    const physicalPlotFindMany = jest
      .fn()
      .mockResolvedValue([{ id: 'pp-1', plot_number: 'legacy-500' }]);
    const prisma = {
      physicalPlot: { findMany: physicalPlotFindMany },
      contractPlot: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    // レガシー行なし（resume パスが throw しないことだけを検証）
    mockedLegacyQuery.mockResolvedValue([]);

    const idMaps = createIdMaps();
    const { stepContractPlot } =
      await import('../../../../scripts/legacy-migration/steps/05-contract-plot');

    await expect(
      stepContractPlot.run({ prisma, logger: buildLogger(), idMaps, dryRun: true })
    ).resolves.toBeDefined();

    // 旧挙動（if (!dryRun) ガード）ではここが呼ばれず assertIdMapsReady で throw していた
    expect(physicalPlotFindMany).toHaveBeenCalled();
    expect(idMaps.physicalPlot.size).toBe(1);
  });

  it('stepSaleContractRole: dry-run で idMap が空でも新DBから再構築し throw しない', async () => {
    const customerFindMany = jest.fn().mockResolvedValue([{ id: 'cust-1', legacy_danka_cd: 100 }]);
    const contractPlotFindMany = jest
      .fn()
      .mockResolvedValue([{ id: 'cp-1', legacy_grave_cd: 500 }]);
    const prisma = {
      customer: { findMany: customerFindMany, create: jest.fn() },
      contractPlot: { findMany: contractPlotFindMany },
      saleContractRole: { upsert: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    } as unknown as PrismaClient;

    mockedLegacyQuery.mockResolvedValueOnce([differentlessRow()]);

    const idMaps = createIdMaps();
    const result = await stepSaleContractRole.run({
      prisma,
      logger: buildLogger(),
      idMaps,
      dryRun: true,
    });

    expect(customerFindMany).toHaveBeenCalledTimes(1);
    expect(contractPlotFindMany).toHaveBeenCalledTimes(1);
    expect(idMaps.customer.size).toBe(1);
    expect(idMaps.contractPlot.size).toBe(1);
    expect(result.inserted).toBeGreaterThan(0);
    // dry-run なので書き込みなし
    expect(prisma.saleContractRole.upsert).not.toHaveBeenCalled();

    function differentlessRow() {
      return {
        danka_cd: 100,
        grave_cd: 500,
        request_sei: null,
        request_sei_kana: null,
        request_mei: null,
        request_mei_kana: null,
        request_zip: null,
        request_addr1: null,
        request_addr2: null,
        request_addr3: null,
        request_tel1: null,
        owner_sei: '山田',
        owner_mei: '太郎',
      };
    }
  });
});
