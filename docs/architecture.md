# Polaris Toolkit 架构说明

> 一个 DSH 插件入口，内含多个功能（feature）。Heap Guard 只是第一个。

## 1. 装载链

    package.json        dsh.bundle.patch -> cordis.patch.yml ; exports "." 与 "./client"
    cordis.patch.yml    insert: [{ id: polaris-toolkit, name: "polaris-toolkit" }]
    profile/package.json  dsh.profile.bundles 必须列出 "polaris-toolkit"

DSH 只把 `dsh.profile.bundles` 里的包变成 Loader entry（仅仅写进 dependencies 不会挂载）。
宿主侧入口 `lib/index.js` 导出 `{ name, inject, Config, apply }`；客户端侧入口 `lib/client.js`
是 classic 脚本包装（`window.__ModuleLoader__.load({ id: "polaris-toolkit", factory })`）。

    inject = ["webServer", "agents", "tools"]

`webServer` 提供 `register/serve`，`tools` 提供工具注册，`agents` 提供会话/agent 视图。
可选服务用 `ctx.get(name)` 探测（例如 `sessions`、`sessionQuery`），缺席时必须静默降级。

安装方式：`install/install.ps1` 把本仓库写成 profile 的**注入式本地依赖**
（`dependencies["polaris-toolkit"] = "file:<仓库路径>"` + `dependenciesMeta["polaris-toolkit"].injected = true`），
再在该 profile 里跑一次 `pnpm install`；pnpm 按 `package.json` 的 `files` 字段把仓库文件**真实复制**进
`node_modules/polaris-toolkit`（不能用符号链接：插件自身的 `@deepseek-ai/*` 依赖要按该 profile 的
node_modules 解析）。改完仓库必须重跑 install.ps1，宿主代码变了必须重启 DSH。

⚠ profile 的 `package.json` 必须**无 UTF-8 BOM**：`dsh-app-boot` 的 `readProfileManifest()`
（`@deepseek-ai/dsh-app-boot/lib/index.js:913`）对文件原始文本直接 `JSON.parse`，一个 BOM 就会让宿主在启动阶段
抛 `DesktopHostFatalError: Unexpected token '\uFEFF'`，此后每次启动都失败（2026-10-18 的真实事故：
安装脚本用 `UTF8Encoding($true)` 写 manifest，DSH 隔天重启后连续三次启动即崩，最后只能删掉 package.json 救回）。
脚本现在用 `UTF8Encoding($false)` 写、读时剥 BOM、写完再用宿主 node 按 DSH 的方式 `JSON.parse` 校验一次，失败回滚。
（校验用的 JS 走临时文件执行：把带引号的代码内联给 `node -e` 会被 Windows PowerShell 撕掉引号。）

⚠ 反过来，**`.ps1` 源文件自身必须带 UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的 UTF-8 脚本按 ANSI/GBK 解码，
中文注释会吃掉后面的代码，症状是行号错位、函数返回 `$null`。用 `tools.edit` 改完这类文件要重新存成 UTF-8 with BOM。

