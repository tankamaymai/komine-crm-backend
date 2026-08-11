/// <reference types="node" />
/**
 * 旧システムの碑文（m_bochi.grave_mei / UI「碑文」「碑文名」）を
 * 契約備考（contract_plots.notes）へ統合する backfill。
 *
 * 背景:
 *   - 旧UIでは碑文(grave_mei)と墓誌(boshi)と備考(note)が別項目
 *   - 移行では boshi→墓誌、note→契約備考は移したが、grave_mei は契約備考に入っていなかった
 *   - 一覧の「備考」は contract_plots.notes を表示するため、碑文が見えていなかった
 *
 * データ源（いずれか必須）:
 *   1. --dump <path> … レガシー mysqldump（m_bochi INSERT）から grave_mei を読む
 *   2. LEGACY_MYSQL_* … レガシー MySQL へ接続（他 backfill と同じ）
 *
 * 使い方:
 *   npm run backfill:grave-mei-notes -- --dry-run --dump "/path/to/dump.sql"
 *   npm run backfill:grave-mei-notes -- --dump "/path/to/dump.sql"
 *   npm run backfill:grave-mei-notes -- --dry-run   # LEGACY_MYSQL_* 利用
 *
 * 冪等: notes に同じ碑文行が既にあればスキップ。
 */
import 'dotenv/config';
import fs from 'node:fs';

import { prisma } from '../src/db/prisma';
import { closeLegacyPool, legacyQuery } from './legacy-migration/legacyDb';
import { appendNoteIfMissing, cleanStr } from './legacy-migration/transforms';

const CONCURRENCY = 25;
const BATCH = 500;

interface GraveMeiRow {
  grave_cd: number;
  grave_mei: string | null;
}

function parseArgs(argv: string[]): { dryRun: boolean; dumpPath: string | null } {
  const dryRun = argv.includes('--dry-run');
  const dumpIdx = argv.indexOf('--dump');
  const dumpPath = dumpIdx >= 0 ? (argv[dumpIdx + 1] ?? null) : null;
  if (dumpIdx >= 0 && !dumpPath) {
    throw new Error('--dump の後ろにダンプファイルパスを指定してください');
  }
  return { dryRun, dumpPath };
}

/** mysqldump の INSERT INTO `m_bochi` VALUES (...) から grave_cd → grave_mei を抽出 */
export function loadGraveMeiFromDump(dumpPath: string): Map<number, string> {
  const text = fs.readFileSync(dumpPath, 'utf8');
  const create = text.match(/CREATE TABLE `m_bochi` \(([\s\S]*?)\) ENGINE=/);
  if (!create) throw new Error(`m_bochi CREATE TABLE が見つかりません: ${dumpPath}`);
  const cols = [...create[1].matchAll(/^\s*`([^`]+)`/gm)].map((m) => m[1]);
  const graveCdIdx = cols.indexOf('grave_cd');
  const graveMeiIdx = cols.indexOf('grave_mei');
  if (graveCdIdx < 0 || graveMeiIdx < 0) {
    throw new Error('m_bochi に grave_cd / grave_mei 列がありません');
  }

  const insert = text.match(/INSERT INTO `m_bochi` VALUES ([\s\S]*?);\r?\n/);
  if (!insert) throw new Error(`m_bochi INSERT が見つかりません: ${dumpPath}`);

  const map = new Map<number, string>();
  for (const fields of parseSqlValueTuples(insert[1])) {
    if (fields.length !== cols.length) continue;
    const cd = Number(unquoteSql(fields[graveCdIdx]));
    const mei = cleanStr(unquoteSql(fields[graveMeiIdx]));
    if (!Number.isInteger(cd) || mei === null) continue;
    map.set(cd, mei);
  }
  return map;
}

function unquoteSql(raw: string): string | null {
  const s = raw.trim();
  if (s.toUpperCase() === 'NULL') return null;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/''/g, "'")
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n');
  }
  return s;
}

function parseSqlValueTuples(valuesBlob: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const n = valuesBlob.length;
  while (i < n) {
    while (i < n && ' \r\n\t,'.includes(valuesBlob[i]!)) i++;
    if (i >= n) break;
    if (valuesBlob[i] !== '(') {
      throw new Error(`unexpected dump token at ${i}: ${valuesBlob.slice(i, i + 40)}`);
    }
    i++;
    const fields: string[] = [];
    let cur = '';
    let inStr = false;
    while (i < n) {
      const ch = valuesBlob[i]!;
      if (inStr) {
        if (ch === '\\') {
          cur += ch;
          i++;
          if (i < n) {
            cur += valuesBlob[i];
            i++;
          }
          continue;
        }
        if (ch === "'") {
          if (i + 1 < n && valuesBlob[i + 1] === "'") {
            cur += "''";
            i += 2;
            continue;
          }
          inStr = false;
          cur += ch;
          i++;
          continue;
        }
        cur += ch;
        i++;
        continue;
      }
      if (ch === "'") {
        inStr = true;
        cur += ch;
        i++;
        continue;
      }
      if (ch === ',') {
        fields.push(cur.trim());
        cur = '';
        i++;
        continue;
      }
      if (ch === ')') {
        fields.push(cur.trim());
        i++;
        break;
      }
      cur += ch;
      i++;
    }
    rows.push(fields);
  }
  return rows;
}

async function loadGraveMeiFromLegacyMysql(graveCds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for (let i = 0; i < graveCds.length; i += BATCH) {
    const chunk = graveCds.slice(i, i + BATCH);
    const rows = await legacyQuery<GraveMeiRow & { constructor: { name: 'RowDataPacket' } }>(
      `SELECT grave_cd, grave_mei FROM m_bochi WHERE grave_cd IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    for (const r of rows) {
      const mei = cleanStr(r.grave_mei);
      if (mei !== null) map.set(r.grave_cd, mei);
    }
  }
  return map;
}

