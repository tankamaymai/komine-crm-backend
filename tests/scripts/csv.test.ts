/**
 * CSV 出力ユーティリティ（データクレンジングのリストアップ用）
 */
import { resolveOutPath, toCsv, toCsvCell } from '../../scripts/lib/csv';

describe('toCsvCell', () => {
  it('通常の値はそのまま出す', () => {
    expect(toCsvCell('A-56')).toBe('A-56');
    expect(toCsvCell(3.6)).toBe('3.6');
  });

  it('null / undefined は空セルにする', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('0 や false は空にせず値として出す', () => {
    expect(toCsvCell(0)).toBe('0');
    expect(toCsvCell(false)).toBe('false');
  });

  it('カンマ・改行を含む値は引用符で囲む', () => {
    expect(toCsvCell('28、29/2,30')).toBe('"28、29/2,30"');
    expect(toCsvCell('行1\n行2')).toBe('"行1\n行2"');
  });

  it('引用符は "" にエスケープする', () => {
    expect(toCsvCell('備考"あり"')).toBe('"備考""あり"""');
  });

  // Excel は先頭が = + - @ の値を数式として解釈する。区画表記に - 始まりがあるため無効化する
  it('数式として解釈され得る先頭文字はクォートで無効化する', () => {
    expect(toCsvCell('-30/2')).toBe("'-30/2");
    expect(toCsvCell('=1+1')).toBe("'=1+1");
    expect(toCsvCell('@name')).toBe("'@name");
    expect(toCsvCell('+81')).toBe("'+81");
  });
});

describe('toCsv', () => {
  it('ヘッダとデータを CRLF 区切りで出す', () => {
    const csv = toCsv(['区画', '面積'], [['A-56', 3.6]]);
    expect(csv).toBe('区画,面積\r\nA-56,3.6\r\n');
  });

  it('データ0件でもヘッダだけ出す（対象なしが分かるように）', () => {
    expect(toCsv(['区画'], [])).toBe('区画\r\n');
  });
});

describe('resolveOutPath', () => {
  it('--out で指定したパスを使う', () => {
    expect(resolveOutPath(['--out', 'foo/bar.csv'], 'default.csv')).toBe('foo/bar.csv');
  });

  it('未指定なら tmp/<既定名> を使う', () => {
    expect(resolveOutPath([], 'default.csv')).toBe('tmp/default.csv');
  });

  // `--out --dry-run` のように値が抜けた指定を次のフラグで埋めてしまわない
  it('--out の直後が別フラグなら既定名にフォールバックする', () => {
    expect(resolveOutPath(['--out', '--dry-run'], 'default.csv')).toBe('tmp/default.csv');
  });
});
