# orchestration

<!-- full-readme: README.md · https://github.com/lfld287/orchestration/blob/main/README.md -->

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a>
</p>

> これは英語版 README の一部を翻訳したものです（機械翻訳のため、誤りのご指摘を歓迎します）。概要、機能、インストール、クイックスタート、`/agents` コマンド、コマンドラインの例のみを収録しています。UI、カスタムエージェント、ツールのパラメーター、設定とデフォルト値、イベント、RPC などその他の内容は英語版でのみ提供しています。全文は [英語版 README（完全版）](README.md) を参照してください。
>
> *Partial translation of the English README. Full reference: [README.md](README.md) · https://github.com/lfld287/orchestration/blob/main/README.md*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/lfld287/orchestration/raw/main/media/logo-dark.svg">
    <img src="https://github.com/lfld287/orchestration/raw/main/media/logo-light.svg" alt="orchestration" width="520">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/lfld287/orchestration/actions/workflows/ci.yml"><img src="https://github.com/lfld287/orchestration/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/lfld287/orchestration/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lfld287/orchestration" alt="ライセンス: MIT"></a>
</p>
<p align="center">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%E2%89%A5%201.1.0-6f42c1" alt="pi >= 1.1.0 が必要"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-style%20subagents-d97757" alt="pi のための Claude Code スタイルのサブエージェント。">
  <a href="https://github.com/lfld287/orchestration/commits/main"><img src="https://img.shields.io/github/last-commit/lfld287/orchestration/main" alt="最終コミット"></a>
</p>

<h3 align="center">pi のための Claude Code スタイルのサブエージェント。</h3>

<p align="center">
  <a href="#インストール"><b>インストール</b></a> ·
  <a href="#クイックスタート"><b>クイックスタート</b></a> ·
  <a href="README.md#ui"><b>UI (EN)</b></a> ·
  <a href="README.md#custom-agents"><b>カスタムエージェント (EN)</b></a> ·
  <a href="README.md#tools"><b>ツール (EN)</b></a> ·
  <a href="README.md#persistent-settings"><b>設定 (EN)</b></a> ·
  <a href="https://github.com/lfld287/orchestration/blob/main/CHANGELOG.md"><b>変更履歴 (EN)</b></a>
</p>

<p align="center"><code>pi install git:github.com/lfld287/orchestration</code></p>

