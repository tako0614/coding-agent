# PLANS.md

## 1. プロジェクト概要

本プロジェクトは、**「使役する側（Supervisor）エージェント」**のみを実装し、実作業（コード生成・修正・デバッグ等）は **Claude Code（Claude Agent SDK）** と **Codex（Codex SDK / Codex CLI）** を **使役（オーケストレーション）**することで完遂する。

Supervisor は **LangGraph** により「仕様策定 → 実装 → 検証 → デバッグ → 完了判定」までのループをグラフとして定義し、**OpenAI互換 API**（`/v1/chat/completions`）として外部から操作可能にする。

加えて、**GitHub Copilot の OpenAI互換プロキシ（ericc-ch/copilot-api）**を併用し、`/usage` 等を参照して **無料/軽量モデルへの切替（フォールバック）**を行う。

同梱 UI として **WebUI**（ブラウザ）および **Tauri**（デスクトップ）を提供し、以下を可視化・操作可能にする。

- Run（実行）管理（開始/停止/状態）
- ログ（Supervisor / Claude / Codex）
- 検証結果（コマンド出力・失敗要約）
- Shell 実行（ポリシー制御付き）
- 起動ショートカット管理（ボタン化）
- 起動中 GUI アプリ操作（MVP: スクショ表示＋入力注入）

---

## 2. 目的

- 人間（ユーザー）は **「使役されるエージェントに渡す指示仕様」**を策定する。
- Supervisor は以下の役割を担う。
  - 仕様策定（受入条件・検証手順の形式化）
  - 作業分解（WorkOrder生成）
  - Claude Code / Codex への指示出し（Adapter 経由）
  - 変更統合（差分収集・ブランチ運用）
  - 検証（コマンド実行）と失敗解析
  - デバッグ WorkOrder 再投入（収束まで反復）
  - 完了判定と成果物レポート出力

---

## 3. 非目的（Non-Goals）

- 「使役される側」エージェント自体の実装（Claude Code / Codex の再実装、独自エージェント化）は行わない。
- IDE/エディタのプラグイン開発を必須とはしない（将来拡張として扱う）。
- GUI 自動操作の高精度化（アクセシビリティツリー等の高度対応）は MVP では行わない。

---

## 4. 用語

- **Supervisor**: 本プロジェクトで実装する「使役する側」エージェント（オーケストレータ）
- **Executor**: 実作業を行う外部エージェント（Claude Code / Codex）
- **WorkOrder**: Supervisor → Executor の作業指示（JSON）
- **WorkReport**: Executor → Supervisor の作業報告（JSON）
- **Run**: ユーザー指示から完了までの 1 回の実行単位（run_id で識別）

---

## 5. 成果物（Deliverables）

- `PLANS.md`（本ファイル）
- `packages/protocol/`：WorkOrder/WorkReport の **JSON Schema** + TypeScript 型
- `apps/supervisor-backend/`：LangGraph + OpenAI互換 API + 管理 API
- `packages/executor-codex/`：Codex SDK Adapter
- `packages/executor-claude/`：Claude Agent SDK Adapter
- `packages/provider-copilot/`：copilot-api client（/usage, /models, /chat）
- `packages/tool-runtime/`：Shell/Git/FS/GUI 操作の統一ツール層
- `apps/supervisor-ui/`：WebUI
- `apps/supervisor-tauri/`：Tauri 同梱クライアント（WebUI を内包）
- 統合テスト（E2E）とデバッグ手順

---

## 6. アーキテクチャ（推奨構成）

### 6.1 コンポーネント

1) **Supervisor Core（LangGraph）**
- State（実行状態）を保持し、ノード遷移でループを構成
- 受入条件（Acceptance）と検証コマンド（Verification）を中核に据える

2) **Executor Adapters**
- Claude / Codex に WorkOrder を渡し、WorkReport を収集
- 出力を schema で正規化し、Supervisor の State に統合

3) **Copilot Provider（任意）**
- copilot-api を sidecar として起動して OpenAI互換 endpoint を提供
- `/usage` を参照してモデルルーティングを行う

4) **Tool Runtime**
- shell / git / fs / process / desktop-control を統一 API 化
- UI と Supervisor の双方から呼べる

5) **API Server**
- **OpenAI互換** `/v1/chat/completions`（Supervisor 操作用）
- 管理用 API（runs、logs、artifacts、usage、shortcuts）
- WebSocket（ログ配信、スクショ配信）

6) **UI（Web + Tauri）**
- run 管理、ログ、検証、shell、shortcuts、GUI 操作

---

## 7. 指示仕様（WorkOrder / WorkReport）v1

### 7.1 設計原則

