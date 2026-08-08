import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { getRequestLogger } from '../utils/logger';

/**
 * エラーハンドラーが参照するアプリケーションエラーの形状。
 * Express のエラーは unknown で受け取り、この型に narrow してから扱う。
 */
interface HandledError {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  details?: unknown[];
  /** body-parser (http-errors) が設定するエラー種別（例: 'entity.parse.failed'） */
  type?: string;
}

/** 4xx ステータスをクライアントエラーコードへマップする（#225） */
const clientErrorCodeForStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'BAD_REQUEST';
  }
};

/**
 * グローバルエラーハンドラー
 * すべてのエラーをキャッチして統一されたレスポンス形式で返す
 */
export const errorHandler = (error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const err: HandledError = typeof error === 'object' && error !== null ? error : {};
  const log = getRequestLogger();
  log.error(
    {
      err: error,
      path: req.path,
      method: req.method,
      query: req.query,
      ...(error instanceof Prisma.PrismaClientKnownRequestError
        ? { prismaCode: error.code, prismaMeta: error.meta }
        : {}),
    },
    'Unhandled error'
  );

  // Sentryにエラーを送信（ユーザー情報とリクエスト情報を含む）
  Sentry.withScope((scope) => {
    // ユーザー情報の追加（認証済みの場合）
    if (req.user) {
      scope.setUser({
        id: req.user.id.toString(),
        email: req.user.email,
        username: req.user.name,
        role: req.user.role,
      });
    }

    // リクエスト情報の追加
    scope.setContext('request', {
      method: req.method,
      url: req.url,
      path: req.path,
      query: req.query,
      headers: {
        'user-agent': req.get('user-agent'),
        'content-type': req.get('content-type'),
      },
    });

    // エラータイプに応じたレベル設定
    if (err.name === 'ValidationError' || err.name === 'NotFoundError') {
      scope.setLevel('warning');
    } else if (err.status && err.status < 500) {
      scope.setLevel('info');
    } else {
      scope.setLevel('error');
    }

    // エラーコードのタグ追加
    if (err.code) {
      scope.setTag('error_code', err.code);
    }

    // Prismaエラーコードのタグ追加
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      scope.setTag('prisma_code', error.code);
    }

    Sentry.captureException(error);
  });

  // Prismaエラーの処理
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaError(error, res);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // error.message にはテーブル名・カラム名・期待型等のスキーマ情報が含まれるため
    // クライアントには返さない（#217）。詳細はサーバログ・Sentryに記録済み。
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'データベースバリデーションエラー',
        details: [],
      },
    });
  }

  // body-parser / Express 由来のエラー（#225）
  // これらは status を持つが code を持たず、message に内部実装文言
  // （送信ボディ断片を含む）が入るため、固定文言・適切なコードへ変換する。
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'リクエストボディが大きすぎます',
        details: [],
      },
    });
  }

  if (err.type === 'entity.parse.failed' || (error instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'リクエストボディの形式が不正です',
        details: [],
      },
    });
  }

  if (error instanceof URIError) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'リクエストURLの形式が不正です',
        details: [],
      },
    });
  }

  // カスタムエラーの処理
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message || 'バリデーションエラーが発生しました',
        details: err.details || [],
      },
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: err.message || '認証が必要です',
        details: [],
      },
    });
  }

  if (err.name === 'ForbiddenError') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: err.message || '権限が不足しています',
        details: [],
      },
    });
  }

  if (err.name === 'NotFoundError') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: err.message || 'リソースが見つかりません',
        details: [],
      },
    });
  }

  if (err.name === 'ConflictError') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: err.message || '競合が発生しました',
        details: err.details || [],
      },
    });
  }

  // デフォルトのエラーレスポンス
  // 未知の 4xx（http-errors 由来等）は INTERNAL_SERVER_ERROR と誤分類せず、
  // ステータスに応じたクライアントエラーコード＋汎用文言へ安全側に倒す（#225）。
  // 生の err.message は内部実装情報を含みうるためクライアントへ返さない。
  if (err.status && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({
      success: false,
      error: {
        code: err.code || clientErrorCodeForStatus(err.status),
        message: 'リクエストを処理できませんでした',
        details: [],
      },
    });
  }

  return res.status(err.status || 500).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || '内部サーバーエラーが発生しました',
      details: [],
    },
  });
};

/**
 * P2002 (unique 制約違反) の field 名を抽出する。
 * Prisma v6 までは meta.target に入っていたが、v7 + @prisma/adapter-pg では
 * meta.driverAdapterError.cause.constraint.fields に入る。どちらも取れない
 * 場合は error.message ("Unique constraint failed on the fields: (`xxx`)")
 * を正規表現でパースしてフォールバックする。
 */
