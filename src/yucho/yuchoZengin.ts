/**
 * ゆうちょＢｉｚダイレクト 自動払込み【全銀形式】120バイト固定。
 * 出典: dataform_jidou_zengin.pdf 1.1版
 */

import type { YuchoBillingItem } from '../validations/yuchoValidation';
import { accountNumberFromYuchoNumber, branchCodeFromSymbol } from './yuchoAccount';
import {
  getAccountKana,
  isZenginExportableItem,
  resolveBranchAndAccount,
  __internal,
} from './yuchoCsv';
import { derivePayerCode } from './yuchoPayerCode';
import type { YuchoBusinessSettings } from './yuchoSettings';

const LINE_SEP = '\r\n';
const WIDTH = 120;

const num = (value: string | number, width: number): string => __internal.padLeftZero(value, width);
const chr = (value: string, width: number): string => __internal.padRight(value, width);

const assertWidth = (row: string, label: string): string => {
  if (row.length !== WIDTH) {
    throw new Error(`${label} が ${row.length} 文字です（120である必要があります）`);
  }
  return row;
};

const businessBranch = (symbol: string): string => {
  const fromSymbol = branchCodeFromSymbol(symbol.length === 5 ? symbol : null);
  if (fromSymbol) return fromSymbol;
  const digits = symbol.replace(/\D/g, '');
  if (digits.length >= 3) return digits.slice(-3).padStart(3, '0');
  return num(digits, 3);
};

const businessAccount = (number: string): string =>
  accountNumberFromYuchoNumber(number) ?? number.replace(/\D/g, '').slice(-7);

export const buildZenginHeader = (
  settings: YuchoBusinessSettings,
  transferMonth: number,
  transferDay: number
): string => {
  const mmdd = `${num(transferMonth, 2)}${num(transferDay, 2)}`;
  const row =
    '1' +
    '91' +
    ' ' +
    num(settings.clientCode, 10) +
    chr(__internal.toHalfWidthKana(settings.clientName).replace(/[ーｰ]/g, '-'), 40) +
    mmdd +
    chr('', 4) +
    chr('', 15) +
    num(businessBranch(settings.businessSymbol), 3) +
    chr('', 15) +
    settings.businessAccountType +
    num(businessAccount(settings.businessNumber), 7) +
    chr('', 17);
  return assertWidth(row, '全銀ヘッダ');
};

export const buildZenginDataRow = (item: YuchoBillingItem): string => {
  const { branchCode, accountNumber } = resolveBranchAndAccount(item);
  const kana = getAccountKana(item);
  const payer = derivePayerCode(item.customerId, item.contractPlotId) ?? '';
  const row =
    '2' +
    chr('', 4) +
    chr('', 15) +
    num(branchCode, 3) +
    chr('', 19) +
    '1' +
    num(accountNumber, 7) +
    chr(kana, 30) +
    num(item.billingAmount, 10) +
    ' ' +
    chr(payer, 20) +
    '0' +
    chr('', 8);
  return assertWidth(row, '全銀データ');
};

export const buildZenginTrailer = (items: YuchoBillingItem[]): string => {
  const countable = items.filter((i) => i.billingAmount > 0);
  const total = countable.reduce((sum, i) => sum + i.billingAmount, 0);
  const row =
    '8' +
    num(countable.length, 6) +
    num(total, 12) +
    num(0, 6) +
    num(0, 12) +
    num(0, 6) +
    num(0, 12) +
    chr('', 65);
  return assertWidth(row, '全銀トレーラ');
};

export const buildZenginEnd = (): string => assertWidth('9' + chr('', 119), '全銀エンド');

export const buildZenginFile = (params: {
  items: YuchoBillingItem[];
  settings: YuchoBusinessSettings;
  transferMonth: number;
  transferDay: number;
}): string => {
  const rows = params.items.filter(isZenginExportableItem);
  if (rows.length === 0) return '';
  return (
    [
      buildZenginHeader(params.settings, params.transferMonth, params.transferDay),
      ...rows.map(buildZenginDataRow),
      buildZenginTrailer(rows),
      buildZenginEnd(),
    ].join(LINE_SEP) + LINE_SEP
  );
};
