# Polaris Toolkit

一个 DSH（DeepSeek Harness）**多功能工具包**插件。Polaris Toolkit 是入口包，
下面的每个能力都是一个 feature；当前内置 **Heap Guard**（宿主 V8 堆监控 / 会话安全瘦身 / bili 预算控制）与 **Steward**（大内总管：观察全部 agent、归类到模块、能力平面判定命中后由该主管的决策树决定动作，动作/审批/上报全链路；设计见 [docs/steward-design.md](docs/steward-design.md)），
后续新增功能只加 feature，不动入口。

- 入口：左侧栏 **Polaris Toolkit**（右侧栏 tab 暂未使用，见"设计取舍"）
- 版本：0.1.0（本地目录包，未发布 npm）
- 依赖：无第三方运行时依赖（只用 node: 内置模块 + @deepseek-ai/schemastery + @deepseek-ai/dsh-tools）

---

## 1. 它解决什么问题

DSH 的 host 进程（真正跑会话/工具的那个 node 子进程）会随运行时间单调占用 V8 堆：
长期挂机 + 超大 session 会让堆顶到上限后 OOM 崩溃。实测结论（本轮排查）：

- 增长不是模块级泄漏，而是**每个被加载过的 session 保留在堆里**：
  Session 的 log 数组保存全部事件对象，且没有空闲卸载路径（无 LRU、无 maxOpenSessions），
  归档（archive）只是写一个 id 标记，不释放任何内存。
- 因此能被"就地"释放的量有限：**真正的大头是让 host 别把超大 session 读进来**，
  以及别让 bili（压缩代理）把已加载 session 的缓冲区留太久。

Heap Guard 做三件事：

1. **看见**：持续采样宿主堆、系统内存、磁盘、agent/会话清单，金字塔面板一眼看清现状。
2. **减负**：安全点自动/手动把超大 session 文件瘦身（L1 重打包 / L2 丢流式增量 / L3 再裁超大工具结果），
   直接减少"下次加载时会被读进堆"的字节量；并可按预算收紧 bili 常驻内存。
3. **不失控**：所有自动动作默认关闭，逐条可回滚（写入备份目录），并且只在"没有 agent 在跑"的安全点动手。

---

