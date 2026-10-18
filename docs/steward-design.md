# D-δ 大内总管团 · 设计文档

- 版本：0.2（设计定稿，待开工）
- 日期：2026-10-18
- 归属：polaris-toolkit / feature `steward`
- 前序：`docs/architecture.md`（装载链、feature 契约、硬约束）

---

## 0. 决策记录

| # | 决策点 | 选择 | 备注 |
|---|---|---|---|
| 1 | 总体方向 | D 持久工作流（Workflow-First） | 弃 A/B/C |
| 2 | 形态 | D-δ 多会话总管团 | 模块化 + 路由层 |
| 3 | 路由 | C1-A 规则优先 + LLM 兜底 | 可解释、低成本 |
| 4 | 模块会话生命周期 | C2-A 懒启动 + 空闲 2h 回收 | |
| 5 | 多设备拓扑 | **C3-C 联邦双主（对等）** | 无中心，见第 3 节 |
| 6 | 请示通道 | C4-A 只走 lead 合并 | 模块不直接打扰主人 |
| 7 | 预算 | C5-A 配额 + 应急池 | 按模块权重 |
| 8 | 会话轮换 | **C6-C 自适应（压力驱动 + 硬上限）** | 见 8.5 |
| 9 | 状态一致性 | C7-A 本机为真相 + 对等摘要 | |
| 10 | 面板层级 | C8-A 设备 → 模块 → 会话 | |
| 11 | lead 故障 | C9-A 不自动提升，只给人工按钮 | |
| 12 | 内置规则默认 | 只读类开、动作类关 | |
| 13 | 总管可见 | lead 与模块会话均进侧边栏 | |
| 14 | 模型 | 配置项，可按模块覆盖 | 见 8.8 |

---

## 1. 目标与非目标

**目标**

1. 收集全部 agent 的状态、计划、提问、错误，形成可追溯的观察流。
2. 对可判定的情况自动处置（通知 / steer / 代答），对不可判定的上报主人。
3. 所有副作用有且只有一次，跨重启、跨断网可恢复。
4. 按模块分治：ev / cb2 / il2cpp / dsh 各自的 agent 由各自的总管管。
5. 多设备对等联邦：每台机自治，互相通报，不需要一台常开的主机。
6. 策略是第一等公民：规则、工作流、预算都可热更新、可灰度、可回滚。

**非目标**

- 不替代 task board 与子 agent 机制，只做“外部观察 + 策略执行”。
- 不跨机迁移会话（物理上做不到，见 3.1）。
- 不做通用 BPMN / 分布式事务；工作流只服务本插件的动作。
- 不默认外置存储（不引入 VictoriaLogs / Grafana / NATS）。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| lead | 总管会话，一台机一个，本机的绝对主管 |
| module | 模块，策略命名空间（ev/cb2/il2cpp/dsh/unassigned） |
| subject | 被观察对象，通常是 agentId 或 sessionId |
| signal | 原子事实（状态变化、提问出现、堆告警、构建失败等） |
| rule | 声明式策略，命中后启动工作流 |
| workflow / run | 工作流定义 / 一次运行实例 |
| step | 工作流的持久化步骤 |
| actuator | 唯一执行副作用的层（notify/prompt/answer/protect） |
| rollup | 注入给 LLM 的摘要包，绝不含原始日志 |
| idemKey | 幂等键，由 runId:stepId 派生 |
| epoch | 所有权代号，单调递增 |
| peer | 联邦中的对等节点 |

---

## 3. 拓扑：联邦双主（对等联邦）

```
                     Tailscale / LAN（TLS + HMAC）
   ┌──────────────┐        gossip 摘要        ┌──────────────┐
   │ win-main     │ ◄──────────────────────► │ linux-build  │
   │ lead(总管)   │   审批 CAS / 动作台账     │ lead(总管)   │
   │ ├ module:ev  │                          │ ├ module:dsh │
   │ ├ module:cb2 │                          │ └ module:... │
   │ └ module:il2 │                          │              │
   └──────────────┘                          └──────────────┘
```

