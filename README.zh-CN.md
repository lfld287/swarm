# swarm

<!-- full-readme: README.md · https://github.com/lfld287/swarm/blob/main/README.md -->

<p align="center">
  <a href="README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

> 本文是英文 README 的部分翻译（机器翻译，欢迎指正），仅包含简介、功能、安装、快速开始、`/agents` 命令和命令行示例。UI、自定义代理、工具参数、设置与默认值、事件、RPC 等其余内容仅提供英文版：[完整英文 README](README.md)。
>
> *Partial translation of the English README. Full reference: [README.md](README.md) · https://github.com/lfld287/swarm/blob/main/README.md*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/lfld287/swarm/raw/main/media/logo-dark.svg">
    <img src="https://github.com/lfld287/swarm/raw/main/media/logo-light.svg" alt="swarm" width="312">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/lfld287/swarm/actions/workflows/ci.yml"><img src="https://github.com/lfld287/swarm/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/lfld287/swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lfld287/swarm" alt="许可证：MIT"></a>
</p>
<p align="center">
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%E2%89%A5%201.1.0-6f42c1" alt="需要 pi >= 1.1.0"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-style%20subagents-d97757" alt="为 pi 提供 Claude Code 风格的子代理。">
  <a href="https://github.com/lfld287/swarm/commits/main"><img src="https://img.shields.io/github/last-commit/lfld287/swarm/main" alt="最近提交"></a>
</p>

<h3 align="center">为 pi 提供 Claude Code 风格的子代理。</h3>

<p align="center">
  <a href="#安装"><b>安装</b></a> ·
  <a href="#快速开始"><b>快速开始</b></a> ·
  <a href="README.md#ui"><b>UI (EN)</b></a> ·
  <a href="README.md#custom-agents"><b>自定义代理 (EN)</b></a> ·
  <a href="README.md#tools"><b>工具 (EN)</b></a> ·
  <a href="README.md#persistent-settings"><b>设置 (EN)</b></a> ·
  <a href="https://github.com/lfld287/swarm/blob/main/CHANGELOG.md"><b>更新日志 (EN)</b></a>
</p>