## 2. 仓库结构

    polaris-toolkit/
      package.json          入口包清单（main + exports + dsh.bundle/dsh.client）
      cordis.patch.yml      bundle 插入行；profile 的 bundles 列表决定是否生效
      README.md
      lib/
        index.js            入口：name/inject/Config/apply -> mountToolkit
        panel.js            入口面板（feature 卡片列表 + iframe 装 feature 面板）
        client.js           客户端半边（__ModuleLoader__ 经典脚本；侧栏/主面板/会话头按钮）
        core/
          host.js           工具包宿主：feature 生命周期、路由收集、设置存储、工具注册、
                            指标/总线/调度/能力注册表、写请求令牌校验、装机信息
          paths.js          ~/.dsh/polaris-toolkit 下的路径与 CSV/格式化小工具
          settings.js       settings.json 读写（版本信封 + 深合并 + schemastery 校验）
          statefile.js      状态文件版本/迁移/保留期清理（loadVersioned / pruneFiles / pruneCsv）
          metrics.js        指标注册表（gauge/counter）+ 宿主采样器（堆/RSS/事件循环）
          secret.js         安装级随机令牌（<stateDir>/secret，0600）
          http.js           极简路由 + JSON/HTML 响应 + 请求体读取
          fence.js          宿主来源校验（Host 头/同源）+ 写操作令牌比对
          zstd.js           多帧 zstd 解析（session.v4.jsonl.zstd 是逐次追加的多帧文件）
        panel/
          kit.js            面板公共件的服务端半边（注入 kit.js、共享 CSS 变量）
          kit.client.js     浏览器公共件 window.PolarisKit（esc/fmt/api/poll/toast）
        features/
          index.js          FEATURES 注册表（新增功能只改这一行）
          heap-guard/
            index.js        该 feature 的 Config/settings/actions/setup/action/status + 路由 + 工具
            panel.js        金字塔面板 HTML
            sampler.js      堆/系统/磁盘/agent/会话 采样
            idle.js         安全点判定（读会话文件尾部，判断是否处于 turn/end 之后的静默窗口）
            slim.js         瘦身执行器（调用 bin/slim.mjs）与 AutoSlimmer（自动清理节流）
            snapshot.js     写 V8 堆快照与轮转
            bili.js         bili 配置读写与预算调整
            titles.js       会话名缓存（子进程扫描 + mtime/size 校验 + 内存标题）
          steward/          大内总管：观察 / 能力平面（能力·编制·树·路由·trace） / 审批 / 联邦
            index.js        只做装配（约 300 行）：构造 + attempt 降级 + dispose
            config.js       Config / settings / settingsSchema / normalize / readSettings
            state.js        只读视图（state/modules/agents/budget/runs/approvals）
            metrics.js      15 条 polaris_steward_* gauge + 每模块 gauge + 统计缓存
            brain.js        编排器：tick 骨架 + 事件桥（判定与动作都在能力平面里）
            http.js         路由表 + agent 工具 + action/status（HTTP 层整体搬出）
            actuators/gated.js  echo/live 闸门（actMode=echo 时只把拟执行动作写进账本）
            panel.js        金字塔面板（结论 / 要我拍板 / 控制 / 设置 / 交办 / 对话 / 正在发生 /
                            主管 / 能力仓 / 路由 / agent 明细 / 记录 / 审计 / 追查 / 体检 / 维护）
            core/           账本 store、db（sqlite 或 JSON 降级）、schema、approvals、健康采样
            wf/             引擎 engine.js（三段式 / 定时器 / 租约 / 重试 / DLQ；历史 runs 审计仍可读）
            plane/          能力平面：catalog（能力仓）/ instances（首批 22 个）/ preset（内置编制）/
                            tree（决策树）/ expr（表达式载体）/ carriers（载体适配）/ pipeline（裁决管线）/
                            grants（授权映射）/ mount（装配）
            policy.js       分级授权 actLevel 的 NEEDS 表
            trace 表         见 lib/core/trace.js：trace/span/effect/intent + OTLP 映射
            session/        rollup、pressure（自适应轮换）、handoff、bootstrap（会话绑定）
            actuators/      notify / prompt / answer 三个动作出口
            channels/       desktop（内存环形）、feishu（lark-cli 子进程）
            federation/     信封 envelope.js（HMAC）与 peer.js（白名单 / 去重 / 心跳）
      bin/polaris.mjs       运维入口：node bin/polaris.mjs install | doctor | token | version
      bin/slim.mjs          独立瘦身脚本（子进程运行，可脱离插件单用）
      bin/titles.mjs        会话名扫描子进程（按帧有界读 session/title，输出 JSON）
      docs/architecture.md  架构说明（装载链 / feature 契约 / 客户端表面 / 硬约束）
      docs/steward-design.md  大内总管团（D-δ）设计：联邦 / 工作流引擎 / 规则 / 会话与轮换
      docs/design-capability-plane.md  能力平面设计（能力=插件、编制=数据、决策树、路由、观测 trace/OTLP）
      docs/known-limits.md             已知限制清单（匿名读接口 / 重启生效 / 预算口径 / 联邦 等 9 条）
      AGENTS.md            给下一个改这个仓库的人或 agent 的约定（测试、格式地雷、交付动作）
      .github/workflows/ci.yml   CI：Node 20/22/24 跑 npm test，22 再跑覆盖率门槛
      skills/polaris-toolkit/SKILL.md  可安装的 skill：什么时候用哪个工具 / 哪个接口
      install/
        install.ps1         安装到 profile（注入式 file: 依赖 + pnpm install + 写 bundles + 清退旧包）
        uninstall.ps1       卸载（JSON 手术移除依赖/bundles，或 -Restore 还原备份）
      _test/all.mjs         跨平台测试入口（枚举 test/*.test.mjs + 冒烟；--coverage 加覆盖率门槛）
      _test/run.mjs         离线冒烟（假 ctx，把整个包挂一遍，不连 DSH）
      test/*.test.mjs       node:test 单元 / 集成测试（16 个文件；npm test 跑完再跑冒烟）
      test/helpers/harness.mjs  共享脚手架：临时 HOME + 假 ctx + mount()/call()/json()
      test/panel.test.mjs   面板 vm 冒烟（document 垫片 + 真跑内联脚本 + fetch 打到假宿主）

---

## 3. 安装 / 升级 / 卸载

在仓库根目录执行（PowerShell 5.1 即可）：

    powershell -ExecutionPolicy Bypass -File install\install.ps1

它做四件事：备份 profile 的 package.json -> 清退旧包 dsh-heap-guard（如存在）->
把本仓库写成 profile 的**注入式本地依赖**（dependencies["polaris-toolkit"] = "file:D:/agent/polaris-toolkit"，
dependenciesMeta["polaris-toolkit"].injected = true）-> 用宿主自带的 node + pnpm 在该 profile 里跑一次
`pnpm install`（自动沿用 profile 的 --store-dir），pnpm 按本包 package.json 的 files 字段把仓库文件
真实复制到
    %USERPROFILE%\.dsh\profiles\desktop\node_modules\polaris-toolkit
-> 把 "polaris-toolkit" 追加进 dsh.profile.bundles。

为什么用注入式依赖而不是手工复制：profile 里任何一次 pnpm 操作都会把"不在依赖树里"的
node_modules 目录挪进 .ignored\；写成 injected 的 file: 依赖后，pnpm 会主动维护这份副本。
代价是注入副本属于**运行时快照**：改完仓库要重跑 install.ps1（或在该 profile 里再跑一次 pnpm install）。

参数：-Profile <目录>（默认 desktop）、-NoBundles（只装不挂载）、-KeepOld（保留旧包）、
-NoPnpm（跳过 pnpm，退回手工复制并警告）。

更推荐的入口是同一套逻辑的 node 版（install.ps1 现在只是它的薄壳）：

    node bin/polaris.mjs install         # 装到默认 profile（win32 上转发给 install.ps1）
    node bin/polaris.mjs doctor          # 只读体检：清单/注入副本/bundles/版本漂移/端口
    node bin/polaris.mjs doctor --json   # 给脚本用
    node bin/polaris.mjs version

doctor 逐项给出 ok/warn/fail 与修复建议，有 fail 时退出码非 0：检查 profile 的 package.json 有无 BOM、
依赖是否仍是 file: 且指向本仓库、dependenciesMeta 是否 injected、bundles 是否含且**只含一次**本包
（重复挂载会让插件树起不来）、node_modules 里的副本版本/文件数/是否比仓库旧，以及状态目录、settings.json
版本、令牌文件权限。装完会顺手写一份装机记录：

    %USERPROFILE%\.dsh\polaris-toolkit\install.json   { at, version, repo, profile, files, mode, node, pnpm }

面板页脚会显示这份记录的版本 / 装机时间 / 来源路径，装完没重启或装到了别的 profile 一眼就能看出来。

两个入口都按"空环境"加固过：DSH 的 PTC 运行器启动的子进程里 `process.env` 几乎是空的，而 PowerShell 里
任何一个 `Join-Path $env:XXX` 拿到 null 都会直接抛 `Cannot bind argument to parameter 'Path' because it is null`
（清单已写入但被回滚，看起来像"装到一半失败"）。所以 `bin/polaris.mjs` 会先补齐 USERPROFILE / LOCALAPPDATA /
APPDATA / TEMP / TMP / SystemRoot / SystemDrive / ProgramData，再按绝对路径找 powershell.exe；两个 .ps1 内部也
各自兜底（拿不到 LOCALAPPDATA 就按 USERPROFILE 推，拿不到 TEMP 就用 `[IO.Path]::GetTempPath()`）。
顺带一条经验：子进程缺 SystemDrive 时，PowerShell 启动会在**当前目录**里造一个字面量 `%SystemDrive%` 目录
（内容为 `ProgramData\Microsoft\Windows\Caches\*.db`），曾被 `git add -A` 误提交 —— 现在有回归测试守着。

**安装/升级后必须重启 DSH**：host 半边在 DSH 启动时加载，页面刷新不够（客户端半边刷新即可）。

升级：改完仓库重新跑一次 install.ps1。
卸载：powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
（-Restore <备份> 可还原某次安装前的 package.json；状态数据保留在 %USERPROFILE%\.dsh\polaris-toolkit，
可自行删除）。

_test/ 与 node_modules 不会进入注入副本（files 字段只列 lib / bin / docs / cordis.patch.yml / README.md）。

---

## 4. 面板：金字塔布局

打开左侧栏 **Polaris Toolkit** -> 选 **Heap Guard**，或直接访问 /__polaris/panel。
自上而下五层，越往下越细：

1. **第一层 结论**：当前堆占用 / 上限 / 百分比 + 等级徽章 + 每分钟增长 + 预计到达上限的时间。
   一眼只需要这一行。
2. **第二层 KPI**：堆、RSS、agent 数、会话总量、系统内存、磁盘剩余。
3. **第三层 阈值与趋势**：warn/high/critical/emergency 四档进度条 + 最近采样曲线。
4. **第四层 操作**：按钮区 + 瘦身档位下拉 + 每次上限输入。
5. **第五层 候选会话表**：按体积排序的会话（名称 / ID / 工作区 / 大小 / 最后修改 / 是否已关闭），每行一个"清理"按钮。
   名称取自会话日志里的 `session/title` 事件，由独立子进程按帧有界扫描后缓存，不进宿主堆。
6. **折叠区**（默认收起）：内存分代明细、系统与磁盘、堆快照、运行状态（状态目录、会话名缓存、上次动作、错误）。

刷新节奏（省电也省堆）：外壳左侧卡片每 5 秒拉一次 `api/features`（页面隐藏即停），右侧 iframe **只在切换功能时换源**，
不再整页重载，所以滚动位置与 `<details>` 展开状态都不会丢；面板内部先打轻量心跳 `api/tick`（5 秒），
只有 `rev` 变化才回拉完整状态，空闲时每 30 秒兜底刷新一次。所有请求都相对页面解析（不看主机名/端口），因此反代或自定义端口都能用。

### 功能按钮

| 按钮 | 行为 |
| --- | --- |
| 立即清理（最大） | 对当前最大的安全候选（已关闭且超过 minMB）执行一次瘦身，默认按面板档位 |
| 立即清理（全部候选） | 串行清理全部候选，每轮受"每次上限"限制（默认 20），执行前确认 |
| 试运行 | 只统计能省多少字节，不写盘 |
| 刷新会话名 | 重新扫描会话日志里的 session/title 事件（有界子进程），刷新表格的"名称"列 |
| 自动清理 | **开关**，默认关。打开后：等级达到阈值 + 处于安全点（无 agent 在跑）+ 冷却期已过 + 每小时次数未超限，才自动清理一个会话 |
| 写堆快照 | 手工 v8.writeHeapSnapshot()（默认保留最新 2 份，磁盘低于 5 GB 时拒绝） |
| 应用 bili 预算 | 把面板里的 max/residentMaxBytes/warmMax/warmMaxBytes 写进 bili 配置 |

自动清理的节流（可在 Config 改）：单次只处理一个会话、冷却 10 分钟、每小时最多 4 次、
只在等级 >= warn 时触发、任何 agent 在跑就不动手。

---

## 4.5 Steward（大内总管）

一条链：**观察 → 归类 → 能力判定 → 该主管的决策树 → 动作 / 审批 / 上报**。默认是"只通知"（L1），
任何真正的副作用都要显式打开。设计依据见 [docs/steward-design.md](docs/steward-design.md)。

- 面板：`/__polaris/steward/`，入口卡片里在 Heap Guard 下面，5 秒自刷新（页面隐藏时停）。自上而下按"要不要现在动手"分层：
  1. 结论条：一个字的状态（平稳 / 偏高 / 吃紧，按堆占用 65% / 80% 分档）+ 一句话（几个 agent 在跑、
  2. 要我拍板：审批卡片（同意 / 拒绝 + 过期时间）与“会话正在等你回答”的提问卡（问题原文 + 选项 + 代答）
     合成一条队列；顶上还有卡住的 agent、critical 信号的点名行；空时一行灰字。需要人点头的事只有这一处。
  3. 控制：自动动作 / act echo-live / 飞书通知 / 飞书文档 / 立即汇报——这几个按钮改的是它下一步怎么动。
  4. 设置：常用运行期设置的表单（actLevel、预算、升级退役、交办、通知、分类器、导出、会话），保存立即生效；
     “打开 settings.json 全文”跳到外壳里的原始 JSON 编辑器（整份文档编辑，保存前按各 feature schema 校验）。
  5. 交办：一句话 + 验收标准 + 派给谁（新开会话或某个已有会话）→ 建单；下面按状态排队列，
     每单可直接派发 / 完成 / 失败 / 取消。
  6. 对话：主管会话的正文（你 / 主管 / 工具 / 系统四种行），底部输入框回车即发；可新建主管会话、
     绑定已有会话、解绑。这就是“跟总管说话”的入口，和原生会话里打字等价。
  7. 正在发生：在跑的工作流表，下面模块卡片（按 agent 数降序、未归类沉底、带占比条）。
  8. 主管：内置编制的开关、决策树编辑、装备列表；可新增 / 删除 / 恢复默认。
     决策树同时给两种读法：上面是只读的人话步骤（when / call / if…else / wait），下面折叠着原始 JSON。
  9. 能力仓：`api/catalog` 的能力清单（载荷 / 载体 / 授权 / 被谁装备），可按载荷 / 载体 / 关键字过滤，
     也能把片段（plan.*）插进某个主管的树。
  10. 路由：编制 × 能力 × 目标 的 allow / approval / deny 三态格，点一格循环切换（inherit 清除例外）。
  11. Agent 明细：卡住 → 待决 → 运行中 → 空闲排序，同类按最近活动；列是会话名 / 模块 / 状态 / 静默 /
      轮次 / 目标 / 工作目录 / 归属依据 / 看 / 重判。「看」打开右侧抽屉：目标、待办进度、轮次、
      最后活动、最后一句、12 条人话轨迹（读的是该会话真实的 goal/change、todo/write、turn/end 事件）。
  12. 记录：echo 拟执行 + 信号流。
  13. 审计：intent 级留痕（谁、哪个能力、什么决定、为什么），可导出 ndjson（审计 / 流水）。
  14. 追查：trace 列表（触发 / 编制 / 主体 / 状态 / span 数 / 耗时）；点「瀑布」看调用链与「为什么」
      （事实 → 表达式 → 分支 → 授权 → 回执）；可重放 / 钉住 / 导出 / 导出 OTLP。
  15. 体检：9 条自动归因（路由被拒 / 未授权 / 无通道 / 卡住 / 预算耗尽 / 能力失败 / 主管静默 /
      死分支 / 噪声分支），每条只给结论和入口。
      死分支 / 噪声分支），每条只给结论和入口。
  维护：折叠区，强制采样 / 按 agent 判断归类 / 重载能力 / 刷新，加上页脚（journal / 能力 hash / 降级 / export）。
- 观察：`agent/created|disposed|status|error|request-error|turn-stopping|inbox/*`、`subagent/*`、
  `session/created|disposed|event|title` 共 13 类事件，外加每 5 秒 `ctx.agents.list()` 对账
  （宿主只在状态变化时发事件，卡死的 running 不会自己发）；running 且 8 分钟无事件 → `stalled`。
- 待答提问：`userQuestions.continued(agent)`；宿主硬约束是只能查 root agent，所以子 agent 的问题
  只能通过它的父会话 `steer`。
- 路由：pin（面板或 `POST api/pin`）→ 工作区路径前缀 → 标题正则 → **agent 判断** → `unassigned`；
  命中理由写进账本，面板"归属依据"列可见。cwd 来自 `sessions.list()` 的 SessionHeader（`agents.list()`
  不带工作目录），所以"这个会话在哪个仓库干活"就是最硬的证据。确定性路由落空的会交给宿主 llm
  （`agentDefaultModel` 路由，可用 `classifier.provider/model` 覆盖）判断一次，答案按
  `sha1(cwd|title|模块集)` 缓存在 `module-cache.json`（TTL 7 天）；低于 `minConfidence` 的也缓存成
  unassigned，避免每个 tick 反复问模型。
- 模块增删改：面板模块区直接操作（`POST api/modules`，写入 settings.json 的 `modules`）。
  「新增模块」「编辑」「删除」「恢复默认」，字段是 id / 名称 / 工作目录（每行或逗号分隔）/ 标题关键词 /
  host / 启用；id 必须匹配 `^[a-zA-Z0-9_-]{1,32}$`，`unassigned` 保留不可删。保存后立刻 `routeAll()` 重算归属，
  指向被删模块的 pin 自动清掉（响应里的 `droppedPins`）。agent 表里的下拉框仍是 pin（固定到某模块，永久生效），
  「重判」按钮强制重问一次；`GET api/modules` 返回 `modules`（计数）+ `defs`（编辑用定义）+ `pins`。
- 交办（任务队列）：`tasks` 表 + 状态机 `queued → assigned → running → review → done / failed / cancelled`，
  `GET/POST api/tasks`（op = create / update / dispatch / complete / fail / cancel）。派单时把标题、要求、
  验收标准拼成一段 prompt，交给 `sessionController.prompt`（`mode:"followup"`，requestId 幂等）；
  目标可以是 `session:<id>`、`agent:<id>`，或留空即新开一个会话。`tasks.tick()` 按 `tasks.concurrency`
  （默认 1）补槽、按 priority 取单；会话 `turn/end` 时该会话上 running 的单自动转 review。
  `actMode="echo"` 下派发只写 `assigned` + 一行"动作已生成但未发送"，**不建会话、不发消息**。
- 对话（主管会话）：`GET/POST api/chat`（op = send / create / bind / unbind / transcript）。`create` 走
  `sessionController.create` 建一个真会话、改名、写进 settings，并先发一段总管人设；`send` 直接
  `prompt` 进该会话（这一步**不过 echo 闸门**——主人自己说话当然要送达）。`transcript` 把
  `user/message`、`assistant/message`、`tool/result`、`turn/end` 折叠成可读的几行。
- 明细抽屉：`GET api/detail?session=<id>` 读该会话事件，折出目标 / 待办进度 / 轮次 / 最后一句 / 轨迹；
  缓存 4 秒（事件）与 20 秒（详情），面板只在打开抽屉时读，不参与 5 秒轮询。
- 分级授权：`actLevel` 是"总管自己能动手到哪一层"的内层闸门，与 `actMode` 正交：
  L1 只通知；L2 允许只读/低危动作（collect、slim、reload 能力、建单）；L3 才允许写（派单、开会话、
  steer、cancel、改设置）。默认 L2，`GET api/policy` 会列出当前 allows / denies。主人点按钮不受限，
  它自己决定时才查这一层。
- 升级退役：`escalation.enabled` 打开后，卡住的 agent 按阶梯处理——先 steer 问一句卡在哪，冷却后再
  cancel，仍不动就只报警一次；每次动作都过 `actLevel` 与 `actMode` 两道闸，冷却默认 600 秒。
- 能力平面（取代旧的 rules/ 与 wf/defs.js）：**能力 = 插件数据**（`plane/instances.js` 首批 22 条：
  6 个判定 judge.*（expr 载体，只回 {hit, level, reason, evidence}）、6 个动作（ask.owner / steer.session /
  cancel.session / slim.host / report.digest / record.journal）、5 个片段 plan.*（tree 载体，树里 call 别的
  能力）、2 个通知，加上 P3 的 record.larkdoc / assign.task / summarize.llm）。**主管 = 编制数据**
  （`plane/preset.js` 内置「堆守望」+「会话守望」；没有 role 字段，装备了什么能力就有什么职责）。
  **决策只有一处**：主管自己的决策树（`plane/tree.js`，保存期校验未知装备与形状）；能力只提供可插入的
  片段，运行时不回看。`plane/pipeline.js` 按固定顺序裁决：人工在场 → 作用域 → 路由矩阵 → 授权 → 幂等 →
  预算 → 冷却 → 预演，每一步都落 intent/span。控制面是 `api/catalog`、`api/stewards`、`api/routes`、
  `api/tree/snippets|validate`；`POST api/rules/reload`（历史命名）＝重读实例表与编制，hash 是 `plane-<hex>`。
- 工作流引擎：`node:sqlite`（宿主裁剪了 sqlite 时自动降级成 JSON 快照 + ops 重放），12 张表；
  副作用走 intent → effect → result 三段式，幂等键落在 `actions.idem_key`，崩在中间的行由恢复钩子结算；
  step 支持 wait/branch/parallel/judge/remote/compensate；单最小堆定时器 + 1 秒 tick，`wake_at` 落库；
  同一 subject 用租约串行；失败指数退避，超限进 DLQ；`shadow` run 只记账不执行；面板可重放。
- 片段能力：`plan.notify` / `plan.ask` / `plan.agent.stall` / `plan.host.protect` / `plan.digest`
  （原 5 个工作流 1:1 迁移，在 `plane/instances.js` 里是树形数据）。
- 动作分档：默认 L1 只通知。`autoAct` 打开后，`actions.stallSteer` / `actions.heapSlim` 还要各自打开
  才会真的 steer 会话或瘦身（瘦身走 heap-guard 的同一个动作，失败只记降级）。
- 动作有两挡：`actMode="echo"`（默认）下判定照常求值，但通知 / 投递 followup / 代答提问都只把
  message 打出来（面板"拟执行"卡片 + `actions` 里 `kind:"echo"`），不产生任何副作用；主人看过 ack 之后
  把 `actMode` 切到 `live`（面板按钮会二次确认）才真正执行。`autoAct` 与 `actMode` 是两道独立的闸。
- 指标出口：`GET /__polaris/steward/metrics` 输出 Prometheus 文本（堆、P99、崩溃数、agent/模块计数、
  运行与待批、预算、信号、事件、标题缓存）；`export.otlp.enabled=true` 时按 `intervalSec` 把同一份
  指标 POST 到 `<endpoint>/v1/metrics`（resource attributes: service.name=polaris-toolkit）。
- trace / OTLP：`GET /__polaris/steward/api/trace/otlp` 把 trace/span 映射成标准 OTLP JSON
  （sha1 截断 id、unix nanos 时间、attributes 带 trigger/steward/subject），与指标共享服务名，可直接喂 OTLP 后端。
- 审批：`POST api/answer {id, answer, version}` 带版本 CAS，两个端同时点只有一个生效；到期自动作废。
- 上报：desktop 通道（内存环形 200 条）永远可用；飞书走本机 `lark-cli`
  （`notify.larkEnabled=true` 才启用，`notify.minSeverity` 默认 warning）。
- 会话：主管会话由面板「新建主管会话」或 `POST api/chat {op:"create"}` 建立；工作目录默认取 `session.cwd`，没配就用第一个模块的工作区，再退回用户主目录（不用宿主进程的 cwd）
  （`sessionController.create` → 改名 → 写 `session.id`），之后 `session.mode=auto` 才会自己再开；
  `rotateTurns/rotateTokens`（默认 200 轮 / 300k token）留给换届预算，压力公式见设计文档 8.5。
- 联邦：只有 `federation.secret` 长度 >= 16 才启用。HMAC-SHA256 信封、nonce 去重、
  5 分钟时钟偏差、命令白名单（ask/approve/collect/set-policy/pause/resume），默认关。
- 加载安全：`setup` 外层 try/catch，内部每步都包一层 attempt；任何服务缺失只降级
  （`api/state` 的 `degraded` 会列出来），绝不让插件加载失败。

为什么动作必须晚于引擎：总管一旦能动手，就必须先有幂等键与租约，否则"重试一次"可能给同一个 agent
发两遍消息。顺序不能倒（见 docs/steward-design.md 第 6 章）。

---

## 5. 工具（agent 侧）

装了插件后，这 15 个工具会注册进 DSH 的工具表，agent 可以直接调用（agent 侧免令牌；
HTTP 写接口才需要 x-polaris-token）：

| 工具 | 作用 |
| --- | --- |
| heap_status | 返回宿主堆/系统/磁盘/bili 的当前摘要文本 |
| heap_slim | 瘦身会话；scope="all" 时批量（受 maxPerClick 限制）；也可传 sessionId |
| heap_snapshot | 写一份 V8 堆快照并返回路径 |
| heap_bili | 读/写 bili 预算（max、residentMaxMB、warmMax、warmMaxBytes、gc.enabled） |
| steward_observe | 只读快照：每个 agent 的模块归属 / 状态 / 静默时长 / 待答提问 / 最新信号 / 运行流程 / 待批 |
| steward_status | 总管自身的运行状态：能力数 + hash、编制数、trace/effect 计数、工作流统计、待批、预算、通知通道、联邦、降级项 |
| steward_begin | 手工拉起一个工作流（workflow / subject / text / vars），返回 run id 与状态 |
| steward_report | 向主人上报一段文本（title / level），走 notify 通道并记账 |
| steward_ask | 发起一次请示（title / detail / subject / ttlMs），返回审批 id；等主人在面板或飞书答复 |
| steward_trace | 看能力平面的决策轨迹：列表（limit / since）或某条 trace 的瀑布（span + intent + effect）；replay:true 用同一份事实重放，export 导出 jsonl |
| steward_audit | 每条能力意图的审计：谁想对谁做什么、执行 / 预演 / 被拒、为什么；可按 decision / cap / steward 过滤 |
| steward_tasks | 交办：op=create（title + brief + acceptance + target）/ list / dispatch / complete / fail / cancel / archive |
| steward_stewards | 主管编制：op=list / save / delete（它装哪些能力、听哪些事件、决策树长什么样） |
| steward_chat | 和主管会话对话：op=status / bind / unbind / create / send（send 把消息 followup 进那条会话） |
| steward_settings | 读写控制主管的设置：op=get / set（走 schema 校验）/ raw（整份文档）/ replace；与面板、HTTP 共用同一条落盘路径 |

---

## 6. 配置

在 profile 的 cordis.patch.yml 或 --patch 层里按 feature 覆写（config.features["heap-guard"]）：

    - insert:
        - id: polaris-toolkit
          name: 'polaris-toolkit'
          config:
            features:
              heap-guard:
                intervalSec: 30        # 采样间隔
                warnPct: 60            # 等级阈值（占堆上限百分比）
                highPct: 75
                criticalPct: 85
                emergencyPct: 92       # 达到这里会写一条 warning 日志
                bili:
                  enabled: true
                  applyOnStart: false
                  max: 256
                  residentMaxMB: 384
                  warmMax: 8
                  warmMaxBytesMB: 64
                slim:
                  enabled: true        # 这条链路允许存在（总开关）；自动执行还要面板开关
                  level: 3
                  minMB: 8
                  quietSec: 45
                  cooldownMin: 10
                  maxPerHour: 4
                  triggerLevel: warn
                  dryRun: false
                  exclude: ["244dc012", "0ea8ff46", "efadff6e", "42a0ae7a"]
                snapshot:
                  minFreeGB: 5
                  keep: 2

steward 的运行期设置（settings.json 的 `steward` 节，面板控制条可直接改）：

    autoAct: false                     # 总闸：关 = 所有工作流只通知
    actions: { stallSteer: false, heapSlim: false }   # 两类真副作用，仍需各自打开
    notify: { minSeverity: "warning", larkEnabled: false, larkCommand: "lark-cli" }
    session: { mode: "manual", preset: "steward", title: "大内总管",
               model: "auto", rotateTurns: 200, rotateTokens: 300000 }
    federation: { hostId: "win-main", secret: "", peerUrl: "" }
    budgetPerHour: 60                  # 动作预算，超了只保留 critical
    actMode: "echo"                    # echo = 只打印拟执行的动作，live = 真执行
    classifier: { enabled: true, provider: "", model: "", minConfidence: 0.55,
                  maxPerTick: 2, timeoutMs: 12000, maxTokens: 120, ttlDays: 7 }
    export: { prometheus: true, intervalSec: 60,
              otlp: { enabled: false, endpoint: "", headers: {} } }
    modules: [...] / pins: {...}

设置控制面有三条等价入口，都走同一套深合并 + settingsSchema 校验 + 落盘：面板「设置」表单（常用字段）、
外壳的 settings.json 全文编辑器（整份文档，`{v,d}` 信封）、agent 工具 `steward_settings`。非法值一律拒绝且
不落盘，所以“改坏了”不会发生。

两个容易误解的口径：

- `budgetPerHour` **只数真动作**：`echo` 预演、`denied`、`signal`、`settings`、`modules`、`route`、`collect`、
  `digest`、`tool.*`、`session`、`chat` 都不计价，`escalate` / `act` / `slim` / `notify` / 派发与重试才算；
  单条账本可用 `action.charge` 显式覆盖。
- `tasks.retainDays` 控制交办单归档：终态（done / failed / cancelled）超过保留期的单子会在 tick 里被裁掉。

面板上可改的运行期设置（settings.json，改完立即生效）：
autoSlim（自动清理开关，默认关）、slimLevel（瘦身档位）、maxPerClick（每轮上限）。

settings.json 是**带版本信封**的文档，不要手写成裸映射：

    { "v": 1, "d": { "heap-guard": { "slimLevel": 3 }, "steward": { "actMode": "echo" } } }

写入口（面板按钮、POST /__polaris/api/settings）会先把 patch 深合并进现有值，再按该 feature 的
settingsSchema（schemastery）整体校验，非法值直接 400 `invalid-settings` 且**不落盘**；
老格式（裸映射，v=0）在启动时自动升级，未知键保留不丢。

**写请求要令牌**：/__polaris/* 匿名可读（只读 GET 便于排障），但所有非 GET 请求必须带
`x-polaris-token`（或同名 cookie）。令牌在首次安装时随机生成并落在
%USERPROFILE%\.dsh\polaris-toolkit\secret（权限 0600），打开面板时通过 cookie 自动带上；
从命令行改设置要自己加头：

    curl -H "x-polaris-token: $(cat ~/.dsh/polaris-toolkit/secret)" ...


---

## 7. 状态与产物

全部在 %USERPROFILE%\.dsh\polaris-toolkit：

    secret                            写请求令牌（首次启动随机生成，0600）
    install.json                      最近一次安装的记录（版本/来源/文件数/时间）
    settings.json                     运行期设置（版本信封 v + d，按 feature 分节）
    features/heap-guard/samples.csv   采样 CSV（config.csv=true 时）
    features/heap-guard/slim-backup-*/ 每次瘦身前的原文件备份
    features/heap-guard/snapshots/    V8 堆快照
    features/heap-guard/titles.json   会话名缓存（按会话 id，带 mtime/size 校验）
    features/steward/journal-YYYYMMDD.jsonl  总管观察日志（按天滚动，可重放重建内存索引）
    features/steward/steward.db      总管库（node:sqlite；裁剪环境下降级为 steward.db.json + steward.ops.jsonl）
    features/steward/plane-*.jsonl    file 载体的落盘（record.* 的流水记录）
    features/steward/slim-backup-*   被 wf.host.protect 触发瘦身时的原文件备份