const extractP2002Fields = (error: Prisma.PrismaClientKnownRequestError): string[] => {
  const meta = error.meta as Record<string, unknown> | undefined;

  const target = meta?.['target'];
  if (Array.isArray(target)) return target.filter((f): f is string => typeof f === 'string');
  if (typeof target === 'string')
    return target
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const driverAdapterError = meta?.['driverAdapterError'] as
    | { cause?: { constraint?: { fields?: unknown } } }
    | undefined;
  const adapterFields = driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(adapterFields)) {
    const fields = adapterFields.filter((f): f is string => typeof f === 'string');
    if (fields.length > 0) return fields;
  }

  const captured = error.message.match(/fields:\s*\(([^)]+)\)/)?.[1];
  if (captured) {
    return captured
      .split(',')
      .map((s) => s.trim().replace(/^`|`$/g, ''))
      .filter(Boolean);
  }

  return [];
};

const FIELD_LABEL_MAP: Record<string, string> = {
  plot_number: '区画番号',
  email: 'メールアドレス',
  supabase_uid: 'Supabaseユーザー',
  contract_plot_id: '契約区画',
  customer_id: '顧客',
  code: 'コード',
};

const toFieldLabel = (field: string): string => FIELD_LABEL_MAP[field] ?? field;

/**
 * Prismaエラーハンドラー
 */
const handlePrismaError = (error: Prisma.PrismaClientKnownRequestError, res: Response) => {
  switch (error.code) {
    case 'P2002': {
      const fields = extractP2002Fields(error);
      const fieldKey = fields.join(', ');
      const fieldLabel = fields.length > 0 ? fields.map(toFieldLabel).join(', ') : 'データ';
      return res.status(409).json({
        success: false,
        error: {
          code: 'CONFLICT',
          message: '重複するデータが存在します',
          details: [
            {
              field: fieldKey || undefined,
              message: `${fieldLabel} は既に使用されています`,
            },
          ],
        },
      });
    }

    case 'P2000': {
      // 値がカラムの最大長を超過（Zod 上限と DB VarChar 長の不整合等）。
      // default に落とすと詳細なしの 500 になりトランザクション全体が原因不明で
      // 失敗するため、400 VALIDATION_ERROR として返す（#276）。
      // meta.column_name は v7 + driver adapter では取れない場合があるため任意。
      const meta = error.meta as Record<string, unknown> | undefined;
      const column =
        typeof meta?.['column_name'] === 'string' ? (meta['column_name'] as string) : undefined;
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が長すぎます',
          details: [
            {
              field: column,
              message: column
                ? `${toFieldLabel(column)} が保存可能な最大文字数を超えています`
                : '入力値が保存可能な最大文字数を超えています',
            },
          ],
        },
      });
    }

    case 'P2025':
      // Record not found
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'レコードが見つかりません',
          details: [],
        },
      });

    // 以下の分岐では error.message（テーブル名・制約名等のDB内部情報を含む）を
    // クライアントへ返さない（#217）。詳細はサーバログ・Sentryに記録済み。
    case 'P2003':
      // Foreign key constraint violation
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '関連するデータが存在しません',
          details: [],
        },
      });

    case 'P2014':
      // Relation violation
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'リレーションの制約違反',
          details: [],
        },
      });

    case 'P2034':
      // Serializable トランザクションの直列化競合（write conflict / deadlock）。
      // check-then-act を原子化した在庫検証・契約解約復活等（#278）で並行更新が
      // 衝突した場合に発生する。データは壊れておらずリトライで成功するため、
      // 500 でなく 409 として再試行を案内する。
      return res.status(409).json({
        success: false,
        error: {
          code: 'CONFLICT',
          message: '同時更新が競合しました。もう一度お試しください',
          details: [],
        },
      });

    case 'P2021': // テーブルが存在しない
    case 'P2022':
      // 列が存在しない。Prisma Client が持つスキーマと実DBがズレている状態で、
      // 実際の原因はほぼ「マイグレーションの適用漏れ」（prisma generate だけ実行し
      // migrate deploy を忘れた等）。default の「データベースエラー」に落ちると
      // 一時的なDB障害と区別できず調査に時間がかかるため、専用の案内にする。
      // 列名・テーブル名はDB内部情報なのでクライアントへは返さない（#217）。
      // 詳細は errorHandler 冒頭で prismaCode / prismaMeta 付きでログ・Sentry に記録済み。
      return res.status(500).json({
        success: false,
        error: {
          code: 'SCHEMA_MISMATCH',
          message:
            'データベースの構成がアプリと一致していません。マイグレーションの適用漏れの可能性があります',
          details: [],
        },
      });

    default:
      return res.status(500).json({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースエラーが発生しました',
          details: [],
        },
      });
  }
};

/**
 * 404エラーハンドラー
 * ルートが見つからない場合に実行される
 */
export const notFoundHandler = (_req: Request, res: Response) => {
  // req.path はクライアント任意の文字列のためレスポンスに反映しない（#228、入力リフレクション対策）。
  // パスは requestLogger が構造化ログ（method/path フィールド）で記録済み。
  return res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'リクエストされたルートが見つかりません',
      details: [],
    },
  });
};

/**
 * カスタムエラークラス
 */
export class ValidationError extends Error {
  details: unknown[];

  constructor(message: string, details: unknown[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message: string = 'リソースが見つかりません') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  details: unknown[];

  constructor(message: string, details: unknown[] = []) {
    super(message);
    this.name = 'ConflictError';
    this.details = details;
  }
}
