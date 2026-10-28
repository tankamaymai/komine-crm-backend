/**
 * 許可証PDF生成サービス
 * 既存のテンプレートPDF（permit-base-*.pdf）にテキストを重ねて出力する。
 */

import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument, rgb, degrees, PDFFont } from 'pdf-lib';
import fontkit from 'pdf-fontkit';
import {
  PERMIT_CERTIFICATE_PAGES,
  ENVELOPE_LETTER_PAGES,
  ENVELOPE_BASE_PAGES,
  type PermitField,
  type PermitPage,
  type PermitTemplateData,
} from '@komine/types';
import { logger } from '../utils/logger';

const TEMPLATE_DIR = path.join(__dirname, 'templates', 'permit');
const FONT_REGULAR_PATH = path.join(TEMPLATE_DIR, 'NotoSansJP-Regular.ttf');
const FONT_BOLD_PATH = path.join(TEMPLATE_DIR, 'NotoSansJP-Bold.ttf');

let _fontCache: { regular: Buffer; bold: Buffer } | null = null;
function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (!_fontCache) {
    _fontCache = {
      regular: fs.readFileSync(FONT_REGULAR_PATH),
      bold: fs.readFileSync(FONT_BOLD_PATH),
    };
  }
  return _fontCache;
}

function getValue(data: PermitTemplateData, id: string): string {
  const v = (data as unknown as Record<string, unknown>)[id];
  if (v === undefined || v === null) return '';
  return String(v);
}

/**
 * 指定のフィールドにテキストを描画
 * pdf-lib の座標系（原点: 左下）で計算。
 */
