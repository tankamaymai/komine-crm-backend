import iconv from 'iconv-lite';
import { parseYuchoResultFile, YuchoResultFileError } from '../../src/yucho/yuchoResultFile';
import { billingItem, buildResultFile } from './yuchoResultTestFile';

describe('parseYuchoResultFile', () => {
  it('引き落とし日・記号・番号・カナ・金額・支払人コード・結果を読む', () => {
    const file = buildResultFile([
      { item: billingItem(), code: '0' },
      { item: billingItem({ billingAmount: 6000 }), code: '1', withPayerCode: false },
    ]);

    const parsed = parseYuchoResultFile(file);

    expect(parsed.transferMonth).toBe(3);
    expect(parsed.transferDay).toBe(16);
    expect(parsed.records).toEqual([
      expect.objectContaining({
        lineNo: 1,
        branchCode: '999',
        accountNumber: '1234567',
        kana: 'ﾔﾏﾀﾞﾀﾛｳ',
        amount: 12000,
        payerCode: expect.stringMatching(/^\d{20}$/),
        resultCode: '0',
      }),
      expect.objectContaining({ lineNo: 2, amount: 6000, payerCode: null, resultCode: '1' }),
    ]);
    expect(parsed.trailer).toEqual({
      processedCount: 1,
      processedAmount: 12000,
      failedCount: 1,
      failedAmount: 6000,
    });
  });

  it('改行なしで120バイトずつ続くファイルも読む', () => {
    const file = buildResultFile([{ item: billingItem(), code: '0' }], { newline: false });
    expect(parseYuchoResultFile(file).records).toHaveLength(1);
  });

  it('送る前のファイル（処理済・不能が0件）は止める', () => {
    const file = buildResultFile([{ item: billingItem(), code: '0' }], { sentFile: true });
    expect(() => parseYuchoResultFile(file)).toThrow(/ゆうちょへ送ったファイルのようです/);
  });

  it('120文字でない行があれば止める', () => {
    const file = iconv.encode('191 short\r\n', 'Shift_JIS');
    expect(() => parseYuchoResultFile(file)).toThrow(YuchoResultFileError);
  });

  it('自動払込み（種別91）以外は止める', () => {
    const text = buildResultFile([{ item: billingItem(), code: '0' }]).toString('latin1');
    const other = Buffer.from('121' + text.slice(3), 'latin1');
    expect(() => parseYuchoResultFile(other)).toThrow(/自動払込みの結果ファイルではありません/);
  });

  it('空のファイルは止める', () => {
    expect(() => parseYuchoResultFile(Buffer.from(''))).toThrow('ファイルが空です');
  });
});
