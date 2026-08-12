/**
 * 合祀カウントダウンの起点＝最終納骨者の埋葬日（議事録 2026-07-21 §1）
 *
 * 業務要望: 最後の納骨者を登録した時点から合祀までの所定年数のカウントダウンを開始したい。
 * 契約人数と実際の納骨人数が一致しないケース（4人契約だが3人で終了）があるため、
 * 埋葬上限人数の到達では最終納骨を判定できず BuriedPerson.is_final_burial で確定させる。
 *
 * 契約日起点へのフォールバック側は collectiveBurialBillingBasis.test.ts で担保する。
 */
import { PrismaClient } from '@prisma/client';

import {
  findFinalBurialDate,
  resolveCountdownBaseDate,
  resolveBillingScheduledDate,
  updateCollectiveBurialCount,
} from '../../src/collective-burials/utils';

type MockPrisma = {
  collectiveBurial: { findUnique: jest.Mock; update: jest.Mock };
  buriedPerson: { count: jest.Mock; findFirst: jest.Mock };
  contractPlot: { findUnique: jest.Mock };
};

const buildPrisma = (): MockPrisma => ({
  collectiveBurial: { findUnique: jest.fn(), update: jest.fn() },
  buriedPerson: { count: jest.fn(), findFirst: jest.fn() },
  contractPlot: { findUnique: jest.fn() },
});

const CB_ROW = {
  id: 'cb1',
  contract_plot_id: 'cp1',
  burial_capacity: 4,
  current_burial_count: 2,
  capacity_reached_date: null,
  validity_period_years: 24,
  billing_scheduled_date: new Date('2043-04-01T00:00:00Z'),
  billing_scheduled_date_manual: false,
  billing_status: 'pending',
  billing_amount: null,
  notes: null,
  deleted_at: null,
};

/** MockPrisma を Prisma クライアントとして渡す（テスト用の絞り込み型） */
const asPrisma = (mock: MockPrisma) => mock as unknown as PrismaClient;

describe('resolveCountdownBaseDate', () => {
  const contractDate = new Date('2019-04-01T00:00:00Z');
  const finalBurialDate = new Date('2025-03-01T00:00:00Z');

  it('最終納骨日があればそれを起点にする', () => {
    expect(resolveCountdownBaseDate(contractDate, finalBurialDate)).toBe(finalBurialDate);
  });

  it('最終納骨日が無ければ契約日を起点にする', () => {
    expect(resolveCountdownBaseDate(contractDate, null)).toBe(contractDate);
  });

  it('どちらも無ければ null（請求予定日も立たない）', () => {
    expect(resolveCountdownBaseDate(null, null)).toBeNull();
  });

  // 最終納骨日は契約日より後になるのが通常だが、順序を仮定せず最終納骨日を優先する。
  // レガシー投入で契約日が誤っているケースを最終納骨日で救うため。
  it('契約日より前の最終納骨日でも最終納骨日を優先する', () => {
    const earlier = new Date('2010-01-01T00:00:00Z');
    expect(resolveCountdownBaseDate(contractDate, earlier)).toBe(earlier);
  });
});

describe('resolveBillingScheduledDate', () => {
  it('最終納骨日 + 有効期間で算出する', () => {
    const result = resolveBillingScheduledDate(
      new Date('2019-04-01T00:00:00Z'),
      24,
      new Date('2025-03-01T00:00:00Z')
    );
    expect(result?.toISOString()).toBe('2049-03-01T00:00:00.000Z');
  });

  it('最終納骨日を渡さない既存呼び出しは契約日起点のまま（後方互換）', () => {
    const result = resolveBillingScheduledDate(new Date('2019-04-01T00:00:00Z'), 24);
    expect(result?.toISOString()).toBe('2043-04-01T00:00:00.000Z');
  });

  it('起点が無ければ null', () => {
    expect(resolveBillingScheduledDate(null, 24)).toBeNull();
  });
});

