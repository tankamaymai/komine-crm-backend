import { Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import prisma from '../db/prisma';
import { getRequestLogger, logger } from '../utils/logger';
import { isRateLimitError } from './isRateLimitError';

// Cookie設定の定数
// secure/sameSite は NODE_ENV ではなく実際の提供スキームに連動させる（#299）。
// 平文HTTPでは Secure 属性付きCookieがブラウザに保存されず、SameSite=None は
// Secure を要求するため、HTTPのローカル本番運用では COOKIE_SECURE=false を設定する。
//   COOKIE_SECURE=true  → secure:true / sameSite:'none'（HTTPS提供）
//   COOKIE_SECURE=false → secure:false / sameSite:'lax'（平文HTTP・同一オリジン運用）
//   未設定              → 従来どおり NODE_ENV==='production' で判定
const isProduction = process.env['NODE_ENV'] === 'production';
const cookieSecureEnv = process.env['COOKIE_SECURE'];
const cookieSecure =
  cookieSecureEnv === 'true' ? true : cookieSecureEnv === 'false' ? false : isProduction;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: (cookieSecure ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};

// アクセストークン用Cookie設定（有効期限: 1時間）
const ACCESS_TOKEN_COOKIE = 'access_token';
const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 1000; // 1時間

// リフレッシュトークン用Cookie設定（有効期限: 7日）
const REFRESH_TOKEN_COOKIE = 'refresh_token';
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7日

/**
 * 認証Cookieを設定するヘルパー関数
 */
const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: ACCESS_TOKEN_MAX_AGE,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...COOKIE_OPTIONS,
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
};

/**
 * 認証Cookieをクリアするヘルパー関数
 */
const clearAuthCookies = (res: Response) => {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...COOKIE_OPTIONS });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...COOKIE_OPTIONS });
};

// Supabaseクライアントの初期化
const supabaseUrl = process.env['SUPABASE_URL'] || '';
const supabaseServiceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] || '';

if (!supabaseUrl || !supabaseServiceKey) {
  logger.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set in environment variables');
}

let supabase: SupabaseClient | null = null;

// 環境変数が設定されている場合のみクライアントを初期化
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
}

/**
 * ログイン
 * POST /api/v1/auth/login
 */
export const login = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'メールアドレスとパスワードは必須です',
          details: [],
        },
      });
    }

    // Supabaseで認証
    log.info({ email }, 'Auth: login attempt');
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      log.warn(
        { email, reason: 'supabase_auth_error', error: error?.message || 'no user returned' },
        'Auth: login failed'
      );
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'メールアドレスまたはパスワードが正しくありません',
          details: [],
        },
      });
    }

    // Staffテーブルでユーザー情報を取得
    const staff = await prisma.staff.findUnique({
      where: {
        supabase_uid: data.user.id,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        is_active: true,
        supabase_uid: true,
      },
    });

    if (!staff) {
      log.warn(
        { email, reason: 'staff_not_found', supabaseUid: data.user.id },
        'Auth: login failed'
      );
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'ユーザーが登録されていません',
          details: [],
        },
      });
    }

    if (!staff.is_active) {
      log.warn({ email, reason: 'user_inactive', staffId: staff.id }, 'Auth: login failed');
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'ユーザーアカウントが無効になっています',
          details: [],
        },
      });
    }

    // last_login_atを更新
    await prisma.staff.update({
      where: { id: staff.id },
      data: { last_login_at: new Date() },
    });

    // HttpOnly Cookieを設定
    if (data.session?.access_token && data.session?.refresh_token) {
      setAuthCookies(res, data.session.access_token, data.session.refresh_token);
    }

    log.info({ email, staffId: staff.id, role: staff.role }, 'Auth: login success');
    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: staff.id,
          email: staff.email,
          name: staff.name,
          role: staff.role,
          supabase_uid: staff.supabase_uid,
        },
        session: {
          // トークンはCookieに設定するため、レスポンスボディには含めない（セキュリティ向上）
          // フロントエンドはexpiresAtのみを使用して有効期限を管理
          expires_at: data.session?.expires_at,
        },
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: login error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ログイン処理中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * ログアウト
 * POST /api/v1/auth/logout
 */
