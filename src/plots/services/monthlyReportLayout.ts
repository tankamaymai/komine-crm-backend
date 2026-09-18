/**
 * 月次報告（区画残数）帳票のレイアウト定義。
 *
 * 業務が毎月末に税理士へ提出している Excel シート「N月末区画残数」の配置を
 * そのまま宣言する（議事録 2026-07-21 §6「現在使用されている月次報告用の
 * Excel シートのレイアウトをそのまま再現する」）。
 *
 * 出典: komine-docs/区画exleファイル/令和8年度6月.xlsx シート「6月末区画残数」
 *       komine-docs/参考画面キャプチャ/08_区画残数管理エクセル.jpg（2025年10月末版）
 *
 * ## 行の作り方が期によって違う
 *
 * 帳票の「区」列は区画名そのままではない。実データ（physical_plots.area_name）と
 * 突き合わせて判明した対応は次の3種類。
 *
 *   1. 区画名そのまま         … A / B / 樹林 / 憩 など大多数
 *   2. 複数の区画名を1行に集約 … 「吉相」= 吉相 + 吉相C（実測 11 + 28 = 39 で帳票と一致）
 *   3. 1つの区画名を㎡で分割   … 第4期の「1.5 / 2.4 / 3 / 4 / 5 / 8.4」は区画名ではなく
 *                                `つながり` を area_sqm で割った行
 *
 * ## レイアウトに載らない区画がある
 *
 * 帳票の5ブロックに居場所がない区画（凛A〜D・納骨堂系・樹木葬・桜系・るり庵・
 * るり庵ガーデン・吉相テラス・つながりの一部㎡など）が実データに存在する。
 * これらは末尾の「その他」ブロックに回して、ブロック合計＝全区画数が必ず
 * 成り立つようにする（未分類バケットを置く方針は inventoryService の
 * UNCLASSIFIED_PERIOD と同じ。#166）。
 */

/** 帳票1行の作り方。 */
export type MonthlyReportRowSpec =
  | {
      /** 区画名（1つ以上）をそのまま／集約して1行にする */
      kind: 'areaNames';
      /** 「区」列に出す表記 */
      label: string;
      /** この行に集約する physical_plots.area_name */
      areaNames: string[];
    }
  | {
      /** 1つの区画名を area_sqm で分割して行にする */
      kind: 'areaSqm';
      label: string;
      areaName: string;
      /** 対象の面積（㎡）。area_sqm がこの値に一致する区画だけが入る */
      areaSqm: number;
    };

export interface MonthlyReportBlockSpec {
  /** inventoryService の期名（PERIODS と一致）。期フィルタ用 */
  period: string;
  /** 帳票の見出し表記。全角スペース混じりの原本表記を保つ */
  title: string;
  rows: MonthlyReportRowSpec[];
}

/** 区画名そのまま1行にする行スペックの短縮記法。 */
const byName = (label: string, ...areaNames: string[]): MonthlyReportRowSpec => ({
  kind: 'areaNames',
  label,
  areaNames: areaNames.length > 0 ? areaNames : [label],
});

/** `つながり` を㎡で割る行スペックの短縮記法。 */
const tsunagariBySqm = (areaSqm: number): MonthlyReportRowSpec => ({
  kind: 'areaSqm',
  label: String(areaSqm),
  areaName: 'つながり',
  areaSqm,
});

/**
 * ブロック定義。配列順・行順が帳票の配置順（左から第1期→第4期、上から下）。
 * 行の増減は業務側の帳票変更に追随してここだけ直せばよい。
 */
