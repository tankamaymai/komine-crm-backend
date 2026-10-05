import {
  buildDebitCsv,
  buildDebitRow,
  buildPayerMasterCsv,
  buildPayerMasterRow,
  buildYuchoCsv,
  isExportableBillingItem,
  __internal,
} from '../../src/yucho/yuchoCsv';
import type { YuchoBillingItem } from '../../src/validations/yuchoValidation';

const baseItem = (overrides: Partial<YuchoBillingItem> = {}): YuchoBillingItem => ({
  category: 'management',
  sourceId: 'fee-1',
  contractPlotId: '11111111-2222-3333-4444-555555555555',
  plotNumber: 'A-1',
  areaName: '第1期',
  contractDate: '2026-01-01',
  customerId: 'cust-1',
  customerName: '山田太郎',
  customerNameKana: 'ヤマダタロウ',
  billingAmount: 12000,
  billingStatus: 'unpaid',
  scheduledDate: '2026-04-30',
  billingMonth: 4,
  billingInfo: {
    bankName: 'ゆうちょ銀行',
    branchName: '〇一八',
    accountType: 'ordinary',
    accountNumber: '1234567',
    accountHolder: 'ヤマダタロウ',
    yuchoSymbol: null,
    yuchoNumber: null,
  },
  ...overrides,
});

describe('yuchoCsv internals', () => {
  describe('toHalfWidthKana', () => {
    it('converts full-width katakana to half-width', () => {
      expect(__internal.toHalfWidthKana('ヤマダタロウ')).toBe('ﾔﾏﾀﾞﾀﾛｳ');
    });
    it('converts hiragana to half-width katakana', () => {
      expect(__internal.toHalfWidthKana('やまだ')).toBe('ﾔﾏﾀﾞ');
    });
    it('converts full-width digits/letters to half-width', () => {
      expect(__internal.toHalfWidthKana('ＡＢＣ１２３')).toBe('ABC123');
    });
    it('keeps ASCII unchanged', () => {
      expect(__internal.toHalfWidthKana('ABC 123')).toBe('ABC 123');
    });
    it('returns empty string for empty input', () => {
      expect(__internal.toHalfWidthKana('')).toBe('');
    });
  });

  describe('padRight / padLeftZero', () => {
    it('right-pads to width with spaces', () => {
      expect(__internal.padRight('AB', 5)).toBe('AB   ');
    });
    it('truncates if too long', () => {
      expect(__internal.padRight('ABCDEFG', 4)).toBe('ABCD');
    });
    it('zero-pads number to width', () => {
      expect(__internal.padLeftZero(123, 6)).toBe('000123');
    });
    it('strips non-digits before padding', () => {
      expect(__internal.padLeftZero('12,345', 6)).toBe('012345');
    });
    it('truncates to lower digits when too long', () => {
      expect(__internal.padLeftZero(1234567890, 6)).toBe('567890');
    });
  });

  describe('accountTypeCode', () => {
    it.each([
      ['ordinary', '1'],
      ['current', '2'],
      ['savings', '4'],
      [null, '1'],
      ['unknown', '1'],
    ])('maps %s → %s', (input, expected) => {
      expect(__internal.accountTypeCode(input as string | null)).toBe(expected);
    });
  });

  describe('extractBranchCode', () => {
    it('extracts ASCII branch code', () => {
      expect(__internal.extractBranchCode('018店')).toBe('018');
    });
    it('extracts kanji branch code', () => {
      expect(__internal.extractBranchCode('〇一八')).toBe('018');
    });
    it('returns 000 when no digits found', () => {
      expect(__internal.extractBranchCode('本店')).toBe('000');
    });
  });
});

describe('buildPayerMasterRow（公式名簿CSV）', () => {
  it('produces exactly 12 columns and starts with empty 委託者コード', () => {
    const cells = buildPayerMasterRow(baseItem()).split(',');
    expect(cells).toHaveLength(12);
    expect(cells[0]).toBe('');
    expect(cells[1]).toBe('9900');
    expect(cells[2]).toBe('');
    expect(cells[3]).toBe('');
    expect(cells[7]).toBe('1');
  });

  it('does not put amount in column 11 — that is the kanji name', () => {
    const cells = buildPayerMasterRow(baseItem()).split(',');
    expect(cells[10]).toBe('山田太郎');
    expect(cells[10]).not.toBe('12000');
  });

  it('puts 20-digit payer code in column 12, not flag 1', () => {
    const cells = buildPayerMasterRow(baseItem()).split(',');
    expect(cells[11]).toMatch(/^\d{20}$/);
    expect(cells[11]).not.toBe('1');
  });

  it('ゆうちょ記号があれば店番は記号の中央3桁を優先する', () => {
    const item = baseItem({
      billingInfo: { ...baseItem().billingInfo!, branchName: '〇一八', yuchoSymbol: '11280' },
    });
    expect(buildPayerMasterRow(item).split(',')[4]).toBe('128');
  });

  it('8桁ゆうちょ番号（末尾1）は7桁で出す', () => {
    const item = baseItem({
      billingInfo: { ...baseItem().billingInfo!, accountNumber: null, yuchoNumber: '12345671' },
    });
    expect(buildPayerMasterRow(item).split(',')[8]).toBe('1234567');
  });

  it('kana is half-width and not space-padded', () => {
    expect(buildPayerMasterRow(baseItem()).split(',')[9]).toBe('ﾔﾏﾀﾞﾀﾛｳ');
  });
});