### 3.1 所有权不变式（联邦能成立的根本）

> **一个 subject 的唯一 owner 是它所在进程的那台主机，永不可迁移。**

理由：`sessionController.prompt`、`userQuestions.answer`、`agent.steer` 全部是本进程内调用。agent 只存在于一个 host 的 V8 里，因此谁管它不取决于协商，而是物理事实。

推论：

- 联邦是两台机各管自己的一批、互相通报，并非两台机抢同一批 agent。
- 不需要选主、不需要分布式锁、不需要共识协议。冲突面只剩两个：审批双答与动作重复，都由 idemKey 与 CAS 解决。
- 跨机的一切都是摘要与意图，不是执行。

### 3.2 为什么是 C3-C 而不是单主

| 维度 | 单主（M2） | 联邦（M3） |
|---|---|---|
| 主机常开要求 | 必须，否则全网失管 | 无 |
| 单点故障 | lead 挂 → 全网降级 | 只影响本机 |
| 跨机延迟 | 命令绕主 | 点对点 |
| 一致性 | 强（一份真相） | 最终一致（摘要） |
| 复杂度 | 低 | 中（gossip + CAS） |
| 扩展 | 加机要改主 | 加机即加 peer |

代价：**没有全局强一致的总账**。面板显示的是最近一次 gossip 的视图，并标注每台机的 `lastSeen`。这是可接受的：本插件的动作都是对单个 agent 的处置，不需要跨机事务。

### 3.3 生效规则

1. 每台机独立预算、独立规则版本、独立 store（SQLite 各自一份）。
2. 只有本机 lead 能对本机 agent 下动作；远端 agent 在本地只读。
3. 请示的落点由“你正在用的那一端”决定（见 10.3），不是固定主。
4. 审批的归属是发起它的那台机，答案可从任意端回传（CAS）。
5. 规则版本允许漂移，但必须可见并可一键同步（取最高版本为参考）。

---

## 4. 组件与目录

```
lib/features/steward/
  index.js                 feature 入口：路由、工具、生命周期、设置
  core/kernel.js           装配与依赖校验（缺服务则整 feature 降级只读）
  core/bus.js              事件订阅与归一化（agent/session/subagent/…）
  core/store.js            SQLite + JSONL 双写，损坏可从 JSONL 重建
  core/scheduler.js        单最小堆定时器 + 1s tick + 时钟校准
  core/leases.js           subject 租约、owner epoch
  core/dedupe.js           idemKey 去重、信号合并
  core/budget.js           配额、应急池、限时提额
  core/health.js           自身健康（事件循环延迟、队列深度、DLQ 深度）
  wf/engine.js             run 生命周期、step 推进、恢复
  wf/steps/{call,wait,branch,parallel,judge,remote,compensate}.js
  wf/defs/*.yaml           内置工作流定义
  wf/recovery.js           启动对账（intent 无 result 的歧义区）
  rules/{loader,evaluator,conflict,shadow}.js
  rules/builtin/{agents,system,social}.yaml
  rules/lock.json
  rules/overrides/
  sources/{agents,plans,questions,taskboard,health,remote}.js
  actuators/{notify,prompt,answer,protect}.js
  session/{bootstrap,wake,handoff,rotate}.js
  session/prompt.md        lead / module 两套系统提示
  modules/registry.js      模块注册表、归属匹配
  federation/{peer,handshake,gossip,approval,budget}.js
  channels/{panel,feishu,desktop}.js
  panel.js
bin/steward.mjs            运维 CLI：wf 触发、DLQ 重放、规则校验
```

---

## 5. 数据模型

### 5.1 SQLite（node:sqlite，WAL）

