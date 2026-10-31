import {
  computeBillingStatus,
  recalculateBillingPayments,
} from '../../src/billings/billingService';

describe('computeBillingStatus', () => {
  const baseBilling = {
    amount: 10000,
    billing_date: null as Date | null,
    terminated: false,
    status: 'pending' as const,
  };

  it('keeps "written_off" status regardless of payments', () => {
    expect(computeBillingStatus({ ...baseBilling, status: 'written_off' }, 0)).toBe('written_off');
    expect(computeBillingStatus({ ...baseBilling, status: 'written_off' }, 99999)).toBe(
      'written_off'
    );
  });

  it('returns "terminated" when terminated=true (regardless of payments)', () => {
    expect(computeBillingStatus({ ...baseBilling, terminated: true }, 0)).toBe('terminated');
    expect(computeBillingStatus({ ...baseBilling, terminated: true }, 5000)).toBe('terminated');
  });

  it('returns "paid" when paid amount equals or exceeds billed amount', () => {
    expect(computeBillingStatus(baseBilling, 10000)).toBe('paid');
    expect(computeBillingStatus(baseBilling, 12000)).toBe('paid');
  });

  it('returns "partial_paid" when 0 < paid < amount', () => {
    expect(computeBillingStatus(baseBilling, 5000)).toBe('partial_paid');
    expect(computeBillingStatus(baseBilling, 9999)).toBe('partial_paid');
  });

  it('preserves "overdue" status when no payment is made', () => {
    expect(computeBillingStatus({ ...baseBilling, status: 'overdue' }, 0)).toBe('overdue');
  });

  it('preserves "overdue" status with partial payment (manual overdue not silently reverted, #302)', () => {
    // 部分入金済みの請求に手動 overdue を設定しても partial_paid に巻き戻らないこと。
    // 旧実装は paidAmount>0 判定が先に評価され、200 を返しつつ別 status が保存される
    // 無言破棄（#271 が解消したはずの挙動）が残存していた
    expect(computeBillingStatus({ ...baseBilling, status: 'overdue' }, 5000)).toBe('overdue');
    expect(computeBillingStatus({ ...baseBilling, status: 'overdue' }, 9999)).toBe('overdue');
  });

  it('transitions from overdue to paid when fully paid', () => {
    expect(computeBillingStatus({ ...baseBilling, status: 'overdue' }, 10000)).toBe('paid');
    expect(computeBillingStatus({ ...baseBilling, status: 'overdue' }, 12000)).toBe('paid');
  });

  it('returns "billed" when billing_date is set and no payment yet', () => {
    expect(computeBillingStatus({ ...baseBilling, billing_date: new Date('2026-04-01') }, 0)).toBe(
      'billed'
    );
  });

  it('returns "pending" when no billing_date and no payment', () => {
    expect(computeBillingStatus(baseBilling, 0)).toBe('pending');
  });

  it('does not return "paid" when amount is 0 and no payment recorded', () => {
    // Edge case: 請求額 0 円で入金 0 円の場合は pending（amount > 0 を条件にしているため）
    expect(computeBillingStatus({ ...baseBilling, amount: 0 }, 0)).toBe('pending');
  });
});

