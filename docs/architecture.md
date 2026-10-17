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

## 2. 目录

    lib/index.js                 插件入口：PREFIX = "/__polaris"，Config = { features: {} }
    lib/core/host.js             mountToolkit()：feature 生命周期、路由、工具、设置、围栏
    lib/core/paths.js            stateDir() / featureDir(id) / sessionsRoot() 等路径与格式化
    lib/core/settings.js         settings.json（按 feature 分节，原子写，每次读取重读文件）
    lib/core/http.js             sendJson/sendText/sendHtml、readBody、createRouter
    lib/core/fence.js            同源围栏：loopback 信任 + sec-fetch-site 拦截
    lib/core/zstd.js             拼接式 zstd 容器按帧读取（解析帧头/解压）
    lib/features/index.js        FEATURES 登记表（新增功能只改这里 + 新目录）
    lib/features/heap-guard/     首个功能（宿主逻辑、面板 HTML、采样器、瘦身、快照、bili、会话名）
    lib/panel.js                 工具包外壳页（左功能卡片 + 右 iframe）
    lib/client.js                客户端入口：注册左侧栏面板、右侧 tab、会话头 chip、设置页
    bin/slim.mjs                 会话瘦身子进程（L1/L2/L3）
    bin/titles.mjs               会话名扫描子进程（有界读帧）
    install/install.ps1          安装到 %USERPROFILE%\.dsh\profiles\<profile>（注入式 file: 依赖 + pnpm install + 写 bundles）
    _test/run.mjs                离线自测（假 ctx，跑通路由/工具/设置/面板）

## 3. feature 契约

    export default {
      id: "heap-guard",                     // 路由段 <prefix>/heap-guard 与状态目录名
      title: "Heap Guard",
      subtitle: "宿主 V8 堆监控 / 会话安全瘦身 / bili 预算",
      order: 10,                            // 外壳卡片排序
      Config,                               // schemastery（可缺省）
      settings(config),                     // 运行期可改设置的默认值（可缺省）
      actions: [ { id, kind: "button"|"toggle", label, hint, confirm, setting } ],
      setup(scope),                         // 必需：注册路由/工具/采样，用 scope.onDispose 收尾
      async action(scope, id, body) {},      // 非 toggle 的动作实现
      async status(scope) {}                // 可选：外壳卡片上的状态与等级
    }

`scope` = `{ id, ctx, config, dir, settings, core, log, route, tool, onDispose, runtime }`：

- `route(method, path, handler)` 注册到 `<prefix>/<id>` 下；面板必须用相对 URL 访问。
- `tool(spec)` 走 `defineTool` 注册到 DSH 工具表。
- `settings.all()/get(k)/set(patch)` 读写 `settings.json` 的该 feature 分节。
- `onDispose(fn)` 在插件卸载时执行（每个 feature 一个 `ctx.effect`）。
- `runtime` 放面板/工具都要用的实例（采样器、瘦身器、会话名缓存…）。

工具包级路由（lib/core/host.js）：

    GET  /__polaris/            外壳页（独立）
    GET  /__polaris/panel       外壳页（嵌入）
    GET  /__polaris/api/features  功能清单 + 各自 status/settings/actions
    GET  /__polaris/api/settings  全部设置
    POST /__polaris/api/settings  { feature, patch }
    POST /__polaris/api/action    { feature, action, ...body }
                                 kind="toggle" 的动作由宿主直接写 settings[setting]

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

## 6. 面板金字塔

    hero      堆已用 / 上限 / 百分比 + 等级 + 增长 + ETA
    KPI       堆、RSS、agent、会话总量、系统内存、磁盘
    阈值+曲线 warn/high/critical/emergency 四档 + 最近采样
    操作行     按钮 + 瘦身档位 + 每次上限
    会话表     名称 / ID / 工作区 / 大小 / 时间 / 每行清理
    折叠细节   内存分代、系统磁盘、快照、运行状态

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