describe('buildDebitRow（公式決済CSV）', () => {
  it('produces 4 columns: code1, code2, kana, amount', () => {
    const cells = buildDebitRow(baseItem()).split(',');
    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatch(/^\d{10}$/);
    expect(cells[1]).toMatch(/^\d{10}$/);
    expect(cells[2]).toBe('ﾔﾏﾀﾞﾀﾛｳ');
    expect(cells[3]).toBe('12000');
  });

  it('does not place amount in an 11th column', () => {
    expect(buildDebitRow(baseItem()).split(',')).toHaveLength(4);
  });
});

describe('buildDebitCsv / buildPayerMasterCsv', () => {
  it('debit CSV has no header and CRLF rows', () => {
    const csv = buildDebitCsv({ items: [baseItem()] });
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split(',')).toHaveLength(4);
  });

  it('master CSV starts with the official header', () => {
    const csv = buildPayerMasterCsv({ items: [baseItem()] });
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toContain('委託者コード');
    expect(lines[0]).toContain('支払人コード');
    expect(lines).toHaveLength(2);
  });

  it('skips items with no billingInfo or zero amount', () => {
    const items = [
      baseItem(),
      baseItem({ sourceId: 'fee-2', billingInfo: null }),
      baseItem({ sourceId: 'fee-3', billingAmount: 0 }),
    ];
    expect(
      buildDebitCsv({ items })
        .split('\r\n')
        .filter((l) => l.length > 0)
    ).toHaveLength(1);
  });

  it('returns empty string when no exportable items', () => {
    expect(buildYuchoCsv({ items: [] })).toBe('');
    expect(buildPayerMasterCsv({ items: [baseItem({ billingInfo: null })] })).toBe('');
  });
});

describe('isExportableBillingItem', () => {
  it('is true when billingInfo present and amount > 0', () => {
    expect(isExportableBillingItem(baseItem())).toBe(true);
  });
  it('is false when billingInfo is null', () => {
    expect(isExportableBillingItem(baseItem({ billingInfo: null }))).toBe(false);
  });
  it('is false when amount is 0', () => {
    expect(isExportableBillingItem(baseItem({ billingAmount: 0 }))).toBe(false);
  });

  describe('口座番号欠損の除外（#266）', () => {
    it('銀行名だけあり口座番号が null なら出力対象外（全0の不正振替行を防ぐ）', () => {
      const item = baseItem({
        billingInfo: { ...baseItem().billingInfo!, accountNumber: null, branchName: null },
      });
      expect(isExportableBillingItem(item)).toBe(false);
    });

    it('口座番号が空文字なら出力対象外', () => {
      const item = baseItem({
        billingInfo: { ...baseItem().billingInfo!, accountNumber: '' },
      });
      expect(isExportableBillingItem(item)).toBe(false);
    });

    it('口座番号が全0（実在しない値）なら出力対象外', () => {
      const item = baseItem({
        billingInfo: { ...baseItem().billingInfo!, accountNumber: '0000000' },
      });
      expect(isExportableBillingItem(item)).toBe(false);
    });

    it('口座番号が数字を含まない（記号のみ）なら出力対象外', () => {
      const item = baseItem({
        billingInfo: { ...baseItem().billingInfo!, accountNumber: '---' },
      });
      expect(isExportableBillingItem(item)).toBe(false);
    });

    it('ハイフン区切りの正常な口座番号は出力対象', () => {
      const item = baseItem({
        billingInfo: { ...baseItem().billingInfo!, accountNumber: '123-4567' },
      });
      expect(isExportableBillingItem(item)).toBe(true);
    });

    it('ゆうちょ番号が振替用に解釈不能（8桁で末尾≠1）でフォールバック口座番号も無ければ出力対象外 (#392)', () => {
      const item = baseItem({
        billingInfo: {
          ...baseItem().billingInfo!,
          accountNumber: null,
          yuchoNumber: '12345678', // 末尾≠1 → null 化されるため除外（静かに壊れた行を出さない）
        },
      });
      expect(isExportableBillingItem(item)).toBe(false);
    });

    it('8桁ゆうちょ番号（末尾チェックデジット1）は出力対象 (#392)', () => {
      const item = baseItem({
        billingInfo: {
          ...baseItem().billingInfo!,
          accountNumber: null,
          yuchoNumber: '12345671',
        },
      });
      expect(isExportableBillingItem(item)).toBe(true);
    });
  });
});

describe('normalizeOfficialKana', () => {
  it('converts long vowel to hyphen and small kana to large', () => {
    expect(__internal.normalizeOfficialKana('タロー')).toBe('ﾀﾛ-');
    expect(__internal.normalizeOfficialKana('ｧｲｳ')).toBe('ｱｲｳ');
  });
});