describe('findFinalBurialDate', () => {
  it('最終納骨者かつ埋葬日ありの行のみを対象に、最も遅い埋葬日を取る', async () => {
    const prisma = buildPrisma();
    prisma.buriedPerson.findFirst.mockResolvedValue({
      burial_date: new Date('2025-03-01T00:00:00Z'),
    });

    const result = await findFinalBurialDate(asPrisma(prisma), 'cp1');

    expect(result?.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(prisma.buriedPerson.findFirst).toHaveBeenCalledWith({
      where: {
        contract_plot_id: 'cp1',
        is_final_burial: true,
        deleted_at: null,
        burial_date: { not: null },
      },
      select: { burial_date: true },
      orderBy: { burial_date: 'desc' },
    });
  });

  it('最終納骨者が未確定なら null', async () => {
    const prisma = buildPrisma();
    prisma.buriedPerson.findFirst.mockResolvedValue(null);

    expect(await findFinalBurialDate(asPrisma(prisma), 'cp1')).toBeNull();
  });
});

describe('updateCollectiveBurialCount の請求予定日再計算', () => {
  const setup = (overrides: Partial<typeof CB_ROW> = {}) => {
    const prisma = buildPrisma();
    prisma.collectiveBurial.findUnique.mockResolvedValue({ ...CB_ROW, ...overrides });
    prisma.collectiveBurial.update.mockImplementation(({ data }: { data: unknown }) => data);
    prisma.buriedPerson.count.mockResolvedValue(3);
    prisma.contractPlot.findUnique.mockResolvedValue({
      contract_date: new Date('2019-04-01T00:00:00Z'),
    });
    return prisma;
  };

  it('最終納骨者が確定したら最終納骨日起点で再計算する', async () => {
    const prisma = setup();
    prisma.buriedPerson.findFirst.mockResolvedValue({
      burial_date: new Date('2025-03-01T00:00:00Z'),
    });

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    // 2025-03-01 + 24年
    expect(data.billing_scheduled_date.toISOString()).toBe('2049-03-01T00:00:00.000Z');
    expect(data.current_burial_count).toBe(3);
  });

  // 上限未到達（3/4）でも最終納骨者が確定していればカウントダウンが始まる。
  // これが議事録 §1「4人契約だが3人で終了」への対応そのもの。
  it('埋葬上限に達していなくても最終納骨者が確定していれば起点になる', async () => {
    const prisma = setup({ burial_capacity: 4 });
    prisma.buriedPerson.findFirst.mockResolvedValue({
      burial_date: new Date('2025-03-01T00:00:00Z'),
    });

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    expect(data.billing_scheduled_date.toISOString()).toBe('2049-03-01T00:00:00.000Z');
    // 上限未到達なので上限到達日は付かない
    expect(data.capacity_reached_date).toBeUndefined();
  });

  it('最終納骨者が外されたら契約日起点へ戻る', async () => {
    // 最終納骨日起点（2049-03-01）で保存済みの状態からフラグを外したケース
    const prisma = setup({ billing_scheduled_date: new Date('2049-03-01T00:00:00Z') });
    prisma.buriedPerson.findFirst.mockResolvedValue(null);

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    // 2019-04-01 + 24年
    expect(data.billing_scheduled_date.toISOString()).toBe('2043-04-01T00:00:00.000Z');
  });

  it('手動指定された請求予定日は上書きしない（例外運用 Q17）', async () => {
    const prisma = setup({ billing_scheduled_date_manual: true });
    prisma.buriedPerson.findFirst.mockResolvedValue({
      burial_date: new Date('2025-03-01T00:00:00Z'),
    });

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    expect(data.billing_scheduled_date).toBeUndefined();
    // 埋葬人数の同期自体は行う
    expect(data.current_burial_count).toBe(3);
    // 手動指定時は起点日の問い合わせすら不要
    expect(prisma.buriedPerson.findFirst).not.toHaveBeenCalled();
  });

  it('請求済（billed）の予定日は動かさない（発行済み請求の根拠日を保つ）', async () => {
    const prisma = setup({ billing_status: 'billed' });
    prisma.buriedPerson.findFirst.mockResolvedValue({
      burial_date: new Date('2025-03-01T00:00:00Z'),
    });

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    expect(data.billing_scheduled_date).toBeUndefined();
  });

  it('契約日も最終納骨日も無ければ null（契約日設定時に再計算される）', async () => {
    const prisma = setup();
    prisma.contractPlot.findUnique.mockResolvedValue({ contract_date: null });
    prisma.buriedPerson.findFirst.mockResolvedValue(null);

    await updateCollectiveBurialCount(asPrisma(prisma), 'cp1');

    const { data } = prisma.collectiveBurial.update.mock.calls[0][0];
    expect(data.billing_scheduled_date).toBeNull();
  });

  it('合祀情報が無い区画では何もしない', async () => {
    const prisma = buildPrisma();
    prisma.collectiveBurial.findUnique.mockResolvedValue(null);

    expect(await updateCollectiveBurialCount(asPrisma(prisma), 'cp1')).toBeNull();
    expect(prisma.collectiveBurial.update).not.toHaveBeenCalled();
  });
});
