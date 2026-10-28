import { ENVELOPE_LETTER_PAGES, PERMIT_CERTIFICATE_PAGES } from '@komine/types';

import {
  PERMIT_TEXT_ONLY_SHIFT_DOWN_PT,
  PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT,
  permitCertificatePages,
} from '../../src/documents/permitPdfService';

describe('許可証の文字だけ印刷の位置', () => {
  it('台紙に文字だけ刷るときは、全項目を右へ約1cm、下へ約2mmずらす', () => {
    const original = PERMIT_CERTIFICATE_PAGES[0]!.fields;
    const shifted = permitCertificatePages(false)[0]!.fields;

    expect(PERMIT_TEXT_ONLY_SHIFT_RIGHT_PT).toBe(28);
    // 2mm = 5.67pt
    expect(PERMIT_TEXT_ONLY_SHIFT_DOWN_PT).toBeCloseTo((2 / 25.4) * 72, 1);
    expect(shifted).toHaveLength(original.length);
    shifted.forEach((field, i) => {
      expect(field.id).toBe(original[i]!.id);
      expect(field.x).toBe(original[i]!.x + 28);
      expect(field.y).toBe(original[i]!.y - PERMIT_TEXT_ONLY_SHIFT_DOWN_PT);
    });
  });

  it('台紙の絵つきPDFは元の位置のまま', () => {
    expect(permitCertificatePages(true)).toBe(PERMIT_CERTIFICATE_PAGES);
  });

  it('元の型定義の位置は書き換えない（画面のプレビューがずれない）', () => {
    const before = PERMIT_CERTIFICATE_PAGES[0]!.fields.map((field) => field.x);
    permitCertificatePages(false);
    expect(PERMIT_CERTIFICATE_PAGES[0]!.fields.map((field) => field.x)).toEqual(before);
    expect(ENVELOPE_LETTER_PAGES[0]!.fields.length).toBeGreaterThan(0);
  });
});
