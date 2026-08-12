/**
 * レガシー値 → 新システム値 変換ユーティリティ
 */

/**
 * レガシー日付 (yyyymmdd の int) → JS Date | null
 *
 * - 0, NULL, 空文字 → null
 * - 19000101 未満 → null（不正値）
 * - 21000101 超 → null（不正値）
 * - それ以外 → Date
 *
 * UTC 00:00 で生成（Prisma の @db.Date は時刻を捨てるため）
 */
export function parseLegacyDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;

  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n) || n < 19000101 || n > 21001231) return null;

  const y = Math.floor(n / 10000);
  const m = Math.floor((n % 10000) / 100);
  const d = n % 100;

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  // 月/日が範囲外（例: 2026-02-30）だと Date が補正してしまうので検出
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

/**
 * レガシー郵便番号 (int) → "1234567" 形式の文字列 | null
 *
 * - 0, NULL → null
 * - 7桁になるよう左ゼロ埋め
 */
export function parseLegacyZip(value: unknown): string | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const n = typeof value === 'string' ? value.replace(/\D/g, '') : String(value);
  if (!n || n === '0') return null;
  return n.padStart(7, '0').slice(0, 7);
}

/**
 * レガシー文字列 → trim 済み文字列 | null
 *
 * - 空文字、null、undefined → null
 * - それ以外 → trim 後の値
 */
export function cleanStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

/**
 * 備考テキストへ追記する（碑文→備考統合など）。
 * - addition が空なら existing をそのまま返す
 * - existing が空なら addition を返す
 * - existing 全体または改行区切り行に addition が既にある場合は冪等にスキップ
 * - それ以外は改行区切りで追記
 */
export function appendNoteIfMissing(
  existing: string | null | undefined,
  addition: string | null | undefined
): string | null {
  const add = cleanStr(addition);
  if (add === null) return cleanStr(existing);
  const cur = cleanStr(existing);
  if (cur === null) return add;
  if (cur === add) return cur;
  const lines = cur.split(/\r?\n/);
  if (lines.includes(add)) return cur;
  return `${cur}\n${add}`;
}

/**
 * 複数の備考断片を改行結合する（空は除外、完全一致の重複は除去）。
 * 旧 note（備考）+ grave_mei（碑文）の契約備考統合に使う。
 */
export function mergeNoteParts(...parts: Array<string | null | undefined>): string | null {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const s = cleanStr(part);
    if (s === null || seen.has(s)) continue;
    seen.add(s);
    unique.push(s);
  }
  return unique.length > 0 ? unique.join('\n') : null;
}

/**
 * 表示用区画番号（grave_name_cd）の正規化。
 * 全角英数（Ａ-Ｚ ａ-ｚ ０-９）を半角へ変換し、前後空白を除去する。
 * "A-100" / "1.5-10" 等の区切り・記号や複数区画表記（"3/2・25/2"）はそのまま保持。
 * 空文字・null は null を返す。#158
 */
export function normalizeGraveName(value: unknown): string | null {
  const s = cleanStr(value);
  if (s === null) return null;
  const half = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  return cleanStr(half);
}

/**
 * cleanStr の必須版（必ず空でない文字列を返す）
 * デフォルト値を渡さない場合、未設定なら fallback を使う
 */
export function requireStr(value: unknown, fallback = ''): string {
  return cleanStr(value) ?? fallback;
}

/**
 * レガシー面積文字列（m_bochi.shiyouryou_menseki / kanriryou_menseki）→ ㎡数値。
 *
 * 実データは "3.6" "0.2" "0.013" "2.475" 等の数値文字列（全件で3桁小数まで）。
 * 念のため全角数字・㎡/m2 サフィックス・カンマにも耐える。
 * "0" は「面積0（レガシーの登録値そのまま）」として 0 を返す（システム確認 項目⑤）。
 * 数値化できない・負値・1000㎡以上（異常値）は null。
 * DB 格納先は numeric(6,3) のため小数第3位に丸める。
 */
export function parseLegacyArea(value: unknown): number | null {
  const s = normalizeGraveName(value);
  if (s === null) return null;
  const cleaned = s
    .replace(/．/g, '.')
    .replace(/[,，]/g, '')
    .replace(/(㎡|m2|M2|平米)\s*$/, '')
    .trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n >= 1000) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * 電話番号: ハイフン除去、数字のみに正規化。長さが 11 桁を超えたら 11 桁にトリム
 */
export function cleanPhone(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.slice(0, 11);
}

/**
 * セイ + メイ を結合（どちらかが null/空でも安全）
 */
export function joinName(sei: unknown, mei: unknown, separator = ' '): string | null {
  const s = cleanStr(sei);
  const m = cleanStr(mei);
  if (!s && !m) return null;
  return [s, m].filter(Boolean).join(separator);
}

/**
 * 性別コード: レガシーは int、新システムは Gender enum
 *
 * 推測マッピング: 1=male / 2=female / それ以外=not_answered or null
 */
export function parseGender(value: unknown): 'male' | 'female' | 'not_answered' | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const n = Number(value);
  if (n === 1) return 'male';
  if (n === 2) return 'female';
  return 'not_answered';
}

/**
 * tinyint(1) → boolean
 */
export function parseBool(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}
