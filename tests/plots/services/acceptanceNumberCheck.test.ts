import { ConflictError } from '../../../src/middleware/errorHandler';
import { assertAcceptanceNumberAvailable } from '../../../src/plots/services/acceptanceNumberCheck';

function txWith(found: { display_number: string | null; plot_number: string } | null) {
  return {
    contractPlot: {
      findFirst: jest.fn().mockResolvedValue(
        found
          ? { physicalPlot: found }
          : null
      ),
    },
  } as never;
}

describe('assertAcceptanceNumberAvailable', () => {
  it('空の番号は調べない', async () => {
    const tx = txWith({ display_number: 'A-1', plot_number: 'A-1' });
    await expect(assertAcceptanceNumberAvailable(tx, '  ', [], false)).resolves.toBeUndefined();
    expect(tx.contractPlot.findFirst).not.toHaveBeenCalled();
  });

  it('ほかに同じ番号がなければ通る', async () => {
    const tx = txWith(null);
    await expect(assertAcceptanceNumberAvailable(tx, '1476', [], false)).resolves.toBeUndefined();
  });

  it('重なっていて、続ける許可がなければ警告で止まる', async () => {
    const tx = txWith({ display_number: 'B-2', plot_number: 'legacy-2' });
    await expect(assertAcceptanceNumberAvailable(tx, '1476', ['self'], false)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it('重なっていても、このままと選んだら通る', async () => {
    const tx = txWith({ display_number: 'B-2', plot_number: 'legacy-2' });
    await expect(assertAcceptanceNumberAvailable(tx, '1476', [], true)).resolves.toBeUndefined();
  });
});