```sql
-- 会话 / 所有权
hosts(peer_id TEXT PK, name, kind, epoch INT, last_seen INT,
      rules_hash TEXT, version TEXT, model TEXT);

modules(id TEXT PK, name, host_id, status, policy_json, budget_json,
        session_id, epoch INT, updated_at INT);

-- 观察与路由
subjects(id TEXT PK, kind, host_id, module_id, owner_at INT,
         pinned INT DEFAULT 0, reason TEXT, confidence REAL);
signals(id INTEGER PK AUTOINCREMENT, host_id, kind, subject, severity,
        payload_json, at INT, consumed_by TEXT);
routing(id INTEGER PK AUTOINCREMENT, subject, module_id, reason,
        decided_by, confidence REAL, at INT);

-- 工作流
runs(id TEXT PK, wf, wf_version, trace_id, host_id, module_id, subject,
     status, vars_json, current_step, wake_at INT, deadline INT,
     lease_until INT, shadow INT DEFAULT 0, error TEXT,
     created_at INT, updated_at INT);
steps(run_id, step_id, kind, attempt, status, intent_at INT, done_at INT,
      input_json, output_json, idem_key TEXT,
      PRIMARY KEY(run_id, step_id, attempt));
timers(id TEXT PK, run_id, step_id, fire_at INT, kind, payload_json);
actions(id INTEGER PK AUTOINCREMENT, idem_key TEXT UNIQUE, run_id, step_id,
        host_id, kind, target, payload_json, level,
        result, error, at INT);
approvals(id TEXT PK, run_id, step_id, host_id, title, options_json,
          default_option, deadline INT, status, answer_json,
          version INT DEFAULT 0);
dlq(id INTEGER PK AUTOINCREMENT, run_id, step_id, reason, payload_json,
    at INT, resolved INT DEFAULT 0);

-- 配置镜像（面板与审计）
settings_history(rev INT PK, at INT, body_json, actor TEXT);
```

`node:sqlite` 已验证可用（node v24.21.0，FTS5 + JSON1 均正常）。启动时探测，失败则降级为纯 JSONL + 内存索引，功能不减、性能降级，面板标注 `store: jsonl`。

### 5.2 JSONL 事件日志

`~/.dsh/polaris-toolkit/steward/journal-YYYYMMDD.jsonl`，每行一条：

```json
{"v":1,"at":1760000000000,"host":"win-main","type":"signal/agent.stall",
 "subject":"a9bf419e","payload":{},"seq":123456}
```

- SQLite 是索引，JSONL 是真相。二者不一致时以 JSONL 重建。
- 写入用 appendFileSync + 每 1s fdatasync（不是每条同步，避免阻塞事件循环）。

### 5.3 保留期（默认）

| 数据 | 保留 |
|---|---|
| journal | 30 天 |
| signals | 7 天（聚合后只留统计） |
| actions / approvals | 180 天 |
| runs / steps | 90 天（完成的） |
| DLQ | 直到 resolved |
---

## 6. 工作流引擎

### 6.1 run 状态机

```
pending ──tick──► running ──step ok──► running
                    │                    │
                    ├──wait(timer)──► waiting ──fire──► running
                    ├──wait(signal)─► waiting ──signal──► running
                    ├──wait(approval)► waiting ──answer──► running
                    ├──step fail────► retrying ──► running | failed
                    └──done─────────► completed
   任意状态 ──cancel/timeout──► cancelled / failed
```

### 6.2 step 种类

| kind | 作用 | 关键字段 | 幂等性 |
|---|---|---|---|
| `call` | 调 actuator | actuator,args,retries,backoff,timeoutMs | 靠 idemKey |
| `wait` | 等定时器/信号/审批 | fireAt 或 matchSignal 或 approval, deadline | 天然 |
| `branch` | 条件跳转 | expr,then,else | 天然 |
| `parallel` | 扇出 ≤5 | branches,onError | 子步各自幂等 |
| `judge` | LLM 判断 | promptId,schema,budgetTokens,fallback | 只读，可重试 |
| `remote` | 跨机命令 | peerId,cmd,args,ttl | 对端按 idemKey 去重 |
| `compensate` | 补偿 | reason,actions | 靠 idemKey |

`expr` 只支持白名单函数（`== != > < && || !`、`has`、`in`、`count`、`ago`），不执行任意 JS。

### 6.3 intent → effect → result

