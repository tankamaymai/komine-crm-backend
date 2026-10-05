/**
 * ゆうちょＢｉｚダイレクト公式 CSV（ブラウザ受付）
 *  - 名簿: 支払人情報CSV（12列・金額なし）
 *  - 決済: 支払人情報追加CSV（4列・金額あり）
 */

import type { YuchoBillingItem } from '../validations/yuchoValidation';
import { branchCodeFromSymbol, accountNumberFromYuchoNumber } from './yuchoAccount';
import { derivePayerCode, splitPayerCode } from './yuchoPayerCode';

const LINE_SEP = '\r\n';
const BANK_CODE = '9900';
const PAYER_MASTER_HEADER =
  '委託者コード,金融機関コード,金融機関カナ名,金融機関漢字名,支店コード,支店カナ名,支店漢字名,預金種目,口座番号,支払人カナ名,支払人漢字名,支払人コード';

/**
 * 預金種目コード変換（Prisma enum → ゆうちょ code）
 *   ordinary (普通)  → 1
 *   current  (当座)  → 2
 *   savings  (貯蓄)  → 4
 *   未設定          → 1 (普通扱い)
 */
const accountTypeCode = (type: string | null | undefined): string => {
  switch (type) {
    case 'current':
      return '2';
    case 'savings':
      return '4';
    case 'ordinary':
    default:
      return '1';
  }
};

/**
 * 全角カナ・ひらがなを半角カナに変換する簡易コンバーター。
 * ゆうちょCSVの口座名義は半角カナを要求するため。
 */
const KANA_MAP: Record<string, string> = {
  ガ: 'ｶﾞ',
  ギ: 'ｷﾞ',
  グ: 'ｸﾞ',
  ゲ: 'ｹﾞ',
  ゴ: 'ｺﾞ',
  ザ: 'ｻﾞ',
  ジ: 'ｼﾞ',
  ズ: 'ｽﾞ',
  ゼ: 'ｾﾞ',
  ゾ: 'ｿﾞ',
  ダ: 'ﾀﾞ',
  ヂ: 'ﾁﾞ',
  ヅ: 'ﾂﾞ',
  デ: 'ﾃﾞ',
  ド: 'ﾄﾞ',
  バ: 'ﾊﾞ',
  ビ: 'ﾋﾞ',
  ブ: 'ﾌﾞ',
  ベ: 'ﾍﾞ',
  ボ: 'ﾎﾞ',
  パ: 'ﾊﾟ',
  ピ: 'ﾋﾟ',
  プ: 'ﾌﾟ',
  ペ: 'ﾍﾟ',
  ポ: 'ﾎﾟ',
  ヴ: 'ｳﾞ',
  ア: 'ｱ',
  イ: 'ｲ',
  ウ: 'ｳ',
  エ: 'ｴ',
  オ: 'ｵ',
  カ: 'ｶ',
  キ: 'ｷ',
  ク: 'ｸ',
  ケ: 'ｹ',
  コ: 'ｺ',
  サ: 'ｻ',
  シ: 'ｼ',
  ス: 'ｽ',
  セ: 'ｾ',
  ソ: 'ｿ',
  タ: 'ﾀ',
  チ: 'ﾁ',
  ツ: 'ﾂ',
  テ: 'ﾃ',
  ト: 'ﾄ',
  ナ: 'ﾅ',
  ニ: 'ﾆ',
  ヌ: 'ﾇ',
  ネ: 'ﾈ',
  ノ: 'ﾉ',
  ハ: 'ﾊ',
  ヒ: 'ﾋ',
  フ: 'ﾌ',
  ヘ: 'ﾍ',
  ホ: 'ﾎ',
  マ: 'ﾏ',
  ミ: 'ﾐ',
  ム: 'ﾑ',
  メ: 'ﾒ',
  モ: 'ﾓ',
  ヤ: 'ﾔ',
  ユ: 'ﾕ',
  ヨ: 'ﾖ',
  ラ: 'ﾗ',
  リ: 'ﾘ',
  ル: 'ﾙ',
  レ: 'ﾚ',
  ロ: 'ﾛ',
  ワ: 'ﾜ',
  ヲ: 'ｦ',
  ン: 'ﾝ',
  ァ: 'ｧ',
  ィ: 'ｨ',
  ゥ: 'ｩ',
  ェ: 'ｪ',
  ォ: 'ｫ',
  ッ: 'ｯ',
  ャ: 'ｬ',
  ュ: 'ｭ',
  ョ: 'ｮ',
  '。': '｡',
  '、': '､',
  '「': '｢',
  '」': '｣',
  '・': '･',
  ー: 'ｰ',
  '　': ' ',
};

