# Supervisor Agent

**使役する側（Supervisor）エージェント** - Claude Code と Codex をオーケストレーションして、検証が通るまで自動でタスクを完遂する AI エージェントシステム。

## 概要

Supervisor Agent は、ユーザーの指示を受け取り、Claude Code や Codex といった「使役されるエージェント」に作業を指示し、検証・デバッグまでを自動で行うオーケストレーターです。

### 主な機能

- **LangGraph による実行グラフ**: 仕様策定 → 実装 → 検証 → デバッグ → 完了判定までのループ
- **OpenAI 互換 API**: `/v1/chat/completions` として外部から操作可能
- **デュアルエグゼキュータ**: Claude Code と Codex の両方に対応
- **自動検証・デバッグ**: 検証が通るまで自動でリトライ
- **Copilot API 連携**: usage 監視とモデル自動切替
- **WebUI**: Run 管理、ストリーミングログ、ショートカット実行
- **Tauri デスクトップアプリ**: スクリーンショット、クリック、キー入力
- **セキュリティポリシー**: Shell コマンドの allowlist/denylist、ファイルシステム制限

## プロジェクト構成

```
supervisor-agent/
├── packages/
│   ├── protocol/           # WorkOrder/WorkReport の JSON Schema + TypeScript 型
│   ├── tool-runtime/       # Shell/Git/FS/Desktop 操作の統一ツール層
│   ├── executor-codex/     # Codex CLI Adapter
│   ├── executor-claude/    # Claude Code CLI Adapter
│   └── provider-copilot/   # Copilot API Provider (usage監視・モデル切替)
├── apps/
│   ├── supervisor-backend/ # LangGraph + OpenAI 互換 API サーバー
│   ├── supervisor-ui/      # React WebUI
│   └── supervisor-tauri/   # Tauri デスクトップアプリ
└── configs/
    └── policy/             # セキュリティポリシー設定
```

## セットアップ

### 前提条件

- Node.js 20+
- pnpm 9+
- Codex CLI または Claude Code CLI（少なくとも一方）
- Rust（Tauri ビルド用、オプション）

### インストール

```bash
# 依存関係のインストール
pnpm install

# ビルド
pnpm build
```

## 使い方

### CLI での実行

```bash
# タスクを直接実行
pnpm --filter @supervisor/backend dev -- run "Add a login button to the homepage" --repo /path/to/project

# API サーバーを起動
pnpm --filter @supervisor/backend dev -- serve --port 3000
```

### WebUI での実行

```bash
# バックエンドを起動
pnpm --filter @supervisor/backend dev -- serve

# フロントエンドを起動（別ターミナル）
pnpm --filter @supervisor/ui dev

# ブラウザで http://localhost:5173 を開く
```

### Tauri デスクトップアプリ

```bash
# 開発モード
pnpm --filter @supervisor/tauri dev

# ビルド
pnpm --filter @supervisor/tauri build
```

### API 経由での実行

```bash
# OpenAI 互換 API
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "supervisor-v1",
    "messages": [{"role": "user", "content": "Add a login button"}],
    "repo_path": "/path/to/project"
  }'

# Run 管理 API
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Fix the failing tests",
    "repo_path": "/path/to/project"
  }'

# Run のステータス確認
curl http://localhost:3000/api/runs/{run_id}

# 最終レポート取得
curl http://localhost:3000/api/runs/{run_id}/report

# ストリーミングログ
curl http://localhost:3000/api/events?run_id={run_id}

# Usage 確認
curl http://localhost:3000/api/usage

# ショートカット一覧
curl http://localhost:3000/api/shortcuts

# Shell コマンド実行
curl -X POST http://localhost:3000/api/shell/execute \
  -H "Content-Type: application/json" \
  -d '{"command": "npm test"}'

# スクリーンショット取得
curl http://localhost:3000/api/desktop/screenshot

# クリック実行
curl -X POST http://localhost:3000/api/desktop/click \
  -H "Content-Type: application/json" \
  -d '{"x": 100, "y": 200}'
```

## アーキテクチャ

### LangGraph 実行フロー

