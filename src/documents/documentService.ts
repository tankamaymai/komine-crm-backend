/**
 * 書類管理サービス
 * PDF生成機能を提供（テンプレート + Puppeteer / pdf-lib）
 *
 * 設計方針:
 * - PDFファイルはサーバーに永続保存しない（オンデマンド再生成方式）
 * - DBにはメタデータ（template_data等）のみ保存し、必要時に再生成
 * - S3やローカルファイルストレージは不要
 *
 * 型・既定値・座標などフロントとバックで共有する定義は `@komine/types` を
 * 単一ソースとする。ここでは PDF 生成の実装のみ持つ。
 */

import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import {
  type DocumentTemplateType,
  type InvoiceTemplateData,
  type PostcardTemplateData,
  type PermitTemplateData,
  type PaymentGuideTemplateData,
  type PdfTemplateData,
  PAYMENT_GUIDE_DEFAULTS,
  getDefaultSeasonGreeting,
} from '@komine/types';
import { logger } from '../utils/logger';
import {
  generatePermitPdf,
  generateEnvelopeLetterPdf,
  generateEnvelopeBasePdf,
} from './permitPdfService';

// 後方互換のため既存名で再エクスポート
export type TemplateType = DocumentTemplateType;
export type {
  InvoiceTemplateData,
  PostcardTemplateData,
  PermitTemplateData,
  PaymentGuideTemplateData,
  PdfTemplateData,
};
export { PAYMENT_GUIDE_DEFAULTS, getDefaultSeasonGreeting };

const PDF_TEXT_STYLE_PRESETS = new Set(['default', 'mincho', 'gothic_large', 'compact']);

/**
 * テンプレート埋め込み時に HTML エスケープせず、生 HTML としてそのまま挿入するキー。
 * サーバー側で生成し、ユーザー入力が混じらないキーだけをここに入れる。
 */
const RAW_HTML_KEYS = new Set(['textStyleBodyAttr']);

function normalizePdfTextStylePreset(raw: unknown): string {
  const s = String(raw ?? 'default');
  return PDF_TEXT_STYLE_PRESETS.has(s) ? s : 'default';
}

/**
 * HTMLテンプレートファイルを読み込む
 */
function loadTemplateHtml(templateType: TemplateType): string {
  const templatePath = path.join(__dirname, 'templates', `${templateType}.html`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`テンプレートが見つかりません: ${templateType}`);
  }

  return fs.readFileSync(templatePath, 'utf-8');
}

/**
 * HTMLテンプレートを読み込み、データを埋め込む
 */
function loadAndRenderTemplate(templateType: TemplateType, data: Record<string, unknown>): string {
  return renderTemplateHtml(loadTemplateHtml(templateType), templateType, data);
}

/**
 * テンプレートHTML文字列にデータを埋め込む（ファイルI/O を伴わない純粋関数）。
 *
 * - プレースホルダ `{{ key }}` をデータ値で置換（ユーザー入力は HTMLエスケープ）
 * - `RAW_HTML_KEYS`（サーバー生成の属性のみ）は素通し
 * - payment-guide は未入力に既定値、invoice は金額整形・季節挨拶フォールバックを補完
 * - 未解決プレースホルダは空文字に置換
 *
 * `loadAndRenderTemplate` から分離し、レンダリングロジックを単体テスト可能にする。
 */
