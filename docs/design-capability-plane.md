# 能力平面设计（v2）

> 状态：设计稿 · v2 · 2026-10-18
> 取代 v1（v1 的「六角色 + 能力/装备/窗口三层解析 + 只能收紧」模型已被否掉，见文末"已确认的决定"）。
> 本文是实现依据；代码尚未按此改造。

---

## 0. 一页结论

- **能力是抽象，不是名单。** 一个能力 = 载荷(payload) × 载体(carrier) × 对象(target) × 协议(protocol) 的一个组合 + 参数 schema + 权限 + 预演模板 + 执行器。
  你说的 notify 只是 `notice × (desktop|lark.im) × owner × fire` 这一个组合。
- **主管不是类型，是数据。** 代码里没有"守望者""记录员"这类角色。主管是一条编制记录：订阅什么、装备了哪些能力实例、自己的决策树、路由矩阵、发声会话。**装了什么能力，就有什么职责。**
- **决策只有一处。** 运行时只读主管自己的显式决策树；能力只提供"可插入的树片段模板"（presets），插进树之后就属于树，运行时不回看能力默认值。没有覆盖层、没有收紧/放宽方向。
- **可配置的路由。** 谁是接收者(voice/inbox)、能不能发给某类对象(routes)、用哪个账号写到哪个文档(实例参数) —— 四层分开，各自回答一个明确问题。
- **可观测是基础设施，不是能力。** trace/span/effect 由框架强制记录（不可绕过），主管只能通过 `query.*` 能力去读它。
- **追查的目标是"不用翻日志"。** 每个结论可点开因果链；常见故障由体检页直接归因；任何一条 trace 可重放（what-if）。

---

## 1. 能力抽象

### 1.1 为什么是这四要素

| 备选抽象 | 问题 |
|---|---|
| 动词制（notify/record/steer...） | 颗粒度不可复用，加一个通道要改一批动词 |
| 管道制（source→transform→sink） | 表达力强但配置复杂，与决策树边界模糊 |
| **四要素组合制（采用）** | 抽象稳定、载体重用率高、实例多数零代码 |
| REST 制（resource×operation） | 与四要素等价，作为"能力仓 UI 的分组方式"采用 |

核心收益：**载体写一次，多载荷复用**。写好 lark.im 这一个 adapter，notice/report/record/ask 四种载荷都能走飞书。

### 1.2 四要素取值表

| 轴 | 取值 | 含义 |
|---|---|---|
| 载荷 payload | notice 通知 · report 汇报 · record 留档 · directive 指令 · answer 答复 · query 取数 · data 操作参数 | 内容语义与形状，决定参数 schema 与模板变量 |
| 载体 carrier | desktop · lark.im · lark.doc · session · task · tool · peer · llm · file | 物理实现，一载体一 adapter |
| 对象 target | owner · steward:<id> · session:<id> · module:<id> · task:<id> · host · workspace:<p> · doc:<id> · peer:<host> | 逻辑接收者，由路由矩阵解析为具体地址 |
| 协议 protocol | fire 发完就算 · ack 等确认 · ask 等主人答复 · stream 取一段 | 是否阻塞、是否进 dlq、是否要审批 |

补充说明：
- **定时不是载荷**。"每 30 分钟"属于决策树的 `when`（或 `wait`），不是能力。
- **读取是能力**（query 载荷），不做成树的内置函数 —— 这样权限、预算、审计对读操作一致。
- **意图(Intent)不是能力**，它是编排器内部的裁决对象。

### 1.3 载体重用矩阵

~~~text
         notice  report  record  directive  answer  query  data
desktop    ●       ●       ○        ○         ○       ○      ○
lark.im    ●       ●       ○        ○         ●       ○      ○
lark.doc   ○       ○       ●        ○         ○       ○      ○
session    ○       ○       ○        ●         ●       ●      ○
task       ○       ○       ○        ●         ○       ○      ●
tool       ○       ○       ○        ○         ○       ●      ●
peer       ○       ●       ○        ○         ○       ○      ●
llm        ○       ●       ○        ○         ○       ○      ●
file       ●       ●       ●        ○         ○       ●      ○