const HIRAGANA_OFFSET = 'ア'.charCodeAt(0) - 'あ'.charCodeAt(0);

const toHalfWidthKana = (input: string): string => {
  if (!input) return '';
  let result = '';
  for (const ch of input) {
    if (ch >= 'ぁ' && ch <= 'ん') {
      const kata = String.fromCharCode(ch.charCodeAt(0) + HIRAGANA_OFFSET);
      result += KANA_MAP[kata] ?? kata;
    } else if (KANA_MAP[ch]) {
      result += KANA_MAP[ch];
    } else if (ch >= '｡' && ch <= 'ﾟ') {
      result += ch;
    } else if (ch >= '０' && ch <= '９') {
      result += String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    } else if (ch >= 'Ａ' && ch <= 'ｚ') {
      result += String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    } else if (ch.charCodeAt(0) < 0x80) {
      result += ch;
    } else {
      result += ' ';
    }
  }
  return result;
};

/**
 * 文字列を指定長に右側スペース埋めする。長すぎる場合は切詰め。
 */
const padRight = (value: string, width: number): string => {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
};

/**
 * 数値文字列を指定長にゼロ埋めする。長すぎる場合は切詰め(下位桁優先)。
 */
const padLeftZero = (value: string | number, width: number): string => {
  const s = String(value).replace(/[^\d]/g, '');
  if (s.length >= width) return s.slice(-width);
  return '0'.repeat(width - s.length) + s;
};

/**
 * 支店名から店番(3桁)を抽出。漢数字を含む店舗名（〇一八店等）から数字を抽出する。
 * 不明な場合は 000 を返す。記号番号方式の本来採番は別 issue (#170) で対応。
 */
