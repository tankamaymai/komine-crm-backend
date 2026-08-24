/**
 * 空き区画の範囲一括登録（議事録 2026-07-21 §6）
 *
 * 「何番から何番まで」で空き区画をまとめて作る。既に登録済みの番号はスキップし、
 * 何をスキップしたかを呼び出し側へ返す（区画増設で一部だけ先に登録済みの運用に対応）。
 */
import {
  BULK_REGISTER_MAX_COUNT,
  buildPlotNumbersInRange,
  splitByExisting,
} from '../../../src/plots/services/bulkPhysicalPlotService';

describe('buildPlotNumbersInRange', () => {
  it('接頭辞なしなら display は連番、plot_number は区画名を前置する', () => {
    const result = buildPlotNumbersInRange({ areaName: 'C', startNumber: 1, endNumber: 3 });

    expect(result).toEqual([
      { plotNumber: 'C-1', displayNumber: '1' },
      { plotNumber: 'C-2', displayNumber: '2' },
      { plotNumber: 'C-3', displayNumber: '3' },
    ]);
  });

  it('接頭辞ありなら display にも plot_number にも接頭辞が入る', () => {
    const result = buildPlotNumbersInRange({
      areaName: '凛B',
      prefix: 'A-',
      startNumber: 10,
      endNumber: 11,
    });

    expect(result).toEqual([
      { plotNumber: '凛B-A-10', displayNumber: 'A-10' },
      { plotNumber: '凛B-A-11', displayNumber: 'A-11' },
    ]);
  });

  it('開始と終了が同じなら1件だけ作る', () => {
    expect(buildPlotNumbersInRange({ areaName: 'C', startNumber: 5, endNumber: 5 })).toEqual([
      { plotNumber: 'C-5', displayNumber: '5' },
    ]);
  });

  it('0 から始まる範囲も作れる（実データに display_number "0" が存在する）', () => {
    const result = buildPlotNumbersInRange({ areaName: 'A', startNumber: 0, endNumber: 1 });

    expect(result.map((r) => r.displayNumber)).toEqual(['0', '1']);
  });

  it('接頭辞の前後空白は落とす（貼り付け由来の空白で番号がずれるのを防ぐ）', () => {
    const result = buildPlotNumbersInRange({
      areaName: 'C',
      prefix: '  A-  ',
      startNumber: 1,
      endNumber: 1,
    });

    expect(result).toEqual([{ plotNumber: 'C-A-1', displayNumber: 'A-1' }]);
  });

  it('開始が終了より大きい場合は弾く', () => {
    expect(() => buildPlotNumbersInRange({ areaName: 'C', startNumber: 10, endNumber: 1 })).toThrow(
      '開始番号は終了番号以下で指定してください'
    );
  });

  // 1〜99999 のような誤入力で数万件が入る事故を防ぐ
  it(`一度に ${BULK_REGISTER_MAX_COUNT} 件を超える範囲は弾く`, () => {
    expect(() =>
      buildPlotNumbersInRange({
        areaName: 'C',
        startNumber: 1,
        endNumber: BULK_REGISTER_MAX_COUNT + 1,
      })
    ).toThrow(`一度に登録できるのは${BULK_REGISTER_MAX_COUNT}件までです`);
  });

  it(`ちょうど ${BULK_REGISTER_MAX_COUNT} 件は通す（境界）`, () => {
    const result = buildPlotNumbersInRange({
      areaName: 'C',
      startNumber: 1,
      endNumber: BULK_REGISTER_MAX_COUNT,
    });

    expect(result).toHaveLength(BULK_REGISTER_MAX_COUNT);
  });
});

describe('splitByExisting', () => {
  const candidates = [
    { plotNumber: 'C-1', displayNumber: '1' },
    { plotNumber: 'C-2', displayNumber: '2' },
    { plotNumber: 'C-3', displayNumber: '3' },
  ];

  it('既存の番号はスキップし、残りを登録対象にする', () => {
    const { toCreate, skipped } = splitByExisting(candidates, ['C-2']);

    expect(toCreate.map((c) => c.plotNumber)).toEqual(['C-1', 'C-3']);
    expect(skipped).toEqual([
      { plotNumber: 'C-2', displayNumber: '2', reason: 'この区画番号は既に登録されています' },
    ]);
  });

  it('既存が無ければ全件を登録対象にする', () => {
    const { toCreate, skipped } = splitByExisting(candidates, []);

    expect(toCreate).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it('全件が既存ならスキップのみになる', () => {
    const { toCreate, skipped } = splitByExisting(candidates, ['C-1', 'C-2', 'C-3']);

    expect(toCreate).toHaveLength(0);
    expect(skipped).toHaveLength(3);
  });

  it('候補に無い既存番号は無視する', () => {
    const { toCreate, skipped } = splitByExisting(candidates, ['C-99']);

    expect(toCreate).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it('元の順序を保つ（登録結果が番号順に並ぶように）', () => {
    const { toCreate } = splitByExisting(candidates, ['C-1']);

    expect(toCreate.map((c) => c.displayNumber)).toEqual(['2', '3']);
  });
});
