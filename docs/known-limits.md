# 已知限制

这份清单是"我们**知道**它这样，并接受它"的取舍，不是待办。每条都写了原因与绕行方式。

## 1. GET 读接口匿名

`authorize()` 只对写请求（非 GET/HEAD/OPTIONS）校验 `x-polaris-token`；所有 GET 只要 Host 头可信
（同源/回环）就放行。后果：**本机任意进程**可以读

- `GET /__polaris/steward/api/chat`（总管会话全文与转录）
- `GET /__polaris/steward/api/detail?sessionId=`（任意 agent 的最近事件与最后一句）
- `GET /api/audit` / `/api/trace`（谁想对谁做什么、命中还是被拒、外部回执）

原因：面板要能在没有令牌的情况下看状态、从 iframe 里带 cookie 会让"复制令牌换机器"变得别扭，
而插件本来就只监听回环/反代后的可信 Host；用户明确要求读接口保持免令牌。
要收紧的话：把 `lib/core/host.js` 的 `authorize()` 改成所有方法都校验令牌，并让面板统一带
`x-polaris-token`（面板已持有 cookie，改动约十行）。

## 2. 改 host 代码必须重启宿主

Node ESM 不会重新 import 已装载的模块，HMR 也只热挂载 profile/bundles 的变化。插件会在两个地方提示：

- 面板顶部琥珀横幅 + `GET /api/features` 的 `install.stale`（磁盘 `lib/**` 比启动时间新，或 install.json 比启动新）
- `node bin/polaris.mjs doctor` 的 `install-drift`（仓库源码比上次安装新）

绕行：托盘退出 DSH 再启动。这是"长期高负载"场景里最容易被误判成"改动没生效"的点。

## 3. 会话读取要自己折算

宿主 `sessionQuery` 的每次读（`listEvents` / `readSession`）都会把整份日志 load 一遍并 structuredClone。
面板 5 秒轮询 × 多会话直接顶爆堆（正是 Heap Guard 要解决的问题）。所以：

- `steward/session/events.js` 做了折叠缓存（只留最近条目），面板读的是它，不是宿主原话。
- 追查页 / 对话页按 `?since=` 增量拉，不每次全量。

## 4. 预算只计"真动作"

`budgetView` 用 `store.chargeOf(action)` 过滤：`echo` 预演、`denied`、`signal`、`settings`、
`modules`、`route`、`collect`、`digest`、`tool.*`、`session`、`chat` 都不计价；
`escalate`、`act`、`slim`、`notify`、`send`、派发/重试才算。条目可用 `action.charge` 显式覆盖。
这是刻意修正：早先把心跳/信号都算进去，空转几个小时就能烧满 `budgetPerHour` 并抑制所有工作流。

## 5. 依赖宿主的模型路由

`summarize.llm`（llm 载体）与 `classifier` 都要宿主有可用的模型选择（`agentDefaultModel` 或配置里的
provider/model）。没有就返回 `no-model-route` / 走规则兜底，不会静默失败，但也不会自己造模型。

## 6. 联邦是"本机/受信转发"

`POST /api/federation/receive` 是写方法 → 需要本地 `x-polaris-token`。默认 secret 不填就不建 peer。
跨机互发需要自己给对端一个受信通道（反代 + 自己签发令牌），当前实现不承担公网身份。

## 7. SQLite 是可选后端

`steward/core/db.js` 默认 `backend:"auto"`：探测 `node:sqlite`（Node 22.5+）就用 SQLite/WAL，
探测不到回落到 `steward.db.json` + 操作日志重放。功能一致，性能与并发弱一些。

## 8. 面板 5 秒轮询

外壳卡片 5 秒拉一次 `api/features`（页面隐藏即停）；功能面板 5 秒拉一次 `api/state`，
内部用 `rev`/心跳决定是否回拉完整状态。这是为了"看一眼就知道"而付的代价；如果以后要更省，
可以把 `api/state` 拆成按需子资源，但当前值不值得。

## 9. 能力平面不做的事

- 不做运行时"收紧/放宽"三层层级：装备就是装备，授权只看 `grant` 单层（实验见 design 文档的早期版本）。
- 不做学习式决策：判定能力只返回 `{hit,level,reason,evidence}`，要不要动由该主管的显式决策树决定。
- 树片段（preset）只在编辑时插入，运行时**不回看**能力自带的决策。