[pi](https://pi.dev) に **Claude Code スタイルのサブエージェント**を追加する拡張機能です。`.pi/agents/<name>.md` にロールを定義してから、`Agent` で起動します（[クイックスタート](#クイックスタート)を参照）。同梱ロールはありません。各エージェントは独自のツール、システムプロンプト、モデル、思考レベルを持ち、別々のバックグラウンドセッションで動きます。実行中に指示を送って軌道修正したり、完了後にセッションを再開したりできます。

<img width="600" alt="orchestration のスクリーンショット" src="https://github.com/lfld287/orchestration/raw/main/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## 機能

- **Claude Code と同じ見た目と操作感**：ツール名、呼び出し規約、UI パターン（`Agent`、`get_subagent_result`、`steer_subagent`）が同じで、ネイティブ機能のように感じられます
- **並列バックグラウンドエージェント**：複数のエージェントを同時に実行でき、自動でキューイングされます（同時実行数の上限は設定可能、デフォルトは 10）。完了通知は親エージェントの次のターンの切れ目で届き、同時に完了した場合はまとめて届きます
- **ライブウィジェット UI**：エディターの上に常駐するウィジェットで、アニメーションするスピナー、ツールの動作状況のリアルタイム表示、トークン数、色付きのステータスアイコンを表示します。`/agents → Settings → Widget` で設定できます：`all`（デフォルト、すべて表示）または `off`（非表示）
- **FleetView**：エディターの下に表示される、Claude Code スタイルの操作可能なリストで、`main` と実行中のすべてのサブエージェントが並びます（起動が早い順）。空のプロンプトで `↓`（または `←`）を押すとリストにフォーカスが移り、`↑`/`↓` で選択を移動、`Enter` で選択したエージェントの会話を開き（リアルタイムで自動更新されます）、`Esc` で戻ります。完了したエージェントは少しの間残ってから消えます。ビューアーは完了後も開いたままなので、最終出力を読めます。`/agents → Settings → Fleet view` で切り替えます
- **会話ビューアー**：`/agents` で任意のエージェントを選ぶと、その会話全体をリアルタイムでスクロール表示するオーバーレイが開きます（新しい内容に自動で追従し、上にスクロールすると一時停止）。pi のフルスクリーンモードでは、枠なしで端末全体を使う、マウス対応の観察画面になります。`Enter` で入力欄を開き、入力して `Enter` で送信すると、実行中のエージェントをその場でステアリングできます（`Esc` または空のまま送信で戻ります）。メッセージはユーザーメッセージとして表示され、エージェントは現在のツール呼び出しを終えた後、その指示に沿って方向を変えます。まだ実行中のエージェントは `x` を押す（確認のためもう一度 `x`）と停止できます。ツール呼び出しは、エージェントのセッションに登録されたレンダラーを通じて、pi 自身のトランスクリプトと同じように表示されます：bash 呼び出しはコマンドと出力、`read` は行番号、`edit` は差分、拡張機能のツールは独自のレンダラーで表示され、レンダラーのないツールは引数と長さ制限付きの出力プレビューにフォールバックします。`ctrl+o`（または `app.tools.expand` に割り当てたキー）で省略されたツール出力を展開します。アシスタントのテキストは Markdown として描画され、`m` で「オフ」「アシスタントのみ」「すべて」の 3 つを切り替えます（[Viewer markdown](README.md#persistent-settings) を参照）
- **カスタムエージェントタイプ**：`.pi/agents/<name>.md` または `.agents/agents/<name>.md`（プロジェクト）、あるいはグローバルにエージェントを定義します。YAML frontmatter で、システムプロンプト、モデル選択、思考レベル、ツール制限、Claude Code 互換の色付き名前バッジを指定できます
- **パッケージ同梱のエージェント**：pi パッケージは `package.json` に `"pi": { "subagents": { "agents": ["./agents"] } }` と書くことで、独自の `.md` エージェントを宣言できます。`pi install` だけでセットアップが完了し、マシンごとやコンテナ起動のたびに `.pi/agents/` へファイルをコピーする必要はありません。読み込むのは pi が実際にインストールしたパッケージだけで（`node_modules` は決して読みません）、パッケージの定義はユーザーが定義したどのエージェントよりも優先度が低く、`/agents` では読み取り専用で表示され、Eject と Disable が使えます。`packageAgents` で対象を絞り込んだり、無効にしたりできます。**[詳細ガイド](https://github.com/lfld287/orchestration/blob/main/docs/packages.md)**
- **エージェントメンション**：サブエージェントはファーストクラスの存在です。プロンプトで `@reviewer also check the RPC path` と入力すると、その内容はメインモデルではなくそのエージェントに届き、メインの会話には一切残りません。1 つの構文でライフサイクル全体を扱えます：実行中のエージェントにメッセージを送る、完了したエージェントを再開する、ずっと後になってからディスク上のセッションを開き直す、一度も実行されていなければ起動する。実行中でないエージェントをメンションすると、画面外で複製した会話を通じて起動されるため、Claude Code と同じように文脈を踏まえて書かれたプロンプトと本物の `Agent` ツール呼び出しが得られ、やはりメインの会話には一切残りません。`direct` モードでは、モデルを一切呼ばずに、入力したテキストからその場で起動します。オーケストレーターがエージェントに `name` を付ければ `@auth-audit` のように呼びかけられ、その名前は `steer_subagent`/`get_subagent_result` でも使えます。`@` を入力すると、pi のファイル補完に加えて、実行中のエージェント、再開可能なエージェント、起動可能なタイプが補完候補に表示されます。`@main` を付けると、テキストを強制的にメインモデルへ戻します。`/agents → Settings → Agent mentions` で切り替えます
- **実行中のステアリング**：実行中のエージェントにメッセージを差し込み、再起動せずに作業の方向を変えます
- **セッションの再開**：会話のコンテキストを保ったまま、エージェントが止まったところから続けます。受理時には同じエージェント ID が返り、完了時には新規起動と同じように通知します
- **穏やかなターン制限**：エージェントは強制中断の前に「まとめに入る」よう警告を受けるため、途中で切れた出力ではなく、きれいな部分結果を返します
- **大文字小文字を区別しないエージェントタイプ**：タイプが有効なロール 1 つに定まらない場合（不明、無効、または大文字小文字の違いで曖昧）、`fallbackSubagent` を明示的に設定しない限り拒否します
- **あいまいなモデル指定**：完全な ID の代わりに名前（`"haiku"`、`"sonnet"`）でモデルを指定でき、利用可能・設定済みのモデルだけに自動で絞り込まれます
- **コンテキストの継承**：必要に応じて親の会話をサブエージェントにフォークし、それまでの議論を把握させます
- **永続的なエージェントメモリ**：3 つのスコープ（project、local、user）があり、書き込みツールを持たないエージェントでは自動的に読み取り専用にフォールバックします
- **Git worktree による分離**：分離されたリポジトリのコピーでエージェントを実行します。完了時に変更はブランチへ自動コミットされます
- **スキルのプリロード**：名前を指定したスキルをエージェントのシステムプロンプトに注入します。スキルは `.pi/skills/`、`.agents/skills/` とグローバルな場所から検出されます（pi 標準の `<name>/SKILL.md` ディレクトリ構成に対応）
- **ツールの拒否リスト**：`disallowed_tools` frontmatter で特定のツールをブロックします
- **スタイル付きの完了通知**：バックグラウンドエージェントの結果は、生の XML ではなく、テーマに沿ったコンパクトな通知ボックス（アイコン、統計、結果のプレビュー）として描画されます。展開すると完全な出力を表示します。まとめて完了した場合も、エージェントごとに個別に描画されます
- **イベントバス**：ライフサイクルイベント（`subagents:created`、`started`、`completed`、`failed`、`steered`、`compacted`）とメッセージごとの消費記録（`subagents:usage`）を `pi.events` 経由で発行し、他の拡張機能がサブエージェントの動きに反応できるようにします
- **拡張機能間 RPC**：他の pi 拡張機能は `pi.events` (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`, `subagents:rpc:steer`, `subagents:rpc:get`, `subagents:rpc:list`) 経由で、サブエージェントを起動、停止、ステアリングし、状態を確認できます。RPC v3 は標準化された応答エンベロープと機能検出を備えています。セッション開始時に `subagents:ready` を発行します。 **[詳細リファレンス](https://github.com/lfld287/orchestration/blob/main/docs/rpc.md)**
- **サブエージェントのスケジュール実行**：`Agent` ツールに `schedule` を渡すと、cron、一定間隔、または 1 回限りで起動します。ジョブはセッション単位で、PID ロック付きで永続化されます。結果は手動で起動したバックグラウンドエージェントと同じ完了通知として届きます。`/agents → Scheduled jobs` で管理します
- **モデル範囲の強制**：明示的に有効化して使う検証機能で、サブエージェントが選ぶモデルが pi の `enabledModels` 許可リストの範囲内に収まるようにします（`/scoped-models` から取得し、グローバルとプロジェクトローカルの pi 設定の両方を反映）。呼び出し側が範囲外のモデルを指定した場合はオーケストレーターにハードエラーを返し、frontmatter で範囲外のモデルが固定されている場合は警告を出したうえでそのまま実行します（frontmatter を優先）。`/agents → Settings → Scope models` で切り替えます

## インストール

```bash
pi install git:github.com/lfld287/orchestration
```

開発時には直接読み込むこともできます：

```bash
pi -e ./src/index.ts
```

pi **1.1.0 以降**が必要です。pi 0.86 と 0.87 でシステムプロンプトと会話履歴がセッションのトランスクリプトに移り、`@handle` による会話の複製とエージェントのトランスクリプトファイルはその仕組みの上に作られています。`peerDependencies` の範囲でこれを宣言しているため、古い pi ではインストール時に npm が警告します。

### その他のホスト

この拡張機能は [pi](https://pi.dev) を対象に開発・テストされています。

サードパーティのアダプターで他の環境でも動くという報告があります。これらは本プロジェクトとは独立して保守されています。本プロジェクトではテストしておらず、CI の対象外で、どのリリースでも互換性が壊れる可能性があります。

- **DeepSeek Harness (`dsh`)**：pi のホスト API をネイティブの DSH エージェントに対応付けるアダプター経由。詳細と報告：[#258](https://github.com/tintinweb/pi-subagents/issues/258)

## クイックスタート

プロジェクトに `.pi/agents/reviewer.md` を作成します。必要ならディレクトリも作成してください。

```markdown
---
description: Read-only code reviewer
tools: read, grep, find, ls
extensions: false
---

Review code without making changes. Cite file paths and explain each finding.
```

そのプロジェクトで pi を起動します。メインエージェントに `reviewer` の実行を頼むか、TUI で `@reviewer Find all files that handle authentication` と入力します。メインエージェントは `Agent` ツールでロールを起動できます。

```typescript
Agent({
  subagent_type: "reviewer",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})
```

`Agent` は、起動待ちや起動処理中でも、受理した時点でエージェント ID を返します。そのまま別の作業を続けられます。完了通知には結果のプレビューが含まれます。全文を取得するには `get_subagent_result` を使います。このツールは完了を待たず現在の状態を返します。

### スケジュール

`schedule` フィールドを追加すると、すぐに実行せず、後で起動するジョブを登録します。返るのはエージェント ID ではなくジョブ ID です。

```typescript
Agent({
  subagent_type: "reviewer",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

スケジュールの形式：

- **Cron**：6 フィールド（`second minute hour day-of-month month day-of-week`）。例：`"0 0 9 * * 1"` は毎週月曜の午前 9 時、`"0 */15 * * * *"` は 15 分ごと。
- **間隔**：`"5m"`、`"1h"`、`"30s"`、`"2d"`。その間隔で繰り返し起動します。
- **1 回限り（相対時刻）**：`"+10m"`、`"+2h"`、`"+1d"`。その時間が経過した時点で 1 回起動します。
- **1 回限り（絶対時刻）**：完全な ISO タイムスタンプ。例：`"2026-12-25T09:00:00.000Z"`。

スケジュールの時刻になると、エージェントはバックグラウンドで実行され、その完了通知は手動で起動したバックグラウンドエージェントと同じように届きます。親エージェントも同じように結果を踏まえて判断します。

スケジュールは**セッション単位**です：`/new` でリセットされ、`/resume` で復元されます。一覧表示とキャンセルは `/agents → Scheduled jobs` で行います（作成は `Agent` ツールの役割で、手動で作成するウィザードは別途ありません）。保存先は `<cwd>/.pi/subagent-schedules/<sessionId>.json` で、複数インスタンス間で安全に動作するよう PID ベースのファイルロックを使います。

**機能を完全に無効にする**：`/agents → Settings → Scheduling → disabled` で、`Agent` ツールの定義から `schedule` が削除され（LLM のコンテキストを消費しません）、メニュー項目が非表示になり、動作中のスケジューラーが停止します。定義からの削除は次の pi セッションから有効になり、実行時の停止はすぐに有効になります。同じメニューから再度有効にできます。

制限：
- `schedule` は `inherit_context`（起動時点では親の会話が存在しないため）や `resume`（スケジュールは常に新しいエージェントを作るため）と組み合わせられません。
- スケジュールによる起動は `maxConcurrent` のキューを迂回するため、5 分間隔のジョブが長時間実行中の手動エージェントの後ろで待たされることはありません。
- **ヘッドレスの `pi -p` は、スケジュールされたサブエージェントを待ちません。**

## コマンド

| コマンド | 説明 |
|---------|-------------|
| `/agents` | 対話型のエージェント管理メニュー：エージェントタイプ、実行中のエージェント、スケジュールされたジョブ、設定 |

### コマンドライン

ヘッドレスで起動するには、設定済みのロールを名前で指定します。

```bash
pi -p "Use the reviewer agent to find files that handle authentication"
```

ツールが返すのは完了結果ではなく、受理の通知です。`pi -p` がバックグラウンドの出力を待つとは限りません。完了通知を受け取るには対話セッションを使うか、拡張機能のホストを終了せずに[終端イベント](README.md#events)を監視してください。

## 詳細情報（英語）

この翻訳は README の一部のみを対象としています。ここに含まれていない内容については、[英語版 README（完全版）](README.md) を参照してください。

- [UI](README.md#ui)：FleetView、フルスクリーンの会話ビューアー、エージェントメンション
- [カスタムエージェント](README.md#custom-agents)：frontmatter のフィールド、ツールと拡張機能の範囲
- [ツール](README.md#tools)：`Agent`、`get_subagent_result`、`steer_subagent` のパラメーター表
- [永続設定](README.md#persistent-settings)：すべての設定とデフォルト値
- [イベント](README.md#events)と[拡張機能間 RPC](README.md#cross-extension-rpc)
- [RPC ガイド](docs/rpc.md)、[パッケージ同梱エージェント](docs/packages.md)
- [変更履歴](CHANGELOG.md)

## ライセンス

MIT — [tintinweb](https://github.com/tintinweb)

Full README (English): [README.md](README.md) · https://github.com/lfld287/orchestration/blob/main/README.md

<!-- Sync pending: the English README changes are not yet committed. -->
<!-- source: README.md @ 26639d7 -->
