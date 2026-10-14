import { z } from 'zod';
import { emailSchema } from '../middleware/validation';

/**
 * パスワード強度バリデーション（共通）
 * 8文字以上、128文字以下、大文字・小文字・数字を含む
 */
export const passwordSchema = z
  .string()
  .min(8, 'パスワードは8文字以上である必要があります')
  .max(128, 'パスワードは128文字以下である必要があります')
  .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'パスワードは大文字、小文字、数字を含む必要があります');

/**
 * ログインリクエストのバリデーションスキーマ
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'パスワードは必須です'),
});

/**
 * パスワード変更リクエストのバリデーションスキーマ
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, '現在のパスワードは必須です'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'パスワード確認は必須です'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'パスワードが一致しません',
    path: ['confirmPassword'],
  });

/**
 * パスワードリセットリクエスト（メール送信）のバリデーションスキーマ
 */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

/**
 * パスワードリセット（新パスワード設定）のバリデーションスキーマ
 */
export const resetPasswordSchema = z
  .object({
    // implicit フロー: メールリンクのハッシュから取り出した access_token（主経路）
    accessToken: z.string().min(1).optional(),
    // PKCE フロー: `?code=` クエリ（後方互換）
    code: z.string().min(1).optional(),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'パスワード確認は必須です'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'パスワードが一致しません',
    path: ['confirmPassword'],
  })
  .refine((data) => Boolean(data.accessToken) || Boolean(data.code), {
    message: '認証情報（accessToken または code）が必要です',
    path: ['accessToken'],
  });

/**
 * プロフィール更新リクエストのバリデーションスキーマ
 */
export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .min(1, '名前は必須です')
      .max(100, '名前は100文字以下で入力してください')
      .optional(),
    email: emailSchema.optional(),
    // メールを変えるときだけ必須。名前だけの変更では不要。
    currentPassword: z.string().optional(),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined, {
    message: '名前またはメールアドレスのいずれかは必須です',
  })
  .refine((data) => data.email === undefined || Boolean(data.currentPassword), {
    message: 'メールアドレスを変更するには現在のパスワードが必要です',
    path: ['currentPassword'],
  });

/**
 * 型エクスポート
 */
export type LoginRequest = z.infer<typeof loginSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;
