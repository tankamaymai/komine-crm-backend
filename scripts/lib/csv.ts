/// <reference types="node" />
/**
 * データクレンジング用リストの CSV 出力ユーティリティ。
 *
 * 議事録 2026-07-21 §4「開発担当が対象データをリストアップし、それを基に運用担当が
 * 手作業で訂正を行う」への対応。運用側が Excel で開いてそのまま作業リストにできる形で出す。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * CSV の1セルを整形する。
 *
 * - 区切り文字・引用符・改行を含む値は引用符で囲み、内部の `"` は `""` にエスケープ
 * - 先頭が `=` `+` `-` `@` の値は Excel が数式として解釈するため `'` を前置して無効化
 *   （区画表記に `-` 始まりの値があり、開いた瞬間に壊れるのを防ぐ）
 * - null / undefined は空セル
 */
export function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** ヘッダ行 + データ行を CSV 文字列にする（改行は CRLF: Excel 互換） */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(toCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(toCsvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * CSV をファイルへ書き出す。
 *
 * Excel（日本語版）は UTF-8 の BOM が無いと Shift_JIS と誤認して文字化けするため、
 * BOM を付ける。区画名・契約者名が読めないとリストとして使えない。
 *
 * @returns 書き出した絶対パス
 */
export function writeCsvFile(filePath: string, headers: string[], rows: unknown[][]): string {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, '﻿' + toCsv(headers, rows), 'utf8');
  return absolute;
}

/**
 * `--out <path>` を引数から取り出す。未指定なら `tmp/<defaultName>` を返す。
 *
 * @param argv process.argv.slice(2) 相当
 * @param defaultName 既定のファイル名（拡張子込み）
 */
export function resolveOutPath(argv: string[], defaultName: string): string {
  const index = argv.indexOf('--out');
  const specified = index >= 0 ? argv[index + 1] : undefined;
  return specified && !specified.startsWith('--') ? specified : path.join('tmp', defaultName);
}
