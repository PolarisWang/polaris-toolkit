# Polaris Toolkit

一个 DSH（DeepSeek Harness）**多功能工具包**插件。Polaris Toolkit 是入口包，
下面的每个能力都是一个 feature；当前内置 **Heap Guard**（宿主 V8 堆监控 / 会话安全瘦身 / bili 预算控制），
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
          host.js           工具包宿主：feature 生命周期、路由收集、设置存储、工具注册
          paths.js          ~/.dsh/polaris-toolkit 下的路径与 CSV/格式化小工具
          settings.js       settings.json 读写（每个 feature 一节，改完立即生效）
          http.js           极简路由 + JSON/HTML 响应 + 请求体读取
          fence.js          宿主来源校验（Host 头/同源）
          zstd.js           多帧 zstd 解析（session.v4.jsonl.zstd 是逐次追加的多帧文件）
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
      bin/slim.mjs          独立瘦身脚本（子进程运行，可脱离插件单用）
      install/
        install.ps1         安装到 profile（复制文件 + 写 bundles + 清退旧包）
        uninstall.ps1       卸载
      _test/run.mjs         离线自测（假 ctx，不连 DSH；node _test/run.mjs）

---

## 3. 安装 / 升级 / 卸载

在仓库根目录执行（PowerShell 5.1 即可）：

    powershell -ExecutionPolicy Bypass -File install\install.ps1

它做四件事：备份 profile 的 package.json -> 清退旧包 dsh-heap-guard（如存在）->
复制 lib/bin/package.json/cordis.patch.yml/README.md 到
    %USERPROFILE%\.dsh\profiles\desktop\node_modules\polaris-toolkit
-> 把 "polaris-toolkit" 追加进 dsh.profile.bundles。

参数：-Profile <目录>（默认 desktop）、-NoBundles（只复制不挂载）、-KeepOld（保留旧包）。

**安装后必须重启 DSH**：host 半边在启动时加载，页面刷新不够。

升级：重新跑一次 install.ps1（会先删旧目录再复制）。
卸载：powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
（状态数据保留在 %USERPROFILE%\.dsh\polaris-toolkit，可自行删除）。

开发用的 _test/ 与 node_modules 联接不会被复制到 profile。

---

## 4. 面板：金字塔布局

打开左侧栏 **Polaris Toolkit** -> 选 **Heap Guard**，或直接访问 /__polaris/panel。
自上而下五层，越往下越细：

1. **第一层 结论**：当前堆占用 / 上限 / 百分比 + 等级徽章 + 每分钟增长 + 预计到达上限的时间。
   一眼只需要这一行。
2. **第二层 KPI**：堆、RSS、agent 数、会话总量、系统内存、磁盘剩余。
3. **第三层 阈值与趋势**：warn/high/critical/emergency 四档进度条 + 最近采样曲线。
4. **第四层 操作**：按钮区 + 瘦身档位下拉 + 每次上限输入。
5. **第五层 候选会话表**：按体积排序的会话（大小/工作区/是否已关闭/最后修改），每行一个"清理"按钮。
6. **折叠区**（默认收起）：内存分代明细、系统与磁盘、堆快照、运行状态（状态目录、上次动作、错误）。

面板每 5 秒刷新一次；所有请求都相对页面解析（不看主机名/端口），因此反代或自定义端口都能用。

### 功能按钮

| 按钮 | 行为 |
| --- | --- |
| 立即清理（最大） | 对当前最大的安全候选（已关闭且超过 minMB）执行一次瘦身，默认按面板档位 |
| 立即清理（全部候选） | 串行清理全部候选，每轮受"每次上限"限制（默认 20），执行前确认 |
| 试运行 | 只统计能省多少字节，不写盘 |
| 自动清理 | **开关**，默认关。打开后：等级达到阈值 + 处于安全点（无 agent 在跑）+ 冷却期已过 + 每小时次数未超限，才自动清理一个会话 |
| 写堆快照 | 手工 v8.writeHeapSnapshot()（默认保留最新 2 份，磁盘低于 5 GB 时拒绝） |
| 应用 bili 预算 | 把面板里的 max/residentMaxBytes/warmMax/warmMaxBytes 写进 bili 配置 |

