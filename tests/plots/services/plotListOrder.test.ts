import { compareLedgerOrder } from '../../../src/plots/services/plotListOrder';

const map = new Map<string, string>([
  ['A', '第1期'],
  ['B', '第1期'],
  ['1', '第2期'],
  ['10', '第3期'],
  ['樹林', '第3期樹林部'],
  ['るり庵', '第4期'],
]);

const row = (
  id: string,
  areaName: string,
  displayNumber: string | null,
  plotNumber = displayNumber ?? id
) => ({ id, areaName, displayNumber, plotNumber });

describe('台帳の初期順', () => {
  it('第1期が第2期より前に来ること', () => {
    const rows = [row('2', '1', '1'), row('1', 'A', 'A-1')].sort((a, b) =>
      compareLedgerOrder(a, b, map)
    );
    expect(rows.map((r) => r.areaName)).toEqual(['A', '1']);
  });

  it('期の順が第1期、第2期、第3期、樹林部、第4期、その他になること', () => {
    const rows = [
      row('x', 'unknown', 'x'),
      row('4', 'るり庵', 'るり庵-1'),
      row('3t', '樹林', '樹林-1'),
      row('3', '10', '10-1'),
      row('2', '1', '1-1'),
      row('1', 'B', 'B-1'),
    ].sort((a, b) => compareLedgerOrder(a, b, map));
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3', '3t', '4', 'x']);
  });

  it('同じ期の中ではエリア名の順になること', () => {
    const rows = [row('b', 'B', 'B-1'), row('a', 'A', 'A-1')].sort((a, b) =>
      compareLedgerOrder(a, b, map)
    );
    expect(rows.map((r) => r.areaName)).toEqual(['A', 'B']);
  });

  it('表示用番号が空の行は末尾に残ること', () => {
    const rows = [row('empty', 'A', null, 'A-9'), row('filled', 'A', 'A-2')].sort((a, b) =>
      compareLedgerOrder(a, b, map, 'desc')
    );
    expect(rows.map((r) => r.id)).toEqual(['filled', 'empty']);
  });
});
