/**
 * 納骨堂・樹林の合祀年。
 * 納骨堂は備考に書いてある年を使う。樹林は契約日で年数が変わり、
 * 備考の人数まで納骨された日から数える。
 */

export function nokotsudoValidityYears(contractDate: Date): number {
  const time = contractDate.getTime();
  if (time <= Date.parse('2015-06-30T00:00:00Z')) return 7;
  if (time <= Date.parse('2021-03-31T00:00:00Z')) return 33;
  return 13;
}

export function jurinValidityYears(contractDate: Date): number {
  if (contractDate.getTime() <= Date.parse('2014-06-30T00:00:00Z')) return 13;
  return 33;
}

const KANJI: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 備考の「2体」「３体」。ペット混じりや数字が複数なら null */
export function parseSingleBodyCount(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/ペット|\+|＋/.test(text)) return null;
  const matches = [...text.matchAll(/([0-9０-９]+|[一二三四五六七八九])\s*体/g)];
  if (matches.length === 0) return null;
  const nums = matches.map((match) => {
    const raw = match[1];
    if (!raw) return Number.NaN;
    const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    return KANJI[half] ?? Number.parseInt(half, 10);
  });
  const unique = [...new Set(nums.filter((n) => Number.isInteger(n) && n > 0))];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

export function parseNotedCollectiveYear(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/([0-9]{4})\s*年\s*合祀/);
  const yearText = match?.[1];
  if (!yearText) return null;
  const year = Number.parseInt(yearText, 10);
  return Number.isInteger(year) ? year : null;
}