启动时会做一次保留期清理：journal-YYYYMMDD.jsonl 保留 30 天，samples.csv 保留 14 天且最多 2 万行。

瘦身档位（bin/slim.mjs）：

- L1 重打包：把上千个小 zstd 帧合并成少量大帧，**内容逐字节等价**（已用 SHA-256 验证）。
- L2 再丢弃 assistant 的流式增量（reasoning/工具调用增量），保留每个 chunk 的最终结果。
- L3 再把超大工具结果裁到 1-2 KB（标注截断了多少字符）。L3 是有损的，面板默认档位是 3，
  重要会话可以先试运行或用 1/2 档。

安全点判定：读会话文件最后几帧，若最新结构记录是 turn/end，且文件在 quietSec 内没再变化，
且宿主没有 runner/工具子进程，且没有 hold 文件，才算安全。被打断的回合在下次加载时由 DSH
自动补出 interrupted 的 turn/end，所以安全点重启/瘦身不会让会话逻辑错乱。

会话名（bin/titles.mjs）：会话开头会写两条 `session/title`——先是机械 fallback（首条人类消息截到约 40 字节），
随后是标题服务的正式结果（source=provider/user）。扫描取**序号最大的那条**（正式名优先）：先扫头部窗口
（默认 96 帧）找正式名，只有拿到 fallback 才继续扫到 max-frames；头部整段都没有才退到尾部窗口（改名场景）。
缓存以 mtime+size 校验，文件一变就重扫；运行中的会话优先用内存里的标题（sessionQuery.readTitleSnapshots）。
缓存条目带格式版本号（v），解析逻辑升级后旧条目自动重扫；缓存键统一为裸会话 id（去掉 session- 前缀），内存标题与磁盘扫描同键。

