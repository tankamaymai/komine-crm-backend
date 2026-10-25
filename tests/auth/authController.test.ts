import { Request, Response } from 'express';

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

// Supabaseモックの作成
const mockSupabaseAuth = {
  signInWithPassword: jest.fn(),
  getUser: jest.fn(),
  resetPasswordForEmail: jest.fn(),
  exchangeCodeForSession: jest.fn(),
  admin: {
    signOut: jest.fn(),
    updateUserById: jest.fn(),
  },
};

const mockSupabase = {
  auth: mockSupabaseAuth,
};

// @supabase/supabase-jsモジュールをモック化
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase),
}));

// Prismaモックの作成
const mockPrisma = {
  staff: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

// 環境変数をモック化
const originalEnv = process.env;

describe('Auth Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  describe('Supabase環境変数が設定されている場合', () => {
    beforeAll(() => {
      // 環境変数を設定
      process.env.SUPABASE_URL = 'https://test.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    beforeEach(() => {
      // モジュールキャッシュをクリア
      jest.resetModules();

      mockRequest = {
        body: {},
        headers: {},
        cookies: {},
      };
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        clearCookie: jest.fn().mockReturnThis(),
      };
      jest.clearAllMocks();
    });

    describe('login', () => {
      let login: any;

      beforeEach(async () => {
        // 毎回モジュールを再インポート
        const authController = await import('../../src/auth/authController');
        login = authController.login;
      });

      it('正常なログインが成功すること', async () => {
        const mockUser = {
          id: 'supabase-uid-123',
          email: 'test@example.com',
        };
        const mockSession = {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_at: 1234567890,
        };
        const mockStaff = {
          id: 1,
          name: 'テストユーザー',
          email: 'test@example.com',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };

        mockRequest.body = {
          email: 'test@example.com',
          password: 'password123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: mockUser, session: mockSession },
          error: null,
        });
        mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
        mockPrisma.staff.update.mockResolvedValue(mockStaff);

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.signInWithPassword).toHaveBeenCalledWith({
          email: 'test@example.com',
          password: 'password123',
        });
        expect(mockPrisma.staff.findUnique).toHaveBeenCalledWith({
          where: { supabase_uid: 'supabase-uid-123' },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            is_active: true,
            supabase_uid: true,
          },
        });
        expect(mockPrisma.staff.update).toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        // トークンはCookieに設定されるため、レスポンスボディには含まれない
        expect(mockResponse.cookie).toHaveBeenCalled();
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            user: {
              id: 1,
              email: 'test@example.com',
              name: 'テストユーザー',
              role: 'admin',
              supabase_uid: 'supabase-uid-123',
            },
            session: {
              expires_at: 1234567890,
            },
          },
        });
      });

      it('メールアドレスが未入力の場合、400エラーを返すこと', async () => {
        mockRequest.body = {
          password: 'password123',
        };

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'メールアドレスとパスワードは必須です',
            details: [],
          },
        });
      });

      it('パスワードが未入力の場合、400エラーを返すこと', async () => {
        mockRequest.body = {
          email: 'test@example.com',
        };

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'メールアドレスとパスワードは必須です',
            details: [],
          },
        });
      });

      it('Supabase認証に失敗した場合、401エラーを返すこと', async () => {
        mockRequest.body = {
          email: 'test@example.com',
          password: 'wrongpassword',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: null, session: null },
          error: { message: 'Invalid credentials' },
        });

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(401);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'メールアドレスまたはパスワードが正しくありません',
            details: [],
          },
        });
      });

      it('ユーザーが登録されていない場合、401エラーを返すこと', async () => {
        const mockUser = {
          id: 'supabase-uid-123',
          email: 'test@example.com',
        };
        const mockSession = {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_at: 1234567890,
        };

        mockRequest.body = {
          email: 'test@example.com',
          password: 'password123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: mockUser, session: mockSession },
          error: null,
        });
        mockPrisma.staff.findUnique.mockResolvedValue(null);

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(401);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'ユーザーが登録されていません',
            details: [],
          },
        });
      });

      it('ユーザーアカウントが無効の場合、401エラーを返すこと', async () => {
        const mockUser = {
          id: 'supabase-uid-123',
          email: 'test@example.com',
        };
        const mockSession = {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_at: 1234567890,
        };
        const mockStaff = {
          id: 1,
          name: 'テストユーザー',
          email: 'test@example.com',
          role: 'admin',
          is_active: false, // 無効
          supabase_uid: 'supabase-uid-123',
        };

        mockRequest.body = {
          email: 'test@example.com',
          password: 'password123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: mockUser, session: mockSession },
          error: null,
        });
        mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(401);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'ユーザーアカウントが無効になっています',
            details: [],
          },
        });
      });

      it('データベースエラーが発生した場合、500エラーを返すこと', async () => {
        const mockUser = {
          id: 'supabase-uid-123',
          email: 'test@example.com',
        };
        const mockSession = {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_at: 1234567890,
        };

        mockRequest.body = {
          email: 'test@example.com',
          password: 'password123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: mockUser, session: mockSession },
          error: null,
        });
        mockPrisma.staff.findUnique.mockRejectedValue(new Error('Database error'));

        await login(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'ログイン処理中にエラーが発生しました',
            details: [],
          },
        });
      });
    });

    describe('logout', () => {
      let logout: any;

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        logout = authController.logout;
      });

      it('正常にログアウトできること', async () => {
        mockRequest.headers = {
          authorization: 'Bearer test-token-123',
        };

        mockSupabaseAuth.admin.signOut.mockResolvedValue({ error: null });

        await logout(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.signOut).toHaveBeenCalledWith('test-token-123');
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            message: 'ログアウトしました',
          },
        });
      });

      it('トークンなしでもログアウトできること', async () => {
        mockRequest.headers = {};

        await logout(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.signOut).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            message: 'ログアウトしました',
          },
        });
      });

      it('Supabaseエラーが発生しても正常終了すること（ログアウト処理の継続）', async () => {
        mockRequest.headers = {
          authorization: 'Bearer test-token-123',
        };

        mockSupabaseAuth.admin.signOut.mockRejectedValue(new Error('Supabase error'));

        await logout(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'ログアウト処理中にエラーが発生しました',
            details: [],
          },
        });
      });
    });

    describe('getCurrentUser', () => {
      let getCurrentUser: any;

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        getCurrentUser = authController.getCurrentUser;
      });

      it('正常にユーザー情報を取得できること', async () => {
        const mockStaff = {
          id: 1,
          name: 'テストユーザー',
          email: 'test@example.com',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
          created_at: new Date('2024-01-01'),
          updated_at: new Date('2024-01-02'),
          last_login_at: new Date('2024-01-03'),
        };

        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };

        mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);

        await getCurrentUser(mockRequest as Request, mockResponse as Response);

        expect(mockPrisma.staff.findUnique).toHaveBeenCalledWith({
          where: { id: 1 },
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
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            user: mockStaff,
          },
        });
      });

      it('認証されていない場合、401エラーを返すこと', async () => {
        mockRequest.user = undefined;

        await getCurrentUser(mockRequest as Request, mockResponse as Response);

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

      it('ユーザーが見つからない場合、404エラーを返すこと', async () => {
        mockRequest.user = {
          id: 999,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };

        mockPrisma.staff.findUnique.mockResolvedValue(null);

        await getCurrentUser(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(404);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'ユーザーが見つかりません',
            details: [],
          },
        });
      });

      it('データベースエラーが発生した場合、500エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };

        mockPrisma.staff.findUnique.mockRejectedValue(new Error('Database error'));

        await getCurrentUser(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'ユーザー情報取得中にエラーが発生しました',
            details: [],
          },
        });
      });
    });

    describe('changePassword', () => {
      let changePassword: any;

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        changePassword = authController.changePassword;
      });

      it('正常にパスワードを変更できること', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'oldpassword123',
          newPassword: 'newpassword123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: { id: 'supabase-uid-123' }, session: {} },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({
          data: {},
          error: null,
        });

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.signInWithPassword).toHaveBeenCalledWith({
          email: 'test@example.com',
          password: 'oldpassword123',
        });
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledWith('supabase-uid-123', {
          password: 'newpassword123',
        });
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            message: 'パスワードを変更しました',
          },
        });
      });

      it('認証されていない場合、401エラーを返すこと', async () => {
        mockRequest.user = undefined;
        mockRequest.body = {
          currentPassword: 'oldpassword123',
          newPassword: 'newpassword123',
        };

        await changePassword(mockRequest as Request, mockResponse as Response);

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

      it('現在のパスワードが未入力の場合、400エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          newPassword: 'newpassword123',
        };

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: '現在のパスワードと新しいパスワードは必須です',
            details: [],
          },
        });
      });

      it('新しいパスワードが未入力の場合、400エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'oldpassword123',
        };

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: '現在のパスワードと新しいパスワードは必須です',
            details: [],
          },
        });
      });

      it('新しいパスワードが8文字未満の場合、400エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'oldpassword123',
          newPassword: 'short',
        };

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'パスワードは8文字以上である必要があります',
            details: [],
          },
        });
      });

      it('現在のパスワードが正しくない場合、401エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'wrongpassword',
          newPassword: 'newpassword123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: null, session: null },
          error: { message: 'Invalid credentials' },
        });

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(401);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '現在のパスワードが正しくありません',
            details: [],
          },
        });
      });

      it('パスワード更新に失敗した場合、500エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'oldpassword123',
          newPassword: 'newpassword123',
        };

        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: { user: { id: 'supabase-uid-123' }, session: {} },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({
          data: null,
          error: { message: 'Update failed' },
        });

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'パスワードの更新に失敗しました',
            details: [],
          },
        });
      });

      it('予期しないエラーが発生した場合、500エラーを返すこと', async () => {
        mockRequest.user = {
          id: 1,
          email: 'test@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockRequest.body = {
          currentPassword: 'oldpassword123',
          newPassword: 'newpassword123',
        };

        mockSupabaseAuth.signInWithPassword.mockRejectedValue(new Error('Unexpected error'));

        await changePassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'パスワード変更中にエラーが発生しました',
            details: [],
          },
        });
      });
    });

    describe('updateProfile の分散整合（#233）', () => {
      let updateProfile: any;

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        updateProfile = authController.updateProfile;

        mockRequest.user = {
          id: 1,
          email: 'old@example.com',
          name: 'テストユーザー',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
      });

      it('Supabase更新成功後にDB更新が失敗したら、Supabaseメールを旧値へ戻すこと', async () => {
        mockRequest.body = { email: 'new@example.com', currentPassword: 'OldPass123' };

        mockPrisma.staff.findFirst.mockResolvedValue(null); // 重複なし
        mockSupabaseAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
        mockPrisma.staff.update.mockRejectedValue(new Error('connection lost'));

        await updateProfile(mockRequest as Request, mockResponse as Response);

        // 1回目: 新メールへ更新 / 2回目: 補償で旧メールへ戻す
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledTimes(2);
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenNthCalledWith(
          1,
          'supabase-uid-123',
          { email: 'new@example.com' }
        );
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenNthCalledWith(
          2,
          'supabase-uid-123',
          { email: 'old@example.com' }
        );
        expect(mockResponse.status).toHaveBeenCalledWith(500);
      });

      it('メール変更を伴わないDB更新失敗では補償を行わないこと', async () => {
        mockRequest.body = { name: '新しい名前' };

        mockPrisma.staff.update.mockRejectedValue(new Error('connection lost'));

        await updateProfile(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(500);
      });

      it('正常系: メール変更がSupabase/DBの両方へ反映されること', async () => {
        mockRequest.body = { email: 'new@example.com', currentPassword: 'OldPass123' };

        mockPrisma.staff.findFirst.mockResolvedValue(null);
        mockSupabaseAuth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
        mockPrisma.staff.update.mockResolvedValue({
          id: 1,
          name: 'テストユーザー',
          email: 'new@example.com',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        });

        await updateProfile(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.signInWithPassword).toHaveBeenCalledWith({
          email: 'old@example.com',
          password: 'OldPass123',
        });
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledTimes(1);
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it('メール変更で現在のパスワードが無いときは更新しないこと', async () => {
        mockRequest.body = { email: 'new@example.com' };

        await updateProfile(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.signInWithPassword).not.toHaveBeenCalled();
        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockPrisma.staff.update).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(400);
      });

      it('メール変更で現在のパスワードが違うときは更新しないこと', async () => {
        mockRequest.body = { email: 'new@example.com', currentPassword: 'wrong' };
        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: {},
          error: { message: 'Invalid login credentials' },
        });

        await updateProfile(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockPrisma.staff.update).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(401);
      });
    });

    describe('forgotPassword の招待未完了検知（#234）', () => {
      let forgotPassword: any;

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        forgotPassword = authController.forgotPassword;
        mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
      });

      it('pending_ スタッフでも応答は一律成功（列挙対策維持）でリセットも呼ぶこと', async () => {
        mockRequest.body = { email: 'pending@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue({
          id: 5,
          supabase_uid: 'pending_1748000000000',
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        // タイミング差での列挙を避けるため resetPasswordForEmail は従来どおり呼ぶ
        expect(mockSupabaseAuth.resetPasswordForEmail).toHaveBeenCalledWith(
          'pending@example.com',
          expect.any(Object)
        );
      });

      it('通常スタッフでも同一応答であること', async () => {
        mockRequest.body = { email: 'active@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue({
          id: 6,
          supabase_uid: 'real-uid',
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      });

      it('存在しないメールでも同一応答であること（列挙対策）', async () => {
        mockRequest.body = { email: 'unknown@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue(null);

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      });

      it('大文字・前後空白入りメールでも正規化してルックアップ・リセット送信すること (#280)', async () => {
        // Staff.email は trim().toLowerCase() で保存されるため、生入力のままでは
        // ルックアップがヒットせず招待未完了検知（#234）が偽陰性になっていた
        mockRequest.body = { email: '  Pending@Example.COM ' };
        mockPrisma.staff.findFirst.mockResolvedValue({
          id: 5,
          supabase_uid: 'pending_1748000000000',
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        // 診断ルックアップは正規化済みメールで行われること
        expect(mockPrisma.staff.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { email: 'pending@example.com', deleted_at: null },
          })
        );
        // リセット送信も正規化済みメールで行われること
        expect(mockSupabaseAuth.resetPasswordForEmail).toHaveBeenCalledWith(
          'pending@example.com',
          expect.any(Object)
        );
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it('レート制限エラー時は専用メッセージを429で返すこと（#350）', async () => {
        mockRequest.body = { email: 'active@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue(null);
        mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({
          error: { message: 'email rate limit exceeded' },
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(429);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
          })
        );
      });

      it('レート制限以外の送信エラーは一律成功を維持すること（列挙対策）', async () => {
        mockRequest.body = { email: 'active@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue(null);
        mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({
          error: { message: 'some other transient error' },
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      });

      it('"For security purposes..." クールダウン文言（rate limit を含まない）でも429を返すこと', async () => {
        // 本番ログで確認された実文言。旧 message.includes('rate limit') では取りこぼし、
        // 失敗にもかかわらず success:true を返していた（成功偽装バグ）。
        mockRequest.body = { email: 'active@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue(null);
        mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({
          error: {
            message: 'For security purposes, you can only request this after 4 seconds.',
            status: 429,
          },
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(429);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
          })
        );
      });

      it('status 429 なら文言に依らず429を返すこと', async () => {
        mockRequest.body = { email: 'active@example.com' };
        mockPrisma.staff.findFirst.mockResolvedValue(null);
        mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({
          error: { message: 'over_email_send_rate_limit', status: 429 },
        });

        await forgotPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(429);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
          })
        );
      });
    });

    describe('resetPassword（新パスワード設定）', () => {
      let resetPassword: any;

      const jwtWithAmr = (method: string): string => {
        const payload = Buffer.from(JSON.stringify({ amr: [{ method, timestamp: 1 }] })).toString(
          'base64url'
        );
        return `e30.${payload}.sig`;
      };

      beforeEach(async () => {
        const authController = await import('../../src/auth/authController');
        resetPassword = authController.resetPassword;
      });

      it('メールリンクの鍵（otp）でもパスワードを更新すること', async () => {
        mockRequest.body = {
          accessToken: jwtWithAmr('otp'),
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: { id: 'user-uid-otp' } },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledWith('user-uid-otp', {
          password: 'NewPass123',
        });
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it('accessToken（implicitフロー）でユーザーを特定しパスワードを更新すること', async () => {
        // メールリンクのハッシュ #access_token=... から取り出したトークンで本人特定
        mockRequest.body = {
          accessToken: jwtWithAmr('recovery'),
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: { id: 'user-uid-1' } },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.getUser).toHaveBeenCalledWith(jwtWithAmr('recovery'));
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledWith('user-uid-1', {
          password: 'NewPass123',
        });
        expect(mockResponse.status).toHaveBeenCalledWith(200);
        expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      });

      it('accessToken が無効/期限切れなら 400 INVALID_TOKEN を返し更新しないこと', async () => {
        mockRequest.body = {
          accessToken: 'expired-token',
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: null },
          error: { message: 'invalid JWT' },
        });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
          })
        );
      });

      it('普通のログイン鍵ではパスワードを更新しないこと', async () => {
        mockRequest.body = {
          accessToken: jwtWithAmr('password'),
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: { id: 'user-uid-login' } },
          error: null,
        });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(400);
        expect(mockResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
          })
        );
      });

      it('code（PKCEフロー後方互換）でもユーザーを特定して更新できること', async () => {
        mockRequest.body = {
          code: 'pkce-code',
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.exchangeCodeForSession.mockResolvedValue({
          data: {
            user: { id: 'user-uid-2' },
            session: { access_token: jwtWithAmr('recovery') },
          },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.exchangeCodeForSession).toHaveBeenCalledWith('pkce-code');
        expect(mockSupabaseAuth.admin.updateUserById).toHaveBeenCalledWith('user-uid-2', {
          password: 'NewPass123',
        });
        expect(mockResponse.status).toHaveBeenCalledWith(200);
      });

      it('accessToken と code 両方あれば accessToken を優先し code 交換を呼ばないこと', async () => {
        mockRequest.body = {
          accessToken: jwtWithAmr('invite'),
          code: 'should-be-ignored',
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: { id: 'user-uid-3' } },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.getUser).toHaveBeenCalledWith(jwtWithAmr('invite'));
        expect(mockSupabaseAuth.exchangeCodeForSession).not.toHaveBeenCalled();
      });

      it('accessToken も code も無ければ 400 を返すこと（防御）', async () => {
        mockRequest.body = {
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockSupabaseAuth.getUser).not.toHaveBeenCalled();
        expect(mockSupabaseAuth.exchangeCodeForSession).not.toHaveBeenCalled();
        expect(mockSupabaseAuth.admin.updateUserById).not.toHaveBeenCalled();
        expect(mockResponse.status).toHaveBeenCalledWith(400);
      });

      it('Admin パスワード更新が失敗したら 500 を返すこと', async () => {
        mockRequest.body = {
          accessToken: jwtWithAmr('recovery'),
          newPassword: 'NewPass123',
          confirmPassword: 'NewPass123',
        };
        mockSupabaseAuth.getUser.mockResolvedValue({
          data: { user: { id: 'user-uid-4' } },
          error: null,
        });
        mockSupabaseAuth.admin.updateUserById.mockResolvedValue({
          data: {},
          error: { message: 'update failed' },
        });

        await resetPassword(mockRequest as Request, mockResponse as Response);

        expect(mockResponse.status).toHaveBeenCalledWith(500);
      });
    });

    describe('COOKIE_SECURE によるCookie属性制御（#299）', () => {
      const originalNodeEnv = process.env.NODE_ENV;

      afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        delete process.env.COOKIE_SECURE;
      });

      // 指定envでログインを実行し、access_token Cookie のオプションを返す
      const loginAndGetCookieOptions = async (env: {
        nodeEnv: string;
        cookieSecure?: string;
      }): Promise<Record<string, unknown>> => {
        process.env.NODE_ENV = env.nodeEnv;
        if (env.cookieSecure !== undefined) {
          process.env.COOKIE_SECURE = env.cookieSecure;
        } else {
          delete process.env.COOKIE_SECURE;
        }
        jest.resetModules();
        const { login } = await import('../../src/auth/authController');

        mockRequest.body = { email: 'test@example.com', password: 'password123' };
        mockSupabaseAuth.signInWithPassword.mockResolvedValue({
          data: {
            user: { id: 'supabase-uid-123', email: 'test@example.com' },
            session: {
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              expires_at: 1234567890,
            },
          },
          error: null,
        });
        const mockStaff = {
          id: 1,
          name: 'テストユーザー',
          email: 'test@example.com',
          role: 'admin',
          is_active: true,
          supabase_uid: 'supabase-uid-123',
        };
        mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
        mockPrisma.staff.update.mockResolvedValue(mockStaff);

        await login(mockRequest as Request, mockResponse as Response);

        const cookieCalls = (mockResponse.cookie as jest.Mock).mock.calls;
        const accessTokenCall = cookieCalls.find((call) => call[0] === 'access_token');
        expect(accessTokenCall).toBeDefined();
        return accessTokenCall![2];
      };

      it('COOKIE_SECURE未設定 + production では secure:true / sameSite:none（従来挙動）', async () => {
        const options = await loginAndGetCookieOptions({ nodeEnv: 'production' });
        expect(options.secure).toBe(true);
        expect(options.sameSite).toBe('none');
      });

      it('COOKIE_SECURE=false なら production でも secure:false / sameSite:lax（平文HTTPローカル運用）', async () => {
        const options = await loginAndGetCookieOptions({
          nodeEnv: 'production',
          cookieSecure: 'false',
        });
        expect(options.secure).toBe(false);
        expect(options.sameSite).toBe('lax');
      });

      it('COOKIE_SECURE=true なら development でも secure:true / sameSite:none', async () => {
        const options = await loginAndGetCookieOptions({
          nodeEnv: 'development',
          cookieSecure: 'true',
        });
        expect(options.secure).toBe(true);
        expect(options.sameSite).toBe('none');
      });

      it('COOKIE_SECURE未設定 + development では secure:false / sameSite:lax', async () => {
        const options = await loginAndGetCookieOptions({ nodeEnv: 'development' });
        expect(options.secure).toBe(false);
        expect(options.sameSite).toBe('lax');
      });

      it('COOKIE_SECURE に不正値が設定された場合は NODE_ENV ベースの従来挙動にフォールバックすること', async () => {
        const options = await loginAndGetCookieOptions({
          nodeEnv: 'production',
          cookieSecure: 'yes',
        });
        expect(options.secure).toBe(true);
        expect(options.sameSite).toBe('none');
      });
    });
  }); // Supabase環境変数が設定されている場合の終了

  describe('Supabase環境変数が設定されていない場合', () => {
    beforeAll(() => {
      // 環境変数をクリア
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    beforeEach(() => {
      jest.resetModules();
      mockRequest = { body: {}, headers: {}, cookies: {} };
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        cookie: jest.fn().mockReturnThis(),
        clearCookie: jest.fn().mockReturnThis(),
      };
      jest.clearAllMocks();
    });

    it('loginが503エラーを返すこと', async () => {
      const authController = await import('../../src/auth/authController');
      const login = authController.login;

      mockRequest.body = {
        email: 'test@example.com',
        password: 'password123',
      };

      await login(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    });

    it('logoutが503エラーを返すこと', async () => {
      const authController = await import('../../src/auth/authController');
      const logout = authController.logout;

      mockRequest.headers = {
        authorization: 'Bearer test-token',
      };

      await logout(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    });

    it('changePasswordが503エラーを返すこと', async () => {
      const authController = await import('../../src/auth/authController');
      const changePassword = authController.changePassword;

      mockRequest.user = {
        id: 1,
        email: 'test@example.com',
        name: 'テストユーザー',
        role: 'admin',
        is_active: true,
        supabase_uid: 'supabase-uid-123',
      };
      mockRequest.body = {
        currentPassword: 'oldpassword123',
        newPassword: 'newpassword123',
      };

      await changePassword(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(503);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Supabase認証サービスが利用できません',
          details: [],
        },
      });
    });
  });
});