const KANJI_DIGIT: Record<string, string> = {
  〇: '0',
  零: '0',
  一: '1',
  壱: '1',
  二: '2',
  弐: '2',
  三: '3',
  参: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

const extractBranchCode = (branchName: string): string => {
  const ascii = branchName.match(/\d{3}/);
  if (ascii) return ascii[0];
  let digits = '';
  for (const ch of branchName) {
    if (KANJI_DIGIT[ch] != null) {
      digits += KANJI_DIGIT[ch];
      if (digits.length === 3) break;
    }
  }
  return digits.length === 3 ? digits : '000';
};

const SMALL_KANA: Record<string, string> = {
  ｧ: 'ｱ',
  ｨ: 'ｲ',
  ｩ: 'ｳ',
  ｪ: 'ｴ',
  ｫ: 'ｵ',
  ｬ: 'ﾔ',
  ｭ: 'ﾕ',
  ｮ: 'ﾖ',
  ｯ: 'ﾂ',
};

/** 公式: 小文字カナは大文字、長音はハイフン */
export const normalizeOfficialKana = (input: string): string =>
  toHalfWidthKana(input)
    .replace(/[ｧｨｩｪｫｬｭｮｯ]/g, (ch) => SMALL_KANA[ch] ?? ch)
    .replace(/[ーｰ]/g, '-');

export const getAccountKana = (item: YuchoBillingItem): string =>
  normalizeOfficialKana(item.billingInfo?.accountHolder ?? item.customerNameKana ?? '').slice(
    0,
    30
  );

export const resolveBranchAndAccount = (
  item: YuchoBillingItem
): { branchCode: string; accountNumber: string } => {
  const info = item.billingInfo;
  const branchCode =
    branchCodeFromSymbol(info?.yuchoSymbol) ?? extractBranchCode(info?.branchName ?? '');
  const accountNumber =
    accountNumberFromYuchoNumber(info?.yuchoNumber) ?? info?.accountNumber ?? '';
  return { branchCode, accountNumber };
};

const csvCell = (value: string): string => {
  if (!/[,"\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
};

/** 名簿用（支払人情報CSV）1行。金額は入れない。 */
export const buildPayerMasterRow = (item: YuchoBillingItem): string => {
  const { branchCode, accountNumber } = resolveBranchAndAccount(item);
  const payerCode = derivePayerCode(item.customerId, item.contractPlotId) ?? '';
  const cells = [
    '',
    BANK_CODE,
    '',
    '',
    padLeftZero(branchCode, 3),
    '',
    '',
    '1',
    padLeftZero(accountNumber, 7),
    getAccountKana(item),
    (item.customerName ?? '').slice(0, 48),
    payerCode,
  ];
  return cells.map(csvCell).join(',');
};

/** 決済用（支払人情報追加CSV）1行。 */
export const buildDebitRow = (item: YuchoBillingItem): string => {
  const code = derivePayerCode(item.customerId, item.contractPlotId);
  const split = splitPayerCode(code);
  const cells = [
    split?.payerCode1 ?? '',
    split?.payerCode2 ?? '',
    getAccountKana(item),
    String(item.billingAmount),
  ];
  return cells.map(csvCell).join(',');
};

interface BuildCsvParams {
  items: YuchoBillingItem[];
}

/**
 * 口座番号として使える値か（数字を1桁以上含み、全0でないこと）。
 * buildDataRow は口座番号空を `0000000`、店番空を `000` で埋めるため、
 * ここで弾かないと「構造上正しいが口座が存在しない」不正振替行が出力される（#266）。
 */
const hasUsableAccountNumber = (item: YuchoBillingItem): boolean => {
  // ゆうちょ番号があればそれを、無ければ従来の口座番号を口座番号として扱う（#170）
  const source =
    accountNumberFromYuchoNumber(item.billingInfo?.yuchoNumber) ??
    item.billingInfo?.accountNumber ??
    '';
  const digits = source.replace(/[^\d]/g, '');
  return digits.length > 0 && Number(digits) > 0;
};

export type YuchoExcludeReason =
  | 'no_account'
  | 'bad_number'
  | 'no_kana'
  | 'no_payer_code'
  | 'zero_amount';

export const getExcludeReason = (item: YuchoBillingItem): YuchoExcludeReason | null => {
  if (item.billingAmount <= 0) return 'zero_amount';
  if (!item.billingInfo) return 'no_account';
  if (!hasUsableAccountNumber(item)) return 'bad_number';
  if (!getAccountKana(item)) return 'no_kana';
  if (!derivePayerCode(item.customerId, item.contractPlotId)) return 'no_payer_code';
  return null;
};

/**
 * 口座があり金額が正なら一覧の「出力対象」。
 * 決済CSVはさらにカナと支払人コードが必要。全銀1本はカナがあればよい。
 */
export const isExportableBillingItem = (item: YuchoBillingItem): boolean =>
  Boolean(item.billingInfo) && hasUsableAccountNumber(item) && item.billingAmount > 0;

export const isCsvExportableItem = (item: YuchoBillingItem): boolean =>
  isExportableBillingItem(item) &&
  Boolean(getAccountKana(item)) &&
  Boolean(derivePayerCode(item.customerId, item.contractPlotId));

export const isZenginExportableItem = (item: YuchoBillingItem): boolean =>
  isExportableBillingItem(item) && Boolean(getAccountKana(item));

export const buildPayerMasterCsv = ({ items }: BuildCsvParams): string => {
  const billable = items.filter(isCsvExportableItem);
  if (billable.length === 0) return '';
  return [PAYER_MASTER_HEADER, ...billable.map(buildPayerMasterRow)].join(LINE_SEP) + LINE_SEP;
};

export const buildDebitCsv = ({ items }: BuildCsvParams): string => {
  const billable = items.filter(isCsvExportableItem);
  if (billable.length === 0) return '';
  return billable.map(buildDebitRow).join(LINE_SEP) + LINE_SEP;
};

/** 毎回使う決済CSV。旧名の呼び出し先を公式4列に寄せる。 */
export const buildYuchoCsv = buildDebitCsv;

export const __internal = {
  toHalfWidthKana,
  normalizeOfficialKana,
  padRight,
  padLeftZero,
  accountTypeCode,
  extractBranchCode,
};