```
1) 写 steps(status=intent, idem_key=sha1(run|step|attempt))   ← 崩溃点 A
2) actuators.<kind>(payload, idemKey)                           ← 副作用
3) 写 actions(result) + steps(status=done)                      ← 崩溃点 B
```

- 崩在 A 前：无副作用，重启直接重跑。
- 崩在 A、B 之间（歧义区）：
  - 有幂等下游（`sessionController.prompt` 的 requestId、审批 CAS）→ 用同一 idemKey 重试，语义安全。
  - 无幂等下游（外部 HTTP）→ 进 DLQ 并告警，不自动重试。
- 崩在 B 后：idemKey 命中，跳过。

### 6.4 启动恢复

```
for run in runs where status in ('running','waiting','retrying'):
    if run.shadow: mark shadow-skipped; continue
    step = last step of run
    if step.status == 'intent':
        if downstream_is_idempotent(step): retry(step)      # 同一 idemKey
        else: dlq(run, 'ambiguous-effect'); continue
    if run.status == 'waiting' and run.wake_at <= now: advance(run)
    if run.lease_until < now: release(lease)
    if now - run.updated_at > run.deadline: fail(run, 'deadline')
rearm_timers()          # 从 timers 表重建最小堆
emit('recovery/summary', counts)
```

### 6.5 定时器与时钟

- 单个最小堆 + 1s tick，`fire_at` 落库；禁止每个 run 一个 setTimeout。
- “多久之后”用单调时钟计算，墙钟只用于落库与展示。
- 检测时间跳变（墙钟与单调钟偏差 > 60s）→ 记 `clock/skew` 信号，重算所有 waiting 的 wake_at。
- 休眠唤醒：tick 时若发现应有 N 个定时器已过期，一次性批量触发（不逐个 delay）。

### 6.6 并发与租约

- 按 subject 串行：同一 agent 在任一刻只有一个 run 持有租约，防止两条工作流同时 steer。
- 全局并发默认 8；队列按 severity 优先，同级 FIFO。
- 租约 lease_until = now + 60s，每推进一步续租；持有者崩溃则 60s 后自动释放。

### 6.7 背压与合并

| 情况 | 处理 |
|---|---|
| 同类 signal 高频（状态抖动） | 合并为最新值 + 计数 |
| 队列 > 500 | 合并 + 采样，记 overload 信号 |
| 审批 | 永不合并、永不丢弃 |
| LLM 唤醒排队 | 60s 合并窗口，每窗最多 1 次 |

### 6.8 版本、影子、DLQ

- run 启动时钉死 wf_version；改定义不影响在飞的 run。
- shadow=true：call 只写 actions（result=shadow）不执行，面板可看“它本会做什么”。
- DLQ 支持 `bin/steward.mjs dlq replay <id>`，重放前强制人工确认（面板按钮）。

---

## 7. 规则引擎

### 7.1 规则 schema

```yaml
- id: agent.stall
  version: 1
  when: tick(10s) | agent/status | session/event      # 触发源
  if: 'status == "running" && silentMinutes > 5 && pendingQuestion == false'
  actions:
    - workflow: wf.diagnose-stall
      args: { subject: "$subject", silentMinutes: "$silentMinutes" }
  cooldown: 10m
  severity: warn            # info | warn | high | critical
  enabledByDefault: true
  params: { silentMinutes: 5 }
  shadowOnly: false
```

规则只启动工作流，不直接调 actuator——这是 D 的核心约束。

### 7.2 内置包（首版）

| 文件 | 规则 id | 默认 |
|---|---|---|
| agents.yaml | agent.stall / agent.error-loop / agent.question-stale / agent.plan-drift / agent.runaway-turn / agent.crash-resume | 前两个只读通知=开；处置类=关 |
| system.yaml | system.heap-warn / heap-high / heap-critical / system.session-growth / system.host-crash / system.plugin-unhealthy / system.disk-low / system.eventloop-lag | 通知=开，自动瘦身=关 |
| social.yaml | social.digest-hourly / digest-daily / approval-timeout / handoff-pending | 开 |