---

## 8. 新增一个 feature

契约（lib/core/host.js 会按这个调用）：

    export default {
      id: "my-feature",            // 路由段与状态目录名
      title: "My Feature",
      subtitle: "一句话说明",       // 入口卡片上的副标题
      order: 20,                    // 卡片排序
      Config,                       // @deepseek-ai/schemastery 的 z.object（可选）
      settings(config) { return { ... } },   // 运行期可改设置的默认值（可选）
      settingsSchema,               // 运行期设置的校验 schema（schemastery，可选但强烈建议）
                                    // 面板/HTTP 的 patch 先深合并再校验，非法值 400 不落盘
      actions: [                    // 面板按钮元数据（纯声明）
        { id: "do", kind: "button", label: "执行", hint: "说明", confirm: true },
        { id: "auto", kind: "toggle", label: "自动", setting: "autoRun" }
      ],
      setup(scope) { ... },         // 挂载：建采样器、注册路由/工具、onDispose
      action(scope, id, body) {},   // 按钮（非 toggle）的实际执行
      status(scope) {}              // 入口卡片上的实时一行
    };

setup(scope) 可用的 scope API：

- scope.config / scope.dir（= ~/.dsh/polaris-toolkit/features/<id>）/ scope.settings（运行期设置）
- scope.core：sendJson/sendText/sendHtml/readBody/queryOf/intOf + 路径与小工具
- scope.route(method, path, handler)   注册 HTTP 路由（前缀固定为 /__polaris/<id>）
- scope.tool(spec)                     注册一个普通 defineTool spec（宿主负责包装）
- scope.onDispose(fn)                  卸载时的清理
- scope.runtime                        自己放运行时对象
- scope.metrics.gauge(name, read, opts) / .counter(name, opts)  只发布，不许自己造出口
- scope.host                            宿主采样器（sample/peek/last：堆/RSS/事件循环）
- scope.every(ms, fn, { jitter })       统一调度（卸载自动停；堆压时全局降频）
- scope.provide(name, fn) / scope.use(name)   跨 feature 能力注册表（拿不到就降级，不要直接摸别人）
- scope.bus.on(topic, fn) / emit(topic, payload)   工具包事件总线（当前主题：heap/critical）
- scope.log / scope.now / scope.core    日志、时间、路由与响应小工具

