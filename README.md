# Tako Agent

**タコのように複数の腕で同時に作業する** - Supervisor Agent が Claude と Codex をオーケストレーションして、並列実行でタスクを効率的に完遂する AI エージェントシステム。

## 概要

Tako Agent は、ユーザーの指示を受け取り、Supervisor Agent（GPT）がリポジトリ構造を理解し、タスクを分解して、Claude や Codex といった複数のワーカーに並列で作業を指示するオーケストレーターです。

### 主な機能

- **Supervisor Agent パターン**: GPT（Copilot API）が全体を統括、Worker（Claude/Codex）が実作業を担当
- **LangGraph によるフロー管理**: シンプルなループ構造で柔軟に対応
- **並列ワーカープール**: 複数の Claude/Codex インスタンスが同時にタスクを実行
- **OpenAI 互換 API**: `/v1/chat/completions` として外部から操作可能
- **デュアルエグゼキュータ**: Claude Code と Codex の両方に対応
- **Copilot API 連携**: GitHub Copilot を OpenAI 互換プロキシとして使用
- **WebUI**: プロジェクト管理、チャットUI、ストリーミングログ
- **セッション復元**: ページを離れても実行継続、復帰時に自動復元

## アーキテクチャ

### Supervisor Agent パターン（推奨）

```
┌─────────────────────────────────────────────────────────────────┐
│                    Supervisor Agent (GPT)                       │
│                    via Copilot API                              │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Tools:                                                    │  │
│  │  - read_file: ファイル読み取り（AGENTS.md、ソース等）    │  │
│  │  - list_files: ディレクトリ構造確認                       │  │
│  │  - spawn_workers: Worker起動（並列実行）                  │  │
│  │  - run_command: シェルコマンド実行                        │  │
│  │  - complete: 完了宣言                                     │  │
│  │  - fail: 失敗宣言                                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ spawn_workers
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Worker Pool                                   │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Claude    │  │   Claude    │  │   Codex     │  ...         │
│  │  (review)   │  │   (impl)    │  │   (impl)    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 処理フロー

```
START
  │
  ▼
┌─────────────────────────────────────────┐
│        Supervisor Agent Loop            │
│                                         │
│  1. リポジトリ構造を確認 (list_files)   │
│  2. AGENTS.md を読んでルール把握        │
│  3. タスクを分解                        │
│  4. spawn_workers で Worker 起動        │◀───┐
│  5. 結果をレビュー                      │    │
│  6. 必要なら追加タスク発行 ─────────────┼────┘
│  7. 全完了なら complete                 │
└─────────────────────────────────────────┘
  │
  ▼
 END
```

### Worker の役割分担

| Executor | 得意なタスク |
|----------|-------------|
| **Claude** | コード分析、レビュー、設計、複雑な判断 |
| **Codex** | 実装、コード生成、ファイル操作 |

Supervisor が各タスクに適切な executor を選択して指示を出します。**レビューも Worker が実行**します。

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
│   ├── supervisor-backend/ # Supervisor Agent + API サーバー
│   │   └── src/
│   │       ├── supervisor/ # Supervisor Agent 実装
│   │       │   ├── agent.ts    # Supervisor Agent 本体
│   │       │   ├── tools.ts    # ツール定義
│   │       │   └── types.ts    # 型定義
│   │       ├── graph/      # LangGraph フロー
│   │       └── workers/    # Worker Pool
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

### プログラムからの使用

```typescript
import { runSimplifiedSupervisor } from '@supervisor/backend/graph/supervisor-graph';

const result = await runSimplifiedSupervisor({
  userGoal: 'Fix the failing tests',
  repoPath: '/path/to/project',
});

console.log(result.status); // 'completed' or 'failed'
console.log(result.final_summary);
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

# ワーカープールの状態確認
curl http://localhost:3000/api/runs/{run_id}/workers

# ストリーミングログ (SSE)
curl http://localhost:3000/api/events?run_id={run_id}
```

## Supervisor Agent の動作

### システムプロンプト

Supervisor Agent は以下の役割を持ちます：

1. **リポジトリ理解**: `list_files` と `read_file` でコードベースを把握
2. **仕様確認**: `AGENTS.md` があれば読んで開発ルールを理解
3. **タスク分解**: ユーザー目標を独立した作業単位に分解
4. **並列実行**: `spawn_workers` で複数タスクを同時に Worker に指示
5. **結果レビュー**: Worker の成果物を確認し、必要なら追加作業を指示
6. **検証**: `run_command` でテスト・ビルドを実行して品質確認
7. **完了判定**: 全てOKなら `complete`、問題あれば `fail`

### ツール一覧

| ツール | 説明 |
|--------|------|
| `read_file` | ファイル内容を読み込む |
| `list_files` | ディレクトリ構造を確認 |
| `spawn_workers` | Worker を起動してタスクを並列実行 |
| `run_command` | シェルコマンドを実行（npm test 等） |
| `complete` | タスク完了を宣言 |
| `fail` | タスク失敗を宣言 |

## WebUI 機能

- **Projects**: プロジェクトの作成・管理
- **Chat**: チャット形式でタスクを指示、リアルタイムログ表示
- **Shell**: 対話的なターミナル
- **Settings**: API キー設定、GitHub Token 設定

## 設定

### GitHub Token（Copilot API 用）

Settings ページで GitHub Token を設定すると、Copilot API が自動的に有効化されます。

```
Settings → GitHub Copilot API → GitHub Token を入力
```

### モデル選択

チャット入力エリアのドロップダウンから Supervisor Agent が使用するモデルを選択できます。Copilot API が有効な場合、利用可能なモデル一覧が自動的に取得されます。

## API エンドポイント一覧

### OpenAI 互換
- `POST /v1/chat/completions` - チャット完了
- `GET /v1/models` - モデル一覧

### Run 管理
- `GET /api/runs` - Run 一覧
- `POST /api/runs` - Run 作成
- `GET /api/runs/:id` - Run 詳細
- `GET /api/runs/:id/workers` - ワーカープール状態
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