describe('recalculateBillingPayments', () => {
  let billingFindFirst: jest.Mock;
  let billingFindMany: jest.Mock;
  let paymentFindMany: jest.Mock;
  let billingUpdate: jest.Mock;
  let contractPlotFindFirst: jest.Mock;
  let contractPlotUpdate: jest.Mock;

  const buildClient = () => {
    billingFindFirst = jest.fn();
    // ContractPlot.payment_status の再計算が読む請求一覧（既定: 空）
    billingFindMany = jest.fn().mockResolvedValue([]);
    paymentFindMany = jest.fn();
    billingUpdate = jest.fn();
    contractPlotFindFirst = jest.fn().mockResolvedValue({ payment_status: 'unpaid' });
    contractPlotUpdate = jest.fn();
    return {
      billing: {
        findFirst: billingFindFirst,
        findMany: billingFindMany,
        update: billingUpdate,
      },
      payment: {
        findMany: paymentFindMany,
      },
      contractPlot: {
        findFirst: contractPlotFindFirst,
        update: contractPlotUpdate,
      },
    } as unknown as Parameters<typeof recalculateBillingPayments>[0];
  };

  it('updates paid_amount, last_payment_date, and computed status', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: new Date('2026-03-01'),
      terminated: false,
      status: 'billed',
    });
    paymentFindMany.mockResolvedValue([
      { payment_amount: 4000, payment_date: new Date('2026-04-01') },
      { payment_amount: 6000, payment_date: new Date('2026-05-01') },
    ]);

    await recalculateBillingPayments(client, 'b1');

    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        paid_amount: 10000,
        last_payment_date: new Date('2026-05-01'),
        status: 'paid',
        next_payment_date: null,
      },
    });
  });

  it('handles empty payments (returns to pending if no billing_date)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: null,
      terminated: false,
      status: 'pending',
    });
    paymentFindMany.mockResolvedValue([]);

    await recalculateBillingPayments(client, 'b1');

    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        paid_amount: 0,
        last_payment_date: null,
        status: 'pending',
      },
    });
  });

  it('レガシー移行 Billing（legacy_seikyu_cd 有・Payment 0件）は移行済み paid_amount を保全し status のみ再算出する (#264)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: new Date('2020-03-01'),
      terminated: false,
      status: 'paid',
      paid_amount: 10000, // t_seikyu.nyukin_goukei 由来（対応する Payment 行は未移行）
      legacy_seikyu_cd: 12345,
      contract_plot_id: 'cp1',
    });
    paymentFindMany.mockResolvedValue([]);

    await recalculateBillingPayments(client, 'b1');

    // paid_amount / last_payment_date は上書きせず、status のみ既存 paid_amount から再算出
    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'paid', next_payment_date: null },
    });
  });

  it('レガシー移行 Billing でも Payment 行が存在すれば通常どおり再集計する (#264)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: new Date('2020-03-01'),
      terminated: false,
      status: 'paid',
      paid_amount: 10000,
      legacy_seikyu_cd: 12345,
      contract_plot_id: 'cp1',
    });
    paymentFindMany.mockResolvedValue([
      { payment_amount: 4000, payment_date: new Date('2020-04-01') },
    ]);

    await recalculateBillingPayments(client, 'b1');

    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        paid_amount: 4000,
        last_payment_date: new Date('2020-04-01'),
        status: 'partial_paid',
      },
    });
  });

  it('非レガシー Billing は Payment 0件で paid_amount を 0 に戻す（最後の入金削除の正常系を維持） (#264)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: new Date('2026-03-01'),
      terminated: false,
      status: 'partial_paid',
      paid_amount: 5000,
      legacy_seikyu_cd: null,
      contract_plot_id: 'cp1',
    });
    paymentFindMany.mockResolvedValue([]);

    await recalculateBillingPayments(client, 'b1');

    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        paid_amount: 0,
        last_payment_date: null,
        status: 'billed',
      },
    });
  });

  it('skips update when billing not found', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue(null);

    await recalculateBillingPayments(client, 'missing');

    expect(paymentFindMany).not.toHaveBeenCalled();
    expect(billingUpdate).not.toHaveBeenCalled();
  });

  it('treats payments without payment_date correctly (no last_payment_date update)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      amount: 10000,
      billing_date: new Date('2026-03-01'),
      terminated: false,
      status: 'billed',
    });
    paymentFindMany.mockResolvedValue([
      { payment_amount: 3000, payment_date: null },
      { payment_amount: 2000, payment_date: null },
    ]);

    await recalculateBillingPayments(client, 'b1');

    expect(billingUpdate).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: {
        paid_amount: 5000,
        last_payment_date: null,
        status: 'partial_paid',
      },
    });
  });

  it('recalculates the linked ContractPlot.payment_status after updating the billing (#162)', async () => {
    const client = buildClient();
    billingFindFirst.mockResolvedValue({
      id: 'b1',
      contract_plot_id: 'cp1',
      amount: 10000,
      billing_date: new Date('2026-03-01'),
      terminated: false,
      status: 'billed',
    });
    paymentFindMany.mockResolvedValue([
      { payment_amount: 10000, payment_date: new Date('2026-05-01') },
    ]);
    // 区画には他に未入金の管理料請求が残っている → 区画全体は partial_paid
    // 未収金額は管理料限定（komine-docs#10 項目2）: 未払いの 5000 は管理料なので未収=5000
    billingFindMany.mockResolvedValue([
      { amount: 10000, paid_amount: 10000, terminated: false, category: 'usage_fee' },
      { amount: 5000, paid_amount: 0, terminated: false, category: 'management_fee' },
    ]);

    await recalculateBillingPayments(client, 'b1');

    expect(contractPlotFindFirst).toHaveBeenCalledWith({
      where: { id: 'cp1', deleted_at: null },
      select: { payment_status: true },
    });
    expect(contractPlotUpdate).toHaveBeenCalledWith({
      where: { id: 'cp1' },
      data: { payment_status: 'partial_paid', uncollected_amount: 5000 },
    });
  });
});