export const logout = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    // Cookieまたはヘッダーからトークンを取得
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const cookieToken = cookies?.[ACCESS_TOKEN_COOKIE];
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.replace('Bearer ', '').trim();
    const token = cookieToken || headerToken;
    const tokenSource = cookieToken ? 'cookie' : headerToken ? 'header' : 'none';

    log.info({ tokenSource }, 'Auth: logout attempt');

    if (token) {
      // Supabaseでログアウト
      await supabase.auth.admin.signOut(token);
    }

    // HttpOnly Cookieをクリア
    clearAuthCookies(res);

    log.info('Auth: logout success');
    return res.status(200).json({
      success: true,
      data: {
        message: 'ログアウトしました',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: logout error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ログアウト処理中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * 現在のユーザー情報取得
 * GET /api/v1/auth/me
 */
export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '認証が必要です',
          details: [],
        },
      });
    }

    // Staffテーブルから最新情報を取得
    const staff = await prisma.staff.findUnique({
      where: {
        id: req.user.id,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        is_active: true,
        supabase_uid: true,
        created_at: true,
        updated_at: true,
        last_login_at: true,
      },
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'ユーザーが見つかりません',
          details: [],
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: staff,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Auth: get current user error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'ユーザー情報取得中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * トークンリフレッシュ
 * POST /api/v1/auth/refresh
 */
export const refreshToken = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    // Cookieまたはリクエストボディからリフレッシュトークンを取得
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const body = req.body as { refresh_token?: string } | undefined;
    const cookieRefreshToken = cookies?.[REFRESH_TOKEN_COOKIE];
    const bodyRefreshToken = body?.refresh_token;
    const refresh_token = cookieRefreshToken || bodyRefreshToken;
    const tokenSource = cookieRefreshToken ? 'cookie' : bodyRefreshToken ? 'body' : 'none';

    log.info({ tokenSource }, 'Auth: token refresh attempt');

    if (!refresh_token) {
      log.warn({ reason: 'no_refresh_token' }, 'Auth: token refresh failed');
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'リフレッシュトークンは必須です',
          details: [],
        },
      });
    }

    // Supabaseでトークンをリフレッシュ
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error || !data.session) {
      log.warn(
        { reason: 'supabase_error', error: error?.message || 'no session returned' },
        'Auth: token refresh failed'
      );
      // リフレッシュ失敗時はCookieをクリア
      clearAuthCookies(res);
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'トークンのリフレッシュに失敗しました。再度ログインしてください。',
          details: [],
        },
      });
    }

    // 新しいトークンでCookieを更新
    setAuthCookies(res, data.session.access_token, data.session.refresh_token);

    log.info({ expiresAt: data.session.expires_at }, 'Auth: token refresh success');
    return res.status(200).json({
      success: true,
      data: {
        session: {
          // トークンはCookieに設定するため、レスポンスボディには含めない
          expires_at: data.session.expires_at,
        },
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: token refresh error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'トークンリフレッシュ処理中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * パスワード変更
 * PUT /api/v1/auth/password
 */
export const changePassword = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '認証が必要です',
          details: [],
        },
      });
    }

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    log.info({ staffId: req.user.id }, 'Auth: password change attempt');

    if (!currentPassword || !newPassword) {
      log.warn({ staffId: req.user.id, reason: 'missing_fields' }, 'Auth: password change failed');
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '現在のパスワードと新しいパスワードは必須です',
          details: [],
        },
      });
    }

    if (newPassword.length < 8) {
      log.warn(
        { staffId: req.user.id, reason: 'password_too_short' },
        'Auth: password change failed'
      );
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'パスワードは8文字以上である必要があります',
          details: [],
        },
      });
    }

    // 現在のパスワードを検証
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: req.user.email,
      password: currentPassword,
    });

    if (signInError) {
      log.warn(
        { staffId: req.user.id, reason: 'current_password_invalid' },
        'Auth: password change failed'
      );
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '現在のパスワードが正しくありません',
          details: [],
        },
      });
    }

    // Supabaseでパスワード更新
    const { error: updateError } = await supabase.auth.admin.updateUserById(req.user.supabase_uid, {
      password: newPassword,
    });

    if (updateError) {
      log.error(
        { staffId: req.user.id, reason: 'supabase_update_error', error: updateError.message },
        'Auth: password change failed'
      );
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'パスワードの更新に失敗しました',
          details: [],
        },
      });
    }

    log.info({ staffId: req.user.id }, 'Auth: password change success');
    return res.status(200).json({
      success: true,
      data: {
        message: 'パスワードを変更しました',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: password change error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'パスワード変更中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * プロフィール更新（名前・メールアドレス）
 * PUT /api/v1/auth/profile
 */
export const updateProfile = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '認証が必要です',
          details: [],
        },
      });
    }

    const { name, email } = req.body as { name?: string; email?: string };

    log.info(
      { staffId: req.user.id, hasName: name !== undefined, hasEmail: email !== undefined },
      'Auth: profile update attempt'
    );

    // メールアドレス変更時: 他ユーザーとの重複チェック
    if (email && email !== req.user.email) {
      const existingStaff = await prisma.staff.findFirst({
        where: {
          email,
          id: { not: req.user.id },
        },
      });

      if (existingStaff) {
        log.warn({ staffId: req.user.id, reason: 'email_conflict' }, 'Auth: profile update failed');
        return res.status(409).json({
          success: false,
          error: {
            code: 'CONFLICT',
            message: 'このメールアドレスは既に使用されています',
            details: [],
          },
        });
      }

      // Supabaseのメールアドレスを更新
      const { error: supabaseError } = await supabase.auth.admin.updateUserById(
        req.user.supabase_uid,
        { email }
      );

      if (supabaseError) {
        log.error(
          {
            staffId: req.user.id,
            reason: 'supabase_email_update_error',
            error: supabaseError.message,
          },
          'Auth: profile update failed'
        );
        return res.status(500).json({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'メールアドレスの更新に失敗しました',
            details: [],
          },
        });
      }
    }

    // Staffテーブルを更新
    const updateData: { name?: string; email?: string } = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;

    // Supabase メール更新成功後に DB 更新が失敗すると Supabase=新メール / DB=旧メール の
    // 分散不整合が残り、以後どちらのメールでもログイン不能になりうる。
    // createStaff の補償削除と同様に、失敗時は Supabase 側を旧メールへ戻す（#233）。
    const emailChanged = Boolean(email && email !== req.user.email);
    let updatedStaff;
    try {
      updatedStaff = await prisma.staff.update({
        where: { id: req.user.id },
        data: updateData,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          is_active: true,
          supabase_uid: true,
        },
      });
    } catch (dbError) {
      if (emailChanged) {
        try {
          const { error: revertError } = await supabase.auth.admin.updateUserById(
            req.user.supabase_uid,
            { email: req.user.email }
          );
          if (revertError) {
            log.warn(
              { staffId: req.user.id, error: revertError.message },
              'Auth: DB更新失敗後のSupabaseメール補償戻しに失敗（不整合が残存している可能性）'
            );
          } else {
            log.warn(
              { staffId: req.user.id },
              'Auth: DB更新失敗のためSupabaseメールを旧値へ戻した'
            );
          }
        } catch (revertException) {
          log.warn(
            { staffId: req.user.id, err: revertException },
            'Auth: Supabaseメール補償戻しで例外（不整合が残存している可能性）'
          );
        }
      }
      throw dbError;
    }

    log.info({ staffId: req.user.id }, 'Auth: profile update success');
    return res.status(200).json({
      success: true,
      data: {
        user: updatedStaff,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: profile update error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'プロフィール更新中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * パスワードリセットメール送信
 * POST /api/v1/auth/forgot-password
 */
export const forgotPassword = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    const { email: rawEmail } = req.body as { email: string };
    // Staff.email は createStaff/updateStaff で trim().toLowerCase() 保存される。
    // 入力をそのまま使うと大文字混じり・前後空白でルックアップがヒットせず、
    // 招待未完了検知（#234）が偽陰性になるため同じ正規化を通す（#280）。
    const email = rawEmail.trim().toLowerCase();

    log.info({ email }, 'Auth: password reset request');

    // 招待未完了（supabase_uid が pending_）のスタッフは Supabase 側にユーザーが
    // 存在せずリセットメールが届かないため、運用検知用の warn を残す（#234）。
    // 列挙対策のため応答は一律成功のまま変えず、タイミング差を避けるため
    // resetPasswordForEmail も従来どおり呼ぶ（このルックアップはログ用途のみ）。
    const staffForDiagnostics = await prisma.staff.findFirst({
      where: { email, deleted_at: null },
      select: { id: true, supabase_uid: true },
    });
    if (
      staffForDiagnostics &&
      (!staffForDiagnostics.supabase_uid || staffForDiagnostics.supabase_uid.startsWith('pending_'))
    ) {
      log.warn(
        { staffId: staffForDiagnostics.id, email },
        'Auth: 招待未完了スタッフへのパスワードリセット要求（メールは届かない。管理者による再招待が必要）'
      );
    }

    const frontendUrl = process.env['FRONTEND_URL'] || 'http://localhost:3000';
    const redirectTo = `${frontendUrl}/reset-password`;

    // Supabaseでパスワードリセットメール送信
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      // エラーが発生してもセキュリティ上同一レスポンスを返す
      log.warn(
        { email, status: error.status, error: error.message },
        'Auth: password reset email failed'
      );

      // レート制限だけは専用メッセージを返す（#350）。
      // レート制限は「送信元の送信枠」の話でメアドの存在に依存しないため、
      // 専用メッセージを返しても登録済みかどうかの列挙情報は漏れない＝安全。
      // それ以外のエラー（user無し含む）は従来どおり一律成功で返し列挙対策を維持する。
      //
      // 判定は HTTP 429 を主軸にする。Supabase のレート制限文言は版・状況で変わり
      // （実例: "For security purposes, you can only request this after N seconds."）、
      // 旧来の message.includes('rate limit') ではこの文言を取りこぼして「送信成功」を
      // 偽装していた（実際は1通も送られない）。status と文言の両方で判定する。
      if (isRateLimitError(error)) {
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'メールの送信制限に達しました。しばらく待ってから再試行してください。',
            details: [],
          },
        });
      }
    } else {
      log.info({ email }, 'Auth: password reset email sent');
    }

    // メールアドレスの存在有無に関わらず同一レスポンス（メール列挙攻撃対策）
    return res.status(200).json({
      success: true,
      data: {
        message: 'パスワードリセット用のメールを送信しました。メールをご確認ください。',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: forgot password error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'パスワードリセット処理中にエラーが発生しました',
        details: [],
      },
    });
  }
};

