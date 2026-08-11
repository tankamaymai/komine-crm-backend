/**
 * 分割販売区画の独自表記の解析（議事録 2026-07-21 §4）
 *
 * 実データ（display_number）に存在する表記を基準にする。
 * 自動訂正はせず、運用担当が手作業で訂正する判断材料を出すのが目的。
 */
import { describeShares, parseSplitPlotNotation } from '../../scripts/lib/splitPlotNotation';

describe('parseSplitPlotNotation', () => {
  it('単一区画は分割表記とみなさない', () => {
    const result = parseSplitPlotNotation('A-56');

    expect(result.isSplitNotation).toBe(false);
    expect(result.plotCount).toBe(1);
    expect(result.totalShare).toBe(1);
  });

  // 実データ: "28、29/2" → 区画28（全体）と 区画29の1/2 = 1.5区画分
  it('読点区切り＋「/2」を区画数と持分合計に分解する', () => {
    const result = parseSplitPlotNotation('28、29/2');

    expect(result.isSplitNotation).toBe(true);
    expect(result.plotCount).toBe(2);
    expect(result.totalShare).toBe(1.5);
    expect(result.tokens.map((t) => t.number)).toEqual(['28', '29']);
    expect(result.tokens.map((t) => t.share)).toEqual([1, 0.5]);
  });

  // 実データ: 全角カンマ「，」も混在している
  it('全角カンマ区切りも扱う', () => {
    const result = parseSplitPlotNotation('66/2，67，68/2');

    expect(result.plotCount).toBe(3);
    expect(result.totalShare).toBe(2);
    expect(result.tokens.map((t) => t.share)).toEqual([0.5, 1, 0.5]);
  });

  // 実データに1件だけ存在する半角読点 ､ (U+FF64)。手入力の表記ゆれなので落とさず拾う
  it('半角読点も区切りとして扱う', () => {
    const result = parseSplitPlotNotation('81､36,120/2,118/2');

    expect(result.plotCount).toBe(4);
    expect(result.tokens.map((t) => t.number)).toEqual(['81', '36', '120', '118']);
    expect(result.totalShare).toBe(3);
  });

  it('中黒区切りも扱う（複数区画のまとめ）', () => {
    const result = parseSplitPlotNotation('A-20・21・62・63');

    expect(result.plotCount).toBe(4);
    expect(result.totalShare).toBe(4);
    expect(result.tokens.every((t) => t.share === 1)).toBe(true);
  });

  it('区切りの前後に全角空白があっても解析できる', () => {
    const result = parseSplitPlotNotation('58　、　57/2');

    expect(result.plotCount).toBe(2);
    expect(result.tokens.map((t) => t.number)).toEqual(['58', '57']);
    expect(result.totalShare).toBe(1.5);
  });

  it('読点と全角カンマの混在も扱う', () => {
    const result = parseSplitPlotNotation('1，2/2，29、30/2');

    expect(result.plotCount).toBe(4);
    expect(result.totalShare).toBe(3);
  });

  // 実データ: "0、1、2、3" → 4区画まとめて1契約
  it('複数区画のまとめは持分1の合算になる', () => {
    const result = parseSplitPlotNotation('0、1、2、3');

    expect(result.plotCount).toBe(4);
    expect(result.totalShare).toBe(4);
    expect(result.isSplitNotation).toBe(true);
  });

  it('「/2」単体も持分表記として検出する', () => {
    const result = parseSplitPlotNotation('25/2');

    expect(result.isSplitNotation).toBe(true);
    expect(result.plotCount).toBe(1);
    expect(result.totalShare).toBe(0.5);
  });

  it('接頭辞つきでも区画番号部分を保つ', () => {
    const result = parseSplitPlotNotation('C-30/2、31/2');

    expect(result.tokens.map((t) => t.number)).toEqual(['C-30', '31']);
    expect(result.totalShare).toBe(1);
  });

  // 議事録の「四分の三」表記。display_number 上には現存しないが将来入り得る
  it('「N分のM」表記を分数として扱う', () => {
    const result = parseSplitPlotNotation('八の4分の3');

    expect(result.tokens[0]?.share).toBe(0.75);
    expect(result.totalShare).toBe(0.75);
  });

  it('0除算になる表記は持分不明にする（合計も null）', () => {
    const result = parseSplitPlotNotation('29/0');

    expect(result.tokens[0]?.share).toBeNull();
    expect(result.totalShare).toBeNull();
  });

  it('空・null は対象外として扱う', () => {
    for (const value of ['', '   ', null, undefined]) {
      const result = parseSplitPlotNotation(value);
      expect(result.isSplitNotation).toBe(false);
      expect(result.plotCount).toBe(0);
      expect(result.totalShare).toBeNull();
    }
  });

  it('区切り文字の連続や末尾の区切りで空トークンを作らない', () => {
    const result = parseSplitPlotNotation('28、、29/2、');

    expect(result.plotCount).toBe(2);
    expect(result.totalShare).toBe(1.5);
  });

  // "1/3" は「区画1の1/3」。分子側の数字は区画番号なので 1/3 + 1/3 = 0.667 になる。
  // 割り切れない持分の加算で誤差が出るため3桁で丸めていることの確認
  it('持分合計は3桁小数に丸める', () => {
    const result = parseSplitPlotNotation('1/3、2/3');

    expect(result.tokens.map((t) => t.number)).toEqual(['1', '2']);
    expect(result.totalShare).toBe(0.667);
  });
});

describe('describeShares', () => {
  it('持分を分数のまま人が読める形にする', () => {
    expect(describeShares(parseSplitPlotNotation('28、29/2'))).toBe('28=1, 29=1/2');
  });

  it('持分不明は「不明」と出す', () => {
    expect(describeShares(parseSplitPlotNotation('29/0'))).toBe('29=不明');
  });
});