● 已预设   ○ 组合可用，需要时开
~~~

### 1.4 预设能力实例（首批发这些）

| 实例 | 载荷 | 载体 | 对象 | 协议 | 说明 | 代码量 |
|---|---|---|---|---|---|---|
| notify.desktop | notice | desktop | owner | fire | 桌面通知 | 复用 |
| notify.lark | notice | lark.im | owner/steward | fire | 飞书发消息 | 复用 feishu |
| report.steward | report | steward.inbox | steward:<id> | ack | 主管给主管发消息 | 新，小 |
| record.larkdoc | record | lark.doc | doc:<id> | ack | 往飞书文档追加 | 新 adapter |
| record.file | record | file | workspace:<p> | ack | 本地留档 | 新，小 |
| steer.session | directive | session | session:<id> | fire | 打断当前思考 | 复用 prompter |
| followup.session | directive | session | session:<id> | ack | 下一轮投递 | 复用 prompter |
| ask.owner | directive | lark.im/desktop | owner | ask | 问主人并等答复 | 复用 wf.ask |
| answer.question | answer | session | session:<id> | ack | 代答 agent 提问 | 复用 answerer |
| task.create | directive | task | session:<id> | ack | 交办落单 | 复用 tasks |
| task.control | data | task | task:<id> | ack | 派发/完成/取消 | 复用 tasks |
| host.slim | data | tool | host | fire | 瘦身 | 复用 heap-guard |
| host.snapshot | data | tool | host | ack | 堆快照 | 复用 heap-guard |
| rules.reload | data | tool | engine | ack | 重载规则 | 复用 |
| query.host | query | tool | host | ack | 读指标 | 复用 |
| query.sessionlog | query | session | session:<id> | stream | 读会话事件 | 复用 sessionQuery |
| peer.send | data | peer | peer:<host> | ack | 联邦转发 | 复用壳 |
| query.trace | query | tool | trace-store | ack | **主管主动查 trace**（观测用） | 新，小 |
| query.journal | query | tool | store | ack | 主管主动查日志 | 新，小 |
| derive.summary | data | llm | text | ack | 会话摘要 | 可选，复用 classifier |

扩展成本：加**载体**→写一个 adapter（一次性）；加**实例**→选组合填参数（多数零代码）。

---

## 2. 主管编制（无角色类型）

~~~json
{
  "id": "s-1",
  "title": "堆守望",
  "enabled": true,
  "voice": { "mode": "session", "sessionId": "session-xxxx" },
  "intake": [
    { "topic": "host/tick", "admission": "every" },
    { "topic": "agent/*", "admission": "threshold", "minSeverity": "warning", "ratePerMin": 30 },
    { "topic": "steward/inbox", "admission": "all" }
  ],
  "equips": [
    { "id": "e1", "cap": "query.host", "grant": "act", "params": {} },
    { "id": "e2", "cap": "notify.lark", "grant": "act",
      "params": { "to": "owner", "level": "critical", "account": "default" } },
    { "id": "e3", "cap": "host.slim", "grant": "dry-run", "params": { "level": 3 } }
  ],
  "tree": { "...": "见第 3 节" },
  "routes": { "owner": "allow", "steward:*": "approval", "session:*": "deny" },
  "limits": { "budgetPerHour": 30, "maxIntentsPerTick": 3, "cooldownSec": 60 }
}
~~~

- 没有 `role` 字段。**装备集合即职责。**
- `grant` 单层：denied / dry-run / act / autonomous（映射到现有 actLevel L1-L3），一处声明，没有覆盖链。
- 参数默认值随实例走，主管可改；保存树时按参数 schema 校验。

### 示例编制（只是例子，可删可改，不是内置类型）