`rules/lock.json` 记 `{file: {version, sha256}}`；启动时校验，不一致则拒绝加载该文件并告警（防止半更新的规则包）。

### 7.3 评估与冲突

```
for sig in batch:
   hits = [r for r in rules if r.matches(sig) and r.enabled and not cooling(r, sig.subject)]
   if not hits: continue
   win = max(hits, key=(severity, specificity))
   suppressed = hits - win      # 记 suppressed 原因，面板可见
   start(win.actions[0].workflow, args)
```

冲突记录写 signals + routing，面板有“为什么没动作”视图——没有这个视图，你无法信任它。

### 7.4 漂移与灰度

- 每台机算 rulesHash，gossip 里带；面板标黄“规则落后”。
- 新规则包默认 shadowOnly=true 跑 24h，面板展示“本会触发 N 次 / 对谁 / 会做什么”，你点启用才生效。
- 一键回滚到上一个 lock.json 版本。

---

## 8. 总管会话

### 8.1 职责边界

| | lead | module steward |
|---|---|---|
| 管辖 | 全机 | 一个模块 |
| 观察 | 全部 agent | 本模块 agent |
| 请示主人 | 是（唯一通道） | 否，只能上报 lead |
| 启动工作流 | 任意 | 本模块命名空间 |
| 代答提问 | 是（root，白名单） | 是（本模块 root） |
| 跨机 | 参与 peer 协商 | 否 |

### 8.2 工具契约（只有四个）

```json
steward_observe { query: "agents"|"agent"|"plans"|"signals"|"actions"|"peers"|"budget",
                  args?: {}, limit?: number }            // 只读
steward_begin   { workflow: string, subject?: string, args?: object }
steward_report  { title: string, body: string, kind: "digest"|"alert"|"result",
                  module?: string, severity?: "info"|"warn"|"high" }
steward_ask     { question: string, options: string[], deadlineSec?: number,
                  defaultOption?: number, dedupeKey?: string }   // lead only
```

禁止：直接 send_message、直接 userQuestions.answer、直接改配置。所有副作用进工作流。

### 8.3 唤醒策略

| 触发 | 延迟 | 说明 |
|---|---|---|
| 用户消息 | 0 | 你在面板/侧边栏说话 |
| 审批到期前 5 分钟 | 定时 | 提醒 lead 做决定 |
| 未归类信号批次 | 60s 合并 | 每窗 ≤1 次 |
| 跨机摘要异常（peer 失联/规则漂移） | 5 分钟合并 | |
| 无事件 | 不唤醒 | 零成本 |

硬上限：每小时 30 次唤醒 / 每模块 60k token（默认，可配）。

### 8.4 rollup 格式（注入内容）

```json
{
  "now": "2026-10-18T11:40:00+08:00",
  "window": "5m",
  "me": {"role":"lead","module":null,"budget":{"usedPct":0.38}},
  "agents": [{"id":"a9bf","module":"ev","status":"running","silentMin":7,
              "question":null,"planTop":"修 cb2 反序列化","lastAction":"steer"}],
  "pending": [{"kind":"approval","id":"ap-12","title":"是否重启构建机","ageMin":18}],
  "signals": [{"kind":"system.heap-warn","count":3}],
  "peers": [{"id":"linux-build","lastSeenSec":12,"rulesDrift":1}],
  "askedRecently": ["agent.stall@a9bf"]
}
```

体积目标 ≤1.2k token；超限则截断低 severity 项并标注 truncated。

### 8.5 自适应轮换（C6-C）

压力模型：

```
fill           = contextTokens / modelWindow                          // 0..1
compactRecency = tokensSinceCompaction / max(1, tokensAtCompaction)   // 压缩后回涨速度
rollupRatio    = rollupTokens(now) / rollupTokens(首次唤醒)            // 摘要膨胀

pressure = 0.50*fill + 0.30*min(1, compactRecency) + 0.20*min(1, rollupRatio/2)
```

判定：