- Executor を差し替えても破綻しない **安定したプロトコル**を固定する。
- WorkOrder は「目的」「制約」「受入条件」「検証手順」「許可ツール」を明記する。
- WorkReport は「やったこと」「変更点」「実行コマンド」「検証結果」「次アクション」を必須化する。
- **最終的な完了判定は Supervisor が行う**（Executor の自己申告に依存しない）。

### 7.2 WorkOrder v1（Supervisor → Executor）

- `task_kind`: `spec | implement | debug | refactor | test | review`
- `repo.path`: 作業対象リポジトリ（絶対/相対パス）
- `constraints`: 触って良い領域／禁止領域／依存追加ポリシー／ネットワークポリシー
- `acceptance_criteria`: 仕様的な合格条件（箇条書き）
- `verification.commands`: 機械的に回せる検証コマンド（must_pass を指定）
- `tooling`: sandbox、approval、write_roots、rate_limit 等

### 7.3 WorkReport v1（Executor → Supervisor）

- `status`: `done | blocked | failed | needs_input`
- `commands_run`: 実行したコマンドと exit_code
- `verification.passed`: Executor 自己判定（参考値）
- `questions`: 仕様選択など人間判断が必要な場合の質問

---

## 8. LangGraph 実行グラフ（最小構成）

### 8.1 State（例）

- `run_id`
- `user_goal`
- `spec`（受入条件・検証コマンド）
- `task_queue`（WorkOrder[]）
- `current_task`
- `artifacts`（diff、ログ、スクショ、コマンド出力）
- `verification_results`
- `iteration_counters`（無限ループ防止）
- `model_policy`（Copilot/Claude/Codex のルーティング）
- `security_policy`（コマンド許可、承認）
- `final_report`

### 8.2 Nodes（推奨）

1. `Intake`：ユーザー入力正規化、repo 推定、Run 作成
2. `SpecDraft`：受入条件・検証手順（commands）策定
3. `TaskDecompose`：WorkOrder に分割（実装/テスト/ドキュメント等）
4. `RouteExecutor`：Claude / Codex 割当（負荷・種別・ポリシーで判断）
5. `Dispatch`：Executor 実行（Adapter）
6. `Integrate`：変更統合（diff収集、ブランチ/コミット）
7. `Verify`：verification.commands を Supervisor が実行
8. `AnalyzeFailures`：失敗ログ要約 → Debug WorkOrder 生成
9. `LoopControl`：収束判定（成功なら Finalize、失敗なら Dispatch に戻る）
10. `Finalize`：最終レポート生成、UIへ反映

---

## 9. “完了（検証/デバッグまで）まで止まらない”ための運用ポリシー

### 9.1 完了条件（DONE）

- `verification.commands` の `must_pass=true` が **全て成功**し、
- `acceptance_criteria` を明確に満たすと Supervisor が判断できること。

### 9.2 ループ制御（無限ループ回避）

- 同一失敗（同一コマンド・同一エラー要約）が N 回（例: 3）続いたら戦術を切替。
  - Executor 切替（Codex ↔ Claude）
  - モデル切替（heavy → small）
  - sandbox/approval を段階的に変更（UIで可視化し、必要なら手動承認）
- `blocked` が続く場合は `needs_input` に昇格し、ユーザー入力を要求する（ただし Run 自体は保持）。

### 9.3 Debug WorkOrder（標準テンプレ）

- `task_kind=debug`
- `background` に以下を必ず含める。
  - 失敗コマンド
  - exit code
  - stderr の末尾 N 行
  - 直近 diff の要約
- `acceptance_criteria` に「当該エラーが解消し、全検証が通る」を明記

---

## 10. Copilot API（copilot-api）連携計画

### 10.1 目的

- `/usage` を参照して利用上限に近づいたら **モデルを軽量/無料側へ切替**する。
- `/v1/models` の結果をもとに「利用可能モデルの候補」を常に更新する。

### 10.2 実装方針

- `provider-copilot` パッケージで以下を提供する。
  - `getUsage()`
  - `listModels()`
  - `chatCompletions()`（OpenAI互換）
- `ModelRouter`（Supervisor 内）で以下を行う。
  - premium 逼迫時に Supervisor の思考を lightweight に寄せる
  - 429/403 が出たらバックオフ・並列度低下
  - “過度な自動化”を避けるためのグローバルレート制限

---

## 11. UI / Tauri 同梱計画

### 11.1 WebUI（必須）

- Run 一覧（状態: running/failed/needs_input/done）
- ログ（ストリーミング）
- diff サマリ（ファイル一覧）
- verify 結果（コマンド・exit code・末尾ログ）
- usage 表示（Copilot）
- shell 実行（allowlist のみ）
- shortcuts（登録/実行/編集）

### 11.2 GUI 操作（MVP）

- スクリーンショット取得 → WebUI 表示
- 座標クリック、キー入力（最小セット）
- 実行は tool-runtime 経由に統一し、ログ/監査に残す

### 11.3 Tauri

