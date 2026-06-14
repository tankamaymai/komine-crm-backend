/**
 * Supabase Admin サービス
 * Service Role Keyを使用した管理者権限でのユーザー管理機能を提供
 */
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

import { isRateLimitError } from '../auth/isRateLimitError';

// 環境変数
const supabaseUrl = process.env['SUPABASE_URL'] || '';
const supabaseServiceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] || '';

let supabaseAdmin: SupabaseClient | null = null;

// 環境変数が設定されている場合のみクライアントを初期化
if (supabaseUrl && supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Supabase Admin クライアントが利用可能かチェック
 */
export const isSupabaseAdminAvailable = (): boolean => {
  return supabaseAdmin !== null;
};

/**
 * ユーザー作成結果
 */
export interface CreateUserResult {
  success: boolean;
  user?: User;
  error?: string;
  /**
   * エラーの機械可読な種別。呼び出し側が文字列マッチに頼らず分岐できるようにする。
   * - 'already_registered': 同一メールのSupabaseユーザーが既に存在する
   * - 'rate_limit': 招待メール送信のレート制限
   */
  errorCode?: 'already_registered' | 'rate_limit';
}

/**
 * 招待メール送信結果
 */
export interface InviteUserResult {
  success: boolean;
  user?: User;
  error?: string;
  /**
   * エラーの機械可読な種別。呼び出し側が文字列マッチに頼らず分岐できるようにする。
   * - 'already_registered': 同一メールのSupabaseユーザーが既に存在する
   * - 'rate_limit': 招待メール送信のレート制限
   */
  errorCode?: 'already_registered' | 'rate_limit';
}

/**
 * ユーザー削除結果
 */
export interface DeleteUserResult {
  success: boolean;
  error?: string;
}

/**
 * Supabaseユーザーを作成（招待メール送信付き）
 *
 * @param email - ユーザーのメールアドレス
 * @param metadata - ユーザーメタデータ（name, roleなど）
 * @param redirectTo - パスワード設定後のリダイレクト先URL（オプション）
 * @returns 作成結果
 */
export const createSupabaseUser = async (
  email: string,
  metadata: { name: string; role: string },
  redirectTo?: string
): Promise<CreateUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    // inviteUserByEmailを使用してユーザーを作成し、招待メールを送信
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: metadata,
      redirectTo: redirectTo,
    });

    if (error) {
      // よくあるエラーの日本語化
      let errorMessage = error.message;
      let errorCode: CreateUserResult['errorCode'];
      if (error.message.includes('already registered')) {
        errorMessage = 'このメールアドレスは既にSupabaseに登録されています';
        errorCode = 'already_registered';
      } else if (isRateLimitError(error)) {
        errorMessage = '招待メールの送信制限に達しました。しばらく待ってから再試行してください';
        errorCode = 'rate_limit';
      }

      return {
        success: false,
        error: errorMessage,
        errorCode,
      };
    }

    return {
      success: true,
      user: data.user,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};

/**
 * Supabaseユーザーを作成（招待メールなし、パスワード指定）
 * 主にテスト用途や、即座にログイン可能なアカウントが必要な場合に使用
 *
 * @param email - ユーザーのメールアドレス
 * @param password - 初期パスワード
 * @param metadata - ユーザーメタデータ
 * @returns 作成結果
 */
export const createSupabaseUserWithPassword = async (
  email: string,
  password: string,
  metadata: { name: string; role: string }
): Promise<CreateUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // メール確認済みとして作成
      user_metadata: metadata,
    });

    if (error) {
      let errorMessage = error.message;
      if (error.message.includes('already registered')) {
        errorMessage = 'このメールアドレスは既にSupabaseに登録されています';
      }

      return {
        success: false,
        error: errorMessage,
      };
    }

    return {
      success: true,
      user: data.user,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};

/**
 * Supabaseユーザーを削除
 *
 * @param userId - Supabase UID
 * @returns 削除結果
 */
export const deleteSupabaseUser = async (userId: string): Promise<DeleteUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};

/**
 * Supabaseユーザーのメールアドレスを更新
 *
 * @param userId - Supabase UID
 * @param newEmail - 新しいメールアドレス
 * @returns 更新結果
 */
export const updateSupabaseUserEmail = async (
  userId: string,
  newEmail: string
): Promise<CreateUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email: newEmail,
    });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      user: data.user,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};

/**
 * 招待メールを再送信（Supabaseユーザーが未作成のスタッフ向け）
 *
 * `inviteUserByEmail` は新規ユーザー作成を伴うため、既にSupabaseアカウントが
 * 存在するメールに対しては `already registered` で失敗する。既存アカウントへの
 * 再送は {@link sendPasswordReset} を使うこと。
 *
 * @param email - ユーザーのメールアドレス
 * @param redirectTo - パスワード設定後のリダイレクト先URL（オプション）
 * @returns 送信結果（`errorCode` で既存登録/レート制限を判別可能）
 */
export const resendInvitation = async (
  email: string,
  redirectTo?: string
): Promise<InviteUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
    });

    if (error) {
      let errorMessage = error.message;
      let errorCode: InviteUserResult['errorCode'];
      if (error.message.includes('already registered')) {
        errorMessage = 'このメールアドレスは既にSupabaseに登録されています';
        errorCode = 'already_registered';
      } else if (isRateLimitError(error)) {
        errorMessage = '招待メールの送信制限に達しました。しばらく待ってから再試行してください';
        errorCode = 'rate_limit';
      }

      return {
        success: false,
        error: errorMessage,
        errorCode,
      };
    }

    return {
      success: true,
      user: data.user,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};

/**
 * パスワード再設定メールを送信（Supabaseアカウントが既に存在するスタッフ向け）
 *
 * 既存ユーザーに対して `inviteUserByEmail` は使えない（`already registered` で失敗する）。
 * recovery メールを送ることで、既存ユーザーがパスワードを（再）設定できるようにする。
 *
 * @param email - ユーザーのメールアドレス
 * @param redirectTo - パスワード設定画面のリダイレクト先URL（オプション）
 * @returns 送信結果（recovery のため `user` は返らない）
 */
export const sendPasswordReset = async (
  email: string,
  redirectTo?: string
): Promise<InviteUserResult> => {
  if (!supabaseAdmin) {
    return {
      success: false,
      error: 'Supabase Admin サービスが利用できません',
    };
  }

  try {
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      let errorMessage = error.message;
      let errorCode: InviteUserResult['errorCode'];
      if (isRateLimitError(error)) {
        errorMessage =
          'パスワード再設定メールの送信制限に達しました。しばらく待ってから再試行してください';
        errorCode = 'rate_limit';
      }

      return {
        success: false,
        error: errorMessage,
        errorCode,
      };
    }

    return {
      success: true,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
    return {
      success: false,
      error: errorMessage,
    };
  }
};