async function main(): Promise<void> {
  const { dryRun, dumpPath } = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill grave-mei→notes] start (dryRun=${dryRun}, dump=${dumpPath ?? 'LEGACY_MYSQL'})`
  );

  const contracts = await prisma.contractPlot.findMany({
    where: { deleted_at: null, legacy_grave_cd: { not: null } },
    select: { id: true, legacy_grave_cd: true, notes: true },
  });
  console.log(`対象 contract_plots（レガシー移行行）: ${contracts.length} 件`);

  const graveCds = [
    ...new Set(contracts.map((c) => Number(c.legacy_grave_cd)).filter((n) => Number.isInteger(n))),
  ];

  let meiByCd: Map<number, string>;
  if (dumpPath) {
    meiByCd = loadGraveMeiFromDump(dumpPath);
    console.log(`dump から grave_mei あり: ${meiByCd.size} 件`);
  } else {
    meiByCd = await loadGraveMeiFromLegacyMysql(graveCds);
    console.log(`legacy MySQL から grave_mei あり: ${meiByCd.size} 件`);
  }

  let noMei = 0;
  let unchanged = 0;
  const updates: Array<{ id: string; from: string | null; to: string; graveCd: number }> = [];

  for (const cp of contracts) {
    const cd = Number(cp.legacy_grave_cd);
    if (!Number.isInteger(cd)) {
      noMei++;
      continue;
    }
    const mei = meiByCd.get(cd) ?? null;
    if (mei === null) {
      noMei++;
      continue;
    }
    const next = appendNoteIfMissing(cp.notes, mei);
    if (next === null || next === cleanStr(cp.notes)) {
      unchanged++;
      continue;
    }
    updates.push({ id: cp.id, from: cp.notes, to: next, graveCd: cd });
  }

  console.log(
    `更新予定: ${updates.length} / 碑文なしor対象外: ${noMei} / 既に統合済: ${unchanged}`
  );
  for (const u of updates.slice(0, 8)) {
    console.log(
      `  grave_cd=${u.graveCd} from=${JSON.stringify(u.from)?.slice(0, 60)} → ${JSON.stringify(u.to).slice(0, 80)}`
    );
  }
  if (updates.length > 8) console.log(`  ... and ${updates.length - 8} more`);

  if (!dryRun) {
    let done = 0;
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const chunk = updates.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((u) =>
          prisma.contractPlot.update({
            where: { id: u.id },
            data: { notes: u.to },
          })
        )
      );
      done += chunk.length;
      if (done % 100 === 0 || done === updates.length) {
        console.log(`  applied ${done}/${updates.length}`);
      }
    }
  }

  console.log(`[backfill grave-mei→notes] done (dryRun=${dryRun}, updated=${updates.length})`);
}

const isDirectRun =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;

if (isDirectRun) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await closeLegacyPool().catch(() => undefined);
    });
}
