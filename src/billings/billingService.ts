import { BillingRecordStatus, Prisma } from '@prisma/client';
import prisma from '../db/prisma';
import { recalculateContractPlotPaymentStatus } from '../plots/services/paymentStatusService';

/**
 * 請求 (Billing) のステータスを入金合計から自動計算する。
 *
 * 遷移ロジック:
 *  - written_off (貸倒処理): 自動遷移しない（手動設定を尊重）
 *  - terminated=true: 'terminated'
 *  - 入金合計 >= 請求額 (請求額 > 0): 'paid'
 *  - 現状 overdue: 'overdue' を維持（手動で設定された延滞ステータスを尊重。
 *    部分入金があっても全額入金までは延滞のまま — #302。解除は手動 #271）
 *  - 入金合計 > 0: 'partial_paid'
 *  - billing_date 設定済: 'billed'
 *  - それ以外: 'pending'
 */
export const computeBillingStatus = (
  billing: {
    amount: number;
    billing_date: Date | null;
    terminated: boolean;
    status: BillingRecordStatus;
  },
  paidAmount: number
): BillingRecordStatus => {
  if (billing.status === 'written_off') return 'written_off';
  if (billing.terminated) return 'terminated';
  if (billing.amount > 0 && paidAmount >= billing.amount) return 'paid';
  // 手動 overdue は partial_paid 算出より先に評価する（#302）。
  // 後に評価すると paid_amount>0 の請求への overdue 設定が 200 のまま
  // partial_paid に黙って巻き戻り、#271 が解消した無言破棄が残存する。
  if (billing.status === 'overdue') return 'overdue';
  if (paidAmount > 0) return 'partial_paid';
  if (billing.billing_date) return 'billed';
  return 'pending';
};

type BillingClient = Prisma.TransactionClient | typeof prisma;

/** 残額が 0 になった請求は、次に払う日を消す */
const clearedNextPaymentDate = (
  amount: number,
  paidAmount: number
): { next_payment_date: null } | Record<string, never> =>
  amount > 0 && paidAmount >= amount ? { next_payment_date: null } : {};

/**
 * 指定の Billing について、紐付く Payment 群から
 *  - paid_amount（入金合計）
 *  - last_payment_date（最終入金日）
 *  - status（自動算出）
 * を再集計して更新する。
 *
 * Payment の作成・更新・削除時に呼ばれる。
 */
export const recalculateBillingPayments = async (
  client: BillingClient,
  billingId: string
): Promise<void> => {
  const billing = await client.billing.findFirst({
    where: { id: billingId, deleted_at: null },
  });
  if (!billing) return;

  const payments = await client.payment.findMany({
    where: { billing_id: billingId, deleted_at: null },
    select: { payment_amount: true, payment_date: true },
  });

  // レガシー移行の入金実績の保全（#264）:
  // 移行 Billing（legacy_seikyu_cd 有）の paid_amount は t_seikyu.nyukin_goukei から
  // 直接投入され、対応する Payment 行が存在しないことがある（del_flg=1 入金は未移行、
  // 孤児入金は billing 未紐付け）。Payment 行が 0 件のままなら移行値を上書きせず、
  // status のみ既存 paid_amount から再算出する。
  // ※非レガシー Billing は対象外（最後の入金を削除→0 円に戻す正常系を維持）
  if (payments.length === 0 && billing.legacy_seikyu_cd !== null && billing.paid_amount > 0) {
    const preservedStatus = computeBillingStatus(billing, billing.paid_amount);
    await client.billing.update({
      where: { id: billingId },
      data: {
        status: preservedStatus,
        ...clearedNextPaymentDate(billing.amount, billing.paid_amount),
      },
    });
    await recalculateContractPlotPaymentStatus(client, billing.contract_plot_id);
    return;
  }

  const paidAmount = payments.reduce((sum, p) => sum + p.payment_amount, 0);
  const lastPaymentDate = payments.reduce<Date | null>((latest, p) => {
    if (!p.payment_date) return latest;
    if (!latest) return p.payment_date;
    return p.payment_date > latest ? p.payment_date : latest;
  }, null);

  const status = computeBillingStatus(billing, paidAmount);

  await client.billing.update({
    where: { id: billingId },
      data: {
        paid_amount: paidAmount,
        last_payment_date: lastPaymentDate,
        status,
        ...clearedNextPaymentDate(billing.amount, paidAmount),
      },
  });

  // 入金集計が変わったので、紐付く ContractPlot の payment_status も再計算する（#162）
  await recalculateContractPlotPaymentStatus(client, billing.contract_plot_id);
};
