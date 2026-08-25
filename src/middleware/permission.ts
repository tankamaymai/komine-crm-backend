import { Request, Response, NextFunction } from 'express';

// 権限レベル定義
export const ROLES = {
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  MANAGER: 'manager',
  ADMIN: 'admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// 権限階層（上位権限は下位権限を含む）
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  [ROLES.VIEWER]: ['viewer'],
  [ROLES.OPERATOR]: ['viewer', 'operator'],
  [ROLES.MANAGER]: ['viewer', 'operator', 'manager'],
  [ROLES.ADMIN]: ['viewer', 'operator', 'manager', 'admin'],
};

// API権限マトリクス
export const API_PERMISSIONS: Record<string, Role[]> = {
  // 認証系
  'GET /auth/me': ['viewer', 'operator', 'manager', 'admin'],
  'GET /auth/permissions': ['viewer', 'operator', 'manager', 'admin'],
  'POST /auth/check-permission': ['viewer', 'operator', 'manager', 'admin'],
  'GET /auth/can/*': ['viewer', 'operator', 'manager', 'admin'],
  'PUT /auth/password': ['viewer', 'operator', 'manager', 'admin'],
  'POST /auth/logout': ['viewer', 'operator', 'manager', 'admin'],

  // 墓石管理
  'GET /gravestones': ['viewer', 'operator', 'manager', 'admin'],
  'GET /gravestones/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /gravestones': ['operator', 'manager', 'admin'],
  'PUT /gravestones/*': ['operator', 'manager', 'admin'],
  'DELETE /gravestones/*': ['manager', 'admin'],

  // 申込者管理
  'GET /applicants/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /applicants': ['operator', 'manager', 'admin'],
  'PUT /applicants/*': ['operator', 'manager', 'admin'],
  'DELETE /applicants/*': ['manager', 'admin'],

  // 契約者管理
  'GET /contractors/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /contractors': ['operator', 'manager', 'admin'],
  'PUT /contractors/*': ['operator', 'manager', 'admin'],
  'DELETE /contractors/*': ['manager', 'admin'],
  'POST /contractors/*/transfer': ['manager', 'admin'],

  // 使用料・管理料
  'POST /usage-fees': ['operator', 'manager', 'admin'],
  'PUT /usage-fees/*': ['operator', 'manager', 'admin'],
  'DELETE /usage-fees/*': ['manager', 'admin'],
  'POST /management-fees': ['operator', 'manager', 'admin'],
  'PUT /management-fees/*': ['operator', 'manager', 'admin'],
  'DELETE /management-fees/*': ['manager', 'admin'],
  'POST /management-fees/calculate': ['operator', 'manager', 'admin'],

  // 請求 (Billing)
  'GET /billings': ['viewer', 'operator', 'manager', 'admin'],
  'GET /billings/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /billings': ['operator', 'manager', 'admin'],
  'PUT /billings/*': ['operator', 'manager', 'admin'],
  'DELETE /billings/*': ['manager', 'admin'],

  // 入金 (Payment)
  'GET /payments': ['viewer', 'operator', 'manager', 'admin'],
  'GET /payments/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /payments': ['operator', 'manager', 'admin'],
  'PUT /payments/*': ['operator', 'manager', 'admin'],
  'DELETE /payments/*': ['manager', 'admin'],

  // 家族連絡先
  'POST /family-contacts': ['operator', 'manager', 'admin'],
  'PUT /family-contacts/*': ['operator', 'manager', 'admin'],
  'DELETE /family-contacts/*': ['operator', 'manager', 'admin'],

  // 埋葬者情報
  'GET /burials/search': ['viewer', 'operator', 'manager', 'admin'],
  'POST /burials': ['operator', 'manager', 'admin'],
  'PUT /burials/*': ['operator', 'manager', 'admin'],
  'DELETE /burials/*': ['manager', 'admin'],

  // 工事情報
  'POST /constructions': ['operator', 'manager', 'admin'],
  'PUT /constructions/*': ['operator', 'manager', 'admin'],
  'DELETE /constructions/*': ['manager', 'admin'],

  // 履歴情報
  'GET /histories': ['viewer', 'operator', 'manager', 'admin'],
  'GET /histories/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /histories/*/restore': ['admin'],

  // マスタデータ管理
  'GET /masters/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /masters/*': ['admin'],
  'PUT /masters/*': ['admin'],
  'DELETE /masters/*': ['admin'],

  // ユーザー・ロール管理
  'GET /users': ['manager', 'admin'],
  'GET /users/*': ['manager', 'admin'],
  'PUT /users/*/role': ['admin'],
  'GET /roles': ['manager', 'admin'],
  'POST /roles': ['admin'],
  'PUT /roles/*': ['admin'],
  'DELETE /roles/*': ['admin'],
  'GET /permissions/matrix': ['admin'],
  'PUT /permissions/matrix': ['admin'],

  // バッチ処理・その他
  'POST /import': ['admin'],
  'GET /export': ['manager', 'admin'],
  'POST /reports': ['manager', 'admin'],

  // 書類管理
  'GET /documents': ['viewer', 'operator', 'manager', 'admin'],
  'GET /documents/*': ['viewer', 'operator', 'manager', 'admin'],
  'POST /documents': ['operator', 'manager', 'admin'],
  'POST /documents/generate-pdf': ['operator', 'manager', 'admin'],
  'GET /documents/bulk-invoice/targets': ['viewer', 'operator', 'manager', 'admin'],
  'POST /documents/bulk-invoice/generate': ['operator', 'manager', 'admin'],
  'PUT /documents/*': ['operator', 'manager', 'admin'],
  'DELETE /documents/*': ['manager', 'admin'],
  'POST /documents/*/regenerate-pdf': ['operator', 'manager', 'admin'],
};

