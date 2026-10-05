import {
  buildZenginDataRow,
  buildZenginEnd,
  buildZenginFile,
  buildZenginHeader,
  buildZenginTrailer,
} from '../../src/yucho/yuchoZengin';
import type { YuchoBillingItem } from '../../src/validations/yuchoValidation';
import type { YuchoBusinessSettings } from '../../src/yucho/yuchoSettings';

const settings: YuchoBusinessSettings = {
  clientCode: '1234567890',
  clientName: 'ｺﾐﾈﾚｲｴﾝ',
  businessSymbol: '19990',
  businessNumber: '12345671',
  businessAccountType: '1',
};

const item = (overrides: Partial<YuchoBillingItem> = {}): YuchoBillingItem => ({
  category: 'management',
  sourceId: 'fee-1',
  contractPlotId: 'plot-1',
  plotNumber: 'A-1',
  displayNumber: 'A-1',
  areaName: '第1期',
  contractDate: '2026-01-01',
  customerId: 'cust-1',
  customerName: '山田太郎',
  customerNameKana: 'ヤマダタロウ',
  billingAmount: 12000,
  billingStatus: 'unpaid',
  scheduledDate: null,
  billingMonth: 4,
  billingInfo: {
    bankName: 'ゆうちょ銀行',
    branchName: null,
    accountType: 'ordinary',
    accountNumber: null,
    accountHolder: 'ヤマダタロウ',
    yuchoSymbol: '19990',
    yuchoNumber: '12345671',
  },
  ...overrides,
});

describe('yuchoZengin', () => {
  it('header/data/trailer/end are each 120 characters', () => {
    expect(buildZenginHeader(settings, 5, 15)).toHaveLength(120);
    expect(buildZenginDataRow(item())).toHaveLength(120);
    expect(buildZenginTrailer([item()])).toHaveLength(120);
    expect(buildZenginEnd()).toHaveLength(120);
  });

  it('uses record types 1 / 2 / 8 / 9 and kind 91', () => {
    expect(buildZenginHeader(settings, 5, 15).startsWith('191')).toBe(true);
    expect(buildZenginDataRow(item()).startsWith('2')).toBe(true);
    expect(buildZenginTrailer([item()]).startsWith('8')).toBe(true);
    expect(buildZenginEnd().startsWith('9')).toBe(true);
  });

  it('puts transfer day as MMDD and amount as 10 digits', () => {
    const header = buildZenginHeader(settings, 5, 15);
    expect(header.slice(54, 58)).toBe('0515');
    const data = buildZenginDataRow(item());
    expect(data.slice(80, 90)).toBe('0000012000');
    expect(data.slice(20, 23)).toBe('999');
    expect(data.slice(43, 50)).toBe('1234567');
  });

  it('builds a complete file in official order', () => {
    const file = buildZenginFile({
      items: [item(), item({ sourceId: 'fee-2', billingInfo: null })],
      settings,
      transferMonth: 5,
      transferDay: 25,
    });
    const lines = file.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]![0]).toBe('1');
    expect(lines[1]![0]).toBe('2');
    expect(lines[2]![0]).toBe('8');
    expect(lines[3]![0]).toBe('9');
    expect(lines[2]!.slice(1, 7)).toBe('000001');
  });
});
