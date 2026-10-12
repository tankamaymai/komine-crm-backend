/**
 * 納骨堂は備考の合祀年、樹林は人数が揃った納骨日から合祀名簿を作る。
 * 備考の年と計算が違う樹林6件は、年を空のまま「確認待ち」にする。
 *
 * 使い方: node scripts/enroll-collective-burials.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').replace(/\r/g, '');
const url = env.match(/^DATABASE_URL="([^"]+)"/m)?.[1];
if (!url) throw new Error('DATABASE_URL がありません');

const RELEASE = { month: 10, day: 1 }; // 初期設定は10月1日

function releaseDate(year) {
  return `${year}-${String(RELEASE.month).padStart(2, '0')}-${String(RELEASE.day).padStart(2, '0')}`;
}

function nokotsudoYears(contractDate) {
  if (contractDate <= '2015-06-30') return 7;
  if (contractDate <= '2021-03-31') return 33;
  return 13;
}

function jurinYears(contractDate) {
  if (contractDate <= '2014-06-30') return 13;
  return 33;
}

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseBodyCount(text) {
  if (!text || /ペット|\+|＋/.test(text)) return null;
  const matches = [...text.matchAll(/([0-9０-９]+|[一二三四五六七八九])\s*体/g)];
  const nums = [...new Set(matches.map((m) => {
    const raw = m[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    return KANJI[raw] ?? Number.parseInt(raw, 10);
  }).filter((n) => Number.isInteger(n) && n > 0))];
  return nums.length === 1 ? nums[0] : null;
}

function parseYear(text) {
  const match = (text || '').match(/([0-9]{4})\s*年\s*合祀/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function addYears(isoDate, years) {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return `${y + years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const summary = { nokotsudo: 0, jurinDated: 0, jurinWaitingCount: 0, jurinHold: 0, skipped: 0 };

await client.connect();
try {
  const { rows } = await client.query(`
    SELECT
      cp.contract_plot_id,
      pp.area_name,
      cp.contract_date::text AS contract_date,
      COALESCE(cp.notes, '') || E'\\n' || COALESCE(pp.notes, '') AS notes,
      (SELECT COUNT(*)::int FROM buried_persons bp
        WHERE bp.contract_plot_id = cp.contract_plot_id AND bp.deleted_at IS NULL) AS buried_n,
      (SELECT ARRAY(
        SELECT bp.burial_date::text FROM buried_persons bp
        WHERE bp.contract_plot_id = cp.contract_plot_id AND bp.deleted_at IS NULL AND bp.burial_date IS NOT NULL
        ORDER BY bp.burial_date ASC
      )) AS burial_dates,
      EXISTS (
        SELECT 1 FROM collective_burials cb
        WHERE cb.contract_plot_id = cp.contract_plot_id AND cb.deleted_at IS NULL
      ) AS has_collective
    FROM contract_plots cp
    JOIN physical_plots pp ON pp.physical_plot_id = cp.physical_plot_id AND pp.deleted_at IS NULL
    WHERE cp.deleted_at IS NULL
      AND cp.contract_status = 'active'
      AND (pp.area_name LIKE '納骨堂%' OR pp.area_name = '樹林')
  `);

  for (const row of rows) {
    if (row.has_collective) {
      summary.skipped += 1;
      continue;
    }
    const isNokotsudo = row.area_name.startsWith('納骨堂');
    const noteYear = parseYear(row.notes);
    const bodyCount = parseBodyCount(row.notes);
    const latest = row.burial_dates.at(-1) ?? null;
    let calcYear = null;
    if (latest && row.contract_date) {
      const years = isNokotsudo ? nokotsudoYears(row.contract_date) : jurinYears(row.contract_date);
      calcYear = Number(addYears(latest, years).slice(0, 4));
    }
    const mismatch = !isNokotsudo && noteYear != null && calcYear != null && noteYear !== calcYear;

    let capacity = bodyCount;
    let validity = isNokotsudo ? nokotsudoYears(row.contract_date) : jurinYears(row.contract_date);
    let scheduled = null;
    let manual = false;
    let startsOnCapacity = false;
    let note = null;
    let reached = null;

    if (isNokotsudo) {
      if (noteYear == null) {
        summary.skipped += 1;
        continue;
      }
      capacity = Math.max(row.buried_n, 1);
      scheduled = releaseDate(noteYear);
      manual = true;
      note = '備考に書いてある合祀年';
      summary.nokotsudo += 1;
    } else if (mismatch) {
      capacity = bodyCount ?? Math.max(row.buried_n, 1);
      manual = true;
      scheduled = null;
      note = '備考の合祀年と計算が違うため、年は未確定';
      summary.jurinHold += 1;
    } else if (noteYear != null) {
      capacity = bodyCount ?? Math.max(row.buried_n, 1);
      scheduled = releaseDate(noteYear);
      manual = true;
      note = '備考に書いてある合祀年';
      summary.jurinDated += 1;
    } else if (bodyCount != null) {
      capacity = bodyCount;
      startsOnCapacity = true;
      if (row.burial_dates.length >= bodyCount) {
        const nth = row.burial_dates[bodyCount - 1];
        const year = Number(addYears(nth, validity).slice(0, 4));
        scheduled = releaseDate(year);
        reached = nth;
      }
      note = '備考の人数まで納骨された日から計算';
      summary.jurinWaitingCount += 1;
    } else {
      summary.skipped += 1;
      continue;
    }

    const id = crypto.randomUUID();
    await client.query('BEGIN');
    await client.query(
      `UPDATE contract_plots
          SET burial_capacity = $2, validity_period_years = $3, updated_at = NOW()
        WHERE contract_plot_id = $1`,
      [row.contract_plot_id, capacity, validity]
    );
    await client.query(
      `INSERT INTO collective_burials (
         collective_burial_id, contract_plot_id, burial_capacity, current_burial_count,
         capacity_reached_date, validity_period_years, billing_scheduled_date,
         billing_scheduled_date_manual, starts_on_capacity, billing_status, notes,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, 'pending', $10,
         NOW(), NOW()
       )`,
      [
        id,
        row.contract_plot_id,
        capacity,
        row.buried_n,
        row.buried_n >= capacity ? reached : null,
        validity,
        scheduled,
        manual,
        startsOnCapacity,
        note,
      ]
    );
    await client.query('COMMIT');
  }
  console.log(JSON.stringify(summary));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
