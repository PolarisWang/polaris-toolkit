---
name: polaris-toolkit
description: Use when the user asks about the DSH host's V8 heap or memory pressure, wants to slim/repack DSH session files, or wants to see or steer the steward fleet (agents, modules, tasks, capability traces, audit) on a machine where the polaris-toolkit DSH plugin is installed. Covers the 15 agent tools and the HTTP control plane.
---

# Polaris Toolkit

一个 DSH 宿主插件，把 **Heap Guard**（堆观测 / 会话瘦身 / 快照 / bili 预算）和
**Steward 大内总管**（观察 fleet、能力平面判定、编制决策树、交办任务、追查审计）装在一起。

## 什么时候用它

- 用户问宿主的堆为什么涨、会话文件多大、要不要重启/瘦身：`heap_status` / `heap_slim` / `heap_snapshot`。
- 用户要看"我的 agent 们在干嘛"、谁卡住了、有哪些等你拍板：`steward_observe` → `GET /api/state`；
  要细节用 `steward_trace`（某次触发的瀑布）与 `steward_audit`（每条能力意图为什么执行/预演/被拒）。
- 用户要派活：`steward_tasks` op=create（title + brief + acceptance，target 传 `session:<id>` 或留空新开）；
  op=dispatch 现在派发，op=complete|fail|cancel|archive 收尾。
- 用户要和总管说话：`steward_chat`（op=status|bind|unbind|create|send；send 把消息 followup 进总管会话）。
- 用户要改插件配置：`steward_settings`（op=get|set|raw|replace，set 走 schema 校验，非法 patch 会被拒且不落盘）。
- 用户要巡检/体检：`steward_status`（能力数 + 编制 + trace/effect + 待批 + 预算 + 降级）、`GET /api/doctor`。

## 工具（15 个，agent 侧，免令牌）

| 工具 | 关键参数 |
| --- | --- |
| heap_status | 无（摘要文本：堆/系统/磁盘/bili/会话量） |
| heap_slim | `sessionId` 或 `scope:"all"`（受 maxPerClick 限制）、`level` |
| heap_snapshot | `label`（可选） |
| heap_bili | `max` / `residentMaxMB` / `warmMax` / `warmMaxBytesMB` / `gc`，省略即读 |
| steward_observe | 无（每个 agent 的模块/状态/静默/提问/信号/流程/待批） |
| steward_status | 无 |
| steward_begin | `workflow`、`subject`、`text`、`vars` |
| steward_report | `text`、`title`、`level` |
| steward_ask | `title`、`detail`、`subject`、`ttlMs` |
| steward_trace | `limit`、`since`、`id`、`replay:true`、`export` |
| steward_audit | `limit`、`since`、`decision`(allow/preview/deny)、`cap`、`steward` |
| steward_tasks | `op`=create/list/dispatch/complete/fail/cancel/archive、`title`、`brief`、`acceptance`、`target`、`id` |
| steward_stewards | `op`=list/save/delete，`steward`（id/name/host/audience/equips/events/scope/tree） |
| steward_chat | `op`=status/bind/unbind/create/send，`sessionId`、`text` |
| steward_settings | `op`=get/set/raw/replace，`feature`、`patch`、`text`、`doc` |

## HTTP 控制面（`/__polaris`）

- 人类入口：`GET /__polaris/panel`（外壳，含设置全文编辑器）→ 功能面板
  `/__polaris/steward/`、`/__polaris/heap-guard/`。
- 读（匿名）：`/api/state`、`/api/agents`、`/api/tasks`、`/api/chat`、`/api/detail`、`/api/trace`、
  `/api/audit`、`/api/catalog`、`/api/routes`、`/api/stewards`、`/api/doctor`、`/api/journal?since=`、
  `/api/trace/otlp`、`/metrics`。
- 写（要 `x-polaris-token`，面板自动带 cookie）：`/api/action`、`/api/settings`、`/api/settings/raw`、
  `/api/tasks`、`/api/chat`、`/api/answer`、`/api/question/answer`、`/api/modules`、`/api/routes`、
  `/api/stewards`、`/api/tree/validate`、`/api/rules/reload`、`/api/classify`、`/api/pin`。
- 拿令牌：面板页脚"复制令牌"，或 `node bin/polaris.mjs token`（读 `~/.dsh/polaris-toolkit/secret`）。

## 关键配置（`~/.dsh/polaris-toolkit/settings.json`，版本信封 `{v:1,d:{...}}`）

`steward` 段：`actLevel`（L1 只通知 / L2 只读动作 / L3 写入）、`actMode`（echo 预演 / live 真执行）、
`budgetPerHour`（只计真动作，见 `store.chargeOf`）、`tasks{concurrency,autoDispatch,maxAttempts,retainDays}`、
`escalation{enabled,cooldownSec,maxAttempts}`、`notify{minSeverity,larkEnabled,larkCommand,larkDocEnabled}`、
`session{id,preset,title,mode}`、`classifier.*`、`export.*`、`plane{instances,stewards,routes}`。
`heap-guard` 段：`autoSlim`、`slimLevel`、`maxPerClick`。

## 已知限制（动它之前先看一眼）

- **GET 读接口是匿名的**：本机任意进程都能读到会话正文（`/api/chat`、`/api/detail`）。这是刻意取舍。
- **改 host 代码要重启宿主**；面板会用"磁盘比进程新"的横幅提示，`doctor` 也有 install-drift 检查。
- `summarize.llm` 能力依赖宿主已有可用模型路由；没有就回 `no-model-route`。
- 联邦 receive 走本地令牌，只适合本机/受信转发；跨机部署需要自己解决对端凭据。
- 详情见 [docs/known-limits.md](../docs/known-limits.md)。
