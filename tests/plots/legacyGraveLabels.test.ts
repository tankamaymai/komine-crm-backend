import { resolveBaseName, resolveHandlerName } from '../../src/plots/legacyGraveLabels';

describe('旧台帳の取扱・基地', () => {
  it('取扱の番号を名前にする', () => {
    expect(resolveHandlerName(null, 1)).toBe('小嶺');
    expect(resolveHandlerName('', 2)).toBe('はせがわ');
    expect(resolveHandlerName(null, 3)).toBe('晃');
  });

  it('あとから入れた取扱の名前を優先する', () => {
    expect(resolveHandlerName('石の大友', 1)).toBe('石の大友');
  });

  it('取扱の番号 0 と空は名前にしない', () => {
    expect(resolveHandlerName(null, 0)).toBeNull();
    expect(resolveHandlerName(null, null)).toBeNull();
  });

  it('基地の番号を名前にする', () => {
    expect(resolveBaseName(7)).toBe('規格-千羽鶴');
    expect(resolveBaseName(23)).toBe('J3');
    expect(resolveBaseName(9)).toBe('自由');
    expect(resolveBaseName(48)).toBe('規格-新A');
  });

  it('基地の番号 0 と空は名前にしない', () => {
    expect(resolveBaseName(0)).toBeNull();
    expect(resolveBaseName(null)).toBeNull();
  });
});
