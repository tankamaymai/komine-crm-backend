/**
 * 1本ファイル（全銀形式）に必要な霊園側の設定。
 * 空なら画面に載せるCSVは出せるが、120文字ファイルは出さない。
 */

export interface YuchoBusinessSettings {
  clientCode: string;
  clientName: string;
  businessSymbol: string;
  businessNumber: string;
  businessAccountType: '1' | '2';
}

const read = (key: string): string => (process.env[key] ?? '').trim();

export const getYuchoBusinessSettings = (): YuchoBusinessSettings | null => {
  const clientCode = read('YUCHO_CLIENT_CODE').replace(/\D/g, '');
  const clientName = read('YUCHO_CLIENT_NAME');
  const businessSymbol = read('YUCHO_BUSINESS_SYMBOL').replace(/\D/g, '');
  const businessNumber = read('YUCHO_BUSINESS_NUMBER').replace(/\D/g, '');
  const typeRaw = read('YUCHO_BUSINESS_ACCOUNT_TYPE');
  const businessAccountType = typeRaw === '2' ? '2' : typeRaw === '1' ? '1' : '';

  if (
    clientCode.length !== 10 ||
    !clientName ||
    !businessSymbol ||
    !businessNumber ||
    !businessAccountType
  ) {
    return null;
  }
  return { clientCode, clientName, businessSymbol, businessNumber, businessAccountType };
};

export const getYuchoExportSettings = (): {
  zenginReady: boolean;
  missing: string[];
} => {
  const missing: string[] = [];
  if (read('YUCHO_CLIENT_CODE').replace(/\D/g, '').length !== 10) {
    missing.push('会社の番号（委託者コード）');
  }
  if (!read('YUCHO_CLIENT_NAME')) missing.push('会社名（カナ）');
  if (!read('YUCHO_BUSINESS_SYMBOL')) missing.push('霊園口座の記号');
  if (!read('YUCHO_BUSINESS_NUMBER')) missing.push('霊園口座の番号');
  if (!['1', '2'].includes(read('YUCHO_BUSINESS_ACCOUNT_TYPE'))) {
    missing.push('霊園口座の種類');
  }
  return { zenginReady: missing.length === 0, missing };
};