```
if fill > 0.88:                       rotate("hard-cap")     # 任何情况都轮换
elif pressure > 0.75 and turns > 20:  rotate("pressure")
elif turns > ceilingTurns:            rotate("ceiling")
else:                                 continue

防抖：轮换后 10 分钟内不再轮换；
      两次轮换间隔 < 30 分钟 → 记 handoff-ineffective 信号并升级给你。
```

默认参数（可配、可视化）：

| 参数 | lead | module | 说明 |
|---|---|---|---|
| floorTurns | 40 | 20 | 低于此不轮换 |
| targetPressure | 0.75 | 0.75 | 触发阈值 |
| ceilingTurns | 200 | 80 | 兜底上限 |
| hardFill | 0.88 | 0.88 | 硬上限 |
| ceilingTokens | 300k | 180k | 兜底上限 |

面板行内显示：`压力 0.62 ▓▓▓▓▓▓░░░░ 预计 18 轮后轮换`，可点开改（改完立即生效，写 settings_history）。

### 8.6 交接摘要契约

轮换时生成，写入 state 并注入新会话首条：

```
## 交接（<旧会话标题> → 本会话）
目标：<当前模块/全局目标，1-2 句>
已决：<最近 10 条决策 + 理由>
待决：<未完成审批、未闭环 run，带 id>
未验证断言：<说过但没证实的事>
关键 id：<agentId / runId / approvalId>
最近动作：<最后 10 条 action，含结果>
```

目标 ≤1.5k token。超过就只保留“待决 + 未验证断言 + 关键 id”。

### 8.7 提示词骨架（lead）

```
你是这台机器（<host>）的总管。你管理 N 个模块，只能通过工作流产生副作用。

铁律：
1. 不对 agent 直接发消息；要发就 steward_begin 一个工作流。
2. 只有你能 steward_ask；模块的请示已合并进 pending。
3. 每次唤醒只依据 rollup 判断，不要臆造历史。
4. 不确定 → report(severity=warn) 而不是 ask（ask 是稀缺资源）。
5. 一次唤醒最多启动 3 个工作流；超出说明该拆规则。

规则索引：<按 severity 排序的 id + 一句话>
工具契约：<四个工具的 JSON schema>
```

### 8.8 模型配置

```yaml
steward:
  model: auto                 # auto | "provider/model"
  judgeModel: auto            # judge 步骤单独可配
  modules:
    ev:  { model: "provider/cheap" }
    dsh: { model: auto }
  maxOutputTokens: 800
```

解析顺序：module > host > global > auto。不可用时回退 auto 并告警（不静默降级）。

---

## 9. 路由

### 9.1 五层判定

```
1 pinned     面板手工钉死              信心 1.0  永不被覆盖
2 taskboard  ledger-v2.json tag/owner  0.95
3 workspace  会话 cwd 前缀（最长匹配）   0.9
4 title      正则/关键词               0.7
5 llm        lead 用 300 token 提示分类  0..1
6 都不中 → unassigned 队列，攒批问主人
```

LLM 结果 <0.6 → 仍归 unassigned，但记 candidate 供你一键确认。

### 9.2 缓存与钉死

- 归属结果写 subjects，同一 agent 不重复分类。
- 你手工改一次 → pinned=1，此后所有规则都不再改它。

### 9.3 可解释

每条归属写 routing(reason, decided_by, confidence)；面板“为什么归到这里”直接展示这一行。
---

## 10. 联邦协议

### 10.1 身份与握手

- 每机 peerId = uuid，存 settings.json；epoch 单调。
- 加入：主人给一次性 joinToken（10 分钟有效，用后即焚）+ 共享 secret（HMAC-SHA256）。
- 信任层优先用 **Tailscale**（免 NAT、加密、有设备身份），回退局域网 + HMAC。
- 每个 peer 记录 lastSeen、rulesHash、version、epoch。

### 10.2 gossip 摘要（上行）

每 30s 或有事件时单向推送（不转发第三方，深度 1）：