## 2. 目录

    lib/index.js                 插件入口：PREFIX = "/__polaris"，Config = { features: {} }
    lib/core/host.js             mountToolkit()：feature 生命周期、路由、工具、设置、围栏
    lib/core/paths.js            stateDir() / featureDir(id) / sessionsRoot() 等路径与格式化
    lib/core/settings.js         settings.json（版本信封 v+d、深合并、schemastery 校验、原子写）
    lib/core/statefile.js        loadVersioned / pruneFiles / pruneCsv（版本、迁移、保留期）
    lib/core/metrics.js          gauge/counter 注册表 + 宿主采样器（堆/RSS/事件循环）
    lib/core/secret.js           安装级随机令牌（<stateDir>/secret，0600）
    lib/core/http.js             sendJson/sendText/sendHtml、readBody、createRouter
    lib/core/fence.js            同源围栏：loopback 信任 + sec-fetch-site 拦截 + 写请求令牌比对
    lib/panel/kit.js             面板公共件（服务端半边：注入 kit.js、共享 CSS 变量）
    lib/panel/kit.client.js      浏览器公共件 window.PolarisKit（esc/fmt/api/poll/toast）
    lib/core/zstd.js             拼接式 zstd 容器按帧读取（解析帧头/解压）
    lib/features/index.js        FEATURES 登记表（新增功能只改这里 + 新目录）
    lib/features/heap-guard/     首个功能（宿主逻辑、面板 HTML、采样器、瘦身、快照、bili、会话名）
    lib/features/steward/        大内总管（详见 steward-design.md 与 design-capability-plane.md）
      index.js                   只做装配（约 300 行）：全部构造都包 attempt，失败只降级、不抛
      config.js                  Config/settings/settingsSchema/normalize/readSettings
      state.js                   只读视图；metrics.js 指标发布；brain.js 编排器（tick 骨架 + 事件桥）
      http.js                    路由表 + 5 个 agent 工具 + action/status
      policy.js                  分级授权：actLevel L1/L2/L3 与动作需求表（gate 只记日志不抛）
      tasks.js                   交办队列：tasks 表状态机 + 派单（prompt 幂等）+ tick 补槽 + turn/end 转 review
      actuators/gated.js         echo/live 闸门（echo 只把拟执行动作写进账本）
      panel.js                   金字塔面板：结论 / 待处理 / 控制 / 交办 / 对话 / 正在发生 / 主管 /
                                 能力仓 / 路由 / agent 明细 / 记录 / 审计 / 追查 / 体检 / 维护
      core/{store,db,schema,approvals,bus,health}.js  账本 + 12 表（sqlite 或 JSON 降级）+ 审批
      wf/engine.js               持久工作流引擎（原 5 个内置流程已 1:1 迁成片段能力 plan.*）
      plane/{catalog,instances,preset,tree,expr,carriers,pipeline,grants,mount}.js
                                 能力平面：能力仓 / 首批 22 条实例 / 内置编制 / 决策树 / 表达式载体 /
                                 载体适配 / 裁决管线 / 授权映射 / 装配；lib/core/trace.js 存 trace/span/
                                 effect/intent 并映射 OTLP
      session/{rollup,pressure,handoff,bootstrap}.js    汇总 / 轮换 / 交接 / 会话绑定
      session/{events,chat,detail}.js                  事件读取（4s 缓存）/ 主管会话（建-绑-发-回放）/
                                                      会话明细折叠（目标、待办、轨迹）
      actuators/{notify,prompt,answer}.js + channels/*  动作出口与通知通道
      federation/{envelope,peer}.js                     HMAC 信封与白名单命令
    lib/panel.js                 工具包外壳页（左功能卡片 + 右 iframe）
    lib/client.js                客户端入口：注册左侧栏面板、右侧 tab、会话头 chip、设置页
    bin/polaris.mjs              运维入口：install / doctor / version（install.ps1 是它的薄壳）
    bin/slim.mjs                 会话瘦身子进程（L1/L2/L3）
    bin/titles.mjs               会话名扫描子进程（有界读帧）
    install/install.ps1          安装到 %USERPROFILE%\.dsh\profiles\<profile>（注入式 file: 依赖 + pnpm install + 写 bundles）
    _test/run.mjs                离线自测（假 ctx，把整包挂一遍：路由/工具/设置/面板）
    test/*.test.mjs              node:test 单测与集成测试（npm test 先跑这一层）

## 3. feature 契约

    export default {
      id: "heap-guard",                     // 路由段 <prefix>/heap-guard 与状态目录名
      title: "Heap Guard",
      subtitle: "宿主 V8 堆监控 / 会话安全瘦身 / bili 预算",
      order: 10,                            // 外壳卡片排序
      Config,                               // schemastery（可缺省）
      settings(config),                     // 运行期可改设置的默认值（可缺省）
      settingsSchema,                       // 运行期设置的校验 schema（可缺省，建议必填）
      actions: [ { id, kind: "button"|"toggle", label, hint, confirm, setting } ],
      setup(scope),                         // 必需：注册路由/工具/采样，用 scope.onDispose 收尾
      async action(scope, id, body) {},      // 非 toggle 的动作实现
      async status(scope) {}                // 可选：外壳卡片上的状态与等级
    }

`scope` = `{ id, ctx, config, dir, settings, core, log, now, route, tool, onDispose, runtime, shared,
metrics, host, every, provide, use, bus }`：

- `route(method, path, handler)` 注册到 `<prefix>/<id>` 下；面板必须用相对 URL 访问。
- `tool(spec)` 走 `defineTool` 注册到 DSH 工具表。
- `settings.all()/get(k)/set(patch)/validate(patch)` 读写 `settings.json` 的该 feature 分节；
  `set` 先深合并再按 `settingsSchema` 校验，非法时抛 `SettingsError`（HTTP 层映射成 400）。
- `onDispose(fn)` 在插件卸载时执行（每个 feature 一个 `ctx.effect`）。
- `runtime` 放面板/工具都要用的实例（采样器、瘦身器、会话名缓存…）。
- `metrics.gauge(name, read, { help, labels })` / `metrics.counter(name)`：**只发布**，出口由工具包统一提供。
- `host`：工具包级宿主采样器（`sample()/peek()/last`），避免每个 feature 各采一遍堆和事件循环。
- `every(ms, fn, { jitter })`：统一调度句柄，卸载自动停；堆压时全局降频（80%→1/4，65%→1/2）。
- `provide(name, fn)` / `use(name)`：跨 feature 能力注册表。`use` 拿不到就返回 undefined，
  调用方必须降级（例：steward `use("heap-guard.action")` 触发瘦身、`use("heap-guard.titles")` 取会话名）。
- `bus.on(topic, fn)` / `bus.emit(topic, payload)`：工具包事件总线，当前主题 `heap/critical`。
- `shared.runtimes` 仍然保留（`Map<featureId, record>`，只暴露 record 的 `action/status`），
  但新代码应当走 `provide/use`：它按能力命名，不依赖某个 feature 的内部形状。

加载隔离是硬要求：feature 的 `setup` 外层必须 try/catch，内部每一步构造也要单独兜底，
任何服务缺失/异常只能降级（面板与 `api/state` 里能看到 degraded），绝不能让插件加载失败——
一个 feature 抛异常会连累整行 bundle 的挂载。

工具包级路由（lib/core/host.js）：

    GET  /__polaris/            外壳页（独立）
    GET  /__polaris/panel       外壳页（嵌入）
    GET  /__polaris/api/features  功能清单 + 各自 status/degraded/settings/actions，
                                 附带 install / metrics / scheduler / capabilities / bus
    GET  /__polaris/api/install   最近一次安装记录
    GET  /__polaris/metrics       Prometheus 文本（所有 feature 发布 + 宿主默认指标）
    GET  /__polaris/kit.js        浏览器公共件
    GET  /__polaris/api/settings  全部设置
    POST /__polaris/api/settings  { feature, patch }  -> 校验失败 400 code="invalid-settings"
    POST /__polaris/api/action    { feature, action, ...body }
                                 kind="toggle" 的动作由宿主直接写 settings[setting]

**写操作令牌**：只读 GET 匿名放行（排障方便），所有非 GET 请求必须带 `x-polaris-token`
（或同名 cookie），否则 401/403。令牌首次启动随机生成、落在 `<stateDir>/secret`（0600），
面板页在 `sendPanel` 里以 `Set-Cookie` 下发，所以浏览器里点按钮无需配置；命令行要自己带头。

**degraded**：feature 的 `setup`/`route`/`tool` 任何一环抛异常都只记 `record.degraded =
{ phase, error, at }`，卡片状态变成 high 并显示原因；该 feature 的 HTTP 入口回 503，其余 feature 与
工具包本身照常工作。`/api/features` 里能直接看到 `degraded` 字段。

## 4. 客户端表面

lib/client.js 用槽位注册，四处入口共享同一个落点：

    sidebar.panellist + main                  左侧栏中的 Polaris Toolkit 面板
    sidebar.right.pane.tab(+ .title)          右侧栏 Tab（可选）
    conversation.session.header.utilities     会话头小按钮
    settings.section                          设置页一节

外壳页 lib/panel.js 与功能面板之间只有两条消息（`window.postMessage`，同源 iframe）：

    polaris:hello   面板加载完主动问"我可见吗"
    polaris:active  { id, active } 外壳告知可见性与当前 feature

面板据此暂停/恢复轮询。客户端注册必须 **逐个 try/catch**：0.2.1 里客户端条目注册抛异常
会让整个 web 启动判定成 "failed"（不是 pending），从而连累其他插件。

## 5. Heap Guard 数据流

    Sampler(ctx) --30s--> state.last / history(ring) / samples.csv
    AutoSlimmer  --等级>=warn & 安全点 & 冷却--> runSlim() 子进程 bin/slim.mjs
    TitleStore   --缺失或文件变化--> 子进程 bin/titles.mjs（头部 <=96 帧，必要时全头/尾部）
    Snapshot     --手工/工具--> v8.writeHeapSnapshot() + 轮转保留 2 份
    bili         --面板/工具--> 写 billion-context.json（重启后生效）

会话名缓存：`features/heap-guard/titles.json`，以 mtime+size 校验；运行中的会话优先用
`sessionQuery.readTitleSnapshots()` 的内存标题。识别标题时**取序号最大的一条**
（fallback 是首条消息截断名，provider/user 才是正式名）。
缓存条目带格式版本号（`v`），扫描/解析逻辑一变，旧条目自动失效重扫；缓存键统一成去掉
`session-` 前缀的裸会话 id，内存标题与磁盘扫描因此共用同一份条目。

## 6. 面板金字塔

    hero      堆已用 / 上限 / 百分比 + 等级 + 增长 + ETA
    KPI       堆、RSS、agent、会话总量、系统内存、磁盘
    阈值+曲线 warn/high/critical/emergency 四档 + 最近采样
    操作行     按钮 + 瘦身档位 + 每次上限
    会话表     名称 / ID / 工作区 / 大小 / 时间 / 每行清理
    折叠细节   内存分代、系统磁盘、快照、运行状态

Steward 面板用同一套金字塔，但按"要不要主人动手"分层：

    hero       一个字状态 + 一句话结论 + 6 个 KPI（堆%、P99、agent、流程/待批、信号、策略）
    待处理     待批卡片 + 卡住的 agent / critical 信号点名（空则一行灰字）
    控制       自动动作 / act echo-live / 飞书 IM / 飞书文档 / 立即汇报
    交办       一句话 + 验收标准 + 派给谁 -> 建单；下面按状态排队列 + 派发/完成/失败/取消
    对话       主管会话正文（你 / 主管 / 工具 / 系统）+ 输入框；新建 / 绑定 / 解绑
    正在发生   工作流表 + 模块卡片（按 agent 数降序、未归类沉底、占比条）
    主管       编制开关 / 决策树编辑 / 装备列表；新增 / 删除 / 恢复默认
    能力仓     能力清单（载荷 / 载体 / 授权 / 被谁装备）+ 过滤 + 片段插入
    路由       编制 x 能力 x 目标 的 allow / approval / deny 三态格（inherit 清例外）
    agent 表   卡住 -> 待决 -> 运行中 -> 空闲，同类按最近活动；行尾「看」开详情抽屉
    记录       echo 拟执行 + 信号流
    审计       intent 级留痕 + ndjson 导出（审计 / 流水）
    追查       trace 列表 + 瀑布 / 为什么 / 重放 / 钉住 / 导出 / 导出 OTLP
    体检       9 条自动归因（路由被拒 / 未授权 / 无通道 / 卡住 / 预算耗尽 / 能力失败 /
               主管静默 / 死分支 / 噪声分支），只给结论和入口
    维护       折叠：强制采样 / 归类 / 重载能力 / 刷新 + 页脚

## 6.5 指挥台：对话、交办、明细、分级授权

四件事共用一条链：**主人说话 / 下单 -> 总管落到某个会话 -> 会话产生事件 -> 面板读回事件**。
面板不直接写会话，全部经 `sessionController` 与 `sessionQuery`，且读路径带缓存（否则 5 秒轮询会把
整份会话日志反复 load 进宿主堆）。

    对话  GET  <p>/api/chat                     { chat, transcript }
          POST <p>/api/chat  op=create|bind|unbind|send|transcript
          create -> sessionController.create({ cwd, agentPreset }) -> rename -> settings.session.id
          send   -> sessionController.prompt({ mode:"followup", requestId })（不过 echo 闸门）
    交办  GET  <p>/api/tasks                    { tasks, summary }
          POST <p>/api/tasks op=create|update|dispatch|complete|fail|cancel
    明细  GET  <p>/api/detail?session=<id>      目标 / 待办 / 轮次 / 最后一句 / 轨迹
    授权  GET  <p>/api/policy                  { policy, actMode, actLevel, escalation }

**任务状态机**：`queued -> assigned -> running -> review -> done / failed / cancelled`。
`dispatch` 先过策略（`task.dispatch` 需要 L3）与 `actMode`：echo 只把单子写成 `assigned` 并留一句
"动作已生成但未发送"，**预览不能有副作用**（不建会话、不发消息）；live 才解析目标
（`session:<id>` / `agent:<id>` / 空 = 新开会话）并 `prompt`。失败累加 `attempts`，
到 `tasks.maxAttempts`（默认 3）转 `failed`，否则回 `queued` 等下一轮。`tasks.tick()` 按
`tasks.concurrency`（默认 1）补槽；会话 `turn/end` 时该会话上的 `running` 单转 `review`。

**分级授权**（`policy.js`）：`actMode` 是最外层"要不要真的动"，`actLevel` 是内层"总管自己能动到哪"。

    L1  只通知                       notify.send / digest.send
    L2  只读与低危                   collect / slim / reload 能力 / task.create
    L3  写：派单、开会话、steer、cancel、改设置

默认 L2；未列出的动作一律按 L3 处理（默认收紧）。主人从面板点按钮不受这一层限制——
这一层只约束总管自己决定的时候。`gate()` 拒绝时只记 debug 日志，由调用方降级。

**升级退役**：`escalation.enabled` 打开后，卡住的 agent 阶梯推进——先 `steer` 问一句卡在哪，
冷却（默认 600 秒）后 `cancel`，仍不动则只报警一次；每步都先过 `actLevel` 与 `actMode`。


## 6.6 能力平面（capability plane）

**能力 = 数据，主管 = 数据，决策 = 主管自己的树**。装什么能力就有什么职责，没有 role 字段。

    能力仓  GET  <p>/api/catalog            { capabilities, usedBy, byPayload, byCarrier, hash }
            GET  <p>/api/tree/snippets      plan.* 片段（可插进树里）
            POST <p>/api/tree/validate      { steward } -> { valid, errors }（坏树也返回 200）
    主管    GET  <p>/api/stewards            { stewards, matrix }
            POST <p>/api/stewards           op=save|delete|enable|reset
    路由    GET  <p>/api/routes             三态矩阵（allow / approval / deny）
            POST <p>/api/routes             op=cell { steward, cap, target, route }（inherit 清例外）
    体检    GET  <p>/api/doctor             9 条自动归因（症状 -> 结论 -> 入口）
    观测    GET  <p>/api/audit[?cap=&decision=&steward=&since=]   intent 级审计（ndjson 导出）
            GET  <p>/api/trace[?limit=&since=&steward=&trigger=]  trace 列表
            GET  <p>/api/trace?id=<id>      瀑布 + 为什么 + intents
            POST <p>/api/trace/replay       用事实快照重跑树（不执行能力）
            GET  <p>/api/trace/diff         同一 subject 的最近两条 trace 对比
            GET  <p>/api/trace/otlp         OTLP resourceSpans（sha1 id + unix nanos）

裁决顺序固定在 `plane/pipeline.js`：人工在场 -> 作用域 -> 路由矩阵 -> 授权 -> 幂等 -> 预算 -> 冷却 ->
预演；每一步都落 intent/span，被拒的意图也入库。新增载体（lark.doc / file / llm / task）只是
`plane/carriers.js` 里多一个适配器 + `plane/instances.js` 里多一条实例，**不改主管与编排器代码**。

## 7. 硬约束

- 插件 **不能** 释放别人的会话堆内存；只能 `AgentHandle.dispose()` 自己持有的 agent。
- 宿主不能通过 IPC 重启应用；只有 out-of-process 独立进程能重启（且宿主退出会弹恢复框）。
- 强制 GC 基本无效；归档不释放内存。
- 任何大文件扫描都放子进程并有界，绝不进宿主堆。
- 所有前端请求相对页面 base 解析，不写死 host/port。
- 外壳轮询只更新左侧卡片；iframe 只在切换功能时换源（否则每 5 秒整页重载）。
- 面板重绘要有签名守卫（actions 开关状态、行数据），否则每 5 秒丢焦点/收起状态。

## 8. 自测

    cd D:\agent\polaris-toolkit
    node _test/run.mjs

假 ctx 覆盖 `logger/effect/webServer.register/tools.register/agents/ctx.get`，断言路由数、
工具名、动作表、设置往返（含 toggle）、面板 HTML 关键片段、404 与围栏行为。