约定：每个 feature 只**发布**指标，工具包统一在 GET /__polaris/metrics 暴露 Prometheus 文本，
steward 的导出（/__polaris/steward/metrics、OTLP）复用同一份快照，所以同名指标只有一份。
所有定时任务都走 scope.every（带抖动），宿主堆到 80% 时自动降到 1/4 频率。

然后在 lib/features/index.js 里 import 并加进 FEATURES。工具包会自动：校验 config 片段、
建状态目录、把 feature 面板挂到 /__polaris/<id>/panel、在入口面板里列出卡片。
**toggle 型 action 不用写代码**：宿主会把值写进 settings[setting] 并立即生效。

---

## 9. 设计取舍与已知限制

- **入口是 Polaris Toolkit，Heap Guard 只是 feature**：入口面板是卡片列表 + iframe，
  新功能不必动 client.js。
- **客户端只用经典 script + __ModuleLoader__**：不引入打包器；能 require 的只有
  react 系列、cordis、dsh-client-store、ui-slots、ui-primitives、ui-dockkit。
- **右侧栏 tab 未注册**：右侧栏 tab 需要一个 kind 注册（sidebarRightTabs 服务），
  首版先用左侧栏主面板 + 会话头小按钮，后续要加再说。
- **0.2.1 起服务名变化**：宿主半边只 inject ["webServer","agents","tools"] —— 0.2.1 移除了 webRuntime 服务，写进 inject 会让整行永远等待、静默不挂载；可信 Host 改为探测式获取。
- **客户端依赖用服务名 + 注册必须 try/catch**：客户端半边用 ctx.inject(["slots"], ...) 等服务就绪，不要在 dsh.client.inject 里堆包名——客户端 loader 把每个 inject 名字当 ctx 服务去等（官方客户端条目都不写 ui-slots），等不到就停在 pending，web boot 报 "pending (waiting for service: …)"。注意 @deepseek-ai/dsh-client-ui-slots 并未被移除：它仍是 web 前端内置的核心模块（seed 注册表 = react / react-dom / @deepseek-ai/cordis / zod / @tanstack/react-virtual / dsh-client-store / **dsh-client-ui-slots** / dsh-client-ui-primitives / dsh-client-ui-dockkit），可以在工厂里 require。真正把我们打爆的是**客户端条目里任意注册抛异常**：条目状态变 failed，web boot 立刻报 "Error: web boot: 1 entry did not activate / polaris-toolkit: failed"，所以所有座席注册一律 try/catch 只告警。
- **不要双重挂载**：包既然在 dsh.profile.bundles 里，cordis.patch.yml 就不要再为它写 insert；
  两条挂载 = 两条 /__polaris 路由 = 整个 feature 树挂载失败。