/**
 * パスワードリセット（新パスワード設定）
 * POST /api/v1/auth/reset-password
 * 招待メールからの初回パスワード設定、パスワードリセット両方に対応
 */
export const resetPassword = async (req: Request, res: Response) => {
  const log = getRequestLogger();
  try {
    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    }

    const { code, accessToken, newPassword } = req.body as {
      code?: string;
      accessToken?: string;
      newPassword: string;
    };

    // 招待/リセットメールのリンクは Supabase の implicit フロー（セッションを
    // URLハッシュ `#access_token=...` に載せて返す）で着地するため、フロントは
    // ハッシュから access_token を取り出してここへ渡す。これがユーザー特定の主経路。
    // PKCE の code（`?code=`）経路も後方互換として残す（デプロイ順で壊れないように）。
    let userId: string;

    if (accessToken) {
      log.info('Auth: password reset attempt via access_token');
      // access_token（リカバリ/招待で発行された短命JWT）を検証してユーザーを特定
      const { data: userData, error: getUserError } = await supabase.auth.getUser(accessToken);

      if (getUserError || !userData?.user) {
        log.warn(
          { reason: 'invalid_access_token', error: getUserError?.message || 'no user returned' },
          'Auth: password reset failed'
        );
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'リンクが無効または期限切れです。再度パスワードリセットをお試しください。',
            details: [],
          },
        });
      }

      userId = userData.user.id;
    } else if (code) {
      log.info('Auth: password reset attempt via code');
      // Supabaseのコードをセッションに交換してユーザーを特定（PKCEフロー）
      const { data: sessionData, error: exchangeError } =
        await supabase.auth.exchangeCodeForSession(code);

      if (exchangeError || !sessionData?.user) {
        log.warn(
          { reason: 'invalid_code', error: exchangeError?.message || 'no user returned' },
          'Auth: password reset failed'
        );
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: '認証コードが無効または期限切れです。再度パスワードリセットをお試しください。',
            details: [],
          },
        });
      }

      userId = sessionData.user.id;
    } else {
      // バリデーションで担保済みだが防御的に（accessToken/code いずれも無い）
      log.warn({ reason: 'missing_token' }, 'Auth: password reset failed');
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'リンクが無効です。再度パスワードリセットをお試しください。',
          details: [],
        },
      });
    }

    // Admin APIでパスワードを更新
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateError) {
      log.error(
        { userId, reason: 'update_error', error: updateError.message },
        'Auth: password reset failed'
      );
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'パスワードの更新に失敗しました',
          details: [],
        },
      });
    }

    log.info({ userId }, 'Auth: password reset success');
    return res.status(200).json({
      success: true,
      data: {
        message: 'パスワードを設定しました。ログインしてください。',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Auth: reset password error');
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'パスワードリセット処理中にエラーが発生しました',
        details: [],
      },
    });
  }
};
