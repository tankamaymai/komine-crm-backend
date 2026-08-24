/** 区画図IDと area_name / display_number の対応。配置本体はフロントの generated-layouts。 */

export type PlotMapId = string;

export interface PlotMapSpec {
  period: string;
  areaNames: string[];
  displayPrefixes: string[];
}

function prefixes(areaNames: string[]): string[] {
  const out: string[] = [];
  for (const name of areaNames) {
    const p = `${name}-`;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

const RAW: Array<{ id: string; period: string; areaNames: string[] }> = [
  { id: '1-A', period: '第1期', areaNames: ['A', 'Ａ', 'A区', 'Ａ区'] },
  { id: '1-B', period: '第1期', areaNames: ['B', 'Ｂ', 'B区', 'Ｂ区'] },
  { id: '1-C', period: '第1期', areaNames: ['C', 'Ｃ', 'C区', 'Ｃ区'] },
  { id: '1-KISSO', period: '第1期', areaNames: ['吉相', '吉相C', '吉相Ｃ'] },
  { id: '1-KISSO-TERRACE', period: '第1期', areaNames: ['吉相テラス'] },
  { id: '1-D', period: '第1期', areaNames: ['D', 'Ｄ', 'D区', 'Ｄ区'] },
  { id: '1-E', period: '第1期', areaNames: ['E', 'Ｅ', 'E区', 'Ｅ区'] },
  { id: '1-F', period: '第1期', areaNames: ['F', 'Ｆ', 'F区', 'Ｆ区'] },
  { id: '1-G', period: '第1期', areaNames: ['G', 'Ｇ', 'G区', 'Ｇ区'] },
  { id: '1-H', period: '第1期', areaNames: ['H', 'Ｈ', 'H区', 'Ｈ区'] },
  { id: '1-I', period: '第1期', areaNames: ['I', 'Ｉ', 'I区', 'Ｉ区'] },
  { id: '1-J', period: '第1期', areaNames: ['J', 'Ｊ', 'J区', 'Ｊ区'] },
  { id: '1-K', period: '第1期', areaNames: ['K', 'Ｋ', 'K区', 'Ｋ区'] },
  { id: '1-L', period: '第1期', areaNames: ['L', 'Ｌ', 'L区', 'Ｌ区'] },
  { id: '1-M', period: '第1期', areaNames: ['M', 'Ｍ', 'M区', 'Ｍ区'] },
  { id: '1-N', period: '第1期', areaNames: ['N', 'Ｎ', 'N区', 'Ｎ区'] },
  { id: '1-O', period: '第1期', areaNames: ['O', 'Ｏ', 'O区', 'Ｏ区'] },
  { id: '1-P', period: '第1期', areaNames: ['P', 'Ｐ', 'P区', 'Ｐ区'] },
  { id: '2-1', period: '第2期', areaNames: ['1', '１', '1区', '１区'] },
  { id: '2-2', period: '第2期', areaNames: ['2', '２', '2区', '２区'] },
  { id: '2-3', period: '第2期', areaNames: ['3', '３', '3区', '３区'] },
  { id: '2-5', period: '第2期', areaNames: ['5', '５', '5区', '５区'] },
  { id: '2-6', period: '第2期', areaNames: ['6', '６', '6区', '６区'] },
  { id: '2-7', period: '第2期', areaNames: ['7', '７', '7区', '７区'] },
  { id: '2-8', period: '第2期', areaNames: ['8', '８', '8区', '８区'] },
  { id: '3-10', period: '第3期', areaNames: ['10', '１０', '10区', '１０区'] },
  { id: '3-11', period: '第3期', areaNames: ['11', '１１', '11区', '１１区'] },
  { id: '3-JURIN', period: '第3期樹林部', areaNames: ['樹林'] },
  { id: '3-TENKU-K', period: '第3期樹林部', areaNames: ['天空K', '天空Ｋ', '天空'] },
  { id: '4-1.5', period: '第4期', areaNames: ['1.5', '１.５'] },
  { id: '4-2.4', period: '第4期', areaNames: ['2.4', '２.４'] },
  { id: '4-3', period: '第4期', areaNames: ['3', '３', '3区', '３区'] },
  { id: '4-4', period: '第4期', areaNames: ['4', '４', '4区', '４区'] },
  { id: '4-5', period: '第4期', areaNames: ['5', '５', '5区', '５区'] },
  { id: '4-8.4', period: '第4期', areaNames: ['8.4', '８.４', '8'] },
  { id: '4-RURI', period: '第4期', areaNames: ['るり庵'] },
  { id: '4-RURI2', period: '第4期', areaNames: ['るり庵テラスⅡ', 'るり庵Ⅱ'] },
  { id: '4-RURI-TERRACE', period: '第4期', areaNames: ['るり庵テラス'] },
  { id: '4-RURI-GARDEN', period: '第4期', areaNames: ['るり庵ガーデン'] },
  { id: '4-RIN', period: '第4期', areaNames: ['凛', '凛A', '凛B', '凛Ａ', '凛Ｂ'] },
  { id: '4-OMOI', period: '第4期', areaNames: ['想'] },
  { id: '4-MEGUMI', period: '第4期', areaNames: ['恵'] },
  { id: '4-IKOI', period: '第4期', areaNames: ['憩'] },
];

export const PLOT_MAP_SPECS: Record<string, PlotMapSpec> = Object.fromEntries(
  RAW.map((item) => [
    item.id,
    { period: item.period, areaNames: item.areaNames, displayPrefixes: prefixes(item.areaNames) },
  ])
);

export const PLOT_MAP_IDS = RAW.map((item) => item.id);