- **只能在重启后生效**：host 半边没有热加载（除非 profile 里装了 hmr）。
- **运行态可能比磁盘旧**：改了 lib/** 但不重启，跑的还是旧代码。面板会弹琥珀横幅、`install.stale` 会变 true、
  `node bin/polaris.mjs doctor` 的 install-drift 检查会告警（都是比较“源码 mtime / install.json 时间 vs 进程启动时间”）。
- **`dsh --profile desktop` 被拒**：desktop profile 由 Electron 应用独占管理，
  想验证组合结果只能在重启后看 Settings -> Plugins。
- **fence**：插件 HTTP 接口要求可信 Host 头（同源转发）；直接跨域 fetch 会被 403。
- **GET 读接口匿名**：写请求要 `x-polaris-token`，但读接口只要 Host 头可信就放行——本机任意进程都能读到
  会话正文（`/api/chat`、`/api/detail`）与审计。这是刻意取舍（便于排障、可无令牌换机器查看），
  完整清单与收紧方法见 [docs/known-limits.md](docs/known-limits.md)。
- **瘦身不是万能**：它减少的是"下次读进堆"的字节；已经加载在堆里的会话，除非重启，
  插件无法释放（DSH 没有空闲卸载路径）。真正的大头建议反馈上游：
  idle session unload/LRU、session/close 命令、裁剪 Session.log/eventsSnapshot、宿主加 --expose-gc。
- **总管只在一个进程里写**：agent 只存在于一台机的宿主进程，所以"谁管它"是物理事实，不需要选主；
  幂等键 + 版本 CAS 覆盖了重复动作与双端审批这两个真实冲突面。
- **联邦默认关**：secret 不填就不建 peer、不收 envelope；跨机只交换摘要与审批，原始日志不出本机。
- **能力与编制都是 JSON 数据不是代码**：装一个能力 = 往实例表加一条记录，改一个主管 = 改它的装备与决策树，
  都不用动管家代码；expr / tree 载体是自研确定性求值器，不 eval、不 Function。
- **等级阈值是按进程上限算的**：如果给宿主加了 --max-old-space-size=8192，
- **回归网**：`npm test`（= `node _test/all.mjs`）跑 16 个单测文件 + 假宿主冒烟，CI 在 Node 20/22/24 上跑同一条命令；
  面板改动由 `test/panel.test.mjs` 用 vm 真跑一遍内联脚本兜底。改代码前先读 [AGENTS.md](AGENTS.md)。
  上限定为 8192，阈值相应变成 4915/6144/6963 MB。

---

## 10. 排障

- 面板 404：确认 profile package.json 的 dsh.profile.bundles 里有 polaris-toolkit，且已重启。
- 面板 403 forbidden：请求没带可信 Host 头（代理/跨域）。用同一浏览器窗口打开 /__polaris/panel。
- 设置改了不生效：settings.json 是即时读取的；如果面板没变，检查 /__polaris/api/settings?feature=heap-guard。
- 自动清理不动手：默认关；另外要等级已达阈值、无 agent 在跑、冷却期已过、每小时未超限。
- 想完全停掉瘦身：config.slim.enabled=false，或面板把自动清理关掉并手动不点按钮。
