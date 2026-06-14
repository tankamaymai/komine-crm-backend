# ============================================
# Stage 0: Build @komine/types
# ============================================
FROM node:20-alpine AS types

RUN apk add --no-cache git

# npm レジストリ fetch の ECONNRESET flake を指数バックオフで吸収する（#381）。
# 既定の fetch-retries=2 では CI の Docker ビルドが稀に転送リセットで落ちるため強化。
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_factor=4 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /packages/types

# TYPES_REF: ビルドする @komine/types の git ref (commit SHA 固定)
# セキュリティ: main 追従だとリポジトリ汚染が即本番到達するため、commit SHA で固定。
# types 更新時はこの値を明示的に更新する。
# 詳細: zaitsu82/komine-crm-backend#60
ARG TYPES_REF=cc588917b2f2c12a3e301aa9ab1987219df0f8fe

RUN git clone https://github.com/zaitsu82/komine-types.git . && \
    git checkout ${TYPES_REF} && \
    npm ci && \
    npm run build

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:20-alpine AS deps

# git: GitHub URL依存パッケージのインストールに必要
RUN apk add --no-cache git

# 作業ディレクトリの設定
WORKDIR /app

# npm_config_install_links: file:依存（@komine/types）を常に実体コピーで解決する。
# フラグ指定だと後続の `npm install` が symlink に戻してしまうため、
# 環境変数で全 npm 実行に適用して一貫性を確保する。
# 詳細: zaitsu82/komine-crm-backend#60
# npm_config_fetch_retry_*: レジストリ fetch の ECONNRESET flake を吸収（#381）
ENV npm_config_install_links=true \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_factor=4 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# @komine/types パッケージを配置（file:../packages/types の解決用）
COPY --from=types /packages/types /packages/types

# 依存関係のインストールに必要なファイルをコピー
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# 本番用依存関係のみインストール
# Prisma v7: クライアントエンジンはJSベース（ネイティブバイナリ不要）
# --ignore-scriptsでprepareスクリプト(husky)をスキップ（本番環境では不要）
# --no-save prisma: preDeployCommand (prisma migrate deploy) 実行用にCLIを含める
RUN npm ci --omit=dev --ignore-scripts && \
    npm install --no-save prisma && \
    npx prisma generate && \
    npm cache clean --force

# ============================================
# Stage 2: Build
# ============================================
FROM node:20-alpine AS builder

# git: GitHub URL依存パッケージのインストールに必要
RUN apk add --no-cache git

WORKDIR /app

# file:依存（@komine/types）を常に実体コピーで解決（deps ステージと同じ）
# npm_config_fetch_retry_*: レジストリ fetch の ECONNRESET flake を吸収（#381）
ENV npm_config_install_links=true \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_factor=4 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# @komine/types パッケージを配置（file:../packages/types の解決用）
COPY --from=types /packages/types /packages/types

# 依存関係のインストール（devDependenciesを含む）
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npm ci && \
    npx prisma generate

# ソースコードをコピー
COPY . .

# TypeScriptのビルド
RUN npm run build

# ============================================
# Stage 3: Production
# ============================================
FROM node:20-slim AS production

# セキュリティ: ベースイメージの脆弱性パッチを適用してから Chromium + 日本語フォントを導入。
# `apt-get upgrade` で libgnutls30 等の CVE 修正を取り込む (Trivy CRITICAL gate 対応)。
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends \
        chromium \
        fonts-ipafont-gothic \
        fonts-ipafont-mincho && \
    rm -rf /var/lib/apt/lists/*

# Puppeteer: システムChromiumを使用し、バンドル版ダウンロードをスキップ
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# セキュリティ: non-rootユーザーで実行
RUN groupadd -g 1001 nodejs && \
    useradd -m -u 1001 -g nodejs nodejs

WORKDIR /app

# 本番用依存関係とPrismaクライアントをコピー
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs /app/package*.json ./

# ビルド成果物をコピー
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./

# 環境変数の設定
ENV NODE_ENV=production
ENV PORT=4000

# non-rootユーザーに切り替え
USER nodejs

# ポートを公開
EXPOSE 4000

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# アプリケーション起動
CMD ["node", "dist/index.js"]
