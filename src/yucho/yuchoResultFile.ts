/**
 * ゆうちょＢｉｚダイレクト 自動払込みの処理結果データ（120バイト固定）を読む。
 * 出典: dataform_jidou_zengin.pdf 1.1版「４ 処理結果データ」/ dataform_jidou_yucho.pdf「８」
 *
 * 全銀形式とゆうちょ形式は、データレコードの記号・番号・カナ・金額・支払人コード・処理結果コードの
 * 位置が同じ。ブラウザ受付の結果も「外部ファイル出力」で全銀データとして落とせるため、この1本で読む。
 */

import iconv from 'iconv-lite';

const WIDTH = 120;

export const YUCHO_RESULT_LABEL: Record<string, string> = {
  '0': '引き落とし済み',
  '1': '残高不足',
  '2': '口座なし',
  '3': '預金者の取消',
  '4': '契約なし',
  '7': '名義が違う',
  '8': '事業主の取消',
  '9': 'その他',
};

export interface YuchoResultDataRecord {
  /** ファイル内のデータ行の順番（1から） */
  lineNo: number;
  /** 記号の真ん中3桁 */
  branchCode: string;
  /** 番号（末尾の1を除いた7桁） */
  accountNumber: string;
  kana: string;
  amount: number;
  /** 支払人コード20桁。空なら null */
  payerCode: string | null;
  resultCode: string;
}

export interface YuchoResultFile {
  /** 払込指定日（ヘッダの MMDD） */
  transferMonth: number;
  transferDay: number;
  records: YuchoResultDataRecord[];
  /** トレーラに書かれた処理済・処理不能の件数と金額 */
  trailer: {
    processedCount: number;
    processedAmount: number;
    failedCount: number;
    failedAmount: number;
  } | null;
}

export class YuchoResultFileError extends Error {}

const field = (record: string, from: number, width: number): string =>
  record.slice(from - 1, from - 1 + width);

const toInt = (value: string): number => {
  const digits = value.trim();
  return /^\d+$/.test(digits) ? parseInt(digits, 10) : NaN;
};

/** 改行あり（1行120バイト）と、改行なし（120バイトずつ連続）の両方を受ける */
const splitRecords = (text: string): string[] => {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
  if (lines.length > 1 || (lines[0]?.length ?? 0) === WIDTH) return lines;
  const flat = lines[0] ?? '';
  const records: string[] = [];
  for (let i = 0; i < flat.length; i += WIDTH) records.push(flat.slice(i, i + WIDTH));
  return records;
};

export const parseYuchoResultFile = (buffer: Buffer): YuchoResultFile => {
  // 古い作り方のファイルは最後に EOF 文字（0x1A）が付くことがあるので落とす
  const raw = iconv.decode(buffer, 'Shift_JIS');
  const eof = String.fromCharCode(0x1a);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === eof) end -= 1;
  const text = raw.slice(0, end);
  const records = splitRecords(text);

  if (records.length === 0) {
    throw new YuchoResultFileError('ファイルが空です');
  }
  const badWidth = records.findIndex((record) => record.length !== WIDTH);
  if (badWidth >= 0) {
    throw new YuchoResultFileError(
      `${badWidth + 1}行目が120文字ではありません。ゆうちょから落とした結果ファイル（全銀データ）をそのまま選んでください`
    );
  }

  const header = records[0] ?? '';
  if (header[0] !== '1' || field(header, 2, 2) !== '91') {
    throw new YuchoResultFileError(
      '自動払込みの結果ファイルではありません（1行目が自動払込みのヘッダではありません）'
    );
  }
  const transferMonth = toInt(field(header, 55, 2));
  const transferDay = toInt(field(header, 57, 2));
  if (!(transferMonth >= 1 && transferMonth <= 12) || !(transferDay >= 1 && transferDay <= 31)) {
    throw new YuchoResultFileError('ファイルの引き落とし日が読めません');
  }

  const data: YuchoResultDataRecord[] = [];
  let trailer: YuchoResultFile['trailer'] = null;
  for (const record of records.slice(1)) {
    if (record[0] === '2') {
      const amount = toInt(field(record, 81, 10));
      if (Number.isNaN(amount)) {
        throw new YuchoResultFileError(`${data.length + 1}件目の金額が読めません`);
      }
      const payerCode = field(record, 92, 20).trim();
      data.push({
        lineNo: data.length + 1,
        branchCode: field(record, 21, 3),
        accountNumber: field(record, 44, 7),
        kana: field(record, 51, 30).trim(),
        amount,
        payerCode: /^\d{20}$/.test(payerCode) ? payerCode : null,
        resultCode: field(record, 112, 1).trim(),
      });
    } else if (record[0] === '8') {
      trailer = {
        processedCount: toInt(field(record, 20, 6)) || 0,
        processedAmount: toInt(field(record, 26, 12)) || 0,
        failedCount: toInt(field(record, 38, 6)) || 0,
        failedAmount: toInt(field(record, 44, 12)) || 0,
      };
    }
  }

  if (data.length === 0) {
    throw new YuchoResultFileError('引き落としの行が1件もありません');
  }
  // 送るファイルも処理結果コードは「0」なので、行だけでは結果ファイルと見分けられない。
  // 結果ファイルはトレーラに処理済・処理不能の件数が入る。両方0なら送る前のファイル。
  const notResult =
    !trailer ||
    trailer.processedCount + trailer.failedCount === 0 ||
    data.some((row) => !(row.resultCode in YUCHO_RESULT_LABEL));
  if (notResult) {
    throw new YuchoResultFileError(
      'これはゆうちょへ送ったファイルのようです。引き落としのあとに、ゆうちょから返ってきた結果ファイルを選んでください'
    );
  }

  return { transferMonth, transferDay, records: data, trailer };
};
