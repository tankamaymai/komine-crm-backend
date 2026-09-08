# セットアップガイド

Cemetery CRM Backend の環境構築・設定ガイド

## 目次

1. [認証・ユーザー管理方針](#認証ユーザー管理方針)
2. [環境変数の設定](#環境変数の設定)
3. [Dockerでの起動](#dockerでの起動)
4. [Supabase認証](#supabase認証)
5. [顧客環境への初回デプロイ手順](#顧客環境への初回デプロイ手順)
6. [CI/CDセットアップ](#cicdセットアップ)
7. [本番環境デプロイ](#本番環境デプロイ)

---

## 認証・ユーザー管理方針

本CRMは霊園スタッフ用の **社内ツール** であり、顧客個人情報・契約内容・埋葬記録などのセンシティブデータを扱う。そのため、アカウント発行に関して以下の方針を取る。

### パブリック signup は提供しない

- `/signup`・`/register` 等のパブリックな新規登録エンドポイントおよび画面は **実装しない**。
- 理由: 社内ツールであり、外部からのアカウント作成を許容するとセンシティブデータ（顧客情報・埋葬記録）への不正アクセスリスクが生じる。
- Supabase Auth 側でもパブリック signup を利用する想定はない（フロントエンドから `supabase.auth.signUp` を呼ばない）。
- 将来機能追加時もこの方針は変えない。もし「外部ユーザー向け機能」（例: 墓地契約者向けマイページ）が必要になった場合は、別系統の認証基盤・権限モデルで設計する。

### ユーザー追加は admin による招待フローのみ

- 新規スタッフアカウントの作成は、既存 admin が API (`POST /api/v1/staff`) 経由で行う。
- 権限定義: `src/staff/staffRoutes.ts` — `requirePermission([ROLES.ADMIN])`
- 一括登録も admin のみ: `POST /api/v1/staff/bulk`
- 招待メール再送: `POST /api/v1/staff/:id/resend-invitation`（admin のみ）
- admin 以外（manager/operator/viewer）はスタッフ作成・削除・権限変更を行えない。

### 最初の admin は bootstrap script で作成

- 顧客環境への初回デプロイ時、admin アカウントが1人も存在しない状態では API 経由での作成ができないため、bootstrap スクリプトで1人目の admin を作成する。
- 実行方法: `npm run bootstrap:admin`（詳細は [顧客環境への初回デプロイ手順](#顧客環境への初回デプロイ手順) を参照）
- 冪等: 既に admin が存在する場合は skip するため、誤って2回実行しても影響なし。
- 本番環境では `ALLOW_BOOTSTRAP_IN_PRODUCTION=true` を明示しないと実行不可（誤操作防止）。

### 権限階層と変更ルール

権限階層は以下の4レベル（上位は下位の権限を包含）:

```
viewer < operator < manager < admin
```

- 権限定義: `src/middleware/permission.ts` の `ROLE_HIERARCHY`
- API権限マトリクス: 同ファイル `API_PERMISSIONS`
- **権限階層の定義自体およびスタッフのロール変更は admin のみが実施可能**
  - スタッフ更新 (`PUT /api/v1/staff/:id`) は admin 権限必須（ロール変更を含む）
  - マスタデータ・権限マトリクス変更系エンドポイントも admin 専用
- manager はスタッフ一覧・詳細の閲覧までは可能だが、作成・更新・削除・権限変更は不可。

---

## 環境変数の設定

### 初期設定

```bash
cp .env.example .env
```

### 必須項目

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `DATABASE_URL` | PostgreSQL接続文字列 | `postgresql://user:pass@localhost:5432/db` |
| `NODE_ENV` | 環境モード | `development` / `production` |
| `PORT` | サーバーポート | `4000` |
| `ALLOWED_ORIGINS` | CORS許可オリジン（カンマ区切り） | `https://app.example.com` |
| `SUPABASE_URL` | SupabaseプロジェクトURL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabaseサービスキー | `eyJ...` |

### 認証Cookieの Secure 属性（COOKIE_SECURE）

認証Cookie（access_token / refresh_token）の `Secure` / `SameSite` 属性を制御します。

| 値 | 挙動 | 用途 |
|----|------|------|
| `true` | `Secure` + `SameSite=None` | HTTPS提供（クロスオリジン許容） |
| `false` | 非Secure + `SameSite=Lax` | 平文HTTP・同一オリジン運用（事務所サーバのローカル運用） |
| 未設定 | `NODE_ENV=production` なら `true` 相当 | 従来挙動 |

> ⚠️ **平文HTTPで本番運用する場合は必ず `COOKIE_SECURE=false` を設定してください。**
> `Secure` 属性付きCookieはHTTP接続ではブラウザに保存されず、`SameSite=None` は
> `Secure` を要求するため、未設定のままだとログインが成立しません。

### CORS設定

- **開発環境**: `ALLOWED_ORIGINS`未設定で全オリジン許可
- **本番環境**: 明示的に指定したオリジンのみ許可
- プロトコル（https://）を必ず含める
- 末尾スラッシュは不要

---

## Dockerでの起動

本リポジトリには本番ビルド用の `Dockerfile` が含まれています（CI の Docker Security Scan / Render デプロイで使用）。
データベースは Supabaseホストの PostgreSQL を利用するため、コンテナには含めません。`DATABASE_URL` などの環境変数は起動時に渡します。

### イメージのビルド

```bash
docker build -t komine-crm-backend .
```

### 起動

```bash
# .env を使って起動（推奨）
docker run --rm -p 4000:4000 --env-file .env komine-crm-backend

# または環境変数を個別に渡す
docker run --rm -p 4000:4000 \
  -e DATABASE_URL="postgresql://..." \
  -e SUPABASE_URL="https://xxx.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  -e ALLOWED_ORIGINS="https://app.example.com" \
  komine-crm-backend
```

動作確認:

```bash
curl http://localhost:4000/health
```

### Prismaマイグレーション

マイグレーションは Supabase の DB に対してホスト側から実行します（コンテナ内ではなくローカル／CI から実行）。

```bash
npx prisma migrate deploy
```

### トラブルシューティング

| 症状 | 解決策 |
|------|--------|
| DB接続エラー | `DATABASE_URL` が正しいか確認。Supabase 側の接続情報（Session Pooler のポート等）を確認 |
| ポート使用中 | `docker run` の `-p` で別ポートにマッピング（例: `-p 4001:4000`） |
| Prismaエラー | `npx prisma generate` を実行してからイメージを再ビルド |

---

## Supabase認証

### セットアップ手順

1. [Supabase](https://supabase.com/)でプロジェクト作成
2. **Settings** → **API** から以下を取得:
   - Project URL → `SUPABASE_URL`
   - service_role key → `SUPABASE_SERVICE_ROLE_KEY`

### メール送信設定（招待・パスワードリセット）※本番前必須（#351 / #350）

スタッフ招待・パスワードリセットのメールが**確実に届くようにする**ための設定。抜けると「リンクが localhost に飛ぶ」「メールが届かない」事故になる。

#### 1. 遷移先URL（`FRONTEND_URL`）

招待/リセットメールのリンク先ベースURL。**末尾スラッシュ不可**（コード側で `${FRONTEND_URL}/set-password` `${FRONTEND_URL}/reset-password` と連結するため、`//set-password` になると Supabase の Redirect URL 許可リストにマッチせず Site URL にフォールバックする）。

- backend env に設定（`render.yaml` / `.env.example` 記載済み・#349）。例: `FRONTEND_URL=https://komine-crm-frontend.vercel.app`
- 未設定だとリセットは `localhost`、招待は Supabase Site URL にフォールバックする。

#### 2. Supabase Dashboard の URL 設定

**Authentication** → **URL Configuration**:

- **Site URL**: 本番フロントのオリジン（例 `https://komine-crm-frontend.vercel.app`）
- **Redirect URLs** に許可登録（`FRONTEND_URL` と一致させること）:
  - `https://<本番フロント>/set-password`
  - `https://<本番フロント>/reset-password`

#### 3. 独自SMTP（本番必須・組み込みメールのレート制限対策 #351）

Supabase の**組み込みメールはテスト用途で送信レート制限が非常に厳しい**（招待・リセット・確認メールが共通枠を消費し、同日に複数送ると「メール送信の制限に達しました」で失敗する）。本番では独自SMTPを設定する。

- **Authentication** → **SMTP Settings** で SendGrid / Resend / Amazon SES 等を設定
- 送信元ドメインの **SPF / DKIM** を設定（到達率・スパム回避）
- 送信レート上限を引き上げる

> レート制限に当たった場合、`forgot-password` は 429 + 専用メッセージを返す（#350）。それ以外のエラーは列挙対策で一律「送信しました」を維持。

### 初期 admin の作成

顧客環境への初回デプロイ時は [顧客環境への初回デプロイ手順](#顧客環境への初回デプロイ手順) の bootstrap スクリプトを使用してください。

運用中の追加ユーザー作成は admin アカウントでログインし `POST /api/v1/staff` から行います。

### （参考）手動でユーザーを追加する場合

1. Supabaseダッシュボード → **Authentication** → **Users**
2. **Add user** でユーザー作成（Auto Confirm: ON）
3. User UIDをコピーし、Staffテーブルに登録:

```sql
UPDATE staff SET supabase_uid = 'User UID' WHERE email = 'user@example.com';
```

### フロントエンド連携

```typescript
const { data } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password'
});

// APIリクエスト
fetch('/api/v1/plots', {
  headers: { 'Authorization': `Bearer ${data.session.access_token}` }
});
```

---

## 顧客環境への初回デプロイ手順

新規の顧客環境に CRM を立ち上げる際の標準手順。以下の順番で実施してください。

### 1. Supabaseプロジェクトの作成

1. [Supabase](https://supabase.com/) にログインし、新規プロジェクトを作成
2. **Settings** → **API** から以下を控える
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
3. **Settings** → **Database** から接続情報（DATABASE_URL / DIRECT_URL）を取得
   - Render / Vercel 等の IPv6 非対応環境では Session Pooler（port 5432）を使用

### 2. 環境変数の設定

`.env`（またはデプロイ先のシークレットマネージャ）に以下を設定:

| 変数名 | 必須 | 用途 |
|--------|------|------|
| `DATABASE_URL` | ✅ | Prisma / アプリ本体のDB接続 |
| `DIRECT_URL` | ▲ | マイグレーション用（Supabase Session Pooler 使用時）|
| `SUPABASE_URL` | ✅ | bootstrap / auth で使用 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | bootstrap / auth で使用 |
| `ALLOWED_ORIGINS` | ✅ | 本番フロントエンドのURLを指定 |
| `NODE_ENV` | ✅ | `production` |
| `INITIAL_ADMIN_EMAIL` | ✅ | 初期adminのメールアドレス |
| `INITIAL_ADMIN_PASSWORD` | ✅ | 初期adminのパスワード（8文字以上）|
| `INITIAL_ADMIN_NAME` | ✅ | 初期adminの表示名 |
| `ALLOW_BOOTSTRAP_IN_PRODUCTION` | ▲ | `NODE_ENV=production` で bootstrap を実行する場合のみ `true` を指定 |

### 3. マイグレーションの実行

```bash
npx prisma migrate deploy
```

### 4. 初期adminの作成（bootstrap）

```bash
# 本番環境では ALLOW_BOOTSTRAP_IN_PRODUCTION=true が必要
npm run bootstrap:admin
# または
npx prisma db seed
```

スクリプトの動作:

- Supabase Auth にユーザーを作成（`email_confirm: true` でメール確認スキップ）
- Staff テーブルに `role=admin` で登録
- **冪等**: 既に admin が Staff テーブルに存在する場合は skip
- **atomic**: Staff 登録に失敗した場合は Supabase ユーザーをロールバック
- Supabase 未設定時は明示的なエラーメッセージで終了
- `NODE_ENV=production` かつ `ALLOW_BOOTSTRAP_IN_PRODUCTION` が未指定の場合は誤実行防止のためブロック

### 5. ログイン確認

```bash
curl -X POST https://yourdomain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<INITIAL_ADMIN_EMAIL>","password":"<INITIAL_ADMIN_PASSWORD>"}'
```

200 が返れば完了。以降、追加ユーザーは admin アカウントでログイン後に `POST /api/v1/staff` から招待できます。

### トラブルシューティング

| エラー | 原因 / 対処 |
|--------|------------|
| `Supabase Admin が利用できません` | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を確認 |
| `必須環境変数が未設定です` | `INITIAL_ADMIN_*` 3変数をすべて設定 |
| `NODE_ENV=production での実行はブロックされました` | `ALLOW_BOOTSTRAP_IN_PRODUCTION=true` を明示的に設定 |
| `メールアドレス XXX の Staff が既に存在します` | 別のメールアドレスを指定、または既存レコードを確認 |
| `既に admin が存在するため skip` | 正常動作（冪等性）。追加 admin は API 経由で作成してください |

---

## CI/CDセットアップ

### GitHub Actions

`.github/workflows/ci.yml` が設定済み。以下が自動実行されます:

- Build（TypeScriptコンパイル）
- Lint & Format Check
- Swagger Validation
- Test（Node.js 18.x, 20.x, 22.x）
- Coverage Report

### Codecov連携（オプション）

1. https://codecov.io/ でリポジトリ追加
2. Repository Upload Tokenを取得
3. GitHub Secrets に `CODECOV_TOKEN` を追加

### ブランチ保護ルール（推奨）

Settings → Branches → Add rule:

- **Require status checks**: Build, Lint, Test, All Checks Passed
- **Require pull request**: 1 approval
- **Require conversation resolution**

---

## 本番環境デプロイ

### セキュリティチェックリスト

- [ ] `NODE_ENV=production`
- [ ] `ALLOWED_ORIGINS` に正しいフロントエンドURL
- [ ] 強固なDBパスワード
- [ ] HTTPS使用
- [ ] `.env`がGitにコミットされていない

### デプロイ後の確認

```bash
# ヘルスチェック
curl https://yourdomain.com/health

# 期待されるレスポンス
{
  "success": true,
  "data": {
    "status": "ok",
    "environment": "production"
  }
}
```

### 環境変数の管理（推奨）

- AWS: Secrets Manager / Parameter Store
- GCP: Secret Manager
- Kubernetes: Secrets

---

## 参考リンク

- [Supabase Documentation](https://supabase.com/docs)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Docker Documentation](https://docs.docker.com/)
- [GitHub Actions](https://docs.github.com/en/actions)
