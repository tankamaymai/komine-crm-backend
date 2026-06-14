import { isRateLimitError } from '../../src/auth/isRateLimitError';

describe('isRateLimitError (#394 / #371・PR#372 横展開)', () => {
  it('status 429 をレート制限と判定する', () => {
    expect(isRateLimitError({ status: 429, message: 'whatever' })).toBe(true);
  });

  it('Supabase のクールダウン文言（rate limit 非含有）も取りこぼさない', () => {
    // 旧 `message.includes('rate limit')` がすり抜けていた実例の文言
    expect(
      isRateLimitError({
        message: 'For security purposes, you can only request this after 35 seconds.',
      })
    ).toBe(true);
  });

  it('"rate limit" / "too many requests" 文言も判定する（大文字小文字非依存）', () => {
    expect(isRateLimitError({ message: 'Email rate limit exceeded' })).toBe(true);
    expect(isRateLimitError({ message: 'Too Many Requests' })).toBe(true);
  });

  it('レート制限と無関係なエラーは false', () => {
    expect(isRateLimitError({ status: 400, message: 'invalid email' })).toBe(false);
    expect(isRateLimitError({ message: 'already registered' })).toBe(false);
  });

  it('null / undefined / 空オブジェクトは false', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError({})).toBe(false);
  });
});
