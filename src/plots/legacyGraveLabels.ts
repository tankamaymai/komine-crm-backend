/**
 * 旧台帳の名称マスタ（sykbnn）から、一覧に出す名前を引く。
 *
 * 取扱 = KBNNO 2016（墓石取扱）。1=小嶺 / 2=はせがわ / 3=晃
 * 基地 = KBNNO 2018（基地タイプ）。例: 7=規格-千羽鶴 / 23=J3 / 9=自由
 *
 * 画面の「取扱」欄（agent_name）に後から入れた名前があれば、そちらを優先する。
 * 番号 0 と未登録は、旧画面でも名前が出ないので空にする。
 */

const HANDLER_BY_KIND: Record<number, string> = {
  1: '小嶺',
  2: 'はせがわ',
  3: '晃',
};

const BASE_BY_TYPE: Record<number, string> = {
  1: '規格',
  2: '規格1-1',
  3: '規格1-2',
  4: '規格－Ｃ',
  5: '規格－記念',
  6: '規格-瑞雲',
  7: '規格-千羽鶴',
  8: '規格-和',
  9: '自由',
  10: '規格-K2',
  11: '規格-D',
  12: '規格-B',
  13: '規格-瑞山',
  14: '20周年記念',
  15: '規格-1-0',
  16: '規格-1-3',
  17: '規格-1-5',
  18: '初雁',
  19: 'J和',
  20: '天翔',
  21: '規格-洋',
  22: '規格-豊後B',
  23: 'J3',
  24: '新B2',
  25: '自由-吉相',
  26: 'J4',
  27: '規格-A',
  28: '規格-2',
  29: '規格-洋2',
  30: '規格-Ｆ',
  31: '規格-1',
  32: '規格-和洋',
  33: '規格-Ｊ和',
  34: '規格-豊後Ｂ',
  35: '規格-豊後',
  36: '規格-E',
  37: '規格-Ｋ',
  38: '規格-A2',
  39: '規格-G',
  40: '規格-2-1',
  41: '規格-Y',
  42: '規格-S',
  43: '規格-H',
  44: '規格-新S',
  45: '規格-新B2',
  46: '規格-B5',
  47: '規格-2-2',
  48: '規格-新A',
  49: '規格-2-2A',
  50: '規格-2-3B',
  51: '規格-新B',
  52: '規格-Ｒ',
  53: '規格-2-5',
  54: '規格-2-8',
  55: '規格-Ｂ3',
  56: '規格-2-9',
  57: '規格-B2',
  58: '規格-3-1',
  59: '規格-2-3',
  60: '規格-2-10',
  61: '規格-3-3',
  62: '規格-2-1-1',
  63: '規格-3-5',
  64: '規格-2-和',
  65: '規格-J-5',
  66: '規格-JA',
  67: '規格-J4和',
  68: '規格-樹林',
  69: '納骨堂',
  70: '規格-天空Ｋ',
  71: '樹木葬',
  72: '花鳥風月',
  73: 'バラ咲く樹木葬',
};

function lookup(table: Record<number, string>, code: number | null | undefined): string | null {
  if (code == null || code === 0) return null;
  return table[code] ?? null;
}

/** 一覧・詳細の「取扱」。手入力があればそれを、無ければ旧番号の名前。 */
export function resolveHandlerName(
  agentName: string | null | undefined,
  graveKind: number | null | undefined
): string | null {
  const typed = agentName?.trim();
  if (typed) return typed;
  return lookup(HANDLER_BY_KIND, graveKind);
}

/** 一覧・詳細の「基地」。旧番号（grave_type）の名前。 */
export function resolveBaseName(graveType: number | null | undefined): string | null {
  return lookup(BASE_BY_TYPE, graveType);
}
