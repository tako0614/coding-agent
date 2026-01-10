# Tako Agent

**タコのように複数の腕で同時に作業する** - Claude と Codex をオーケストレーションして、DAG ベースの並列実行でタスクを効率的に完遂する AI エージェントシステム。

## 概要

Tako Agent は、ユーザーの指示を受け取り、タスクを DAG（有向非巡回グラフ）に分解して、Claude や Codex といった複数のワーカーに並列で作業を指示するオーケストレーターです。

### 主な機能

- **LangGraph による DAG 実行**: ゴール受付 → コンテキスト読み取り → DAG 構築 → 並列ディスパッチ → 検証 → 完了
- **並列ワーカープール**: 複数の Claude/Codex インスタンスが同時にタスクを実行
- **OpenAI 互換 API**: `/v1/chat/completions` として外部から操作可能
- **デュアルエグゼキュータ**: Claude Code と Codex の両方に対応
- **Copilot API 連携**: GitHub Copilot を OpenAI 互換プロキシとして使用
- **WebUI**: プロジェクト管理、チャットUI、ストリーミングログ
- **セッション復元**: ページを離れても実行継続、復帰時に自動復元

## プロジェクト構成

```
tako-agent/
├── packages/
│   ├── protocol/           # WorkOrder/WorkReport の JSON Schema + TypeScript 型
│   ├── tool-runtime/       # Shell/Git/FS/Desktop 操作の統一ツール層
│   ├── executor-codex/     # Codex CLI Adapter
│   ├── executor-claude/    # Claude Code CLI Adapter
│   └── provider-copilot/   # Copilot API Provider
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
- GitHub Token（Copilot API 使用時）

### インストール

```bash
# 依存関係のインストール
pnpm install

# ビルド
pnpm build
```

## 使い方

### WebUI での実行（推奨）

```bash
# バックエンドを起動
pnpm --filter @supervisor/backend dev -- serve

# フロントエンドを起動（別ターミナル）
pnpm --filter @supervisor/ui dev

# ブラウザで http://localhost:5173 を開く
```

### CLI での実行

```bash
# タスクを直接実行
pnpm --filter @supervisor/backend dev -- run "Add a login button to the homepage" --repo /path/to/project

# API サーバーのみ起動
pnpm --filter @supervisor/backend dev -- serve --port 3000
```

### API 経由での実行

```bash
# Run 作成
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Fix the failing tests",
    "repo_path": "/path/to/project"
  }'

# Run のステータス確認
curl http://localhost:3000/api/runs/{run_id}

# DAG の状態確認
curl http://localhost:3000/api/runs/{run_id}/dag

# ワーカープールの状態確認
curl http://localhost:3000/api/runs/{run_id}/workers

# ストリーミングログ (SSE)
curl http://localhost:3000/api/events?run_id={run_id}
```

## アーキテクチャ

### LangGraph 実行フロー

```
START → Intake → ReadContext → BuildDAG → ParallelDispatch → Verify → Finalize → END
                                              ↑                  ↓
                                              └──────────────────┘
                                              (タスク完了まで繰り返し)
```

### DAG ベースの並列実行

1. **Intake**: ユーザーゴールを受け取り、実行を初期化
2. **ReadContext**: リポジトリ構造とコンテキストを読み取り
3. **BuildDAG**: ゴールをタスクに分解し、依存関係グラフを構築
4. **ParallelDispatch**: 依存関係が解決したタスクを並列でワーカーに割り当て
5. **Verify**: 完了したタスクの検証
6. **Finalize**: 最終レポート生成

### ワーカータイプ

- **Claude**: 設計・アーキテクチャ決定・複雑な判断が必要なタスク
- **Codex**: 実装・コーディング・ファイル操作タスク

各タスクは `executor_preference` で適切なワーカーに振り分けられます。

## WebUI 機能

- **Projects**: プロジェクトの作成・管理
- **Chat**: チャット形式でタスクを指示、リアルタイムログ表示
- **DAG Visualization**: タスクの依存関係と進捗をビジュアル表示
- **Shell**: 対話的なターミナル
- **Settings**: API キー設定、GitHub Token 設定

## 設定

### GitHub Token（Copilot API 用）

Settings ページで GitHub Token を設定すると、Copilot API が自動的に有効化されます。

```
Settings → GitHub Copilot API → GitHub Token を入力
```

### モデル選択

チャット入力エリアのドロップダウンから DAG 構築に使用するモデルを選択できます。Copilot API が有効な場合、利用可能なモデル一覧が自動的に取得されます。

## API エンドポイント一覧

### OpenAI 互換
- `POST /v1/chat/completions` - チャット完了
- `GET /v1/models` - モデル一覧

### Run 管理
- `GET /api/runs` - Run 一覧
- `POST /api/runs` - Run 作成
- `GET /api/runs/:id` - Run 詳細
- `GET /api/runs/:id/dag` - DAG 状態
- `GET /api/runs/:id/workers` - ワーカープール状態
- `GET /api/runs/:id/plan` - プラン取得
- `DELETE /api/runs/:id` - Run 削除

### Projects
- `GET /api/projects` - プロジェクト一覧
- `POST /api/projects` - プロジェクト作成
- `GET /api/projects/:id` - プロジェクト詳細
- `PUT /api/projects/:id` - プロジェクト更新
- `DELETE /api/projects/:id` - プロジェクト削除

### Settings
- `GET /api/settings` - 設定取得
- `PUT /api/settings` - 設定更新

### Copilot API
- `GET /api/copilot/status` - Copilot API 状態
- `GET /api/copilot/models` - 利用可能なモデル一覧
- `POST /api/copilot/start` - Copilot API 開始
- `POST /api/copilot/stop` - Copilot API 停止

### Shell
- `POST /api/shell/execute` - コマンド実行

### Events
- `GET /api/events` - SSE ストリーミング
- `GET /api/logs/:runId` - バッファされたログ

## 開発

```bash
# 開発サーバー起動（ホットリロード）
pnpm dev

# 型チェック
pnpm build

# フロントエンドビルド（本番用）
pnpm --filter @supervisor/ui build
```

## ライセンス

MIT
