/**
 * レガシー面積文字列パーサ parseLegacyArea のテスト（システム確認 項目⑤）
 *
 * 実データ（usage_fees.area / management_fees.area）に出現する値:
 * "3.6" "0.2" "0.013" "2.475" "1" "0" 等の数値文字列。
 */
import { parseLegacyArea } from '../../scripts/legacy-migration/transforms';

describe('parseLegacyArea', () => {
  it('実データの代表値を正しくパースする', () => {
    expect(parseLegacyArea('3.6')).toBe(3.6);
    expect(parseLegacyArea('0.2')).toBe(0.2);
    expect(parseLegacyArea('0.013')).toBe(0.013);
    expect(parseLegacyArea('2.475')).toBe(2.475);
    expect(parseLegacyArea('1')).toBe(1);
    expect(parseLegacyArea('4.05')).toBe(4.05);
  });

  it('"0" はレガシーの登録値として 0 を返す（未設定扱いにしない）', () => {
    expect(parseLegacyArea('0')).toBe(0);
  });

  it('空・null・undefined は null', () => {
    expect(parseLegacyArea('')).toBeNull();
    expect(parseLegacyArea('   ')).toBeNull();
    expect(parseLegacyArea(null)).toBeNull();
    expect(parseLegacyArea(undefined)).toBeNull();
  });

  it('全角数字・全角小数点・㎡サフィックスに耐える', () => {
    expect(parseLegacyArea('３．６')).toBe(3.6);
    expect(parseLegacyArea('0.6㎡')).toBe(0.6);
    expect(parseLegacyArea('3.6 ㎡')).toBe(3.6);
    expect(parseLegacyArea('1,000')).toBeNull(); // 1000㎡ 以上は異常値
    expect(parseLegacyArea('12.5m2')).toBe(12.5);
  });

  it('数値化できない文字列・負値・異常値は null', () => {
    expect(parseLegacyArea('abc')).toBeNull();
    expect(parseLegacyArea('3.6坪')).toBeNull();
    expect(parseLegacyArea('-1')).toBeNull();
    expect(parseLegacyArea('1000')).toBeNull();
    expect(parseLegacyArea('1.2.3')).toBeNull();
  });

  it('小数第3位に丸める（numeric(6,3) 格納前提）', () => {
    expect(parseLegacyArea('0.0134')).toBe(0.013);
    expect(parseLegacyArea('2.4755')).toBe(2.476);
  });
});
