/**
 * 分割販売区画の独自表記の解析（議事録 2026-07-21 §4）
 *
 * 旧システムでは複数区画・持分をまとめて1つの区画番号欄に手入力しており、
 * システムが面積を自動計算できない。実データの表記例:
 *
 *   "28、29/2"          → 区画28（全体）と 区画29の1/2
 *   "66/2，67，68/2"     → 66の1/2、67 全体、68の1/2
 *   "0、1、2、3"         → 4区画をまとめて1契約
 *   "C-30/2、31/2"      → 接頭辞つき
 *
 * 「/2」は口頭の「二分の一」に対応する（議事録では「四分の三」の言及もあるが
 * display_number 上に「分の」表記は存在しない。将来出た場合に備えて解析は残す）。
 *
 * 面積の正解は別途 Excel（区画内訳）にあるため、ここでは**自動訂正はしない**。
 * 運用担当が手作業で訂正する判断材料として、区画数と持分合計を機械的に出す。
 */

/** 表記中の1トークン（例: "29/2" → number="29", share=0.5） */
export interface SplitPlotToken {
  /** 元のトークン文字列（トリム済み） */
  raw: string;
  /** 区画番号部分（"/N" や "N分のM" を除いた部分） */
  number: string;
  /** 持分。全体なら 1、"/2" なら 0.5。解析できなければ null */
  share: number | null;
}

export interface SplitPlotNotation {
  /** 区切り文字で分割したトークン */
  tokens: SplitPlotToken[];
  /** まとめられている区画の数 */
  plotCount: number;
  /** 持分の合計（何区画分か）。1つでも解析不能なら null */
  totalShare: number | null;
  /** 複数区画をまとめている、または持分表記を含むか */
  isSplitNotation: boolean;
}

/**
 * 区切り文字。実データ（physical_plots.display_number）の出現数を数えて決めた:
 *   、 U+3001 (344) ・ U+30FB (191) ， U+FF0C (21) , U+002C (2) ､ U+FF64 (1)
 * 手入力ゆえの表記ゆれなので、1件しか無い半角読点も落とさず拾う。
 */
const SEPARATOR = /[、､，,・]/;

/**
 * 1トークンの持分を解析する。
 *
 * - "29/2"     → 1/2
 * - "八の四分の三" 等の「N分のM」→ M/N
 * - 区切りが無ければ全体（1）
 */
function parseToken(raw: string): SplitPlotToken {
  const trimmed = raw.trim();

  // 「N分のM」表記（例: 四分の三 → 3/4）。漢数字は対象外で、算用数字のみ扱う
  const kanji = trimmed.match(/^(.*?)(\d+)分の(\d+)$/);
  if (kanji) {
    const denominator = Number(kanji[2]);
    const numerator = Number(kanji[3]);
    return {
      raw: trimmed,
      number: (kanji[1] ?? '').replace(/の$/, ''),
      share: denominator > 0 ? numerator / denominator : null,
    };
  }

  // 「/N」表記（例: 29/2 → 1/2）
  const slash = trimmed.match(/^(.*?)\/(\d+)$/);
  if (slash) {
    const denominator = Number(slash[2]);
    return {
      raw: trimmed,
      number: slash[1] ?? '',
      share: denominator > 0 ? 1 / denominator : null,
    };
  }

  return { raw: trimmed, number: trimmed, share: trimmed.length > 0 ? 1 : null };
}

/**
 * 区画番号表記を解析する。
 *
 * @param value display_number 等の生値
 */
export function parseSplitPlotNotation(value: string | null | undefined): SplitPlotNotation {
  const source = (value ?? '').trim();
  if (source.length === 0) {
    return { tokens: [], plotCount: 0, totalShare: null, isSplitNotation: false };
  }

  const tokens = source
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseToken);

  const shares = tokens.map((t) => t.share);
  const totalShare = shares.includes(null)
    ? null
    : // 0.5 の加算で誤差が出るため3桁で丸める（面積は3桁小数まで扱う）
      Math.round(shares.reduce((sum, s) => sum + (s as number), 0) * 1000) / 1000;

  return {
    tokens,
    plotCount: tokens.length,
    totalShare,
    // 1区画かつ持分1（＝ただの "A-56"）は分割表記ではない
    isSplitNotation: tokens.length > 1 || tokens.some((t) => t.share !== 1),
  };
}

/** 「28=1, 29=1/2」のように持分を人が読める形にする（CSV の判断材料列用） */
export function describeShares(notation: SplitPlotNotation): string {
  return notation.tokens
    .map((t) => `${t.number || '?'}=${t.share === null ? '不明' : formatShare(t.share)}`)
    .join(', ');
}

function formatShare(share: number): string {
  if (share === 1) return '1';
  // 1/2, 1/4 等は分数のまま出す方が運用側に伝わる
  const denominator = Math.round(1 / share);
  if (denominator > 1 && Math.abs(1 / denominator - share) < 1e-9) return `1/${denominator}`;
  return String(Math.round(share * 1000) / 1000);
}