<p align="center"><code>pi install git:github.com/lfld287/swarm</code></p>
这是一个为 [pi](https://pi.dev) 提供 **Claude Code 风格子代理**的扩展。先在 `.pi/agents/<name>.md` 定义角色，再用 `Agent` 启动（见[快速开始](#快速开始)）。扩展不附带任何角色。每个代理都在独立的后台会话中运行，有自己的工具、系统提示词、模型和思考级别。你可以在运行中引导代理，也可以在完成后恢复会话。

<img width="600" alt="swarm 截图" src="https://github.com/lfld287/swarm/raw/main/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## 功能

- **与 Claude Code 一致的外观与体验**：相同的工具名、调用约定和 UI 模式（`Agent`、`get_subagent_result`、`steer_subagent`），用起来就像原生功能
- **并行后台代理**：启动多个并发运行的代理，自动排队（并发上限可配置，默认 10）。完成通知会在父代理的下一个边界送达；多个代理同时完成时，通知会一起送达
- **实时小组件 UI**：编辑器上方常驻的小组件，带动画加载指示、实时工具活动、token 计数和彩色状态图标。通过 `/agents → Settings → Widget` 配置：`all`（默认，显示所有代理）或 `off`（关闭）
- **FleetView**：在编辑器下方显示的 Claude Code 风格的可导航列表，包含 `main` 和所有正在运行的子代理（最早启动的排在最前）。在空提示符下按 `↓`（或 `←`）进入，`↑`/`↓` 移动选择，`Enter` 打开所选代理的实时自动更新对话，`Esc` 返回。已完成的代理会短暂保留后再移出列表；查看器在代理完成后仍保持打开，方便你阅读最终输出。通过 `/agents → Settings → Fleet view` 开关
- **对话查看器**：在 `/agents` 中选择任意代理，即可打开实时滚动的浮层，显示其完整对话（自动跟随新内容，向上滚动即暂停）。在 pi 的全屏模式下，它是一个无边框、占满整个终端、支持鼠标的查看器。按 `Enter` 打开输入框，输入内容后再按 `Enter` 发送，即可内联引导正在运行的代理（`Esc` 或提交空内容则返回）。这条消息会作为用户消息显示，并在代理当前的工具调用结束后调整其工作方向。按 `x`（再按一次 `x` 确认）可停止仍在运行的代理。工具调用的显示方式与 pi 自身的对话记录一致，使用代理会话中注册的渲染器：bash 调用显示命令和输出，`read` 显示行号，`edit` 显示 diff，扩展工具使用自己的渲染器，没有渲染器的工具则回退为显示参数和截断后的输出预览。`ctrl+o`（或 `app.tools.expand` 绑定的任意按键）可展开被折叠的工具输出。助手文本以 Markdown 渲染；按 `m` 可在关闭、仅助手、全部三种模式之间循环切换（参见 [Viewer markdown](README.md#persistent-settings)）
- **自定义代理类型**：在 `.pi/agents/<name>.md` 或 `.agents/agents/<name>.md`（项目级）或全局位置定义代理，使用 YAML frontmatter：自定义系统提示词、模型选择、思考级别、工具限制，以及兼容 Claude Code 的彩色名称徽标
- **随包分发的代理**：pi 包可以在其 `package.json` 中用 `"pi": { "subagents": { "agents": ["./agents"] } }` 声明自己的 `.md` 代理，这样只需 `pi install` 即可完成全部配置：无需在每台机器或每次容器启动时把文件复制到 `.pi/agents/`。只读取 pi 实际安装的包（绝不读取 `node_modules`），包中定义的代理优先级低于你自己编写的所有代理，`/agents` 以只读方式显示它们，并提供 Eject 和 Disable。用 `packageAgents` 缩小范围或关闭此功能。**[完整指南](https://github.com/lfld287/swarm/blob/main/docs/packages.md)**
- **运行中引导**：向正在运行的代理注入消息，无需重启即可改变其工作方向
- **会话恢复**：从代理停下的地方继续，保留对话上下文。受理时返回同一个代理 ID，完成时与新启动的代理一样发送通知
- **轮次上限时优雅收尾**：代理在被强制中止前会收到“收尾”警告，从而产出干净、可用的部分结果，而不是被截断的输出
- **代理类型不区分大小写**：类型无法解析为唯一的已启用角色（未知、已禁用或大小写有歧义）时，默认拒绝，除非你显式设置 `fallbackSubagent`
- **模糊模型选择**：按名称（`"haiku"`、`"sonnet"`）而非完整 ID 指定模型，并自动筛选出可用/已配置的模型
- **上下文继承**：可选择把父对话分叉给子代理，让它了解之前讨论过的内容
- **持久化代理记忆**：三种作用域（project、local、user），对没有写入工具的代理自动回退为只读
- **Git worktree 隔离**：在隔离的仓库副本中运行代理；完成时变更会自动提交到分支
- **技能预加载**：把指定的技能注入代理的系统提示词，从 `.pi/skills/`、`.agents/skills/` 和全局位置查找技能（支持 pi 标准的 `<name>/SKILL.md` 目录布局）
- **工具黑名单**：通过 `disallowed_tools` frontmatter 屏蔽特定工具
- **带样式的完成通知**：后台代理的结果渲染为带主题的紧凑通知框（图标、统计、结果预览），而不是原始 XML。可展开显示完整输出。成组完成时，每个代理分别渲染
- **事件总线**：通过 `pi.events` 发出生命周期事件（`subagents:created`、`started`、`completed`、`failed`、`steered`、`compacted`）和逐条消息的开销明细（`subagents:usage`），让其他扩展能够响应子代理的活动
- **跨扩展 RPC**：其他 pi 扩展可通过 `pi.events` (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`, `subagents:rpc:steer`, `subagents:rpc:get`, `subagents:rpc:list`) 启动、停止、引导和查询子代理。RPC v3 使用标准化响应和能力探测。会话开始时发出 `subagents:ready`。 **[完整参考](https://github.com/lfld287/swarm/blob/main/docs/rpc.md)**
- **定时子代理**：向 `Agent` 工具传入 `schedule`，按 cron、固定间隔或一次性时间触发。任务作用域为会话，持久化存储使用 PID 锁；结果以与手动启动的后台代理相同的完成通知送达；通过 `/agents → Scheduled jobs` 管理
- **模型范围约束**：需主动开启的校验，确保子代理选用的模型在你的 pi `enabledModels` 允许列表之内（来源为 `/scoped-models`，全局和项目本地的 pi 设置都会生效）。调用方指定了范围外的模型时，直接向编排者返回错误；frontmatter 固定了范围外的模型时，发出警告但照常运行（以 frontmatter 为准）。通过 `/agents → Settings → Scope models` 开关

## 安装

```bash
pi install git:github.com/lfld287/swarm
```

或在开发时直接加载：

```bash
pi -e ./src/index.ts
```

需要 pi **1.1.0 或更高版本**：pi 0.86 和 0.87 把系统提示词和对话历史移入了会话记录（session transcript），代理对话记录文件和已保存会话的恢复都依赖这一机制。`peerDependencies` 范围中声明了这一要求，因此安装时 npm 会对较旧的 pi 发出警告。

### 其他宿主

本扩展针对 [pi](https://pi.dev) 开发和测试。

有第三方报告称，借助适配器可以在其他宿主中运行本扩展。这些适配器独立于本项目维护：未在此测试，不在我们的 CI 覆盖范围内，任何版本都可能破坏兼容性。

- **DeepSeek Harness (`dsh`)**：通过一个把 pi 的宿主 API 映射到原生 DSH 代理的适配器运行。详情和报告：[#258](https://github.com/tintinweb/pi-subagents/issues/258)

## 快速开始

在项目中创建 `.pi/agents/reviewer.md`，必要时先创建目录：

```markdown
---
description: Read-only code reviewer
tools: read, grep, find, ls
extensions: false
---

Review code without making changes. Cite file paths and explain each finding.
```

在该项目中启动 pi。请主代理运行 `reviewer`。主代理可以用 `Agent` 工具启动该角色：

```typescript
Agent({
  subagent_type: "reviewer",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
})
```

`Agent` 在受理时就返回代理 ID，即使代理仍在排队或启动中。继续其他工作即可；完成通知会附带结果预览。使用 `get_subagent_result` 读取全文；它只读取当前状态，不会等待。

### 定时调度

添加 `schedule` 字段会登记稍后触发的任务，而不是立即运行。调用返回任务 ID，而非代理 ID：

```typescript
Agent({
  subagent_type: "reviewer",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

调度格式：

- **Cron**：6 个字段（`second minute hour day-of-month month day-of-week`），例如 `"0 0 9 * * 1"` 表示每周一上午 9 点，`"0 */15 * * * *"` 表示每 15 分钟。
- **间隔**：`"5m"`、`"1h"`、`"30s"`、`"2d"`。按该间隔重复触发。
- **一次性（相对时间）**：`"+10m"`、`"+2h"`、`"+1d"`。在相应的未来时刻触发一次。
- **一次性（绝对时间）**：完整的 ISO 时间戳，例如 `"2026-12-25T09:00:00.000Z"`。

调度触发时，代理在后台运行，其完成通知的送达方式与手动启动的后台代理相同，父代理也会以同样的方式处理结果。

调度**作用域为会话**：执行 `/new` 时重置，执行 `/resume` 时恢复。通过 `/agents → Scheduled jobs` 查看和取消（创建由 `Agent` 工具负责，没有另外的手动创建向导）。存储在 `<cwd>/.pi/subagent-schedules/<sessionId>.json`，使用基于 PID 的文件锁保证多实例安全。

**完全禁用此功能**：`/agents → Settings → Scheduling → disabled` 会从 `Agent` 工具定义中移除 `schedule`（不占用 LLM 上下文），隐藏对应菜单项，并停止所有活动的调度器。工具定义层面的移除在下一个 pi 会话生效；运行时的停止立即生效。可在同一菜单中重新启用。

限制：
- `schedule` 不能与 `inherit_context`（触发时不存在父对话）或 `resume`（调度总是创建新代理）同时使用。
- 定时触发会绕过 `maxConcurrent` 队列，因此 5 分钟间隔的任务不会被长时间运行的手动代理推迟。
- **无头模式（headless）的 `pi -p` 不会等待定时子代理。**

## 命令

| 命令 | 说明 |
|---------|-------------|
| `/agents` | 交互式代理管理菜单：代理类型、正在运行的代理、定时任务、设置 |

### 命令行

在无头模式下，可在提示中按名称指定已配置的角色：

```bash
pi -p "Use the reviewer agent to find files that handle authentication"
```

工具返回的是受理回执，而不是完成结果；`pi -p` 不保证等待后台输出。要接收完成通知，请使用交互式会话；扩展宿主也可以保持运行并监听[终态事件](README.md#events)。

## 更多详情（英文）

本文仅为部分翻译；未涵盖的内容请参阅[完整英文 README](README.md)。

- [UI](README.md#ui)：FleetView、全屏对话查看器
- [自定义代理](README.md#custom-agents)：frontmatter 字段、工具与扩展范围
- [工具](README.md#tools)：`Agent`、`get_subagent_result`、`steer_subagent` 的参数表
- [持久化设置](README.md#persistent-settings)：所有设置项及其默认值
- [事件](README.md#events)与[跨扩展 RPC](README.md#cross-extension-rpc)
- [RPC 指南](docs/rpc.md)、[随包分发的代理](docs/packages.md)
- [更新日志](CHANGELOG.md)

## 许可证

MIT — [tintinweb](https://github.com/tintinweb)

Full README (English): [README.md](README.md) · https://github.com/lfld287/swarm/blob/main/README.md

<!-- Sync pending: the English README changes are not yet committed. -->
<!-- source: README.md @ 26639d7 -->