- WebUI を内包して配布
- Supervisor backend / copilot-api を sidecar 起動（任意）
- shell は allowlist + 引数検査で制限（安全第一）

---

## 12. リポジトリ構成（推奨）

```
repo/
  apps/
    supervisor-backend/
    supervisor-ui/
    supervisor-tauri/
  packages/
    protocol/
    executor-codex/
    executor-claude/
    provider-copilot/
    tool-runtime/
  configs/
    policy/
  scripts/
    dev/
```

---

## 13. フェーズ計画（チェックリスト）

### Phase 0: 仕様固定（プロトコル & ポリシー）

- [ ] WorkOrder/WorkReport v1 の JSON Schema を確定
- [ ] security policy（allowlist、sandbox、approval）を定義
- [ ] run/ログ/成果物の保存形式（ディレクトリ構成）を定義

**Acceptance**
- Schema バリデーションが通るサンプル（WorkOrder/WorkReport）が揃っている

---

### Phase 1: Supervisor MVP（Codex のみで縦切り）

- [ ] LangGraph の最小グラフ（Intake → Decompose → Dispatch → Verify → DebugLoop → Finalize）
- [ ] OpenAI互換 `/v1/chat/completions`（Supervisor 操作用）
- [ ] Codex Adapter（WorkOrder→実行→WorkReport）
- [ ] Verify（Supervisor がコマンド実行）
- [ ] 失敗時の Debug WorkOrder 自動生成

**Acceptance**
- 既知の小タスク（例: サンプル関数追加＋テスト追加）で「検証が通るまで」自走できる

---

### Phase 2: Claude Adapter 追加 & ルーティング

- [ ] Claude Agent SDK Adapter を追加
- [ ] RouteExecutor（タスク種別で割当）
- [ ] WorkReport 正規化（Claude 由来のテキストを JSON 化）

**Acceptance**
- “実装は Codex、仕様・レビューは Claude”のような分担が成立する

---

### Phase 3: Copilot 連携（usage/モデル切替）

- [ ] provider-copilot 実装（/usage, /models, /chat）
- [ ] ModelRouter 実装（逼迫・エラー時フォールバック）
- [ ] グローバルレート制限、バックオフ、手動承認モード

**Acceptance**
- usage 変化に応じてモデルが切り替わる（ログで追跡できる）

---

### Phase 4: WebUI

- [ ] run 管理画面
- [ ] ストリーミングログ
- [ ] verify 結果表示
- [ ] shell（allowlist）+ shortcuts

**Acceptance**
- UI から Run 状態/ログ/検証結果が追える
- shell 実行がポリシー通りに制限される

---

### Phase 5: Tauri 同梱 + GUI 操作 MVP

- [ ] Tauri パッケージング（WebUI 内包）
- [ ] sidecar 起動（backend / copilot-api）
- [ ] スクショ表示・クリック・キー入力

**Acceptance**
- デスクトップ配布物として起動し、同一機能が利用できる

---

## 14. テスト戦略

- Unit
  - protocol schema validation
  - router / policy 判定
- Integration
  - Executor Adapter（モック or 実動）
  - Verify コマンド runner
- E2E
  - UI から Run を起動して完了まで観測
- Regression
  - 既知タスクの再実行で同一結果を確認（ログ比較）

---

## 15. ロギング / 監査 / 再現性

- すべての Run を `runs/<run_id>/` に保存
  - `state.json`（逐次）
  - `workorders/`, `workreports/`
  - `commands.log`
  - `diff/`（パッチ）
  - `screenshots/`
- UI と API は同じ Run データソースを参照する（単一の真実）。

---

## 16. セキュリティ / 安全設計（必須）

- Shell は allowlist + 引数検査
- ファイル書き込みは `write_roots` で制限
- ネットワークポリシー（deny/allow）を設定可能にし、デフォルト deny
- 危険操作（rm -rf 等）は常に manual approval
- copilot-api は過度な自動化を避けるレート制限を強制（運用上の安全策）

---

## 17. 未決事項（Open Questions）

- Supervisor 実装言語を TypeScript（LangGraph.js を採用）とするか、Python（LangGraph Python + FastAPI）とするか
  - 互換性・成熟度・チーム得意領域で決める
- GUI 操作の対象 OS（macOS / Windows / Linux）の優先順位
- 既存の UI Automation 連携方式（座標クリック中心 vs アクセシビリティAPI）をどこまでやるか
- repo/workspace のサンドボックス方針（コンテナ化するか）

---

## 18. 次のアクション（最優先）

1) `packages/protocol/` に WorkOrder/WorkReport v1 の JSON Schema を作成  
2) Supervisor MVP の縦切り（Codex のみ）で「検証が通るまでループ」を成立させる  
3) その後に Claude / Copilot / UI / Tauri を段階追加する

