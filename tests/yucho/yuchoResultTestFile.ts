import iconv from 'iconv-lite';
import type { YuchoBillingItem } from '../../src/validations/yuchoValidation';
import { buildZenginDataRow, buildZenginEnd, buildZenginHeader } from '../../src/yucho/yuchoZengin';
import type { YuchoBusinessSettings } from '../../src/yucho/yuchoSettings';

export const settings: YuchoBusinessSettings = {
  clientCode: '1234567890',
  clientName: 'ｺﾐﾈﾚｲｴﾝ',
  businessSymbol: '19990',
  businessNumber: '12345671',
  businessAccountType: '1',
};

export const billingItem = (overrides: Partial<YuchoBillingItem> = {}): YuchoBillingItem => ({
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
  billingStatus: 'pending',
  scheduledDate: null,
  billingMonth: 3,
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

const num = (value: number, width: number) => String(value).padStart(width, '0');

/** ゆうちょから返ってくる結果ファイルと同じ形を組み立てる（112バイト目に結果、トレーラに件数） */
export const buildResultFile = (
  rows: Array<{ item: YuchoBillingItem; code: string; withPayerCode?: boolean }>,
  options: { month?: number; day?: number; sentFile?: boolean; newline?: boolean } = {}
): Buffer => {
  const data = rows.map(({ item, code, withPayerCode = true }) => {
    const row = buildZenginDataRow(item);
    const payer = withPayerCode ? row.slice(91, 111) : ' '.repeat(20);
    return row.slice(0, 91) + payer + code + row.slice(112);
  });
  const ok = rows.filter((r) => r.code === '0');
  const ng = rows.filter((r) => r.code !== '0');
  const sum = (list: typeof rows) => list.reduce((s, r) => s + r.item.billingAmount, 0);
  const trailer =
    '8' +
    num(rows.length, 6) +
    num(sum(rows), 12) +
    (options.sentFile
      ? num(0, 36)
      : num(ok.length, 6) + num(sum(ok), 12) + num(ng.length, 6) + num(sum(ng), 12)) +
    ' '.repeat(65);
  const lines = [
    buildZenginHeader(settings, options.month ?? 3, options.day ?? 16),
    ...data,
    trailer,
    buildZenginEnd(),
  ];
  const text = options.newline === false ? lines.join('') : lines.join('\r\n') + '\r\n';
  return iconv.encode(text, 'Shift_JIS');
};