/**
 * 特定の権限レベルが必要な操作をチェック
 */
export const requirePermission = (requiredRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
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

    const userRole = req.user.role as Role;
    const userPermissions = ROLE_HIERARCHY[userRole] || [];

    // ユーザーの権限が要求された権限のいずれかと一致するかチェック
    const hasPermission = requiredRoles.some((role) => userPermissions.includes(role));

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: '権限が不足しています',
          details: [
            {
              message: `必要な権限: ${requiredRoles.join(', ')}、現在の権限: ${userRole}`,
            },
          ],
        },
      });
    }

    next();
  };
};

/** 正規表現のメタ文字をエスケープする */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * API_PERMISSIONS のキーと突き合わせて必要ロールを解決する（#207）。
 * - 完全一致を最優先
 * - キー中の `*` は1つ以上のパスセグメントに一致するワイルドカードとして評価
 *   （例: `GET /masters/*` は `GET /masters/all` にも `PUT /masters/＊/＊` 形の
 *   2セグメントパスにも一致する前方一致相当）
 * - 複数一致時はより具体的なキー（ワイルドカードが少ない→リテラルが長い）を優先
 */
export const resolveApiPermission = (apiKey: string): Role[] | undefined => {
  const exact = API_PERMISSIONS[apiKey];
  if (exact) return exact;

  const candidates = Object.entries(API_PERMISSIONS)
    .filter(([key]) => key.includes('*'))
    .filter(([key]) => {
      const pattern = new RegExp(`^${key.split('*').map(escapeRegExp).join('.+')}$`);
      return pattern.test(apiKey);
    })
    .sort(([keyA], [keyB]) => {
      const wildcardsA = keyA.split('*').length;
      const wildcardsB = keyB.split('*').length;
      if (wildcardsA !== wildcardsB) return wildcardsA - wildcardsB;
      return keyB.length - keyA.length;
    });

  return candidates[0]?.[1];
};

/**
 * API パスに基づいて自動で権限チェック
 */
export const checkApiPermission = () => {
  return (req: Request, res: Response, next: NextFunction) => {
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

    const method = req.method;
    const route = req.route as { path?: string } | undefined;
    // サブルーター配下では req.route.path はマウントパスを含まない相対パス
    // （例: GET /api/v1/masters/all → '/all'）になるため、req.baseUrl と
    // 連結してフルパス化し、API_PERMISSIONS のキー（/masters/* 等）と照合する（#207）
    const fullPath = `${req.baseUrl || ''}${route?.path ?? req.path}`;
    const normalizedPath = fullPath.replace(/^\/api\/v1/, '').replace(/(.)\/$/, '$1');

    // パスパラメータをワイルドカードに変換
    const apiKey = `${method} ${normalizedPath}`.replace(/\/:\w+/g, '/*');

    const requiredRoles = resolveApiPermission(apiKey);

    if (!requiredRoles) {
      // 権限定義がない場合はadminのみ許可
      return requirePermission([ROLES.ADMIN])(req, res, next);
    }

    return requirePermission(requiredRoles)(req, res, next);
  };
};

/**
 * 権限チェック用ヘルパー関数
 */
export const hasPermission = (userRole: Role, requiredRoles: Role[]): boolean => {
  const userPermissions = ROLE_HIERARCHY[userRole] || [];
  return requiredRoles.some((role) => userPermissions.includes(role));
};