| 编制 | 装备 | 树大意 |
|---|---|---|
| 堆守望 | query.host + notify.lark + host.slim | 堆 >92% → 通知并瘦身 |
| 会话巡查 | query.sessionlog + steer.session + notify.desktop | 静默 → 查日志 → 催或报 |
| 文档记录 | query.sessionlog + derive.summary + record.larkdoc | 定时把摘要写进文档 |
| 汇报中继 | report.steward 收 + record.file | 收集各总管汇报并留档 |

---

## 3. 决策树（唯一决策源）

### 3.1 节点

| 节点 | 语义 |
|---|---|
| when | 事件类型匹配（通常是根） |
| if / all / any / not | 事实表达式（复用现有 15 个算子） |
| choose | 首个命中分支，带 fallback（同一 subject 只走一条） |
| seq | 顺序执行，可引用上一步结果（step0.ok / step0.data） |
| par | 并行提议，交编排器裁决冲突 |
| call | 调用已装备能力实例 + 参数（可含模板变量） |
| wait | 等 N 秒或等条件，必须带 timeout |
| set | 写树内变量 |
| noop | 显式什么都不做 |

### 3.2 事实与模板变量

- 事实来源：宿主指标、会话事件、主管信箱、能力回写（`queries` step 的结果）。
- 模板：`{heapPct}`、`{session.title}`、`{step0.data.count}`、`{steward.id}`。
- 事实一律带 **采集时间**，树求值时用同一快照，避免"边看边变"。

### 3.3 校验（保存时）

1. `call` 引用的 equip id 必须存在；
2. 每个 `choose` 必须有 fallback；
3. `wait` 必须有 timeout；
4. 参数符合实例 schema；
5. 无任意 JS、无网络访问、无未声明事实（未声明只警告，不拒绝）。

### 3.4 能力片段 presets（不参与运行时）

能力实例带 `presets: [{title, node}]`，例如 notify.lark 带"堆>92% 时通知"的 if+call 片段。面板一键插入，**插进去就是树的内容**；运行时不回看能力默认值。

### 3.5 示例树（会话巡查）

~~~json
{ "type": "when", "event": "agent/stalled",
  "child": { "type": "seq", "steps": [
    { "type": "call", "equip": "e1", "save": "log" },
    { "type": "choose", "branches": [
      { "if": { "gte": ["log.lastGoalAgeMin", 30] },
        "child": { "type": "seq", "steps": [
          { "type": "call", "equip": "e2", "params": { "mode": "steer",
              "text": "一句话说明你卡在哪；完成就直接收尾" } },
          { "type": "wait", "sec": 120, "timeout": "abort" },
          { "type": "call", "equip": "e3", "params": { "level": "warning" } } ] } },
      { "if": { "gte": ["silenceMin", 30] }, "child": { "type": "call", "equip": "e4" } }
    ], "fallback": { "type": "noop" } } ] } }
~~~

---

## 4. 路由可配置

| 层 | 字段 | 回答的问题 |
|---|---|---|
| 发声会话 | `voice` | 这个主管从哪个 DSH session 发消息 / 被对话（`{mode:"virtual"}` = 不占会话） |
| 信箱 | `steward_inbox` 表 | 主管给主管发消息怎么收：投 `steward:<id>` → 进它的 inbox → 作为 `steward/inbox` 事实喂给它的树 |
| 路由矩阵 | `routes` | 能不能发给这一类对象：allow / approval / deny |
| 资源绑定 | 实例 `params` | 用哪个账号、写到哪个文档、发到哪个群 |

**地址解析规则（框架写死，不可配置关闭）**

1. 实例参数指定 `target: session:<id>` → 用它；
2. 未指定 → 用该主管的 `voice.sessionId`；
3. `voice.mode = virtual` 且实例是 `session.*` → 拒绝执行（要建会话必须先装备 session.create 并过授权）；
4. **主管永远不接收也不作用于自己的 voice 会话**（self-exclusion）。

---

## 5. 编排器与执行管线