```
START → Intake → SpecDraft → Decompose → RouteExecutor → Dispatch
                                              ↑              ↓
                                       AnalyzeFailures ← Verify → LoopControl
                                                                      ↓
                                                                  Finalize → END
```

### WorkOrder / WorkReport プロトコル

Supervisor と Executor 間の通信は、JSON Schema で定義された WorkOrder / WorkReport で行われます。

**WorkOrder** (Supervisor → Executor):
- `task_kind`: spec | implement | debug | refactor | test | review
- `objective`: 作業目標
- `acceptance_criteria`: 受入条件
- `verification.commands`: 検証コマンド
- `constraints`: 制約（パス制限、依存追加ポリシー等）

**WorkReport** (Executor → Supervisor):
- `status`: done | blocked | failed | needs_input
- `commands_run`: 実行したコマンドと結果
- `changes`: 変更されたファイル
- `verification.passed`: 自己検証結果（参考値）

### Copilot API 連携

`provider-copilot` パッケージで Copilot API と連携し、以下を実現：

- `/usage` エンドポイントで利用状況を監視
- 利用上限に近づいたら軽量モデルへ自動切替
- レート制限時のバックオフ処理

```bash
# Copilot 連携を有効化
ENABLE_COPILOT=true COPILOT_API_URL=http://localhost:4141 pnpm --filter @supervisor/backend dev -- serve
```

## WebUI 機能

- **Runs**: Run の作成・管理・詳細表示
- **Shortcuts**: よく使うコマンドのショートカット管理
- **Shell**: 対話的なシェル実行
- **Settings**: 設定と使用状況の確認

## Tauri デスクトップアプリ機能

- WebUI を内包
- バックエンドの sidecar 起動
- GUI 操作（スクリーンショット、クリック、キー入力）

## セキュリティ

`configs/policy/default.json` でセキュリティポリシーを設定できます：

- **Shell allowlist/denylist**: 実行可能なコマンドの制限
- **Filesystem write_roots**: 書き込み可能なディレクトリの制限
- **Network policy**: ネットワークアクセスの制限（デフォルト: deny）
- **Approval required**: 危険な操作に対する手動承認

## 開発

```bash
# 開発サーバー起動（ホットリロード）
pnpm dev

# テスト実行
pnpm test

# 型チェック
pnpm build

# 全パッケージのクリーン
pnpm clean
```

## 実装済みフェーズ

- [x] Phase 0: プロトコル定義、セキュリティポリシー
- [x] Phase 1: Supervisor MVP (Codex/Claude)
- [x] Phase 2: Claude Adapter 追加 & ルーティング
- [x] Phase 3: Copilot API 連携 (usage/モデル切替)
- [x] Phase 4: WebUI
- [x] Phase 5: Tauri デスクトップアプリ + GUI 操作 MVP

## API エンドポイント一覧

### OpenAI 互換
- `POST /v1/chat/completions` - チャット完了
- `GET /v1/models` - モデル一覧

### Run 管理
- `GET /api/runs` - Run 一覧
- `POST /api/runs` - Run 作成
- `GET /api/runs/:id` - Run 詳細
- `GET /api/runs/:id/logs` - ログ取得
- `GET /api/runs/:id/report` - レポート取得
- `DELETE /api/runs/:id` - Run 削除

### Usage
- `GET /api/usage` - 使用状況
- `GET /api/usage/model` - モデル推奨
- `GET /api/usage/copilot/status` - Copilot 状態

### Shortcuts
- `GET /api/shortcuts` - ショートカット一覧
- `POST /api/shortcuts` - 作成
- `PUT /api/shortcuts/:id` - 更新
- `DELETE /api/shortcuts/:id` - 削除
- `POST /api/shortcuts/:id/execute` - 実行

### Shell
- `POST /api/shell/execute` - コマンド実行
- `POST /api/shell/check` - ポリシーチェック

### Desktop
- `GET /api/desktop/screenshot` - スクリーンショット
- `GET /api/desktop/screen-size` - 画面サイズ
- `POST /api/desktop/click` - クリック
- `POST /api/desktop/type` - テキスト入力
- `POST /api/desktop/key` - キー入力

### Events
- `GET /api/events` - SSE ストリーミング
- `GET /api/logs/:runId` - バッファされたログ

## ライセンス

MIT