```json
{"v":1,"from":"win-main","epoch":7,"seq":1288,"at":1760000000000,
 "rulesHash":"ab12...","version":"0.2.0",
 "agents":[{"id":"a9bf","module":"ev","status":"running","silentMin":7,
            "question":false,"planTop":"..."}],
 "signals":[{"kind":"system.heap-warn","count":3}],
 "actions":[{"idem":"...","kind":"prompt","target":"a9bf","result":"ok"}],
 "approvals":[{"id":"ap-12","title":"...","deadline":1760003600000,"status":"open"}],
 "budget":{"usedPct":0.38},"health":{"loopLagMs":12,"queue":3,"dlq":0}}
```

大小上限 32 KB；超出则只带 agents 的 {id,module,status} + 计数。

### 10.3 请示落点（联邦下的关键设计）

> **请示投递给“你此刻正在用的那一端”，而不是固定主。**

```
用户活跃端判定：本机 GUI 在前台 且 最近 5 分钟有输入/滚动
  ├─ 有且只一台 → 该端 lead 直接 steward_ask
  ├─ 多台同时活跃 → 全部投递，但同 dedupeKey 只弹一次；
  │                  任一端回答后广播 answer，其余端收“已处理”
  └─ 都无活跃    → 按 askFallback 顺序（默认：最近一次活动的机器）
```

这样联邦仍然对等，但永远不会出现“两台机都问、你答两遍”。

### 10.4 审批 CAS

- 审批持久化在**发起端**；其他端只持有镜像。
- 回答走 `POST /approval/:id/answer {version, answer}`，version 不匹配 → 409 + 返回当前答案（幂等：同答案返回 200）。
- 发起端执行 `remote{cmd:"approve"}`（若审批的执行方是远端），或本地直接执行。

### 10.5 预算（联邦）

- 每机独立配额（token 按各自 provider key 计）。
- gossip 带 usedPct；全局视图是近似值（±5%），面板标注“估算”。
- 可选全局软上限：任一机发现总量 > 90% → 广播 throttle，各机降级为规则-only。

### 10.6 离线与恢复

| 场景 | 行为 |
|---|---|
| peer 离线 < 5 分钟 | 只标黄，动作照旧（本机不受影响） |
| peer 离线 > 5 分钟 | 其 agent 在本地视图转 remote-unknown；不再为其发起跨机工作流 |
| 恢复 | 回补最多 24h 摘要（只补结论 + 动作台账） |
| 其 open 审批 | 保持 open 但不可答（除非你在该端本地直接处理） |
| 分区期间远端有动作 | 恢复后按 idemKey 去重合并，冲突记 split-action |

### 10.7 安全

- 传输：Tailscale（优先）或 TLS + HMAC；不传会话内容、不传文件。
- 命令白名单：ask | approve | collect-diagnostics | set-policy | pause | resume；永不接受 cancel/exec/rm。
- 每 peer 独立 secret；撤销 = 删 peer 记录 + 轮换 secret。

---

## 11. 权限与防自激

动作等级：

| 级 | 动作 | 默认 |
|---|---|---|
| L0 | 只读观察 | 开 |
| L1 | 通知（面板/飞书） | 开 |
| L2 | steer 子 agent 的父会话 / 注入提示 | 关 |
| L3 | 代答 root 提问（白名单问题类型） | 关 |

五道闸：

1. 总管自身的 sessionId 与 agentId 永久排除在观察名单外。
2. 所有由总管发出的消息带 `source.kind="steward"`，观察层直接忽略。
3. 同一 subject + 同一规则 10 分钟冷却。
4. 全局 ≤20 动作/小时（可配），超限只通知不执行。
5. 面板“制停”开关 + 全局 dryRun（所有 call 变 shadow）。

---

## 12. 面板

三级树：`设备 → 模块 → 会话/规则/预算`

```
▾ win-main   ● online  v0.2.0  规则 ab12  预算 38%   [制停] [dry-run]
   ▾ 总管 lead      ● healthy  待决 2  动作 14  压力 0.62 ▓▓▓▓▓▓░░░░ 预计 18 轮
      ▸ 会话：总管            [打开] [轮换阈值]
      ▸ 规则：12 启用 / 2 影子 / 1 停用          [查看 suppressed]
      ▸ 工作流：3 在飞 / 今日 41 完成 / DLQ 1    [DLQ]
   ▾ EV 引擎        ● busy     活跃 2  待决 0  动作 31  预算 61%
      ▸ 会话：总管 / ev       [打开]
      ▸ 归属：cwd D:/agent/ev-engine（0.9）
   ▸ cb2 引擎       ● stalled  活跃 1  待决 1
▾ linux-build  ● online 规则 ab11（落后）  [同步规则]
   ▸ dsh            ● healthy
```