~~~text
事实 tick → 主管树求值 → Intent → 裁决 → [预演|执行] → 审计 → 回写事实
裁决顺序：人工在场 > 作用域(self/租约) > 路由矩阵 > 授权(grant) > 幂等 > 预算 > 冷却
~~~

- **预演是管线的一站**，由能力的 `preview` 模板统一渲染；预演不写任何业务状态（不写 attempts、不占并发槽）。
- 每次执行必须留一条 **Intent**：steward / equip / cap / subject / params / tree_path / 事实证据 / 裁决 / 结果。
- **被拒的 Intent 也入库**（route-denied / need-grant / budget / cooldown），保证"开了却没反应"不再出现。

---

## 6. 观测、日志追踪与追查

### 6.1 关联模型（与 OpenTelemetry 对齐）

~~~text
trace  = 一次触发引发的一整条决策-执行链
span   = 链上的一个步骤（树分支 / 一次裁决 / 一次能力调用 / 一次等待）
effect = 能力调用对外产生的副作用与回执

字段：trace_id, span_id, parent_span_id, kind, ref, status, started_at, ms, attrs
~~~

- trace_id：一个"触发"（事件或定时 tick）一个。定时触发要带 `trigger: tick#seq` 便于区分。
- span 的 `kind`：`tree` / `decide` / `call` / `wait` / `effect`。
- `ref` 指向具体对象：树节点路径、equip id、能力实例、target。
- 好处：现有 export.js 的 OTLP 导出可以直接映射（trace_id/span_id 就是 OTel 的值）。

### 6.2 数据分级与保留

| 级 | 内容 | 默认 | 保留 |
|---|---|---|---|
| L0 事实 | 宿主指标、会话事件、信箱消息（append-only） | 开 | 内存近 200 条 + 落盘，7 天 |
| L1 决策 | 每次树求值：事件、命中/未命中分支摘要、选中路径 | 开 | 30 天（索引进 sqlite） |
| L2 效果 | 每次能力调用：参数、回执 id、耗时、错误码、重试 | 开 | 30 天 |
| L3 调试 | 表达式逐项求值、参数渲染、payload 原文 | 关 | 只保留最近 100 条，或按 trace 手动开 |

**体积控制（与"省堆"目标一致）**：内存只留最近 200 条事实 + 2000 条 intent 索引；要全文走 `?since=` 增量；L0 用环形 + 落盘，不整份 structuredClone。

### 6.3 存储与索引

新增/改造表（sqlite 后端已有）：

| 表 | 关键列 | 用途 |
|---|---|---|
| traces | id, trigger, steward_id, subject, started_at, status, span_count | 列表页、按会话/主管筛 |
| spans | id, trace_id, parent_id, kind, ref, status, started_at, ms, attrs_json | waterfall |
| effects | id, span_id, cap, params_json, ext_id, ok, error_code, ms, attempt | 能力统计与失败聚合 |
| intents | 沿用/扩展，加 trace_id, span_id, decision_json | 裁决与解释 |

索引：`(steward_id, started_at)`、`(subject, started_at)`、`(ok, error_code)`、`(trace_id)`。

### 6.4 面板六视图

顶层仍然是金字塔：**需要你处理在最上**。

| # | 视图 | 回答的问题 |
|---|---|---|
| 1 | 总览 Ops Home | 现在谁在动、动得对不对、有没有要拍板的 |
| 2 | 主管 | 每个编制的职责（装备）与树的合理性 |
| 3 | 能力仓 | 能力被谁用、成功率、失败原因 |
| 4 | 路由 | 谁能不能发给谁；为什么没发出去 |
| 5 | 追查 Trace | 这一条到底怎么走的 |
| 6 | 体检 Doctor | 哪条设计有毛病（自动归因） |

### 6.5 总览页（线框）

