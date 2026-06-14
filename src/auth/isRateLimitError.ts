/**
 * Supabase 認証系エラーのレート制限判定（#371 / PR#372 の横展開・#394）
 *
 * Supabase のレート制限は HTTP 429 を返すが、文言は版・状況で変わる
 * （実例: "For security purposes, you can only request this after N seconds."）。
 * 旧来の `message.includes('rate limit')` ではこの文言を取りこぼし、
 * クールダウン中なのに「rate_limit ではない」と誤判定して生英語メッセージを
 * 400 で UI 露出させていた。status を主軸に、文言フォールバックを併用する。
 *
 * authController の forgot-password と同一の判定を共有するための共通ヘルパ。
 */

/**
 * Supabase が返すエラー風オブジェクトの最小形。`@supabase/supabase-js` の
 * `AuthError` は `status?: number` と `message: string` を持つ。
 */
export interface RateLimitCandidateError {
  status?: number;
  message?: string;
}

/**
 * Supabase 認証エラーがレート制限由来かを判定する。
 *
 * @param error - Supabase の error オブジェクト（status / message を持つ）
 * @returns レート制限なら true
 */
export const isRateLimitError = (error: RateLimitCandidateError | null | undefined): boolean => {
  if (!error) return false;
  if (error.status === 429) return true;
  const message = error.message ?? '';
  return /rate limit|you can only request this|too many requests/i.test(message);
};
