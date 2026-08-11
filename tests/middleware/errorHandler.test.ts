import { Request, Response, NextFunction } from 'express';
// Import actual Prisma error classes, not mocked ones
const { Prisma } = jest.requireActual('@prisma/client');
import { getRequestLogger } from '../../src/utils/logger';
import {
  errorHandler,
  notFoundHandler,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../../src/middleware/errorHandler';

// Express.Request型を拡張
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        is_active: boolean;
        supabase_uid: string;
      };
    }
  }
}

// Don't mock @prisma/client for this test file
jest.unmock('@prisma/client');

// Mock Sentry
jest.mock('@sentry/node', () => ({
  withScope: jest.fn((callback) => {
    const mockScope = {
      setUser: jest.fn(),
      setContext: jest.fn(),
      setLevel: jest.fn(),
      setTag: jest.fn(),
    };
    callback(mockScope);
  }),
  captureException: jest.fn(),
}));

describe('Error Handler Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  beforeEach(() => {
    mockRequest = {
      path: '/test',
      method: 'GET',
      url: '/test',
      query: {},
      get: jest.fn((header: string): string | string[] | undefined => {
        if (header === 'user-agent') return 'test-agent';
        if (header === 'content-type') return 'application/json';
        if (header === 'set-cookie') return [];
        return undefined;
      }) as any,
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  describe('errorHandler', () => {
    describe('Prismaエラー処理', () => {
      it('P2002（重複エラー、v6 meta.target=array）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['email'] },
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: 'email',
                message: 'メールアドレス は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2000（カラム長超過）は 500 でなく 400 VALIDATION_ERROR を返すこと (#276)', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'The provided value for the column is too long',
          {
            code: 'P2000',
            clientVersion: '7.0.0',
            meta: { column_name: 'phone_number' },
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
        expect(payload.error.code).toBe('VALIDATION_ERROR');
        expect(payload.error.message).toBe('入力値が長すぎます');
        expect(payload.error.details[0].field).toBe('phone_number');
        // DB内部情報（テーブル名等）をそのまま返さないこと（#217 と同方針）
        expect(JSON.stringify(payload)).not.toContain('column is too long');
      });

      it('P2000（meta.column_name 不在）でも 400 で汎用メッセージを返すこと (#276)', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Value too long', {
          code: 'P2000',
          clientVersion: '7.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        const payload = (mockResponse.json as jest.Mock).mock.calls[0][0];
        expect(payload.error.code).toBe('VALIDATION_ERROR');
        expect(payload.error.details[0].message).toContain('最大文字数');
      });

      it('P2002（v6 meta.target=string カンマ区切り）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: 'email,supabase_uid' },
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: 'email, supabase_uid',
                message: 'メールアドレス, Supabaseユーザー は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2002（v7 adapter-pg, driverAdapterError から field を抽出）を正しく処理すること', () => {
        // Prisma v7 + @prisma/adapter-pg では meta.target が無く、
        // meta.driverAdapterError.cause.constraint.fields に入る
        const error = new Prisma.PrismaClientKnownRequestError(
          '\nInvalid `prisma.physicalPlot.create()` invocation:\n\n\nUnique constraint failed on the fields: (`plot_number`)',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
            meta: {
              modelName: 'PhysicalPlot',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: '23505',
                  originalMessage:
                    'duplicate key value violates unique constraint "physical_plots_plot_number_key"',
                  kind: 'UniqueConstraintViolation',
                  constraint: { fields: ['plot_number'] },
                },
              },
            },
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: 'plot_number',
                message: '区画番号 は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2002（meta 不在、error.message からフォールバック抽出）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`plot_number`)',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: 'plot_number',
                message: '区画番号 は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2002（field 完全に取れない場合）でも undefined を出さないこと', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.8.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: undefined,
                message: 'データ は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2002（未知の field 名はそのまま表示）', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.8.0',
          meta: { target: ['unknown_field_xyz'] },
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '重複するデータが存在します',
            details: [
              {
                field: 'unknown_field_xyz',
                message: 'unknown_field_xyz は既に使用されています',
              },
            ],
          },
        });
      });

      it('P2025（レコードが見つからない）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: '5.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(404);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'レコードが見つかりません',
            details: [],
          },
        });
      });

      it('P2003（外部キー制約違反）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: '5.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: '関連するデータが存在しません',
            // 内部スキーマ情報を含む error.message は返さない（#217）
            details: [],
          },
        });
      });

      it('P2014（リレーション制約違反）を正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Relation violation', {
          code: 'P2014',
          clientVersion: '5.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'リレーションの制約違反',
            // 内部スキーマ情報を含む error.message は返さない（#217）
            details: [],
          },
        });
      });

      it('P2034（直列化競合）を 409 CONFLICT として処理すること（#278）', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'Transaction failed due to a write conflict or a deadlock',
          {
            code: 'P2034',
            clientVersion: '5.0.0',
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '同時更新が競合しました。もう一度お試しください',
            details: [],
          },
        });
      });

      // スキーマとDBのズレ（マイグレーション適用漏れ）は「データベースエラー」の一言だと
      // 原因が分からず調査に時間がかかる。運用が自力で気づけるメッセージにする。
      it('P2022（列が存在しない）をスキーマ不整合として案内すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'The column `buried_persons.is_final_burial` does not exist in the current database.',
          {
            code: 'P2022',
            clientVersion: '5.0.0',
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'SCHEMA_MISMATCH',
            message:
              'データベースの構成がアプリと一致していません。マイグレーションの適用漏れの可能性があります',
            details: [],
          },
        });
      });

      it('P2021（テーブルが存在しない）も同じ案内にすること', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'The table `public.buried_persons` does not exist in the current database.',
          {
            code: 'P2021',
            clientVersion: '5.0.0',
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'SCHEMA_MISMATCH',
            message:
              'データベースの構成がアプリと一致していません。マイグレーションの適用漏れの可能性があります',
            details: [],
          },
        });
      });

      // テーブル名・列名はDB内部情報のためクライアントへ返さない（#217）
      it('P2022 の応答に列名・テーブル名を含めないこと（#217）', () => {
        const error = new Prisma.PrismaClientKnownRequestError(
          'The column `buried_persons.is_final_burial` does not exist in the current database.',
          {
            code: 'P2022',
            clientVersion: '5.0.0',
          }
        );

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        const body = JSON.stringify((mockResponse.json as jest.Mock).mock.calls[0][0]);
        expect(body).not.toContain('buried_persons');
        expect(body).not.toContain('is_final_burial');
      });

      it('その他のPrismaエラーを正しく処理すること', () => {
        const error = new Prisma.PrismaClientKnownRequestError('Unknown error', {
          code: 'P9999',
          clientVersion: '5.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'DATABASE_ERROR',
            message: 'データベースエラーが発生しました',
            // 内部スキーマ情報を含む error.message は返さない（#217）
            details: [],
          },
        });
      });

      it('PrismaClientValidationErrorを正しく処理すること', () => {
        const error = new Prisma.PrismaClientValidationError('Validation failed', {
          clientVersion: '5.0.0',
        });

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'データベースバリデーションエラー',
            // 内部スキーマ情報を含む error.message は返さない（#217）
            details: [],
          },
        });
      });
    });

    describe('カスタムエラー処理', () => {
      it('ValidationErrorを正しく処理すること', () => {
        const error = new ValidationError('バリデーションエラー', [
          { field: 'email', message: '無効なメールアドレス' },
        ]);

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'バリデーションエラー',
            details: [{ field: 'email', message: '無効なメールアドレス' }],
          },
        });
      });

      it('NotFoundErrorを正しく処理すること', () => {
        const error = new NotFoundError('リソースが見つかりません');

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(404);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'リソースが見つかりません',
            details: [],
          },
        });
      });

      it('ConflictErrorを正しく処理すること', () => {
        const error = new ConflictError('競合が発生しました', [
          { field: 'id', message: '既に存在します' },
        ]);

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '競合が発生しました',
            details: [{ field: 'id', message: '既に存在します' }],
          },
        });
      });

      it('ValidationErrorのデフォルトメッセージを使用すること', () => {
        const error: any = { name: 'ValidationError' };

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'バリデーションエラーが発生しました',
            details: [],
          },
        });
      });

      it('UnauthorizedErrorのデフォルトメッセージを使用すること', () => {
        const error: any = { name: 'UnauthorizedError' };

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(401);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '認証が必要です',
            details: [],
          },
        });
      });

      it('ForbiddenErrorのデフォルトメッセージを使用すること', () => {
        const error: any = { name: 'ForbiddenError' };

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(403);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: '権限が不足しています',
            details: [],
          },
        });
      });

      it('NotFoundErrorのデフォルトメッセージを使用すること', () => {
        const error: any = { name: 'NotFoundError' };

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(404);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'リソースが見つかりません',
            details: [],
          },
        });
      });

      it('ConflictErrorのデフォルトメッセージを使用すること', () => {
        const error: any = { name: 'ConflictError' };

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(409);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'CONFLICT',
            message: '競合が発生しました',
            details: [],
          },
        });
      });
    });

    describe('デフォルトエラー処理', () => {
      it('一般的なエラーを正しく処理すること', () => {
        const error = new Error('予期しないエラー');

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: '予期しないエラー',
            details: [],
          },
        });
      });

      it('カスタムステータスコードを持つエラーを正しく処理すること', () => {
        const error: any = new Error('カスタムエラー');
        error.status = 418;
        error.code = 'TEAPOT';

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(418);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'TEAPOT',
            // 4xx は raw な err.message を返さず汎用文言に置換（#225）
            message: 'リクエストを処理できませんでした',
            details: [],
          },
        });
      });

      it('エラーをログに記録すること', () => {
        const error = new Error('テストエラー');
        const mockErrorLog = (getRequestLogger() as unknown as { error: jest.Mock }).error;

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockErrorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            err: error,
            path: '/test',
            method: 'GET',
          }),
          'Unhandled error'
        );
      });

      it('メッセージのないエラーでデフォルトメッセージを使用すること', () => {
        const error: any = {};

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: '内部サーバーエラーが発生しました',
            details: [],
          },
        });
      });
    });

    describe('body-parser / Express 由来エラー処理 (#225)', () => {
      it('JSONパース失敗（entity.parse.failed）は 400 BAD_REQUEST 固定文言になること', () => {
        const error: any = new SyntaxError(
          `Unexpected token 'b', "{"email": broken" is not valid JSON`
        );
        error.status = 400;
        error.type = 'entity.parse.failed';

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'リクエストボディの形式が不正です',
            details: [],
          },
        });
      });

      it('サイズ超過（entity.too.large）は 413 PAYLOAD_TOO_LARGE 固定文言になること', () => {
        const error: any = new Error('request entity too large');
        error.status = 413;
        error.type = 'entity.too.large';

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(413);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'リクエストボディが大きすぎます',
            details: [],
          },
        });
      });

      it('URIデコード失敗（URIError）は 400 BAD_REQUEST 固定文言になること', () => {
        const error = new URIError("Failed to decode param '%E0%A4%A'");

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'リクエストURLの形式が不正です',
            details: [],
          },
        });
      });

      it('コードを持たない未知の 4xx はステータスに応じたコードへマップされること', () => {
        const error: any = new Error('some internal http-errors message');
        error.status = 415;

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(415);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'リクエストを処理できませんでした',
            details: [],
          },
        });
      });

      it('5xx は従来どおり INTERNAL_SERVER_ERROR を返すこと', () => {
        const error: any = new Error('upstream failure');
        error.status = 502;

        errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockResponse.status).toHaveBeenCalledWith(502);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'upstream failure',
            details: [],
          },
        });
      });
    });
  });

  describe('notFoundHandler', () => {
    it('404レスポンスを返すこと', () => {
      const testRequest: any = {
        method: 'POST',
        path: '/api/nonexistent',
      };

      notFoundHandler(testRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'NOT_FOUND',
          // リクエストパスを反映しない固定文言（#228 入力リフレクション対策）
          message: 'リクエストされたルートが見つかりません',
          details: [],
        },
      });
    });
  });

  describe('カスタムエラークラス', () => {
    it('ValidationErrorがdetailsを持つこと', () => {
      const details = [{ field: 'name', message: '必須です' }];
      const error = new ValidationError('テストエラー', details);

      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('テストエラー');
      expect(error.details).toEqual(details);
    });

    it('ValidationErrorがdetailsなしで作成できること', () => {
      const error = new ValidationError('テストエラー');

      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('テストエラー');
      expect(error.details).toEqual([]);
    });

    it('NotFoundErrorがデフォルトメッセージを持つこと', () => {
      const error = new NotFoundError();

      expect(error.name).toBe('NotFoundError');
      expect(error.message).toBe('リソースが見つかりません');
    });

    it('NotFoundErrorがカスタムメッセージを持つこと', () => {
      const error = new NotFoundError('カスタムメッセージ');

      expect(error.name).toBe('NotFoundError');
      expect(error.message).toBe('カスタムメッセージ');
    });

    it('ConflictErrorがdetailsを持つこと', () => {
      const details = [{ field: 'id', message: '既に存在します' }];
      const error = new ConflictError('テストエラー', details);

      expect(error.name).toBe('ConflictError');
      expect(error.message).toBe('テストエラー');
      expect(error.details).toEqual(details);
    });

    it('ConflictErrorがdetailsなしで作成できること', () => {
      const error = new ConflictError('テストエラー');

      expect(error.name).toBe('ConflictError');
      expect(error.message).toBe('テストエラー');
      expect(error.details).toEqual([]);
    });
  });
});