~~~text
┌ 需要你处理 ─────────────────────────────────────────────┐
│ 2 项待批 · 1 个会话在等你回答        [同意][拒绝] …      │
├ 控制 ─────────────────────────────────────────────────┤
│ [自动动作] [echo/live] [飞书通知] [立即汇报]             │
├ 正在发生 ──────────────────────────────────────────────┤
│ 宿主 堆 2.4/4.2GB 58%  P99 12ms  磁盘 34GB              │
│ 信号 12/min   意图 3 执行 / 1 预演 / 2 被拒   预算 8/30  │
│  堆守望  ▸ t-1024  session-abc  steer(1/2)   ●行          │
│  会话巡查 ▸ 空闲（上次触发 2m 前，未命中）              │
├ 最近动作（时间线，颜色区分 执行/预演/被拒/失败）─────────┤
│ 16:01:03 堆守望  notify.lark → owner        ✅ 飞书 msg  │
│ 16:00:48 会话巡查 steer.session → s-abc      ⚠ 等回执    │
│ 16:00:41 堆守望  host.slim                   ⛔ 路由拒绝  │
├ 异常 ──────────────────────────────────────────────────┤
│ ● host.slim 连续 3 次被拒（routes.session=deny）→ 追查   │
└────────────────────────────────────────────────────────┘
~~~

要点：每个"正在发生"行带 **trace 指针**，点进去就是追查页；"未命中"也要显示（沉默的主管必须是可见的）。

### 6.6 追查页（Trace）

~~~text
trace t-1024  触发 host/heap.critical  主管 堆守望  主体 host   18ms   ✅
┌ 决策链（waterfall）────────────────────────────────────┐
│ 00 host/heap.critical  usedMB=3900 heapPct=93          │
│ 01 tree  when/if: {gte:[heapPct,92]} → true            │
│ 02 decide 路由 owner=allow 授权 act 预算 8/30 冷却 ok    │
│ 03 call  e2 notify.lark   to=owner level=critical      │
│ 04 effect ✅ 飞书 message_id=om_xxx  312ms             │
│ 05 call  e3 host.slim      level=3                     │
│ 06 effect ⛔ route-denied: session:* = deny            │
└────────────────────────────────────────────────────────┘
[为什么] [重放] [钉住] [导出 jsonl] [对比上一条]
~~~

- **[为什么]（因果链）**：逐层展开"事实证据 → 表达式取值 → 选中分支 → 授权/路由判定 → 能力回执"。每个结论都能点出依据。
- **[重放]（what-if）**：用当时的事实快照重跑这棵树（不执行能力），回答"改了树以后还会这样吗"。
- **[钉住]**：把一条 trace 固定在面板顶部，改配置时对着看。
- **[导出]**：事实快照 + 树版本 hash + 能力版本 + 预期，可直接做回归测试用例。
- **[对比]**：同一 subject 的两次 trace diff。

### 6.7 体检页（自动归因，这是"不用翻日志"的关键）

| 症状 | 归因结论 | 修法入口 |
|---|---|---|
| 路由拒绝 | 路由矩阵禁止该对象类，主管永远发不出去 | 跳路由页 |
| need-grant | 该主管未授权此能力 | 跳主管装备 |
| no-voice | voice=virtual 但树调用了 session.* | 跳主管/树 |
| stuck-step | wait 超时后续步骤未执行 | 跳树 |
| budget-exhausted | 预算已满，动作被抑制 | 跳限额/审计（看谁烧的） |
| cap-failed | 能力侧错误聚合（按 error_code top3） | 跳能力仓 |
| silent-steward | 主管自身 tick 停摆（健康检查） | 跳主管 |
| dead-branch | 树分支 24h 命中 0 次 | 跳树（可能白写） |
| noisy-branch | 某分支命中占比 >80% 且多为 noop | 跳树 |

体检页只给**结论 + 跳转**，不让人读日志。

### 6.8 外部系统反查

每次 effect 记录外部回执 id：飞书 `message_id`、DSH `requestId`、task id、doc block id。
于是可以从"飞书里那条消息"反查到 → effect → span → intent → 树分支 → 主管。这是追查的最后一公里。

### 6.9 查询与导出

