/**
 * documentService.buildBulkInvoiceHtml の単体テスト
 *
 * 数百件を 1 ファイルに連結して 1 回だけ Puppeteer を動かすため、
 * 「1 件 = 1 ページ」に分かれることと、各件のデータが混ざらないことを固定する。
 */

jest.mock('puppeteer', () => ({ launch: jest.fn() }));

import { buildBulkInvoiceHtml } from '../../src/documents/documentService';

const TEMPLATE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <style>.notice-container { color: #222; }</style>
</head>
<body{{textStyleBodyAttr}}>
  <div class="notice-container">
    <span class="name">{{ customerName }}</span>
    <span class="year">{{ yearCount }}</span>
    <span class="amount">{{ amountFormatted }}</span>
    <span class="next">{{ nextNoticeDate }}</span>
  </div>
</body>
</html>`;

describe('buildBulkInvoiceHtml', () => {
  it('1件につき1ページ分のセクションを作る', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, [
      { customerName: 'A' },
      { customerName: 'B' },
      { customerName: 'C' },
    ]);

    expect(html.match(/class="invoice-page"/g)).toHaveLength(3);
    expect(html).toContain('page-break-after: always');
  });

  it('テンプレートの style は 1 度だけ取り込む', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, [{ customerName: 'A' }, { customerName: 'B' }]);

    expect(html.match(/\.notice-container \{ color: #222; \}/g)).toHaveLength(1);
  });

  it('件ごとのデータがそれぞれのページに入る', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, [
      { customerName: '山田 太郎', yearCount: 10, amount: 82800, nextNoticeDate: '2037年3月' },
      { customerName: '鈴木 花子', yearCount: 5, amount: 31820, nextNoticeDate: '2032年3月' },
    ]);

    expect(html).toContain('山田 太郎');
    expect(html).toContain('鈴木 花子');
    // 金額はテンプレート側の補完で桁区切りされる
    expect(html).toContain('82,800');
    expect(html).toContain('31,820');
  });

  it('書体プリセットはドキュメント全体の body に 1 度だけ適用する', () => {
    const html = buildBulkInvoiceHtml(
      TEMPLATE,
      [{ customerName: 'A' }, { customerName: 'B' }],
      'mincho'
    );

    expect(html.match(/doc-preset-mincho/g)).toHaveLength(1);
    expect(html).toContain('<body class="doc-preset-mincho">');
  });

  it('未知のプリセットは既定にフォールバックし、body に class を付けない', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, [{ customerName: 'A' }], 'evil"><script>');

    expect(html).toContain('<body>');
    expect(html).not.toContain('<script>');
  });

  it('契約者名は HTML エスケープされる', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, [{ customerName: '<script>alert(1)</script>' }]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('0件でもページを作らない', () => {
    const html = buildBulkInvoiceHtml(TEMPLATE, []);

    expect(html).not.toContain('class="invoice-page"');
  });
});
