/**
 * ゆうちょ引き落とし結果の取り込み（突き合わせ・入金）
 */

const mockPrisma: any = {
  billing: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  payment: { create: jest.fn() },
  $transaction: jest.fn((callback: any) => callback(mockPrisma)),
};

jest.mock('../../src/db/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockFetchYuchoBillingData = jest.fn();
jest.mock('../../src/yucho/yuchoService', () => ({
  fetchYuchoBillingData: (...args: unknown[]) => mockFetchYuchoBillingData(...args),
}));

const mockRecalculateBillingPayments = jest.fn();
jest.mock('../../src/billings/billingService', () => ({
  recalculateBillingPayments: (...args: unknown[]) => mockRecalculateBillingPayments(...args),
}));

import { applyYuchoResult, previewYuchoResult } from '../../src/yucho/yuchoResultImport';
import { derivePayerCode } from '../../src/yucho/yuchoPayerCode';
import { YuchoResultFileError } from '../../src/yucho/yuchoResultFile';
import type { YuchoBillingItem } from '../../src/validations/yuchoValidation';
import { billingItem, buildResultFile } from './yuchoResultTestFile';

const withCode = (item: YuchoBillingItem): YuchoBillingItem => ({
  ...item,
  payerCode: derivePayerCode(item.customerId, item.contractPlotId),
});

const yamada = withCode(billingItem());
const sato = withCode(
  billingItem({
    contractPlotId: 'plot-2',
    customerId: 'cust-2',
    plotNumber: 'A-2',
    displayNumber: 'A-2',
    customerName: '佐藤花子',
    billingAmount: 6000,
    billingInfo: { ...billingItem().billingInfo!, yuchoSymbol: '18880', yuchoNumber: '7654321' },
  })
);

const billing = (overrides: Record<string, unknown> = {}) => ({
  id: 'bill-1',
  contract_plot_id: 'plot-1',
  amount: 12000,
  paid_amount: 0,
  status: 'billed',
  notes: null,
  use_start_year: 2027,
  use_end_year: 2027,
  ...overrides,
});

const params = (file: Buffer) => ({ year: 2027, month: 3, file });

describe('ゆうちょ引き落とし結果の取り込み', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((callback: any) => callback(mockPrisma));
    mockFetchYuchoBillingData.mockResolvedValue({ items: [yamada, sato] });
    mockPrisma.billing.findMany.mockResolvedValue([
      billing(),
      billing({ id: 'bill-2', contract_plot_id: 'plot-2', amount: 6000 }),
    ]);
    mockPrisma.billing.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve({
        id: where.id,
        customer_id: where.id === 'bill-1' ? 'cust-1' : 'cust-2',
        contract_plot_id: where.id === 'bill-1' ? 'plot-1' : 'plot-2',
        category: 'management_fee',
        amount: where.id === 'bill-1' ? 12000 : 6000,
        paid_amount: 0,
        status: 'billed',
        notes: null,
      })
    );
  });

  describe('中身の確認（書き込まない）', () => {
    it('引き落とせた人は入金を付ける、引き落とせなかった人は理由付きで分ける', async () => {
      const plan = await previewYuchoResult(
        params(
          buildResultFile([
            { item: yamada, code: '0' },
            { item: sato, code: '1' },
          ])
        )
      );

      expect(mockFetchYuchoBillingData).toHaveBeenCalledWith({
        year: 2027,
        month: 3,
        category: 'management',
        status: 'all',
      });
      expect(plan.transferDate).toBe('2027-03-16');
      expect(plan.monthMismatch).toBe(false);
      expect(plan.rows).toEqual([
        expect.objectContaining({
          status: 'will_record',
          billingId: 'bill-1',
          contractPlotId: 'plot-1',
          customerName: '山田太郎',
          amount: 12000,
          remainingAmount: 12000,
        }),
        expect.objectContaining({
          status: 'failed',
          resultLabel: '残高不足',
          billingId: 'bill-2',
          customerName: '佐藤花子',
        }),
      ]);
      expect(plan.summary.will_record).toEqual({ count: 1, amount: 12000 });
      expect(plan.summary.failed).toEqual({ count: 1, amount: 6000 });
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(mockPrisma.billing.update).not.toHaveBeenCalled();
    });

    it('支払人コードが無くても、記号・番号・金額で区画を当てる', async () => {
      const plan = await previewYuchoResult(
        params(buildResultFile([{ item: sato, code: '0', withPayerCode: false }]))
      );
      expect(plan.rows[0]).toEqual(
        expect.objectContaining({ status: 'will_record', contractPlotId: 'plot-2' })
      );
    });

    it('台帳に見つからない口座は「見つからない」に分ける', async () => {
      const stranger = billingItem({
        customerId: 'cust-x',
        contractPlotId: 'plot-x',
        billingInfo: {
          ...billingItem().billingInfo!,
          yuchoSymbol: '17770',
          yuchoNumber: '1111111',
        },
      });
      const plan = await previewYuchoResult(
        params(buildResultFile([{ item: stranger, code: '0', withPayerCode: false }]))
      );
      expect(plan.rows[0]).toEqual(
        expect.objectContaining({ status: 'unmatched', contractPlotId: null })
      );
    });

    it('もう払い済みの請求には付けない（二重取り込みしない）', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([
        billing({ paid_amount: 12000, status: 'paid' }),
      ]);
      const plan = await previewYuchoResult(params(buildResultFile([{ item: yamada, code: '0' }])));
      expect(plan.rows[0]!.status).toBe('already_paid');
    });

    it('その年の請求がまだ無ければ「請求なし」にする', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([
        billing({ use_start_year: 2026, use_end_year: 2026 }),
      ]);
      const plan = await previewYuchoResult(params(buildResultFile([{ item: yamada, code: '0' }])));
      expect(plan.rows[0]!.status).toBe('no_billing');
    });

    it('引き落とせた額が請求の残りより多ければ、自動では付けない', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([
        billing({ paid_amount: 5000, status: 'partial_paid' }),
      ]);
      const plan = await previewYuchoResult(params(buildResultFile([{ item: yamada, code: '0' }])));
      expect(plan.rows[0]).toEqual(
        expect.objectContaining({ status: 'amount_mismatch', remainingAmount: 7000 })
      );
    });

    it('ファイルの引き落とし月が選んだ月と違えば知らせる', async () => {
      const plan = await previewYuchoResult(
        params(buildResultFile([{ item: yamada, code: '0' }], { month: 4, day: 15 }))
      );
      expect(plan.monthMismatch).toBe(true);
    });

    it('送る前のファイルは止める', async () => {
      await expect(
        previewYuchoResult(
          params(buildResultFile([{ item: yamada, code: '0' }], { sentFile: true }))
        )
      ).rejects.toBeInstanceOf(YuchoResultFileError);
    });
  });

  describe('入金を付ける', () => {
    it('引き落とせた分だけ、引き落とし日で入金を作り、請求の入金合計を計算し直す', async () => {
      const result = await applyYuchoResult(
        params(
          buildResultFile([
            { item: yamada, code: '0' },
            { item: sato, code: '2' },
          ])
        )
      );

      expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.payment.create).toHaveBeenCalledWith({
        data: {
          billing_id: 'bill-1',
          customer_id: 'cust-1',
          contract_plot_id: 'plot-1',
          payment_date: new Date('2027-03-16T00:00:00Z'),
          payment_amount: 12000,
          fee_type: '管理料',
          notes: 'ゆうちょ自動払込（結果ファイル取り込み）',
        },
      });
      expect(mockRecalculateBillingPayments).toHaveBeenCalledWith(mockPrisma, 'bill-1');
      expect(result).toEqual(
        expect.objectContaining({
          recordedCount: 1,
          recordedAmount: 12000,
          notedFailedCount: 1,
          skippedCount: 0,
        })
      );
    });

    it('引き落とせなかった人は、請求の備考に日付と理由を残す（同じ行は二度書かない）', async () => {
      await applyYuchoResult(params(buildResultFile([{ item: sato, code: '2' }])));
      expect(mockPrisma.billing.update).toHaveBeenCalledWith({
        where: { id: 'bill-2' },
        data: { notes: 'ゆうちょ引き落とし不能 2027-03-16（口座なし）' },
      });

      jest.clearAllMocks();
      mockPrisma.$transaction.mockImplementation((callback: any) => callback(mockPrisma));
      mockFetchYuchoBillingData.mockResolvedValue({ items: [yamada, sato] });
      mockPrisma.billing.findMany.mockResolvedValue([
        billing({ id: 'bill-2', contract_plot_id: 'plot-2', amount: 6000 }),
      ]);
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: 'bill-2',
        amount: 6000,
        paid_amount: 0,
        status: 'billed',
        notes: '前からのメモ\nゆうちょ引き落とし不能 2027-03-16（口座なし）',
      });
      const again = await applyYuchoResult(params(buildResultFile([{ item: sato, code: '2' }])));
      expect(mockPrisma.billing.update).not.toHaveBeenCalled();
      expect(again.notedFailedCount).toBe(0);
    });

    it('確認のあとに窓口で払われていたら、入金は付けずに数だけ知らせる', async () => {
      mockPrisma.billing.findFirst.mockResolvedValue({
        id: 'bill-1',
        customer_id: 'cust-1',
        contract_plot_id: 'plot-1',
        category: 'management_fee',
        amount: 12000,
        paid_amount: 12000,
        status: 'paid',
        notes: null,
      });
      const result = await applyYuchoResult(params(buildResultFile([{ item: yamada, code: '0' }])));
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ recordedCount: 0, skippedCount: 1 }));
    });

    it('件数が多いときは50件ずつ区切って保存する', async () => {
      const many = Array.from({ length: 120 }, (_, i) =>
        withCode(
          billingItem({
            contractPlotId: `plot-m${i}`,
            customerId: `cust-m${i}`,
            billingInfo: {
              ...billingItem().billingInfo!,
              yuchoNumber: String(1000000 + i),
            },
          })
        )
      );
      mockFetchYuchoBillingData.mockResolvedValue({ items: many });
      mockPrisma.billing.findMany.mockResolvedValue(
        many.map((item, i) => billing({ id: `bill-m${i}`, contract_plot_id: item.contractPlotId }))
      );
      mockPrisma.billing.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve({
          id: where.id,
          customer_id: 'c',
          contract_plot_id: 'p',
          category: 'management_fee',
          amount: 12000,
          paid_amount: 0,
          status: 'billed',
          notes: null,
        })
      );

      const result = await applyYuchoResult(
        params(buildResultFile(many.map((item) => ({ item, code: '0' }))))
      );

      expect(result.recordedCount).toBe(120);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('lineFrom / lineTo で、その範囲の行だけに付ける', async () => {
      const result = await applyYuchoResult({
        ...params(
          buildResultFile([
            { item: yamada, code: '0' },
            { item: sato, code: '0' },
          ])
        ),
        lineFrom: 2,
        lineTo: 2,
      });
      expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.payment.create.mock.calls[0][0].data.billing_id).toBe('bill-2');
      expect(result.recordedCount).toBe(1);
      expect(result.plan.rows).toHaveLength(2);
    });

    it('払い済みや見つからない行には何も書かない', async () => {
      mockPrisma.billing.findMany.mockResolvedValue([
        billing({ paid_amount: 12000, status: 'paid' }),
      ]);
      const result = await applyYuchoResult(params(buildResultFile([{ item: yamada, code: '0' }])));
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(result.recordedCount).toBe(0);
    });
  });
});