export function renderTemplateHtml(
  templateHtml: string,
  templateType: TemplateType,
  data: Record<string, unknown>
): string {
  let html = templateHtml;

  const preset = normalizePdfTextStylePreset(data['textStylePreset']);
  const dataForTemplate: Record<string, unknown> = {
    ...data,
    textStyleBodyAttr: preset === 'default' ? '' : ` class="doc-preset-${preset}"`,
  };

  // お支払い方法のご案内テンプレート：未入力フィールドに既定値を補完
  if (templateType === 'payment-guide') {
    for (const [key, value] of Object.entries(PAYMENT_GUIDE_DEFAULTS)) {
      if (
        dataForTemplate[key] === undefined ||
        dataForTemplate[key] === null ||
        String(dataForTemplate[key]).trim() === ''
      ) {
        dataForTemplate[key] = value;
      }
    }
  }

  // 護持費のお知らせテンプレート用：金額の桁区切り表示と季節挨拶のフォールバックを補完
  if (templateType === 'invoice') {
    const rawAmount = data['amount'] ?? data['total'];
    if (dataForTemplate['amountFormatted'] === undefined) {
      const amountNum =
        typeof rawAmount === 'number'
          ? rawAmount
          : typeof rawAmount === 'string' && rawAmount.trim() !== ''
            ? Number(rawAmount)
            : NaN;
      dataForTemplate['amountFormatted'] = Number.isFinite(amountNum)
        ? new Intl.NumberFormat('ja-JP').format(amountNum)
        : '';
    }
    if (
      !dataForTemplate['seasonGreeting'] ||
      String(dataForTemplate['seasonGreeting']).trim() === ''
    ) {
      dataForTemplate['seasonGreeting'] = getDefaultSeasonGreeting(new Date());
    }
  }

  // プレースホルダーを置換。
  // ユーザー入力を含むため HTMLエスケープは必須（XSS / `&` 等での表示崩壊対策）。
  // textStyleBodyAttr のみサーバーで生成した HTML 属性そのものを差し込むため allowlist で素通し。
  const flattenData = flattenObject(dataForTemplate);
  for (const [key, value] of Object.entries(flattenData)) {
    const placeholder = new RegExp(`{{\\s*${escapeRegex(key)}\\s*}}`, 'g');
    const stringValue = String(value ?? '');
    const replacement = RAW_HTML_KEYS.has(key) ? stringValue : escapeHtml(stringValue);
    // String.prototype.replace は第2引数文字列内の `$&` `$1` 等を特殊解釈するため、
    // 関数形式で渡してリテラル挿入にする。
    html = html.replace(placeholder, () => replacement);
  }

  // 残った未解決の {{ key }} プレースホルダーは空文字に置換
  html = html.replace(/\{\{\s*[\w.]+\s*\}\}/g, '');

  return html;
}

/**
 * オブジェクトをフラット化（ネストしたキーを.で連結）
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, string | number | boolean | null | undefined> {
  const result: Record<string, string | number | boolean | null | undefined> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(value)) {
      // 配列は別途処理
      continue;
    } else if (value && typeof value === 'object') {
      Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
    } else {
      result[newKey] = value as string | number | boolean | null | undefined;
    }
  }

  return result;
}

/**
 * 正規表現の特殊文字をエスケープ
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HTMLエスケープ
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Chromium 同時起動数の制限（#229）
 *
 * generatePdfFromHtml はリクエスト毎に puppeteer.launch() で Chromium を
 * フル起動する（各プロセス数百MB）。同時生成が重なると事務所サーバ1台の
 * 運用でメモリ/プロセス/FD枯渇を起こすため、簡易セマフォで同時起動数を
 * 制限する。permit/envelope 系（pdf-lib 経路）は Chromium を使わないため対象外。
 */
const MAX_CONCURRENT_CHROMIUM = 2;
let activeChromiumCount = 0;
const chromiumWaitQueue: Array<() => void> = [];

async function acquireChromiumSlot(): Promise<void> {
  if (activeChromiumCount < MAX_CONCURRENT_CHROMIUM) {
    activeChromiumCount++;
    return;
  }
  await new Promise<void>((resolve) => chromiumWaitQueue.push(resolve));
  activeChromiumCount++;
}

function releaseChromiumSlot(): void {
  activeChromiumCount--;
  const next = chromiumWaitQueue.shift();
  if (next) next();
}

/**
 * HTMLからPDFを生成
 */
export async function generatePdfFromHtml(
  html: string,
  options: {
    format?: 'A4' | 'Letter' | 'postcard';
    landscape?: boolean;
    margin?: {
      top?: string;
      right?: string;
      bottom?: string;
      left?: string;
    };
  } = {}
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  let browser = null;

  // 同時起動数を制限（#229）。空きが出るまで待機する
  await acquireChromiumSlot();

  try {
    // puppeteerをサンドボックスモードで起動
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 60000,
    });

    const page = await browser.newPage();

    // ページ設定
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    // PDF生成オプション
    const pdfOptions: Parameters<typeof page.pdf>[0] = {
      format: options.format === 'postcard' ? undefined : options.format || 'A4',
      landscape: options.landscape || false,
      margin: options.margin || {
        top: '20mm',
        right: '20mm',
        bottom: '20mm',
        left: '20mm',
      },
      printBackground: true,
    };

    // はがきサイズの場合はカスタムサイズを設定
    if (options.format === 'postcard') {
      pdfOptions.width = '100mm';
      pdfOptions.height = '148mm';
    }

    const pdfBuffer = await page.pdf(pdfOptions);

    return { success: true, buffer: Buffer.from(pdfBuffer) };
  } catch (error) {
    logger.error({ err: error }, 'PDF generation error');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'PDF生成に失敗しました',
    };
  } finally {
    try {
      if (browser) {
        await browser.close();
      }
    } finally {
      releaseChromiumSlot();
    }
  }
}

