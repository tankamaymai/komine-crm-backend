import { ENVELOPE_LETTER_PAGES, PERMIT_CERTIFICATE_PAGES } from '@komine/types';
import { PDFDocument } from 'pdf-lib';

import {
  PERMIT_PRINT_PAPER_HEIGHT_PT,
  PERMIT_PRINT_PAPER_WIDTH_PT,
  PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT,
  generatePermitPdf,
  permitCertificatePages,
} from '../../src/documents/permitPdfService';

describe('許可証の文字だけ印刷の位置', () => {
  const card = PERMIT_CERTIFICATE_PAGES[0]!;

  it('文字だけ印刷はA4横の紙で出す', () => {
    expect(PERMIT_PRINT_PAPER_WIDTH_PT).toBeCloseTo(841.89, 1);
    expect(PERMIT_PRINT_PAPER_HEIGHT_PT).toBeCloseTo(595.28, 1);

    const page = permitCertificatePages(false)[0]!;
    expect(page.widthPt).toBe(PERMIT_PRINT_PAPER_WIDTH_PT);
    expect(page.heightPt).toBe(PERMIT_PRINT_PAPER_HEIGHT_PT);
  });

  it('台紙はA4の右下に置く前提で、文字を右へ寄せる（下はそろえるので上下は動かさない）', () => {
    const original = card.fields;
    const shifted = permitCertificatePages(false)[0]!.fields;
    const cardLeftOnA4 = PERMIT_PRINT_PAPER_WIDTH_PT - card.widthPt;

    expect(PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT).toBe(28);
    expect(shifted).toHaveLength(original.length);
    shifted.forEach((field, i) => {
      expect(field.id).toBe(original[i]!.id);
      expect(field.x).toBeCloseTo(original[i]!.x + cardLeftOnA4 + 28, 5);
      expect(field.y).toBe(original[i]!.y);
    });
  });

  it('生成したPDFもA4横になる', async () => {
    const result = await generatePermitPdf(
      { applicantName: '大利　和子', permitNumber: '1844' } as never,
      { includeBackground: false }
    );
    expect(result.success).toBe(true);
    const doc = await PDFDocument.load(result.buffer!);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(841.89, 1);
    expect(height).toBeCloseTo(595.28, 1);
  });

  it('台紙の絵つきPDFはB5の大きさ・元の位置のまま', () => {
    expect(permitCertificatePages(true)).toBe(PERMIT_CERTIFICATE_PAGES);
  });

  it('元の型定義の位置は書き換えない（画面のプレビューがずれない）', () => {
    const before = card.fields.map((field) => field.x);
    permitCertificatePages(false);
    expect(card.fields.map((field) => field.x)).toEqual(before);
    expect(card.widthPt).toBe(728.4);
    expect(ENVELOPE_LETTER_PAGES[0]!.fields.length).toBeGreaterThan(0);
  });
});
