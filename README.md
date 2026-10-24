# Cemetery CRM Backend

Cemetery CRM（kurosakicrm）は、墓地・墓石管理を行うための包括的なバックエンドシステムです。

## 📋 目次

- [概要](#概要)
- [主な機能](#主な機能)
- [技術スタック](#技術スタック)
- [セットアップ](#セットアップ)
  - [ローカル環境](#ローカル環境)
  - [Dockerでの起動](#dockerでの起動)
- [開発ガイド](#開発ガイド)
- [テスト](#テスト)
- [API仕様](#api仕様)
- [デプロイメント](#デプロイメント)
- [ドキュメント](#ドキュメント)
- [ライセンス](#ライセンス)

---

## 📖 概要

Cemetery CRM Backendは、墓地管理業務のデジタル化を支援するREST APIサーバーです。区画管理、契約者情報、請求情報、履歴管理など、墓地運営に必要な機能を提供します。

### 特徴

- 🔐 **Supabase認証**: JWT認証とロールベースアクセス制御
- 📊 **包括的なデータ管理**: 区画、契約者、請求、埋葬者など全情報を一元管理
- 📝 **履歴追跡**: 全ての変更履歴を自動記録
- 🔒 **セキュリティ**: Helmet、CORS、Rate Limiting、XSS対策を実装
- ✅ **高品質**: テストカバレッジ（Functions 100%, Lines 99%, Statements 97%, Branches 81%）
- 🚀 **CI/CD対応**: GitHub Actionsによる自動テスト・ビルド
- 🐳 **Docker対応**: コンテナ化による簡単なデプロイメント

---

## 🚀 主な機能

### 区画管理（Plots）
- 区画の作成、更新、削除、検索
- 契約者情報、請求情報、埋葬者情報の統合管理
- 変更履歴の自動記録と参照

### 認証・認可
- Supabase JWTトークン認証
- ロールベースアクセス制御（viewer, operator, manager, admin）
- パスワード変更機能

### マスタデータ管理
- 使用状況、墓地種別、宗派、性別など各種マスタデータ
- 都道府県、支払方法、税区分などのコード管理

### セキュリティ
- CORS設定（オリジンホワイトリスト）
- Rate Limiting（DDoS対策）
- XSS対策（入力サニタイゼーション）
- HPP対策（HTTP Parameter Pollution）
- Helmet（セキュリティヘッダー）

---

## 🛠️ 技術スタック

### バックエンド
- **Node.js** (v24.x)
- **TypeScript** (v5.8.3)
- **Express.js** (v4.19.2)

### データベース
- **PostgreSQL** (Supabaseホスト)
- **Prisma ORM** (v6.9.0)

### 認証
- **Supabase** (v2.76.1)

### セキュリティ
- **Helmet** - セキュリティヘッダー
- **CORS** - クロスオリジンリソース共有
- **express-rate-limit** - レート制限
- **HPP** - HTTP Parameter Pollution対策

### テスト
- **Jest** (v30.1.3) - 単体・統合テスト
- **Supertest** (v7.1.4) - API統合テスト（HTTPレベルE2E）

### コード品質
- **ESLint** (v8.57.1)
- **Prettier** (v3.6.2)
- **Husky** - Gitフック
- **lint-staged** - ステージングファイルのLint

### CI/CD
- **GitHub Actions** - 自動テスト・ビルド
- **Codecov** - カバレッジレポート

### コンテナ化
- **Docker** - コンテナ化（本番イメージは `Dockerfile` でビルド）

---

## ⚙️ セットアップ

### 前提条件

- **Node.js**: v24.x（24.22.1 以上）
- **npm**: v8以降
- **PostgreSQL**: Supabaseホストのインスタンスを使用（接続文字列を `DATABASE_URL` に設定）

### ローカル環境

#### 1. リポジトリのクローン

```bash
git clone https://github.com/zaitsu82/komine-crm-backend.git
cd komine-crm-backend
```

#### 2. 依存関係のインストール

```bash
npm install
```

#### 3. 環境変数の設定

```bash
# .env.exampleをコピーして.envを作成
cp .env.example .env

# .envファイルを編集
# 必要な値を設定:
# - DATABASE_URL
# - SUPABASE_URL
# - SUPABASE_SERVICE_ROLE_KEY
# - ALLOWED_ORIGINS
```

#### 4. Prismaのセットアップ

```bash
# Prismaクライアント生成
npx prisma generate

# データベースマイグレーション
npx prisma migrate dev

# （任意）テストデータの投入
node scripts/insert-test-data.js
```

#### 5. 開発サーバー起動

```bash
npm run dev
```

サーバーは `http://localhost:4000` で起動します。

ヘルスチェック: `http://localhost:4000/health`

---

### Dockerでの起動

リポジトリには本番ビルド用の `Dockerfile` が含まれています。データベースは Supabaseホストの PostgreSQL を利用するため、コンテナには含めません。`DATABASE_URL` などの環境変数はコンテナ起動時に渡します。

#### 前提条件

- **Docker**: v20.10以降

#### イメージのビルドと起動

```bash
# 1. イメージをビルド
docker build -t komine-crm-backend .

# 2. .env を使って起動（推奨）
#    .env に DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ALLOWED_ORIGINS を設定しておく
docker run --rm -p 4000:4000 --env-file .env komine-crm-backend

#    または環境変数を個別に渡す
docker run --rm -p 4000:4000 \
  -e DATABASE_URL="postgresql://..." \
  -e SUPABASE_URL="https://xxx.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  -e ALLOWED_ORIGINS="https://app.example.com" \
  komine-crm-backend

# 3. 動作確認
curl http://localhost:4000/health
```

> マイグレーションは Supabase に対して別途実行します（`npx prisma migrate deploy`）。詳細は [SETUP.md](./SETUP.md) を参照してください。

---

## 💻 開発ガイド

### スクリプト一覧

```bash
# 開発サーバー起動（ホットリロード）
npm run dev

# 本番用ビルド
npm run build

# 本番サーバー起動（ビルド後）
npm start

# テスト実行
npm test                    # 全テスト実行
npm run test:watch          # ウォッチモード
npm run test:coverage       # カバレッジレポート生成

# コード品質
npm run lint                # ESLintチェック
npm run lint:fix            # ESLint自動修正
npm run format              # Prettierフォーマット
npm run format:check        # フォーマットチェック

# API仕様書
npm run swagger:validate    # OpenAPI仕様検証
npm run swagger:json        # YAML→JSON変換
npm run swagger:build       # 仕様書ビルド

# データベース
npx prisma generate         # Prismaクライアント生成
npx prisma migrate dev      # マイグレーション作成・適用
npx prisma migrate deploy   # 本番環境マイグレーション
npx prisma studio           # Prisma Studio起動
```

### コーディング規約

- **ESLint**: コードの静的解析とスタイル統一
- **Prettier**: コードフォーマット統一
- **Pre-commit hooks**: コミット前に自動でlint + format実行
- **TypeScript strict mode**: 厳格な型チェック

### ブランチ戦略

- `main`: 本番環境用ブランチ
- `develop`: 開発用メインブランチ
- `feature/*`: 機能開発ブランチ

### コミット時の注意

Huskyによりコミット前に以下が自動実行されます：
- ESLintによる構文チェック
- Prettierによるフォーマット

---

## ✅ テスト

### テスト実行

```bash
# 全テスト実行
npm test

# カバレッジレポート生成
npm run test:coverage

# 特定のテストファイル実行
npm test -- tests/plots/plotController.test.ts

# テスト名でフィルタ
npm test -- --testNamePattern="GET /api/v1/plots"
```

### カバレッジ目標

現在のカバレッジ（445テスト）:
- **Functions**: 100%
- **Lines**: 99.16%
- **Statements**: 97.87%
- **Branches**: 81.72%

### テスト方針（E2Eの所在）

バックエンドの自動テストは **Jest + Supertest** に一本化している。Supertest は Express アプリを HTTP レベルで起動して叩くため、API の E2E はこの層でカバーする。

ブラウザを介した画面 E2E（Playwright）は **フロントエンドリポジトリ（`komine-crm-frontend`）** に集約している。バックエンド単体には Playwright を置かない方針。

---

## 📚 API仕様

### Swagger UI（インタラクティブAPI仕様書）

サーバー起動後、ブラウザで以下にアクセスすると、インタラクティブなAPI仕様書を閲覧できます：

```
http://localhost:4000/api-docs
```

**機能**：
- 📖 全エンドポイントの詳細仕様を確認
- 🔧 ブラウザから直接APIをテスト（Try it out機能）
- 🔐 JWT認証を使用した保護されたエンドポイントのテスト
- 📝 リクエスト/レスポンスのサンプルコード生成

### OpenAPI仕様書ファイル

- **swagger.yaml** - YAML形式のAPI仕様書
- **swagger.json** - JSON形式のAPI仕様書

### 主要エンドポイント

#### 認証
- `POST /api/v1/auth/login` - ログイン
- `POST /api/v1/auth/logout` - ログアウト
- `GET /api/v1/auth/me` - 現在のユーザー情報取得
- `POST /api/v1/auth/change-password` - パスワード変更

#### 区画管理
- `GET /api/v1/plots` - 区画一覧取得
- `GET /api/v1/plots/:id` - 区画詳細取得
- `POST /api/v1/plots` - 区画新規作成
- `PUT /api/v1/plots/:id` - 区画更新
- `DELETE /api/v1/plots/:id` - 区画削除

#### マスタデータ
- `GET /api/v1/masters/:type` - マスタデータ取得

詳細は `swagger.yaml` を参照してください。

---

## 🚀 デプロイメント

### 本番環境セットアップ

本番環境・顧客環境へのデプロイ手順、環境変数設定、初期adminの作成（bootstrap）、セキュリティチェックリストについては、以下のドキュメントを参照してください：

📖 **[SETUP.md](./SETUP.md)** - セットアップ／デプロイガイド

### CI/CD

GitHub Actions（`.github/workflows/ci.yml`）による自動テスト・ビルドパイプラインを実装しています。設定手順は [SETUP.md](./SETUP.md) を参照してください。

#### CI/CDワークフロー

- ✅ **Build**: TypeScriptコンパイルチェック
- ✅ **Lint & Format Check**: ESLint + Prettier検証
- ✅ **Swagger Validation**: API仕様書検証
- ✅ **Test**: Node.js 24.x でテスト実行
- ✅ **Coverage**: Codecovへカバレッジレポート送信

---

## 📖 ドキュメント

### 主要ドキュメント

- **[README.md](./README.md)** - このファイル（プロジェクト概要）
- **[SETUP.md](./SETUP.md)** - セットアップ／デプロイガイド（環境変数・CI/CD・本番デプロイ含む）
- **[SECURITY.md](./SECURITY.md)** - セキュリティポリシー
- **[CLAUDE.md](./CLAUDE.md)** - プロジェクト概要と開発ガイドライン

### API仕様書

- **[swagger.yaml](./swagger.yaml)** - OpenAPI 3.0仕様書（YAML）
- **[swagger.json](./swagger.json)** - OpenAPI 3.0仕様書（JSON）

### データベース

- **[prisma/schema.prisma](./prisma/schema.prisma)** - Prismaスキーマ定義

---

## 🔒 セキュリティ

### 実装済みセキュリティ対策

- **Helmet**: セキュリティヘッダー設定（CSP, HSTS, X-Frame-Options等）
- **CORS**: オリジンホワイトリスト
- **Rate Limiting**: DDoS対策（100 req/15min）
- **HPP Protection**: HTTP Parameter Pollution対策
- **XSS Protection**: 入力サニタイゼーション
- **JWT認証**: Supabaseベースのトークン認証
- **Role-based Access Control**: ロールベースの権限管理

### 自動セキュリティスキャン

- **Dependabot**: npm依存関係の脆弱性を週次で自動検出・PR作成
- **npm audit**: CI/CDパイプラインで自動実行
- **Trivy**: Dockerイメージの脆弱性スキャン（CRITICAL/HIGH検出）
- **GitHub Security**: Security Advisoriesで脆弱性を一元管理

### 手動セキュリティチェック

```bash
# npm依存関係の脆弱性チェック
npm audit

# 本番環境依存関係のみチェック
npm audit --production

# Dockerイメージの脆弱性スキャン
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image komine-crm-backend:latest
```

### セキュリティベストプラクティス

1. `.env`ファイルをGitにコミットしない
2. 本番環境では強力なパスワードを使用
3. `ALLOWED_ORIGINS`を適切に設定
4. 定期的な依存関係の更新（Dependabotによる自動PR）
5. ログから機密情報を除外

### 脆弱性の報告

セキュリティ上の脆弱性を発見した場合は、**[SECURITY.md](./SECURITY.md)** を参照してください。

---

## 🤝 開発フロー

### ブランチ運用

- `main` への直接コミット・プッシュは禁止。必ず `main` からブランチを切って作業し、PRマージのみ。
- ブランチ名は変更内容がわかる名称にする（例: `feature/xxx`, `fix/xxx`, `chore/xxx`）。

### コミット前のチェック

```bash
# Lint & Format
npm run lint
npm run format

# テスト実行
npm test

# カバレッジ確認
npm run test:coverage
```

---

## 📄 ライセンス

このプロジェクトのライセンス情報については、LICENSEファイルを参照してください。

---

## 🆘 サポート

問題が発生した場合は、以下を確認してください：

1. [GitHub Issues](https://github.com/zaitsu82/komine-crm-backend/issues)
2. ドキュメント: `SETUP.md`, `CLAUDE.md`, `SECURITY.md`
3. API仕様書: `swagger.yaml`

---

**最終更新**: 2025-11-19
**バージョン**: 1.1.1
