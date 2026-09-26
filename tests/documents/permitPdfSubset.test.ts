/**
 * 許可証・封筒PDFのフォントサブセット化テスト（#237）
 *
 * 実フォント（NotoSansJP）・実テンプレートで生成し、
 * - 生成が成功すること（CIDマップ不整合等で throw しない）
 * - subset: true によりサイズが大幅に縮小されていること
 *   （全グリフ埋め込みだと1ページ約6.3MB、サブセットなら数百KB）
 * を回帰担保する。加えて、埋め込んだ文字の形が壊れていないこと
 * （入力した文字が PDF 上で欠けないこと）を見る。
 */
import type { PermitTemplateData } from '@komine/types';
import fontkit from 'pdf-fontkit';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

import {
  generatePermitPdf,
  generateEnvelopeLetterPdf,
  generateEnvelopeBasePdf,
} from '../../src/documents/permitPdfService';

/**
 * 入力文字が PDF 上で欠けないこと。
 * @pdf-lib/fontkit のサブセットは Noto Sans JP の字形テーブルを壊し、
 * 画面では文字が途中までしか出ない。壊れた字形は読み出しで例外になる。
 */
async function assertEmbeddedGlyphsAreDrawable(buffer: Buffer): Promise<void> {
  const doc = await PDFDocument.load(buffer);
  let fontFiles = 0;

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj instanceof PDFRawStream) continue;
    const type = obj.get(PDFName.of('Type'));
    if (!type || type.toString() !== '/FontDescriptor') continue;
    const fileRef = obj.get(PDFName.of('FontFile2'));
    if (!fileRef) continue;
    const stream = doc.context.lookup(fileRef);
    if (!(stream instanceof PDFRawStream)) continue;

    const font = fontkit.create(decodePDFRawStream(stream).decode());
    fontFiles += 1;

    let threw = 0;
    let nonempty = 0;
    for (let i = 0; i < font.numGlyphs; i += 1) {
      try {
        const glyph = font.getGlyph(i);
        if ((glyph.path?.commands.length ?? 0) > 0) nonempty += 1;
      } catch {
        threw += 1;
      }
    }

    expect(threw).toBe(0);
    expect(nonempty).toBeGreaterThan(0);
  }

  expect(fontFiles).toBeGreaterThan(0);
}

// 漢字・かな・カナ・英数・記号を含む代表データ（全フィールド使用）
const data: PermitTemplateData = {
  permitNumber: '第12345号',
  permitType: '埋蔵',
  plotNumber: '吉相-10',
  area: '3.6㎡',
  issueYear: '2026',
  issueMonth: '6',
  issueDay: '5',
  applicantName: '山田　太郎',
  registeredAddress: '福岡県北九州市八幡西区小嶺台1-2-3',
  registeredAddress2: '',
  currentAddress: '東京都渋谷区渋谷1丁目',
  currentAddress2: '2番3号 ハイツ渋谷101',
  recipientPostalCode: '8070815',
  recipientPostalDigit1: '8',
  recipientPostalDigit2: '0',
  recipientPostalDigit3: '7',
  recipientPostalDigit4: '0',
  recipientPostalDigit5: '8',
  recipientPostalDigit6: '1',
  recipientPostalDigit7: '5',
  recipientAddress: '福岡県北九州市八幡西区小嶺台',
  recipientAddress2: '4丁目5-6',
  recipientName: '小嶺　花子',
  notes: 'テスト備考',
};

// サブセット化後の上限（全グリフ埋め込みだと 5MB 超になるため、
// これを下回っていればサブセットが効いていると判定できる）
const MAX_SUBSET_SIZE = 1.5 * 1024 * 1024; // 1.5MB

describe('permitPdfService フォントサブセット（#237）', () => {
  jest.setTimeout(30000); // 実フォント埋め込みのため余裕を持たせる

  it('許可証PDF（横書き）が生成され、サブセット化でサイズが縮小されること', async () => {
    const result = await generatePermitPdf(data);

    expect(result.success).toBe(true);
    expect(result.buffer).toBeDefined();
    expect(result.buffer!.length).toBeGreaterThan(0);
    expect(result.buffer!.length).toBeLessThan(MAX_SUBSET_SIZE);
  });

  it('封筒書PDF（縦書き含む）が生成され、サブセット化でサイズが縮小されること', async () => {
    const result = await generateEnvelopeLetterPdf(data);

    expect(result.success).toBe(true);
    expect(result.buffer!.length).toBeGreaterThan(0);
    expect(result.buffer!.length).toBeLessThan(MAX_SUBSET_SIZE);
  });

  it('封筒大PDFが生成され、サブセット化でサイズが縮小されること', async () => {
    const result = await generateEnvelopeBasePdf(data);

    expect(result.success).toBe(true);
    expect(result.buffer!.length).toBeGreaterThan(0);
    expect(result.buffer!.length).toBeLessThan(MAX_SUBSET_SIZE);
  });

  it('厚紙印刷用PDFは台紙の絵を入れず、入力文字だけが残ること', async () => {
    const withSheet = await generatePermitPdf(data);
    const textOnly = await generatePermitPdf(data, { includeBackground: false });

    expect(withSheet.success).toBe(true);
    expect(textOnly.success).toBe(true);
    expect(textOnly.buffer!.length).toBeGreaterThan(0);
    expect(textOnly.buffer!.length).toBeLessThan(withSheet.buffer!.length / 2);
    await assertEmbeddedGlyphsAreDrawable(textOnly.buffer!);
  });

  it('入力した文字の形が壊れず、許可証・封筒のPDFに全部残ること', async () => {
    const permit = await generatePermitPdf(data);
    const letter = await generateEnvelopeLetterPdf(data);
    const base = await generateEnvelopeBasePdf(data);

    expect(permit.success).toBe(true);
    expect(letter.success).toBe(true);
    expect(base.success).toBe(true);

    await assertEmbeddedGlyphsAreDrawable(permit.buffer!);
    await assertEmbeddedGlyphsAreDrawable(letter.buffer!);
    await assertEmbeddedGlyphsAreDrawable(base.buffer!);
  });
});
