import { tokenAllowsPasswordSetup } from '../../src/auth/passwordSetupToken';

function jwtWithAmr(amr: unknown): string {
  const payload = Buffer.from(JSON.stringify({ amr })).toString('base64url');
  return `e30.${payload}.sig`;
}

describe('tokenAllowsPasswordSetup', () => {
  it('再設定リンクの鍵は通す', () => {
    expect(tokenAllowsPasswordSetup(jwtWithAmr([{ method: 'recovery', timestamp: 1 }]))).toBe(true);
  });

  it('招待リンクの鍵は通す', () => {
    expect(tokenAllowsPasswordSetup(jwtWithAmr([{ method: 'invite', timestamp: 1 }]))).toBe(true);
  });

  it('文字列だけの amr でも再設定は通す', () => {
    expect(tokenAllowsPasswordSetup(jwtWithAmr(['recovery']))).toBe(true);
  });

  it('普通のログイン鍵は通さない', () => {
    expect(tokenAllowsPasswordSetup(jwtWithAmr([{ method: 'password', timestamp: 1 }]))).toBe(
      false
    );
  });

  it('中身が読めない鍵は通さない', () => {
    expect(tokenAllowsPasswordSetup('not-a-jwt')).toBe(false);
    expect(tokenAllowsPasswordSetup('e30.%%% .sig')).toBe(false);
  });
});
