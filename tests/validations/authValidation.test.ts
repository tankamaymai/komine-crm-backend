import {
  loginSchema,
  changePasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from '../../src/validations/authValidation';

describe('Auth Validation', () => {
  describe('loginSchema', () => {
    it('有効なログインデータでバリデーションが成功すること', () => {
      const validData = {
        email: 'test@example.com',
        password: 'password123',
      };

      expect(() => loginSchema.parse(validData)).not.toThrow();
    });

    it('無効なメールアドレスでエラーが発生すること', () => {
      const invalidData = {
        email: 'invalid-email',
        password: 'password123',
      };

      expect(() => loginSchema.parse(invalidData)).toThrow();
    });

    it('パスワードが空でエラーが発生すること', () => {
      const invalidData = {
        email: 'test@example.com',
        password: '',
      };

      expect(() => loginSchema.parse(invalidData)).toThrow();
    });

    it('必須フィールドが欠けている場合エラーが発生すること', () => {
      expect(() => loginSchema.parse({ email: 'test@example.com' })).toThrow();
      expect(() => loginSchema.parse({ password: 'password123' })).toThrow();
    });
  });

  describe('changePasswordSchema', () => {
    it('有効なパスワード変更データでバリデーションが成功すること', () => {
      const validData = {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
        confirmPassword: 'NewPassword1',
      };

      expect(() => changePasswordSchema.parse(validData)).not.toThrow();
    });

    it('新しいパスワードが8文字未満でエラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'Pass1',
        confirmPassword: 'Pass1',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('新しいパスワードが128文字を超える場合エラーが発生すること', () => {
      const longPassword = 'A' + 'a'.repeat(127) + '1'; // 129文字
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: longPassword,
        confirmPassword: longPassword,
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('新しいパスワードに大文字が含まれない場合エラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'newpassword1',
        confirmPassword: 'newpassword1',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('新しいパスワードに小文字が含まれない場合エラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'NEWPASSWORD1',
        confirmPassword: 'NEWPASSWORD1',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('新しいパスワードに数字が含まれない場合エラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword',
        confirmPassword: 'NewPassword',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('パスワードと確認パスワードが一致しない場合エラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
        confirmPassword: 'DifferentPassword1',
      };

      try {
        changePasswordSchema.parse(invalidData);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.issues).toBeDefined();
        expect(error.issues[0].message).toBe('パスワードが一致しません');
        expect(error.issues[0].path).toEqual(['confirmPassword']);
      }
    });

    it('必須フィールドが欠けている場合エラーが発生すること', () => {
      expect(() =>
        changePasswordSchema.parse({
          newPassword: 'NewPassword1',
          confirmPassword: 'NewPassword1',
        })
      ).toThrow();

      expect(() =>
        changePasswordSchema.parse({
          currentPassword: 'OldPassword1',
          confirmPassword: 'NewPassword1',
        })
      ).toThrow();

      expect(() =>
        changePasswordSchema.parse({
          currentPassword: 'OldPassword1',
          newPassword: 'NewPassword1',
        })
      ).toThrow();
    });

    it('現在のパスワードが空でエラーが発生すること', () => {
      const invalidData = {
        currentPassword: '',
        newPassword: 'NewPassword1',
        confirmPassword: 'NewPassword1',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });

    it('確認パスワードが空でエラーが発生すること', () => {
      const invalidData = {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
        confirmPassword: '',
      };

      expect(() => changePasswordSchema.parse(invalidData)).toThrow();
    });
  });

  describe('resetPasswordSchema', () => {
    it('accessToken（implicitフロー）で成功すること', () => {
      const validData = {
        accessToken: 'some-access-token',
        newPassword: 'NewPassword1',
        confirmPassword: 'NewPassword1',
      };

      expect(() => resetPasswordSchema.parse(validData)).not.toThrow();
    });

    it('code（PKCEフロー後方互換）で成功すること', () => {
      const validData = {
        code: 'some-code',
        newPassword: 'NewPassword1',
        confirmPassword: 'NewPassword1',
      };

      expect(() => resetPasswordSchema.parse(validData)).not.toThrow();
    });

    it('accessToken も code も無ければエラーになること', () => {
      const invalidData = {
        newPassword: 'NewPassword1',
        confirmPassword: 'NewPassword1',
      };

      expect(() => resetPasswordSchema.parse(invalidData)).toThrow();
    });

    it('パスワードと確認が一致しない場合エラーになること', () => {
      const invalidData = {
        accessToken: 'some-access-token',
        newPassword: 'NewPassword1',
        confirmPassword: 'DifferentPassword1',
      };

      expect(() => resetPasswordSchema.parse(invalidData)).toThrow();
    });
  });

  describe('updateProfileSchema', () => {
    it('名前だけなら現在のパスワードなしで通ること', () => {
      expect(() => updateProfileSchema.parse({ name: '新しい名前' })).not.toThrow();
    });

    it('メール変更は現在のパスワードがないとエラーになること', () => {
      expect(() => updateProfileSchema.parse({ email: 'new@example.com' })).toThrow();
    });

    it('メール変更は現在のパスワードがあれば通ること', () => {
      expect(() =>
        updateProfileSchema.parse({
          email: 'new@example.com',
          currentPassword: 'OldPassword1',
        })
      ).not.toThrow();
    });
  });
});