export const MONTHLY_REPORT_BLOCKS: MonthlyReportBlockSpec[] = [
  {
    period: '第1期',
    title: '第　1　期',
    rows: [
      byName('Ａ', 'A'),
      byName('Ｂ', 'B'),
      byName('Ｃ', 'C'),
      // 帳票は「吉相」1行。吉相テラスは別枠（㎡別シートの「Ｃ区吉相テラス」）なので含めない
      byName('吉相', '吉相', '吉相C'),
      byName('Ｄ', 'D'),
      byName('Ｅ', 'E'),
      byName('Ｆ', 'F'),
      byName('Ｇ', 'G'),
      byName('Ｈ', 'H'),
      byName('Ｉ', 'I'),
      byName('Ｊ', 'J'),
      byName('Ｋ', 'K'),
      byName('Ｌ', 'L'),
      byName('Ｍ', 'M'),
      byName('Ｎ', 'N'),
      byName('Ｏ', 'O'),
      byName('Ｐ', 'P'),
    ],
  },
  {
    period: '第2期',
    title: '第　２　期',
    // 4 は帳票に行がない（実データにも区画名 '4' は存在しない）
    rows: ['1', '2', '3', '5', '6', '7', '8'].map((n) => byName(n)),
  },
  {
    period: '第3期',
    title: '第　３　期',
    rows: [byName('10'), byName('11')],
  },
  {
    period: '第3期樹林部',
    title: '第 ３ 期 樹 林 葬',
    // 帳票の見出しは「樹林葬」だが区画名マスタの期名は「第3期樹林部」
    rows: [byName('樹林'), byName('天空K')],
  },
  {
    period: '第4期',
    title: '第４期',
    rows: [
      byName('るり庵テ', 'るり庵テラス'),
      tsunagariBySqm(1.5),
      tsunagariBySqm(2.4),
      tsunagariBySqm(3),
      tsunagariBySqm(4),
      tsunagariBySqm(5),
      tsunagariBySqm(8.4),
      byName('憩'),
      byName('恵'),
      byName('想'),
      byName('るり庵Ⅱ'),
    ],
  },
];

/** レイアウトに載らない区画を受ける末尾ブロックの見出し。 */
export const OTHER_BLOCK_TITLE = 'その他';

/**
 * `area_sqm` を行スペックの照合キーに正規化する。
 *
 * area_sqm は Decimal(6,3) なので "3.000" と 3 を突き合わせる必要がある。
 * 小数3桁で丸めた文字列をキーにすることで、`3` と `3.0` を同じ行に寄せる。
 */
export const sqmKey = (areaSqm: number): string => (Math.round(areaSqm * 1000) / 1000).toFixed(3);

/** 区画名 → その区画を㎡で分割する行の一覧（㎡キー→行スペック）。 */
export type SqmSplitIndex = Map<string, Map<string, MonthlyReportRowSpec>>;

export interface LayoutIndex {
  /** area_name → 行スペック（kind: 'areaNames'） */
  byAreaName: Map<string, MonthlyReportRowSpec>;
  /** area_name → (㎡キー → 行スペック)（kind: 'areaSqm'） */
  bySqm: SqmSplitIndex;
  /** 行スペック → 所属ブロックの period */
  blockOf: Map<MonthlyReportRowSpec, string>;
}

/**
 * ブロック定義から照合用インデックスを組む。
 *
 * 同じ区画名が「名前でまとめる行」と「㎡で割る行」の両方に現れることは想定しない。
 * 万一定義が重複したら後勝ちになるため、定義追加時は注意すること。
 */
export function buildLayoutIndex(
  blocks: MonthlyReportBlockSpec[] = MONTHLY_REPORT_BLOCKS
): LayoutIndex {
  const byAreaName = new Map<string, MonthlyReportRowSpec>();
  const bySqm: SqmSplitIndex = new Map();
  const blockOf = new Map<MonthlyReportRowSpec, string>();

  for (const block of blocks) {
    for (const row of block.rows) {
      blockOf.set(row, block.period);
      if (row.kind === 'areaNames') {
        for (const name of row.areaNames) byAreaName.set(name, row);
      } else {
        let perName = bySqm.get(row.areaName);
        if (!perName) {
          perName = new Map();
          bySqm.set(row.areaName, perName);
        }
        perName.set(sqmKey(row.areaSqm), row);
      }
    }
  }

  return { byAreaName, bySqm, blockOf };
}

/**
 * 区画1件が入る行を決める。該当行がなければ null（= その他ブロックへ）。
 *
 * 判定順は「㎡で割る指定 → 区画名そのまま」。`つながり` のように㎡分割が
 * 定義されている区画名は、定義に無い㎡（0㎡・3.6㎡など）の区画が
 * 名前行に混ざらないよう、名前へのフォールバックをしない。
 */
export function findRow(
  index: LayoutIndex,
  areaName: string,
  areaSqm: number
): MonthlyReportRowSpec | null {
  const perName = index.bySqm.get(areaName);
  if (perName) return perName.get(sqmKey(areaSqm)) ?? null;
  return index.byAreaName.get(areaName) ?? null;
}
