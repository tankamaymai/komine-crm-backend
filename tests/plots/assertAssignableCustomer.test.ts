import { assertAssignableCustomer } from '../../src/plots/services/assertAssignableCustomer';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler';

describe('assertAssignableCustomer (#394 / #311・#318・#319 ガード共有)', () => {
  const makeTx = (customer: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(customer);
    return { tx: { customer: { findUnique } } as never, findUnique };
  };

  it('有効な顧客（deleted_at:null / is_terminated:false）は通過する', async () => {
    const { tx } = makeTx({ id: 'c-1', deleted_at: null, is_terminated: false });
    await expect(assertAssignableCustomer(tx, 'c-1')).resolves.toBeUndefined();
  });

  it('存在しない顧客は NotFoundError', async () => {
    const { tx } = makeTx(null);
    await expect(assertAssignableCustomer(tx, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('論理削除済み顧客は NotFoundError（changeContractor の deleted_at:null と整合）', async () => {
    const { tx } = makeTx({ id: 'c-2', deleted_at: new Date(), is_terminated: false });
    await expect(assertAssignableCustomer(tx, 'c-2')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('解約済み（終了）顧客は ValidationError で契約者指定を拒否', async () => {
    const { tx } = makeTx({ id: 'c-3', deleted_at: null, is_terminated: true });
    await expect(assertAssignableCustomer(tx, 'c-3')).rejects.toBeInstanceOf(ValidationError);
  });

  it('割り当て可否は id で 1 回だけ問い合わせる', async () => {
    const { tx, findUnique } = makeTx({ id: 'c-1', deleted_at: null, is_terminated: false });
    await assertAssignableCustomer(tx, 'c-1');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { id: 'c-1' } });
  });
});