自动清理的节流（可在 Config 改）：单次只处理一个会话、冷却 10 分钟、每小时最多 4 次、
只在等级 >= warn 时触发、任何 agent 在跑就不动手。

---

## 5. 工具（agent 侧）

装了插件后，工具会注册进 DSH 的工具表，agent 也可以直接调用：

| 工具 | 作用 |
| --- | --- |
| heap_status | 返回宿主堆/系统/磁盘/bili 的当前摘要文本 |
| heap_slim | 瘦身会话；scope="all" 时批量（受 maxPerClick 限制）；也可传 sessionId |
| heap_snapshot | 写一份 V8 堆快照并返回路径 |
| heap_bili | 读/写 bili 预算（max、residentMaxMB、warmMax、warmMaxBytes、gc.enabled） |

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

面板上可改的运行期设置（settings.json，改完立即生效）：
autoSlim（自动清理开关，默认关）、slimLevel（瘦身档位）、maxPerClick（每轮上限）。

---

## 7. 状态与产物

全部在 %USERPROFILE%\.dsh\polaris-toolkit：

    settings.json                     运行期设置（按 feature 分节）
    features/heap-guard/samples.csv   采样 CSV（config.csv=true 时）
    features/heap-guard/slim-backup-*/ 每次瘦身前的原文件备份
    features/heap-guard/snapshots/    V8 堆快照

瘦身档位（bin/slim.mjs）：

- L1 重打包：把上千个小 zstd 帧合并成少量大帧，**内容逐字节等价**（已用 SHA-256 验证）。
- L2 再丢弃 assistant 的流式增量（reasoning/工具调用增量），保留每个 chunk 的最终结果。
- L3 再把超大工具结果裁到 1-2 KB（标注截断了多少字符）。L3 是有损的，面板默认档位是 3，
  重要会话可以先试运行或用 1/2 档。

安全点判定：读会话文件最后几帧，若最新结构记录是 turn/end，且文件在 quietSec 内没再变化，
且宿主没有 runner/工具子进程，且没有 hold 文件，才算安全。被打断的回合在下次加载时由 DSH
自动补出 interrupted 的 turn/end，所以安全点重启/瘦身不会让会话逻辑错乱。

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
- **客户端依赖只用服务名**：客户端半边用 ctx.inject(["slots"], ...) 等服务就绪，不要在 dsh.client.inject 里写包名；0.2.1 已移除 @deepseek-ai/dsh-client-ui-slots，写死包名会让条目 "did not activate" 并导致 web boot 报错。
- **不要双重挂载**：包既然在 dsh.profile.bundles 里，cordis.patch.yml 就不要再为它写 insert；
  两条挂载 = 两条 /__polaris 路由 = 整个 feature 树挂载失败。
- **只能在重启后生效**：host 半边没有热加载（除非 profile 里装了 hmr）。
- **`dsh --profile desktop` 被拒**：desktop profile 由 Electron 应用独占管理，
  想验证组合结果只能在重启后看 Settings -> Plugins。
- **fence**：插件 HTTP 接口要求可信 Host 头（同源转发）；直接跨域 fetch 会被 403。
- **瘦身不是万能**：它减少的是"下次读进堆"的字节；已经加载在堆里的会话，除非重启，
  插件无法释放（DSH 没有空闲卸载路径）。真正的大头建议反馈上游：
  idle session unload/LRU、session/close 命令、裁剪 Session.log/eventsSnapshot、宿主加 --expose-gc。
- **等级阈值是按进程上限算的**：如果给宿主加了 --max-old-space-size=8192，
  上限定为 8192，阈值相应变成 4915/6144/6963 MB。

---

## 10. 排障

- 面板 404：确认 profile package.json 的 dsh.profile.bundles 里有 polaris-toolkit，且已重启。
- 面板 403 forbidden：请求没带可信 Host 头（代理/跨域）。用同一浏览器窗口打开 /__polaris/panel。
- 设置改了不生效：settings.json 是即时读取的；如果面板没变，检查 /__polaris/api/settings?feature=heap-guard。
- 自动清理不动手：默认关；另外要等级已达阈值、无 agent 在跑、冷却期已过、每小时未超限。
- 想完全停掉瘦身：config.slim.enabled=false，或面板把自动清理关掉并手动不点按钮。
