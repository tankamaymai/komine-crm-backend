/**
 * パスワード再設定に使ってよい鍵かどうかを見る。
 *
 * メールのリンク（パスワード再設定・招待）で発行された鍵だけを通す。
 * 普通のログイン鍵でも supabase.auth.getUser は成功するため、
 * 署名確認のあとに中身の「入り方」（amr）を見て弾く。
 *
 * 署名の確認は呼び出し側（getUser / exchangeCodeForSession）の仕事。
 * ここでは、確認済みの鍵の中身を読むだけ。
 */

const PASSWORD_SETUP_METHODS = new Set(['recovery', 'invite']);

export function tokenAllowsPasswordSetup(token: string): boolean {
  return readAmrMethods(token).some((method) => PASSWORD_SETUP_METHODS.has(method));
}

function readAmrMethods(token: string): string[] {
  const payload = decodeJwtPayload(token);
  if (!payload) return [];
  return normalizeAmr(payload['amr']);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeAmr(amr: unknown): string[] {
  if (!Array.isArray(amr)) return [];
  const methods: string[] = [];
  for (const entry of amr) {
    if (typeof entry === 'string' && entry) {
      methods.push(entry);
    } else if (entry && typeof entry === 'object' && 'method' in entry) {
      const method = (entry as { method?: unknown }).method;
      if (typeof method === 'string' && method) methods.push(method);
    }
  }
  return methods;
}
