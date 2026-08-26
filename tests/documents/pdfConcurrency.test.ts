/**
 * Chromium 同時起動数制限のテスト（#229）
 *
 * generatePdfFromHtml はリクエスト毎に puppeteer.launch するため、
 * 同時生成時の起動数が MAX(2) を超えないことを検証する。
 */
jest.mock('puppeteer', () => ({ launch: jest.fn() }));

import puppeteer from 'puppeteer';
import { generatePdfFromHtml } from '../../src/documents/documentService';

const mockedLaunch = puppeteer.launch as jest.Mock;

describe('generatePdfFromHtml の同時実行制限（#229）', () => {
  beforeEach(() => {
    mockedLaunch.mockReset();
  });

  it('同時に4件呼んでも Chromium の同時起動は2件までに制限される', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    mockedLaunch.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);

      const page = {
        setContent: jest.fn().mockResolvedValue(undefined),
        waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // 明示的に解放するまで browser を占有させる
              releases.push(() => resolve(new Uint8Array([1, 2, 3])));
            })
        ),
      };
      return {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockImplementation(async () => {
          active--;
        }),
      };
    });

    const tasks = Array.from({ length: 4 }, () => generatePdfFromHtml('<html></html>'));

    // 2件が占有状態になるまで待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedLaunch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);

    // 1件解放すると次の1件が起動する
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedLaunch).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2); // 同時起動は2を超えない

    // 残りも順次解放して全件完了
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const results = await Promise.all(tasks);

    expect(mockedLaunch).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('生成が失敗してもスロットが解放され、後続が実行できる', async () => {
    // 1回目は起動失敗、以降は成功
    mockedLaunch.mockImplementation(async () => ({
      newPage: jest.fn().mockResolvedValue({
        setContent: jest.fn().mockResolvedValue(undefined),
        waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn().mockResolvedValue(new Uint8Array([1])),
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }));
    mockedLaunch.mockRejectedValueOnce(new Error('launch failed'));

    const failed = await generatePdfFromHtml('<html></html>');
    expect(failed.success).toBe(false);

    // スロットが解放されていれば後続2件も問題なく実行できる
    const [a, b] = await Promise.all([
      generatePdfFromHtml('<html></html>'),
      generatePdfFromHtml('<html></html>'),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});
