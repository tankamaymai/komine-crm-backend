/**
 * 許可証・封筒PDFのフォントサブセット化テスト（#237）
 *
 * 実フォント（NotoSansJP）・実テンプレートで生成し、
 * - 生成が成功すること（CIDマップ不整合等で throw しない）
 * - subset: true によりサイズが大幅に縮小されていること
 *   （全グリフ埋め込みだと1ページ約6.3MB、サブセットなら数百KB）
 * を回帰担保する。縦書き（封筒系の direction: 'vertical'）・回転を含む
 * 全テンプレート経路をカバーする。
 */
import type { PermitTemplateData } from '@komine/types';

import {
  generatePermitPdf,
  generateEnvelopeLetterPdf,
  generateEnvelopeBasePdf,
} from '../../src/documents/permitPdfService';

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
});