新页面：`/__polaris/steward`；API 前缀 `/__polaris/steward/api`。

---

## 13. 自身可观测性（不能自己瞎）

| 指标 | 来源 |
|---|---|
| 事件循环延迟 | perf_hooks.monitorEventLoopDelay() |
| 队列深度 / DLQ 深度 | kernel |
| 每小时动作数 / token | budget |
| 规则命中率 / suppressed 率 | evaluator |
| 恢复次数 / 歧义数 | recovery |
| 每 run 时长 P50/P95 | store |

插件由 system.plugin-unhealthy 规则监控自己；自身超过阈值 → 降级为只读并主动 report。

---

## 14. 分期与验收

| 期 | 内容 | 天数 | 验收 |
|---|---|---|---|
| P0 | kernel + store + bus + sources(agents/plans/questions) + 路由 + 只读面板 + 模块树 | 3 | 面板实时显示 4 个模块的 agent、计划、提问；零副作用 |
| P1 | 工作流引擎（call/wait/branch + intent-effect-result + 恢复 + 定时器 + 租约） | 4 | 注入故障重启 20 次，动作不重不漏；DLQ 正确 |
| P2 | 规则引擎 + 内置包 + 冲突 + suppressed 视图 + shadow 24h | 3 | 影子报告与实际动作一致率 ≥95% |
| P3 | lead + module 会话 + 四工具 + 唤醒 + 自适应轮换 + 交接 | 4 | 连续 48h 无自激；轮换后任务可续 |
| P4 | 联邦：握手 + gossip + 审批 CAS + 活跃端请示 | 4 | 拔网 10 分钟，恢复后无重复审批、无重复动作 |
| P5 | remote step + 命令白名单 + 规则同步 | 3 | 跨机 ask/approve 端到端 ≤5s |
| P6 | DLQ 重放 + 时间旅行 + 复盘库 + 飞书通道 | 3 | 任一历史 run 可回放；飞书收到摘要 |
| P7 | 可选：OTLP 出口 / MQTT / 转发中继（>3 台） | 2 | |

合计约 **26 天**。

---

## 15. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| LLM 自激（总管处理总管） | 中 | 高 | 五道闸 + 排除名单 + 冷却 + 制停 |
| 联邦出现双答审批 | 中 | 中 | CAS + 幂等 + 活跃端唯一弹窗 |
| 规则过拟合你的习惯，误 steer | 中 | 高 | 动作类默认关 + shadow + 白名单问题类型 |
| node:sqlite 在 Electron 内被裁剪 | 低 | 中 | 启动探测 + JSONL 降级 |
| 会话轮换丢上下文 | 中 | 中 | 交接摘要契约 + 未验证断言显式列出 |
| 事件循环被自家定时器拖慢 | 低 | 高 | 单最小堆 + 批量触发 + 自身延迟监控 |
| 面板数据量大（240 会话） | 中 | 低 | 分页 + 摘要聚合 + 虚拟列表 |

---

## 16. 待决

1. 请示落点：活跃端（本文推荐）/ 固定端 / 全端广播。
2. peer 传输：Tailscale（推荐）/ 局域网 HMAC / SSH 隧道。
3. 共享粒度：摘要 + 审批 + 台账（推荐）/ 再加只读 agent 列表 / 仅审批。
4. 通知通道首版：lark-cli（推荐，已装 1.0.72）/ 自定义机器人 webhook / 双向卡片。
5. 动作默认档：L1（推荐）/ L2 / 白名单 L3。
6. 模块清单确认：ev、cb2、il2cpp、dsh、unassigned；各自 host。