/**
 * 一括印刷の各請求書を 1 ページずつに分けるスタイル。
 * テンプレート側の CSS は据え置き、ページ送りだけを足す。
 */
const BULK_PAGE_STYLE = `
    .invoice-page {
      page-break-after: always;
      break-after: page;
    }

    .invoice-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
`;

/**
 * 複数件の請求書を 1 つの HTML に連結する（ファイルI/O を伴わない純粋関数）。
 *
 * 数百件を 1 件ずつ PDF 化すると Chromium の起動コスト（同時2プロセス制限あり）で
 * 実用にならないため、全件を 1 ドキュメントに連結して Puppeteer を 1 回だけ動かす。
 * 書体プリセットは一括ジョブ単位で共通のため body に 1 度だけ適用する。
 */
export function buildBulkInvoiceHtml(
  templateHtml: string,
  items: InvoiceTemplateData[],
  textStylePreset: string = 'default'
): string {
  const head = templateHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';

  const sections = items.map((item) => {
    const rendered = renderTemplateHtml(templateHtml, 'invoice', {
      ...item,
      // ページ単位ではなくドキュメント全体の body に付けるため、ここでは無効化する
      textStylePreset: 'default',
    });
    const body = rendered.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
    return `<section class="invoice-page">${body}</section>`;
  });

  const preset = normalizePdfTextStylePreset(textStylePreset);
  const bodyAttr = preset === 'default' ? '' : ` class="doc-preset-${preset}"`;

  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    `<head>${head}<style>${BULK_PAGE_STYLE}</style></head>`,
    `<body${bodyAttr}>`,
    sections.join('\n'),
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * 複数件の請求書を 1 ファイルの PDF にまとめて生成する
 */
export async function generateBulkInvoicePdf(
  items: InvoiceTemplateData[],
  options?: { textStylePreset?: string }
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  if (items.length === 0) {
    return { success: false, error: '印刷対象がありません' };
  }

  try {
    const html = buildBulkInvoiceHtml(
      loadTemplateHtml('invoice'),
      items,
      options?.textStylePreset ?? 'default'
    );
    return await generatePdfFromHtml(html, { format: 'A4' });
  } catch (error) {
    logger.error({ err: error }, 'Bulk invoice PDF generation error');
    return {
      success: false,
      error: error instanceof Error ? error.message : '請求書の一括生成に失敗しました',
    };
  }
}

/**
 * テンプレートからPDFを生成
 */
export async function generatePdfFromTemplate(
  templateType: TemplateType,
  data: PdfTemplateData,
  options?: {
    landscape?: boolean;
  }
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  try {
    // 許可証は既存のテンプレートPDFに pdf-lib で文字を重ねる
    if (templateType === 'permit') {
      return await generatePermitPdf(data as PermitTemplateData);
    }
    if (templateType === 'envelope-letter') {
      return await generateEnvelopeLetterPdf(data as PermitTemplateData);
    }
    if (templateType === 'envelope-base') {
      return await generateEnvelopeBasePdf(data as PermitTemplateData);
    }

    const html = loadAndRenderTemplate(templateType, data as unknown as Record<string, unknown>);

    const pdfOptions = {
      format: templateType === 'postcard' ? ('postcard' as const) : ('A4' as const),
      landscape: options?.landscape || false,
      margin:
        templateType === 'postcard'
          ? { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' }
          : undefined,
    };

    return await generatePdfFromHtml(html, pdfOptions);
  } catch (error) {
    logger.error({ err: error }, 'Template PDF generation error');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'テンプレートPDF生成に失敗しました',
    };
  }
}