- 查询条件：时间范围 / steward / subject / severity / trace_id / 能力 / 只失败 / 全文。
- 增量：`GET ?since=seq&limit=N`（沿用 journal 的思路）。
- 导出：jsonl（单条 trace 或一段查询结果）。
- 对外：`/metrics` 加 intent/effect 计数（prometheus），OTLP 导出复用 trace/span。

### 6.10 主管主动查日志（能力化的观测）

观测基础设施不可绕过，但主管要"主动查"时走能力，进入同一套权限/预算/审计：

- `query.trace`（query × tool × trace-store）：按 trace_id / steward / 时间查。
- `query.journal`（query × tool × store）：按 topic / since / 全文查。
- 典型树用法：「巡检」主管每 5 分钟 `query.trace` 查近 5 分钟被拒 intent，汇总后 `notify.lark` 给 owner。

---

## 7. 与现状映射

| 现状 | 变为 |
|---|---|
| actuators/{gated,prompt,notify,answer}.js | 载体 adapter（session/lark.im/desktop） |
| policy.js 的 NEEDS + actLevel | equip.grant 单层 + 编排器裁决 |
| tasks.js 的 dispatch/echo | task.* 能力实例 + 管线预演站 |
| rules/ + wf/defs.js（两套规则语言） | 规则决定"要不要、谁、多急"；主管树决定"怎么做"（待 §11 对齐后收编） |
| store.js 的 signals/actions/journal | facts / intents / effects（journal 保留兼容） |
| engine 的 runs/steps | span 存储的一部分（plan 步骤天然是 span） |
| http.js 的 23 条路由 | 路由表不变，新增 traces/spans/effects/doctor 查询 |
| panel.js 金字塔 9 层 | 六视图（总览/主管/能力/路由/追查/体检） |

---

## 8. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 四要素抽象 + 载体 registry + 首批实例 + Intent/管线 + trace/span 落库 + 总览页 | 现有动作以实例形式跑通；测试全绿；总览页能看到"谁在动" |
| P1 | 主管编制 CRUD + 装备 + 显式树（校验器/求值器）+ 路由矩阵 + 追查页（waterfall/为什么/重放）+ 体检页 | 手写一棵树按预期执行、能解释、能重放；体检页能点名错配置 |
| P2 | 树编辑器（可视化 + 片段插入）+ 能力仓 + 路由页 + 审计页 + 日志查询/导出 | 面板里不写 JSON 配出"文档记录"主管 |
| P3 | 新载体 lark.doc / file / llm；Otlp 导出对齐；trace 对比 | 新增载体不改主管/编排器代码 |

---

## 9. 已确认的决定

用户 2026-10-18 确认（m06419 / m06422）：

1. 四要素取值表照本文采用（7 载荷 / 9 载体 / 9 对象 / 4 协议）。
2. `query.*` 归为能力（树里用 call 取数），不做成树内置函数。
3. `voice` 允许 `virtual`（不占会话的主管）。
4. 能力实例允许带默认参数，主管可改；参数 schema 在保存树时校验。
5. 能力颗粒度必须抽象（notify 只是其中一个实例）。
6. 先统一，不做放宽/收紧方向。
7. 决策树必须显式、可视化。
8. 任何主管都可装备任何能力；没有预定义角色/记录员。
9. 路由可配置（谁发给谁、从哪个 DSH session 发）。
10. 能力可扩展增删，首批按 §1.4 预设。
11. 面板展示、日志追踪、出问题的追查能力必须一并设计好（本文第 6 节）。

## 10. 未决

- 固定规则（rules/ + wf/defs.js）与主管树的最终关系：是"规则只做入口与严重度、树做执行"，还是规则整体迁移进树？（§7 映射按前者暂定）
- `par` 并行提议的冲突裁决是否需要 subject 租约表。
- trace 保留期与磁盘上限的具体数值（暂定 30 天 / L3 100 条）。
- 能力仓是否需要"能力版本"（升级 adapter 时的兼容声明）。
