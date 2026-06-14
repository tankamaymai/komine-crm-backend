/**
 * 契約役割（SaleContractRole）に割り当て可能な顧客かを検証する共通ガード（#394）
 *
 * 背景: changeContractor は新契約者に `deleted_at: null`（論理削除拒否）と
 * `is_terminated` 拒否（解約者拒否）を実装している（#311/#318/#319）。一方
 * updatePlot の roles 全件入替・createPlot/createPlotContract の roles 作成は
 * customerId の存在チェックしかしておらず、/customers/terminated（viewer 可）で得た
 * 解約者 UUID を roles に指定すると、解約者・論理削除顧客を active 契約の contractor に
 * できてしまっていた。changeContractor と同じ不変条件をこのヘルパで共有する。
 */
import { Prisma } from '@prisma/client';

import { ValidationError, NotFoundError } from '../../middleware/errorHandler';

type Tx = Prisma.TransactionClient;

/**
 * 指定 customerId が契約役割に割り当て可能かを検証する。
 * 違反時は例外を投げる（呼び出し側のトランザクションをロールバックさせる）。
 *
 * @param tx - Prisma トランザクションクライアント
 * @param customerId - 役割に割り当てたい顧客 UUID
 * @throws NotFoundError 顧客が存在しない / 論理削除済み
 * @throws ValidationError 解約済み（終了）顧客
 */
export const assertAssignableCustomer = async (tx: Tx, customerId: string): Promise<void> => {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true, deleted_at: true, is_terminated: true },
  });

  // 論理削除済み顧客は契約者に指定不可（changeContractor の deleted_at: null と整合）
  if (!customer || customer.deleted_at !== null) {
    throw new NotFoundError('指定された顧客が見つかりません');
  }

  // 終了顧客（is_terminated、del_flg=2 由来 #129）は契約者に指定不可
  if (customer.is_terminated) {
    throw new ValidationError('解約済み（終了）顧客は契約者に指定できません');
  }
};
