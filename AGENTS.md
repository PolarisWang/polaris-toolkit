# AGENTS.md — 在这个仓库里干活的约定

面向"下一个来改这个插件的人（或 agent）"。这里只写不读代码看不出来的东西；
架构与能力平面的权威说明在 [docs/design-capability-plane.md](docs/design-capability-plane.md)，
运行手册在 [README.md](README.md)。

## 一条命令跑完自测

    node _test/all.mjs              # 16 个单测文件 + 假宿主冒烟（跨平台，CI 用的就是它）
    node _test/all.mjs --coverage   # 追加覆盖率门槛（Node 22.8+：行 60 / 函数 50 / 分支 50）
    node bin/polaris.mjs doctor     # 装机体检：清单 BOM、注入式依赖、bundle patch、install.json、代码漂移
    node bin/polaris.mjs install    # 装进 profile（会写清单、跑 pnpm、更新 install.json）

改了 host 半边（lib/**, cordis.patch.yml）必须重启宿主才生效：Node 不会重新 import 已装载的模块。
插件会在面板和 `GET /api/features` 的 `install.stale` 里提示"磁盘比进程新"，doctor 的
`install-drift` 检查也会告警；不要用"改了没反应"当结论，先看这个标志。

## 不能破坏的硬约束

- **能力不是代码，是数据**：新增能力 = 往 `lib/features/steward/plane/instances.js` 加一条记录
  （id / payload / carrier / target / protocol / grant / tags / params / limits），新增载体 =
  在 `plane/carriers.js` 注册一个适配器。**不要**再引入 rules 引擎或 `wf/defs.js` 那种硬编码剧本
  （v2.1 已把它们 1:1 迁进能力实例；`rules/`、`wf/defs.js` 已删除）。`wf/engine.js` 只留着读历史 runs。
- **裁决只有一处**：`plane/pipeline.js` 的顺序是 人工在场 > 作用域 > 路由 > 授权 > 幂等 > 预算 > 冷却。
  拦截、预演、审计都在这里落痕；不要在调用方再写第二套 gate。
- **账本 kind 决定预算**：`store.chargeOf(action)` 用 `FREE_KINDS` 白名单判定谁免费（echo / denied /
  signal / settings / modules / route / collect / digest / tool.* / session / chat）；新加一个 `pushAction`
  kind 时要么进 FREE_KINDS，要么接受它计入 `budgetPerHour`（否则空转就把预算烧满并抑制工作流，
  这个 bug 修过一次）。
- **写接口要令牌**：宿主侧 `authorize()` 对非 GET/HEAD/OPTIONS 校验 `x-polaris-token`
  （面板自动带 cookie）。GET 一律匿名——这是刻意的（见 docs/known-limits.md），别顺手加鉴权。
- **工具参数 schema 里 object 必须显式 additionalProperties**：`tools.register` 校验很死，
  漏了会 "JsonSchemaError: parameters.patch.additionalProperties must be explicitly true or false"，
  工具会被静默拒绝（只看日志里的 warn）。
- **插件运行时不能 bare-import `@deepseek-ai/*`**：一律 `ctx.get(name)`；`inject` 只列真实存在的服务
  （0.2.1 没有 `webRuntime`，写进 inject 会让整行永远等待）。
- **客户端条目里每次座席注册都要 try/catch**：任意一个注册抛异常，web boot 直接
  "1 entry did not activate"。客户端用 `ctx.inject(["slots"], ...)` 等服务就绪。
- **不要双挂载**：包已在 `dsh.profile.bundles`，`cordis.patch.yml` 就不要再 insert 一条。

## 文件格式的地雷（都踩过）

- `README.md` 是 **CRLF**：用 `\n` 拼的多行锚点匹配不到，改动要按行或先 split("\r\n")。
- `lib/features/steward/http.js` 也是 CRLF。
- `install/*.ps1` 必须是 **UTF-8 with BOM**，否则 Windows PowerShell 按 GBK 解码，中文注释变乱码、
  报错行号全错（`test/install-env.test.mjs` 守着这条）；profile 的 `package.json`
  反过来**不能带 BOM**，否则宿主启动即 "is not valid JSON"。
- 面板 HTML 是**单个模板字符串**：插进去的浏览器 JS 里每个反斜杠都要写两遍，
  否则渲染出的内联脚本提前闭合。改完必须用 `test/panel.test.mjs` 的 vm 冒烟兜底。
- 面板脚本包在 IIFE 里，内联 `onclick="fn()"` 在全局作用域求值：新函数必须加进 `GLOBAL_FNS`
  并挂到 `window`；`test/panel.test.mjs` 会逐个断言 onclick 名字在 window 上。
- 宿主 `sessionQuery` 的每次读都会把整份会话日志 load 一遍并 structuredClone：给面板用的读必须
  自己折叠缓存（`steward/session/events.js`），别在 5 秒轮询里直接调。

## 测试怎么写

- 用 `test/helpers/harness.mjs`：它在模块加载期就把 `DSH_HOME` 指到临时目录，导出的
  `mount()` 返回假宿主的 routes / tools / logs，`call(handler, method, url, body)` 发一个假请求。
  别在每个测试文件里再手写一份假 ctx（评审指出过这是最大的重复面）。
- 面板改动跑 `test/panel.test.mjs`：它用 `node:vm` 造 document 垫片（未知 id 会显式报错，能抓
  "引用已删除元素"），先注入 `lib/panel/kit.client.js` 再执行内联脚本，并把 fetch 真打到假宿主。
- 测试不能在真实 `~/.dsh` 上留痕：所有状态都落在临时 HOME（harness / `_test/run.mjs` / install-env 都如此）。

## 交付动作

    1) node _test/all.mjs                        # 全绿
    2) node bin/polaris.mjs install              # 装到 profile（76+ 文件）
    3) node bin/polaris.mjs doctor               # 全 ok
    4) git add -A && git commit -F <临时文件>     # pwsh 里双引号不可转义，信息写文件更稳
    5) git -c http.proxy=http://127.0.0.1:8899 -c credential.interactive=false push origin main

第 5 步的代理是本机 DNS 被阻断时的绕行（`Documents/polaris-github-proxy.mjs`，把 github.com 钉到
可达 IP）；换机器/网络前先 `git ls-remote origin` 确认，别把代理写进 git config。