function drawField(
  page: import('pdf-lib').PDFPage,
  field: PermitField,
  value: string,
  fontRegular: PDFFont,
  fontBold: PDFFont
): void {
  if (!value) return;
  const font = field.bold ? fontBold : fontRegular;
  const size = field.fontSize;

  if (field.direction === 'vertical') {
    // field.y は 1 文字目の上端。文字の頭がそこへ来るよう、少し下げて描く。
    const lineHeight = field.lineHeight ?? size * 1.3;
    const firstBaseline = field.y - size * 0.88;
    const chars = Array.from(value);
    chars.forEach((ch, i) => {
      const w = font.widthOfTextAtSize(ch, size);
      const cx = field.x - w / 2;
      const cy = firstBaseline - i * lineHeight;
      page.drawText(ch, {
        x: cx,
        y: cy,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    });
    return;
  }

  if (field.direction === 'rotated') {
    // -90° 回転で縦方向に流れる
    const w = font.widthOfTextAtSize(value, size);
    const align = field.align ?? 'left';
    let startY = field.y;
    if (align === 'center') startY = field.y - w / 2;
    else if (align === 'right') startY = field.y - w;
    page.drawText(value, {
      x: field.x,
      y: startY,
      size,
      font,
      rotate: degrees(-90),
      color: rgb(0, 0, 0),
    });
    return;
  }

  // horizontal
  const w = font.widthOfTextAtSize(value, size);
  const align = field.align ?? 'left';
  let x = field.x;
  if (align === 'center') x = field.x - w / 2;
  else if (align === 'right') x = field.x - w;
  page.drawText(value, {
    x,
    y: field.y,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

/**
 * 許可証・封筒書・封筒大: 指定ページ定義どおりに PDF を結合して返す
 */
export async function generatePermitPdfFromPages(
  pages: readonly PermitPage[],
  data: PermitTemplateData,
  options?: { includeBackground?: boolean }
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  try {
    const fonts = loadFonts();
    const outDoc = await PDFDocument.create();
    outDoc.registerFontkit(fontkit);
    // subset: true で、入力に使った文字だけを PDF に入れる（#237）。
    // NotoSansJP Regular/Bold は各約5MBあり、全部入れると許可証1枚が約6MBになる。
    // @pdf-lib/fontkit のまま subset すると字形テーブルが壊れ、
    // 入れた名前や住所の一部が PDF 上で消える。pdf-fontkit なら形が残る。
    const fontRegular = await outDoc.embedFont(fonts.regular, { subset: true });
    const fontBold = await outDoc.embedFont(fonts.bold, { subset: true });

    const includeBackground = options?.includeBackground !== false;

    for (const pageDef of pages) {
      if (!pageDef.enabled) continue;
      const newPage = outDoc.addPage([pageDef.widthPt, pageDef.heightPt]);

      // 厚紙印刷は、すでに刷ってある台紙の上に文字だけを載せる。
      // PDF保存のときは台紙の絵も一緒に残す。
      if (includeBackground) {
        const basePath = path.join(TEMPLATE_DIR, pageDef.baseFile);
        if (!fs.existsSync(basePath)) {
          throw new Error(`Permit base PDF が見つかりません: ${pageDef.baseFile}`);
        }

        const baseBytes = fs.readFileSync(basePath);
        const embeddedPages = await outDoc.embedPdf(baseBytes);
        const embeddedPage = embeddedPages[0];
        if (embeddedPage) {
          newPage.drawPage(embeddedPage, {
            x: 0,
            y: 0,
            width: pageDef.widthPt,
            height: pageDef.heightPt,
          });
        }
      }

      for (const field of pageDef.fields) {
        const value = getValue(data, field.id);
        drawField(newPage, field, value, fontRegular, fontBold);
      }
    }

    const bytes = await outDoc.save();
    return { success: true, buffer: Buffer.from(bytes) };
  } catch (error) {
    logger.error({ err: error }, 'Permit-style PDF generation error');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'PDFの生成に失敗しました',
    };
  }
}

/**
 * B5の許可証台紙へ文字だけ刷ると、台紙の絵に対して文字が左へ約1cm寄る。
 * 画面のプレビューと絵つきPDFは元の位置で合っているので、文字だけ印刷のときだけ右へ足す。
 */
export const PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT = 28;

/**
 * 文字だけ印刷はA4横で出す。旧システムと同じく、プリンターはA4で刷り、
 * B5の台紙はA4の右下の角に合わせて置く。
 */
export const PERMIT_PRINT_PAPER_WIDTH_PT = (297 / 25.4) * 72;
export const PERMIT_PRINT_PAPER_HEIGHT_PT = (210 / 25.4) * 72;

export function permitCertificatePages(includeBackground: boolean): readonly PermitPage[] {
  if (includeBackground) return PERMIT_CERTIFICATE_PAGES;
  return PERMIT_CERTIFICATE_PAGES.map((page) => {
    // 台紙の下端はA4の下端にそろうので、上下は動かさない
    const cardLeftOnPaper = PERMIT_PRINT_PAPER_WIDTH_PT - page.widthPt;
    return {
      ...page,
      widthPt: PERMIT_PRINT_PAPER_WIDTH_PT,
      heightPt: PERMIT_PRINT_PAPER_HEIGHT_PT,
      fields: page.fields.map((field) => ({
        ...field,
        x: field.x + cardLeftOnPaper + PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT,
      })),
    };
  });
}

/** 許可証は1ページ（許可証書）のみ */
export async function generatePermitPdf(
  data: PermitTemplateData,
  options?: { includeBackground?: boolean }
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  const includeBackground = options?.includeBackground !== false;
  return generatePermitPdfFromPages(permitCertificatePages(includeBackground), data, options);
}

export async function generateEnvelopeLetterPdf(
  data: PermitTemplateData,
  options?: { includeBackground?: boolean }
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  return generatePermitPdfFromPages(ENVELOPE_LETTER_PAGES, data, options);
}

export async function generateEnvelopeBasePdf(
  data: PermitTemplateData
): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
  return generatePermitPdfFromPages(ENVELOPE_BASE_PAGES, data);
}
