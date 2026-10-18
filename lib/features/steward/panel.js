/**
 * Steward 面板。
 *
 * 布局按金字塔：顶部一行宿主结论 → 控制条 → 模块卡片 → agent 明细 →
 * 工作流 / 待批 → 信号流。所有按钮都走 feature 自己的 api，默认只读；
 * 有副作用的开关（autoAct / lark）必须人点，且回写 settings。
 */
export function stewardPanelHtml({ embed } = {}) {
  const bodyClass = embed === false ? "" : "embed";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steward</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#232b36;--fg:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--err:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body.embed{padding:14px 16px 32px}
h1{font-size:15px;margin:0 0 2px;font-weight:600}
.sub{color:var(--dim);font-size:11px;margin-bottom:12px}
.hero{background:linear-gradient(180deg,#182131,#12171f);border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.hero .big{font-size:26px;font-weight:700;letter-spacing:.5px}
.hero .kv{color:var(--dim);font-size:11px}
.hero .kv b{display:block;color:var(--fg);font-size:13px;font-weight:600;margin-top:2px}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line);color:var(--dim)}
.pill.ok{color:var(--ok);border-color:#1f6f34}.pill.warn{color:var(--warn);border-color:#6b4a12}.pill.err{color:var(--err);border-color:#7d2b26}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:20px 0 8px;font-weight:600}
.mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.mod{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px 12px}
.mod .name{font-weight:600;display:flex;justify-content:space-between;gap:8px}
.mod .meta{color:var(--dim);font-size:11px;margin-top:3px}
.mod.attention{border-color:#6b4a12;box-shadow:inset 3px 0 0 var(--warn)}
table{width:100%;border-collapse:collapse;margin-top:6px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:11px}
tr:last-child td{border-bottom:none}
td.mono,.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dim)}
.sig{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px}
.sig .t{color:var(--dim);font-family:ui-monospace,Consolas,monospace;font-size:11px;min-width:52px}
.sig .k{min-width:120px;color:var(--accent)}
.tools{display:flex;gap:8px;margin:8px 0 0;flex-wrap:wrap;align-items:center}
button{background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.on{border-color:#1f6f34;color:var(--ok)}
button.danger{border-color:#7d2b26;color:var(--err)}
.empty{color:var(--dim);font-size:12px;padding:6px 0}
.appr{background:var(--card);border:1px solid #6b4a12;border-radius:9px;padding:10px 12px;margin-bottom:8px}
.appr .t{font-weight:600}
.appr .d{color:var(--dim);font-size:12px;margin:4px 0 8px;white-space:pre-wrap}
.hero.verdict{align-items:flex-start;justify-content:space-between;border-left:3px solid var(--ok)}
.hero.verdict.warn{border-left-color:var(--warn)}
.hero.verdict.err{border-left-color:var(--err)}
.vword{font-size:28px;font-weight:700;line-height:1;letter-spacing:.02em}
.vword.ok{color:var(--ok)}.vword.warn{color:var(--warn)}.vword.err{color:var(--err)}
.vsum{color:var(--dim);font-size:12px;margin-top:8px;max-width:58ch}
.kpis{display:flex;gap:20px;flex-wrap:wrap}
.kpis .k{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.kpis .k b{display:block;font-size:15px;color:var(--fg);font-weight:600;margin-top:3px;letter-spacing:0;text-transform:none}
.kpis .k b.warn{color:var(--warn)}.kpis .k b.err{color:var(--err)}
.sec{margin-top:20px}
.sech{display:flex;align-items:baseline;gap:8px;border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:10px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--dim);text-transform:uppercase}
.sech .tier{font-size:10px;color:var(--accent);border:1px solid var(--line);border-radius:4px;padding:0 5px;line-height:14px}
.sech .sechint{font-weight:400;letter-spacing:0;text-transform:none;font-size:11px;opacity:.85}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:16px 0 6px;font-weight:600}
.attn.none{color:var(--dim);font-size:12px;padding:2px 0}
.mods .bar{height:4px;background:#0d1117;border-radius:999px;margin-top:7px;overflow:hidden}
.mods .bar i{display:block;height:100%;background:var(--accent);border-radius:999px;opacity:.75}
.modcat{border:1px solid var(--line);border-radius:7px;padding:7px 9px;margin:6px 0}
.modcat .name{font-size:12px}
.rcell{margin:2px 3px 2px 0;padding:2px 6px;border-radius:5px;font:11px ui-monospace,Consolas,monospace}
.rcell span{opacity:.7;margin-left:5px}
.rcell.allow{border-color:#2f6f4f}
.rcell.deny{border-color:#7a3b3b}
.rcell.approval{border-color:#7a6a3b}
.rcell.inherit{opacity:.55}
details.maint{margin-top:24px;border-top:1px dashed var(--line);padding-top:10px}
details.maint summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em;outline:none}
.sec input[type=text],.sec input:not([type]),.sec select{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}
.chatlog{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px 12px;max-height:320px;overflow:auto;margin-top:8px}
.chatlog .line{padding:4px 0;border-bottom:1px dashed rgba(35,43,54,.7);font-size:12px;white-space:pre-wrap}
.chatlog .line:last-child{border-bottom:none}
.chatlog .who{font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-right:8px;color:var(--dim)}
.chatlog .line.you .who{color:var(--accent)}.chatlog .line.steward .who{color:var(--ok)}.chatlog .line.sys .who{color:var(--dim)}
.chatlog .line.sys{color:var(--dim);font-size:11px}
.tk{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap}
.tk .ttl{font-weight:600}
.tk .res{color:var(--dim);flex:1;min-width:160px}
.tk .tools{margin:0}
#drawer{display:none;position:fixed;top:0;right:0;width:min(560px,92vw);height:100vh;overflow:auto;background:#10151d;border-left:1px solid var(--line);padding:16px 18px;z-index:20;box-shadow:-18px 0 40px rgba(0,0,0,.45)}
#drawer.on{display:block}
#drawer h4{margin:0 0 4px;font-size:13px}
#drawer .kv{font-size:12px;color:var(--dim);margin:3px 0}
#drawer .kv b{color:var(--fg);font-weight:500}
#drawer .trace{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
#drawer .tr{font-size:11px;padding:3px 0;color:var(--dim)}
#drawer .tr b{color:var(--fg);font-weight:500}
#drawer button{margin-top:10px}
</style></head>
<body class="${bodyClass}">
<h1>大内总管 Steward <span class="pill" id="phase">能力 → 判定 → 动作</span></h1>
<div class="sub">观察全部 agent / 归类到模块 / 能力平面判定命中后由编制树决定怎么动。动作默认只通知，需显式开启才动手。</div>

<!-- 1 结论：不滚动就能看完 -->
<div class="hero" id="hero"><div class="empty">读取中…</div></div>

<!-- 2 要我拍板：待批 + 正在等你回答的会话，没有就收成一行（P2-B 合并成一条队列） -->
<section class="sec">
  <div class="sech"><span class="tier">1</span> 要我拍板 <span class="pill" id="attn-count">0</span>
    <span class="sechint">待批要点过才会继续；会话挂着的提问也能在这里代答</span></div>
  <div id="approvals"><div class="empty">没有要你点头的事</div></div>
  <div id="asks"></div>
  <div id="attn-more"></div>
</section>

<!-- 3 控制：会立刻改变它下一步怎么动 -->
<section class="sec">
  <div class="sech"><span class="tier">2</span> 控制 <span class="sechint">自动动作 / echo-live / 飞书 IM·文档 是行为面</span></div>
  <div class="tools">
    <button id="btn-auto" onclick="toggleAuto()">自动动作</button>
    <button id="btn-mode" onclick="toggleMode()">act: echo</button>
    <button id="btn-lark" onclick="toggleLark()">飞书通知</button>
    <button id="btn-larkdoc" onclick="toggleLarkDoc()">飞书文档</button>
    <button onclick="act('digest')">立即汇报</button>
  </div>
</section>

<!-- 4 设置：常用旋钮 + 全文编辑入口 -->
<section class="sec">
  <div class="sech"><span class="tier">3</span> 设置 <span class="sechint">改完即生效；整份 settings.json 在外壳面板的「设置」抽屉里直接编辑</span></div>
  <div id="settings-form" style="display:grid;grid-template-columns:170px 1fr;gap:6px 10px;align-items:center;margin-top:8px"></div>
  <div class="tools" style="margin-top:8px">
    <button onclick="saveSettings()">保存设置</button>
    <button onclick="loadSettings(true)">重新读取</button>
    <button onclick="openRawSettings()">编辑完整 settings.json</button>
    <span class="mono" id="set-msg"></span>
  </div>
</section>

<!-- 4 交办：把活交给它 -->
<section class="sec">
  <div class="sech"><span class="tier">4</span> 交办 <span class="pill" id="tasks-count">0</span>
    <span class="sechint">写一句话就能派活；echo 下只拟发不发送，切 live 才真发</span></div>
  <div class="tools">
    <input id="tk-title" type="text" placeholder="要它做什么（一句话）" style="flex:1;min-width:220px">
    <input id="tk-accept" type="text" placeholder="验收标准（可空）" style="flex:1;min-width:160px">
    <select id="tk-target"><option value="">新开会话</option></select>
    <button onclick="addTask()">交办</button>
  </div>
  <div id="tasks"><div class="empty">还没有交办单</div></div>
</section>

<!-- 5 对话：主管会话 -->
<section class="sec">
  <div class="sech"><span class="tier">5</span> 对话 <span class="pill" id="chat-state">未绑定</span>
    <span class="sechint">绑定一个会话后，这里打的字就是发给主管的话（主人说话不受 echo 限制）</span></div>
  <div class="tools">
    <button onclick="chatCreate()">新建主管会话</button>
    <button onclick="chatBind()">绑定现有会话</button>
    <button onclick="chatUnbind()">解绑</button>
    <span class="mono" id="chat-id"></span>
  </div>
  <div id="chat-log" class="chatlog"><div class="empty">未绑定主管会话</div></div>
  <div class="tools">
    <input id="chat-text" type="text" placeholder="跟主管说点什么，回车发送…" style="flex:1">
    <button onclick="chatSend()">发送</button>
  </div>
</section>

<!-- 6 正在发生：流程 + 模块分布 -->
<section class="sec">
  <div class="sech"><span class="tier">6</span> 正在发生 <span class="pill" id="runs-count">0</span>
    <span class="sechint">在跑的工作流 → 模块怎么分</span></div>
  <div id="runs"><div class="empty">暂无工作流</div></div>
<h3>模块 <span class="pill" id="mods-count">0</span> <button onclick="editModule(null)">新增模块</button> <button onclick="resetModules()">恢复默认</button></h3>
<div class="mods" id="mods"><div class="empty">读取中…</div></div>
<div class="mod" id="mod-editor" style="display:none">
  <div class="name"><span id="me-title">编辑模块</span><span class="mono" id="me-msg"></span></div>
  <div class="meta">匹配顺序：手工指定 → workspace 路径前缀 → 标题关键词。titles / workspaces 用逗号或换行分隔。</div>
  <div style="display:grid;grid-template-columns:88px 1fr;gap:6px 10px;margin-top:8px;align-items:center">
    <label>id</label><input id="me-id" spellcheck="false" placeholder="cb2" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font:11px ui-monospace,Consolas,monospace">
    <label>名称</label><input id="me-name" spellcheck="false" placeholder="CB2 引擎" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-size:12px">
    <label>workspaces</label><textarea id="me-ws" spellcheck="false" placeholder="D:\agent\cb2" style="min-height:52px;background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font:11px ui-monospace,Consolas,monospace"></textarea>
    <label>titles</label><input id="me-titles" spellcheck="false" placeholder="cb2, cb2引擎" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-size:12px">
    <label>启用</label><div><input id="me-enabled" type="checkbox" checked> <span class="mono">不启用则不参与归类</span></div>
  </div>
  <div class="tools"><button onclick="saveModule()">保存</button><button onclick="closeEditor()">取消</button></div>
</div>
</section>

<!-- 7 主管：编制 = 数据记录，装了什么能力就有什么职责 -->
<section class="sec">
  <div class="sech"><span class="tier">7</span> 主管 <span class="pill" id="stewards-count">0</span>
    <span class="sechint">装了什么能力就有什么职责；决策树决定什么时候用哪条</span></div>
  <div class="tools"><button onclick="addSteward()">新增主管</button><button onclick="loadStewards()">刷新</button></div>
  <div id="stewards"><div class="empty">读取中…</div></div>
  <div class="mod" id="sw-editor" style="display:none">
    <div class="name"><span id="sw-title">编辑主管</span><span class="mono" id="sw-msg"></span></div>
    <div class="meta">整条编制（含决策树）是 JSON；保存时服务端会做保存期校验，非法树会被 400 拒绝。</div>
    <textarea id="sw-json" spellcheck="false" style="width:100%;min-height:180px;background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:6px;font:11px ui-monospace,Consolas,monospace"></textarea>
    <div class="tools"><button onclick="validateSteward()">校验</button><span class="mono" id="sw-msg2"></span></div>
    <div class="tools" id="sw-snippets"><span class="mono">插入片段：</span></div>
    <div class="tools"><button onclick="saveSteward()">保存</button><button onclick="closeStewardEditor()">取消</button></div>
  </div>
</section>

<!-- 7 能力仓：插件化的能力表 -->
<section class="sec">
  <div class="sech"><span class="tier">8</span> 能力仓 <span class="pill" id="catalog-count">0</span>
    <span class="sechint">每个能力是一个插件：载荷 × 载体 × 目标 × 协议；主管只是装备它们</span></div>
  <div class="tools">
    <input id="cat-q" placeholder="搜索 id / 标题" oninput="loadCatalog()" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font-size:12px" />
    <select id="cat-payload" onchange="loadCatalog()"><option value="">全部载荷</option><option value="verdict">判定 verdict</option><option value="notice">通知 notice</option><option value="directive">指令 directive</option><option value="plan">片段 plan</option><option value="record">记录 record</option><option value="report">汇报 report</option><option value="answer">答复 answer</option><option value="query">查询 query</option></select>
    <select id="cat-carrier" onchange="loadCatalog()"><option value="">全部载体</option><option value="expr">表达式 expr</option><option value="tree">片段 tree</option><option value="desktop">桌面</option><option value="lark.im">飞书 im</option><option value="session">会话</option><option value="tool">工具</option><option value="file">文件</option><option value="peer">对等</option></select>
    <button onclick="loadCatalog()">刷新</button>
  </div>
  <div id="catalog"><div class="empty">读取中…</div></div>
</section>

<!-- 8 路由：每个主管 × 每条能力的三态 -->
<section class="sec">
  <div class="sech"><span class="tier">9</span> 路由 <span class="pill" id="routes-count">0</span>
    <span class="sechint">allow / approval / deny 三态；virtual 声带没有会话时 session.* 直接 deny（点格子切换，再点一次回继承）</span></div>
  <div class="tools"><button onclick="loadRoutes()">刷新</button></div>
  <div id="routes"><div class="empty">读取中…</div></div>
</section>

<!-- 9 明细：agent 表 -->
<section class="sec">
  <div class="sech"><span class="tier">10</span> Agent 明细 <span class="pill" id="agents-count">0</span>
    <span class="sechint">卡住 → 待决 → 运行中 → 空闲；点「看」打开详情抽屉（目标 / 待办 / 最近轨迹）</span></div>
<div id="agents"><div class="empty">读取中…</div></div>
</section>

<!-- 9 记录：echo 拟执行 + 信号流 -->
<section class="sec">
  <div class="sech"><span class="tier">11</span> 记录 <span class="sechint">echo 拟执行 · 信号流</span></div>
<h3>拟执行（echo，只打印不执行）</h3><div id="echoes"><div class="empty">没有待确认动作</div></div>
<h3>信号流</h3><div id="signals"><div class="empty">暂无信号</div></div>
</section>

<!-- 11 审计：intent 级决策流 -->
<section class="sec">
  <div class="sech"><span class="tier">12</span> 审计 <span class="pill" id="audit-count">0</span>
    <span class="sechint">每条 intent 都留痕：执行 / 预演 / 被拦；可与 trace 对照，也可导出</span></div>
  <div class="tools">
    <select id="au-filter" onchange="loadAudit()"><option value="">全部决定</option><option value="run">执行 run</option><option value="preview">预演 preview</option><option value="deny">被拦 deny</option><option value="approval">待批 approval</option><option value="skip">跳过 skip</option></select>
    <button onclick="loadAudit()">刷新</button>
    <button onclick="exportAudit()">导出审计</button>
    <button onclick="exportJournal()">导出流水</button>
  </div>
  <div id="audit"><div class="empty">读取中…</div></div>
</section>

<!-- 12 追查：能力平面 trace -->
<section class="sec">
  <div class="sech"><span class="tier">13</span> 追查 <span class="pill" id="traces-count">0</span>
    <span class="sechint">每次判定/动作一条 trace；点「瀑布」看调用链与「为什么」</span></div>
  <div class="tools">
    <select id="tr-filter"><option value="">全部</option><option value="bad">被拦 / 失败</option></select>
    <button onclick="loadTraces()">刷新</button>
    <button onclick="exportOtlp()">导出 OTLP</button>
  </div>
  <div id="tr-pin"></div>
  <div id="traces"><div class="empty">暂无 trace</div></div>
</section>

<!-- 10 体检：哪条设计有毛病 -->
<section class="sec">
  <div class="sech"><span class="tier">14</span> 体检 <span class="pill" id="doctor-count">0</span>
    <span class="sechint">把"哪条设计有毛病"翻成结论 + 入口；全绿时是空的</span></div>
  <div class="tools"><button onclick="loadDoctor()">重新体检</button></div>
  <div id="doctor"><div class="empty">读取中…</div></div>
</section>

<div id="drawer"></div>
<!-- 12 维护：低频操作收进折叠区 -->
<details class="maint">
  <summary>维护 / 页脚</summary>
  <div class="tools">
    <button onclick="act('collect')">强制采样</button>
    <button onclick="classifyAll()">按 agent 判断归类</button>
    <button onclick="act('reload-rules')">重载能力</button>
    <button onclick="load()">刷新</button>
  </div>
  <div class="sub" id="foot" style="margin-top:18px"></div>
</details>
<script src="../kit.js"></script>
<script>
(function(){
  var API = "api/";
  var S = null;
  var SET = null;
  var K = window.PolarisKit || {};
  // 设置表单：常用旋钮按点号路径读写；整份 JSON 交给外壳面板的设置抽屉（更灵活）。
  var SET_FIELDS = [
    {p:"actLevel", label:"授权级别", type:"select", opts:["L1","L2","L3"]},
    {p:"budgetPerHour", label:"每小时动作预算", type:"number", min:1},
    {p:"autoAct", label:"自动动作", type:"bool"},
    {p:"escalation.enabled", label:"卡住自动升级", type:"bool"},
    {p:"escalation.cooldownSec", label:"升级冷却（秒）", type:"number", min:60},
    {p:"escalation.maxAttempts", label:"最多催几次", type:"number", min:1},
    {p:"tasks.concurrency", label:"同时派发数", type:"number", min:1},
    {p:"tasks.autoDispatch", label:"自动派发交办单", type:"bool"},
    {p:"tasks.maxAttempts", label:"交办最多尝试", type:"number", min:1},
    {p:"tasks.retainDays", label:"交办保留天数", type:"number", min:1},
    {p:"notify.minSeverity", label:"通知最低级别", type:"select", opts:["info","warning","error","critical"]},
    {p:"notify.larkEnabled", label:"飞书 IM", type:"bool"},
    {p:"notify.larkDocEnabled", label:"飞书文档", type:"bool"},
    {p:"classifier.enabled", label:"LLM 归类", type:"bool"},
    {p:"classifier.model", label:"归类模型", type:"text"},
    {p:"classifier.minConfidence", label:"归类置信下限", type:"number", step:"0.05", min:0, max:1},
    {p:"export.prometheus", label:"导出 Prometheus", type:"bool"},
    {p:"export.otlp.enabled", label:"导出 OTLP", type:"bool"},
    {p:"export.otlp.endpoint", label:"OTLP 地址", type:"text"},
    {p:"session.preset", label:"主管会话 preset", type:"text"},
    {p:"session.title", label:"主管会话标题", type:"text"},
    {p:"session.mode", label:"主管会话模式", type:"select", opts:["manual","auto"]}
  ];
  function getPath(obj, path){
    var cur = obj; var parts = String(path).split(".");
    for (var i=0;i<parts.length;i++){ if(cur==null||typeof cur!=="object") return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(obj, path, value){
    var parts = String(path).split("."); var cur = obj;
    for (var i=0;i<parts.length-1;i++){ if(cur[parts[i]]==null||typeof cur[parts[i]]!=="object") cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length-1]] = value;
  }
  function esc(s){ return K.esc ? K.esc(s) : String(s==null?"":s); }
  function ago(t){ if(!t) return "-"; var d=Date.now()-t; if(d<60000) return Math.round(d/1000)+"s"; if(d<3600000) return Math.round(d/60000)+"m"; return Math.round(d/3600000)+"h"; }
  function cls(v){ return v==="high"||v==="error"||v==="critical"?"err":(v==="warn"||v==="warning"?"warn":"ok"); }
  function load(){
    fetch(API+"state",{cache:"no-store"}).then(function(r){return r.json()}).then(render).catch(function(e){
      document.getElementById("hero").innerHTML='<div class="empty">读取失败: '+esc(e)+'</div>';
    });
    loadTasks(); loadChat(); loadTraces(); loadStewards(); loadDoctor(); loadCatalog(); loadRoutes(); loadAudit(); loadSnippets();
    loadSettings();
  }
  function getJson(url){ return fetch(url,{cache:"no-store"}).then(function(r){return r.json()}); }
  function setMsg(text){ var t=document.getElementById("set-msg"); if(t) t.textContent = text||""; }
  function loadSettings(force){
    if (SET && force !== true) return;
    getJson(new URL("../api/settings?feature=steward", location.href).href).then(function(d){
      if(!d||d.ok!==true){ setMsg("读取设置失败："+((d&&d.error)||"unknown")); return; }
      SET = d.settings || {};
      renderSettings();
      setMsg("settings.json："+(d.file||""));
    }).catch(function(e){ setMsg("读取设置失败："+e); });
  }
  function renderSettings(){
    var box = document.getElementById("settings-form"); if(!box) return;
    box.innerHTML = SET_FIELDS.map(function(f){
      var v = getPath(SET||{}, f.p);
      var ctl;
      if(f.type==="bool"){
        ctl = '<input type="checkbox" data-path="'+esc(f.p)+'"'+(v===true?" checked":"")+'>';
      } else if(f.type==="number"){
        ctl = '<input type="number" data-path="'+esc(f.p)+'" value="'+esc(v==null?"":v)+'"'+(f.min!=null?' min="'+f.min+'"':"")+(f.max!=null?' max="'+f.max+'"':"")+(f.step?' step="'+f.step+'"':"")+' style="width:110px">';
      } else if(f.type==="select"){
        ctl = '<select data-path="'+esc(f.p)+'">'+f.opts.map(function(o){ return '<option'+(String(v)===o?" selected":"")+'>'+esc(o)+'</option>'; }).join("")+'</select>';
      } else {
        ctl = '<input type="text" data-path="'+esc(f.p)+'" value="'+esc(v==null?"":v)+'" style="width:240px">';
      }
      return '<div class="lab">'+esc(f.label)+'</div><div>'+ctl+'</div>';
    }).join("");
  }
  function saveSettings(){
    var nodes = document.querySelectorAll("#settings-form [data-path]");
    var patch = {};
    for(var i=0;i<nodes.length;i++){
      var el = nodes[i]; var path = el.getAttribute("data-path");
      var value;
      if(el.type==="checkbox") value = el.checked;
      else if(el.type==="number"){ if(el.value==="") continue; value = Number(el.value); }
      else value = el.value;
      setPath(patch, path, value);
    }
    setMsg("保存中…");
    postAt(new URL("../api/settings", location.href).href, {feature:"steward", patch:patch}).then(function(d){
      if(!d||d.ok!==true){ setMsg("保存被拒："+((d&&d.feature)?d.feature+" ":"")+((d&&d.error)||"unknown")); return; }
      setMsg("已保存（立刻生效，无需重启）"); SET = null; loadSettings(true); load();
    }).catch(function(e){ setMsg("保存失败："+e); });
  }
  function openRawSettings(){ window.open(new URL("../panel", location.href).href, "_blank"); }
  function post(path, body){
    if (K.post) return K.post(API+path, body);
    return fetch(API+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json()});
  }
  function postAt(url, body){
    if (K.postAt) return K.postAt(url, body);
    return fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json()});
  }
  function act(id){ post("action",{id:id}).then(load); }
  function toggleAuto(){ if(!S||!S.control) return; post("settings",{patch:{autoAct:S.control.autoAct!==true}}).then(load); }
  function toggleLark(){ if(!S||!S.control||!S.control.notify) return; post("settings",{patch:{notify:{larkEnabled:S.control.notify.larkEnabled!==true}}}).then(load); }
  function toggleLarkDoc(){ if(!S||!S.control||!S.control.notify) return; post("settings",{patch:{notify:{larkDocEnabled:S.control.notify.larkDocEnabled!==true}}}).then(load); }
  function answer(id, value, version){ post("answer",{id:id,answer:value,version:version,by:"panel"}).then(load); }
  /** 代答会话挂着的提问（宿主只允许 live root agent；被拒时把原因说清楚）。 */
  function answerQuestion(agentId, sessionId, callId){
    var row=null, list=(S&&S.agents)||[];
    for(var i=0;i<list.length;i++){ if(list[i].id===agentId) row=list[i]; }
    var q=row&&row.question?row.question:{}, items=Array.isArray(q.items)?q.items:[], last=items.length?items[items.length-1]:null;
    if(!last||!Array.isArray(last.questions)||last.questions.length===0){ alert("这条提问没有可代答的文本，请直接打开会话回复"); return; }
    var answers=[];
    for(var j=0;j<last.questions.length;j++){
      var x=last.questions[j];
      var def=(x.options&&x.options.length)? x.options[0] : "";
      var text=window.prompt(x.question, def);
      if(text===null) return;
      answers.push({ id: x.id, selected: text===""? [] : [text], custom: text });
    }
    postAt(new URL("../api/question/answer", location.href), { agentId:agentId, sessionId:sessionId, callId:last.callId||callId, answers:answers }).then(function(r3){
      if(r3&&r3.ok===true){ load(); return; }
      alert("代答被拒："+String((r3&&(r3.reason||r3.error))||"未知原因"));
    });
  }
  function toggleMode(){
    if(!S||!S.control) return;
    var live = S.control.actMode === "live";
    if(live){ post("settings",{patch:{actMode:"echo"}}).then(load); return; }
    if(!confirm("切到 live 后，规则动作会真的执行：发通知、向会话投递 followup、代为回答提问。继续？")) return;
    post("settings",{patch:{actMode:"live"}}).then(load);
  }
  function pin(id, value){ post("pin",{agentId:id,module:value}).then(load); }
  function classifyOne(id){ post("classify",{agentId:id,force:true}).then(function(r){ if(r&&r.ok) load(); else alert("归类失败: "+((r&&r.reason)||"unknown")); }); }
  function classifyAll(){
    var rows=(S&&S.agents)||[];
    var un=rows.filter(function(a){return a.moduleId==="unassigned"});
    if(!un.length){ alert("没有 unassigned 的 agent"); return; }
    var i=0; (function next(){ if(i>=un.length){ load(); return; } classifyOneAsync(un[i++].id, next); })();
  }
  function classifyOneAsync(id, done){ post("classify",{agentId:id,force:true}).then(function(){ done(); }).catch(function(){ done(); }); }
  var EDITING = null;
  function splitList(v){ return String(v||"").split(/[,\\n]/).map(function(x){return x.trim()}).filter(function(x){return x.length>0}); }
  function editModule(id){
    var defs=(S&&S.moduleDefs)||[];
    var d=null;
    for(var i=0;i<defs.length;i++) if(defs[i].id===id) d=defs[i];
    EDITING = id;
    var box=document.getElementById("mod-editor");
    document.getElementById("me-title").textContent = id? ("编辑 "+id) : "新增模块";
    document.getElementById("me-msg").textContent = "";
    document.getElementById("me-id").value = id||"";
    document.getElementById("me-id").disabled = !!id;
    document.getElementById("me-name").value = d? (d.name||id) : "";
    document.getElementById("me-ws").value = d? (d.workspaces||[]).join("\\n") : "";
    document.getElementById("me-titles").value = d? (d.titles||[]).join(", ") : "";
    document.getElementById("me-enabled").checked = d? d.enabled!==false : true;
    box.style.display="";
    document.getElementById("me-id").focus();
  }
  function closeEditor(){ EDITING=null; document.getElementById("mod-editor").style.display="none"; }
  function saveModule(){
    var id=(document.getElementById("me-id").value||"").trim();
    var msg=document.getElementById("me-msg");
    if(!id){ msg.textContent="id 不能为空"; return; }
    var body={op:"save",module:{
      id:id,
      name:(document.getElementById("me-name").value||"").trim(),
      workspaces:splitList(document.getElementById("me-ws").value),
      titles:splitList(document.getElementById("me-titles").value),
      enabled:document.getElementById("me-enabled").checked
    }};
    post("modules",body).then(function(r){
      if(r&&r.ok){ closeEditor(); load(); }
      else msg.textContent = "保存失败: "+((r&&r.error)||"unknown");
    });
  }
  function delModule(id){
    if(!confirm("删除模块 "+id+"？该模块下的 agent 会回到「未归类」，指向它的手工指定也会清掉。")) return;
    post("modules",{op:"delete",id:id}).then(function(r){ if(r&&r.ok) load(); else alert("删除失败: "+((r&&r.error)||"unknown")); });
  }
  function resetModules(){
    if(!confirm("恢复内置默认模块？你自定义的模块会被覆盖。")) return;
    post("modules",{op:"reset"}).then(function(r){ if(r&&r.ok) load(); else alert("恢复失败: "+((r&&r.error)||"unknown")); });
  }
  function replay(id){ post("replay",{runId:id}).then(load); }
  // ---- P1：主管（编制）/ 路由入口 / 体检 / 追查增强 ----
  var STEW = { list: [], routes: null, editing: null, pinned: null };
  try { STEW.pinned = window.localStorage.getItem("polaris.pin.trace"); } catch(e){ }
  function loadStewards(){
    fetch(API+"stewards",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      if(!d||!d.ok) return;
      STEW.list = d.stewards||[]; STEW.routes = d.routes||null;
      renderStewards(); renderPin();
    }).catch(function(){});
  }
  function treeText(s2){ var t = s2 && s2.tree ? s2.tree : null; return t ? JSON.stringify(t,null,1) : "(内置树不可读)"; }
  function renderStewards(){
    var el=document.getElementById("stewards"); if(!el) return;
    var list=STEW.list||[];
    document.getElementById("stewards-count").textContent=String(list.length);
    if(!list.length){ el.innerHTML='<div class="empty">没有编制</div>'; return; }
    el.innerHTML=list.map(function(s2){
      var voice=s2.voice||{};
      var vtxt=voice.mode==="session" ? ("会话 "+String(voice.sessionId||"").slice(0,8)) : "virtual";
      var caps=(s2.equips||[]).map(function(c2){ return '<span class="pill">'+esc(c2)+'</span>'; }).join(" ");
      var ev=(s2.events||[]).join(" / ")||"(全部事件)";
      var sc=(s2.scope&&s2.scope.length)?s2.scope.join(","):"全部";
      return '<div class="mod"><div class="name">'+esc(s2.name||s2.id)+' <span class="mono">'+esc(s2.id)+'</span> '+
        '<span class="pill '+cls(s2.enabled===false?"warn":"ok")+'">'+(s2.enabled===false?"停用":"启用")+'</span></div>'+
        '<div class="meta">发声 '+esc(vtxt)+' · 监听 '+esc(ev)+' · 作用域 '+esc(sc)+'</div>'+
        '<div class="meta">'+(caps||'<span class="meta">未装备能力</span>')+'</div>'+
        '<details><summary class="mono">决策树</summary><pre class="mono" style="max-height:220px;overflow:auto">'+esc(treeText(s2))+'</pre></details>'+
        '<div class="tools"><button data-sw-en="'+esc(s2.id)+'">'+(s2.enabled===false?"启用":"停用")+'</button>'+
        '<button data-sw-edit="'+esc(s2.id)+'">编辑</button><button data-sw-del="'+esc(s2.id)+'">删除</button></div></div>';
    }).join("");
    var find=function(id){ for(var k=0;k<list.length;k++) if(list[k].id===id) return list[k]; return null; };
    var en=el.querySelectorAll("button[data-sw-en]");
    for(var i=0;i<en.length;i++){ en[i].onclick=(function(b){ return function(){ var id=b.getAttribute("data-sw-en"); var cur=find(id); toggleSteward(id, !(cur&&cur.enabled!==false)); }; })(en[i]); }
    var ed=el.querySelectorAll("button[data-sw-edit]");
    for(var j=0;j<ed.length;j++){ ed[j].onclick=(function(b){ return function(){ editSteward(b.getAttribute("data-sw-edit")); }; })(ed[j]); }
    var de=el.querySelectorAll("button[data-sw-del]");
    for(var m=0;m<de.length;m++){ de[m].onclick=(function(b){ return function(){ delSteward(b.getAttribute("data-sw-del")); }; })(de[m]); }
  }
  function toggleSteward(id, on){
    post("stewards",{op:"enable",id:id,enabled:on}).then(function(r){ if(r&&r.ok) loadStewards(); else alert("操作失败: "+((r&&r.error)||"unknown")); });
  }
  function delSteward(id){
    if(!confirm("删除主管 "+id+"？（内置编制会退回默认）")) return;
    post("stewards",{op:"delete",id:id}).then(function(r){ if(r&&r.ok) loadStewards(); else alert("删除失败: "+((r&&r.error)||"unknown")); });
  }
  function editSteward(id){
    var cur=null; for(var k=0;k<STEW.list.length;k++) if(STEW.list[k].id===id) cur=STEW.list[k];
    if(!cur){ alert("找不到主管 "+id); return; }
    STEW.editing=id;
    document.getElementById("sw-title").textContent="编辑主管 "+id;
    document.getElementById("sw-msg").textContent="";
    document.getElementById("sw-json").value=JSON.stringify(cur,null,1);
    document.getElementById("sw-editor").style.display="";
  }
  function closeStewardEditor(){ STEW.editing=null; var b=document.getElementById("sw-editor"); if(b) b.style.display="none"; }
  function addSteward(){
    STEW.editing=null;
    document.getElementById("sw-title").textContent="新增主管";
    document.getElementById("sw-msg").textContent="";
    document.getElementById("sw-json").value=JSON.stringify({id:"new-steward",name:"新主管",enabled:true,voice:{mode:"virtual"},events:["host/tick"],equips:[],tree:{seq:[]}},null,1);
    document.getElementById("sw-editor").style.display="";
  }
  function saveSteward(){
    var msg=document.getElementById("sw-msg");
    var rec=null;
    try { rec=JSON.parse(document.getElementById("sw-json").value); }
    catch(e){ msg.textContent="JSON 解析失败: "+String(e); return; }
    if(!rec||typeof rec!=="object"||Array.isArray(rec)){ msg.textContent="必须是一个对象"; return; }
    if(STEW.editing) rec.id=STEW.editing;
    post("stewards",{op:"save",id:rec.id,steward:rec}).then(function(r){
      if(r&&r.ok){ closeStewardEditor(); loadStewards(); } else msg.textContent="保存失败: "+((r&&r.error)||"unknown");
    });
  }
  function loadDoctor(){
    fetch(API+"doctor",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      if(d&&d.ok) renderDoctor(d);
    }).catch(function(){});
  }
  function renderDoctor(d){
    var el=document.getElementById("doctor"); if(!el) return;
    var checks=d.checks||[];
    document.getElementById("doctor-count").textContent=String(checks.length);
    if(!checks.length){
      var c2=d.counts||{};
      el.innerHTML='<div class="empty">全绿：'+esc(String(c2.traces||0))+' 条 trace · '+esc(String(c2.intents||0))+' 次意图 · '+esc(String(c2.capabilities||0))+' 条能力，没有发现设计毛病。</div>';
      return;
    }
    el.innerHTML=checks.map(function(c3){
      return '<div class="mod"><div class="name"><span class="pill '+cls(c3.level)+'">'+esc(c3.level||"-")+'</span> '+esc(c3.title||c3.id)+'</div>'+
        '<div class="meta">'+esc(c3.conclusion||"")+'</div>'+
        '<div class="tools"><button data-fix="'+esc((c3.fix&&c3.fix.page)||"")+'">去处理</button></div></div>';
    }).join("");
    var fx=el.querySelectorAll("button[data-fix]");
    for(var i=0;i<fx.length;i++){ fx[i].onclick=(function(b){ return function(){ jump(b.getAttribute("data-fix")); }; })(fx[i]); }
  }
  function jump(page){
    var map={stewards:"stewards",routes:"stewards",capabilities:"traces",trace:"traces",audit:"traces",settings:"foot"};
    var el=document.getElementById(map[page]||"foot");
    if(el&&el.scrollIntoView) el.scrollIntoView({behavior:"smooth",block:"start"});
  }
  function replayTrace(id){
    var d=document.getElementById("drawer");
    post("trace/replay",{id:id}).then(function(r){
      if(!r||!r.ok){ d.innerHTML+='<div class="empty">重放失败: '+esc((r&&(r.error||r.reason))||"unknown")+'</div>'; return; }
      var rows=(r.after||[]).map(function(a2){ return '<div class="tr">'+esc(a2.cap||"-")+' → '+esc(a2.decision||"-")+(a2.reason?(" · "+esc(a2.reason)):"")+'</div>'; }).join("");
      d.innerHTML+='<div class="trace"><div class="tr"><b>重放（用事实快照重跑当前树，不执行能力）</b>'+(r.changed?" · 与原来不同":" · 与原来一致")+'</div>'+(rows||'<div class="tr">这棵树当前没做出调用</div>')+'</div>';
    });
  }
  function exportTrace(id){ window.open(API+"trace/export?id="+encodeURIComponent(id),"_blank"); }
  function diffTrace(id){
    var list=(typeof TR!=="undefined"&&TR&&TR.traces)?TR.traces:[];
    var idx=-1;
    for(var i=0;i<list.length;i++) if(list[i].id===id) idx=i;
    var against=(idx>=0&&idx+1<list.length)?list[idx+1].id:"";
    if(!against){ alert("没有可对比的上一条 trace"); return; }
    fetch(API+"trace/diff?id="+encodeURIComponent(id)+"&against="+encodeURIComponent(against),{cache:"no-store"}).then(function(r){return r.json()}).then(function(res){
      var d=document.getElementById("drawer");
      if(!res||!res.ok){ d.innerHTML+='<div class="empty">对比失败</div>'; return; }
      var add=(res.added||[]).map(function(a2){ return '<div class="tr">＋ '+esc(a2)+'</div>'; }).join("");
      var rem=(res.removed||[]).map(function(a2){ return '<div class="tr">－ '+esc(a2)+'</div>'; }).join("");
      d.innerHTML+='<div class="trace"><div class="tr"><b>对比 '+esc(String(against).slice(0,16))+'</b></div>'+(add+rem||'<div class="tr">意图集完全一致</div>')+'</div>';
    });
  }
  function pinTrace(id){
    STEW.pinned=id;
    try { window.localStorage.setItem("polaris.pin.trace",id); } catch(e){ }
    renderPin();
  }
  function renderPin(){
    var el=document.getElementById("tr-pin"); if(!el) return;
    if(!STEW.pinned){ el.innerHTML=""; return; }
    el.innerHTML='<div class="tr">钉住 '+esc(STEW.pinned)+' <button data-unpin="1">取消</button></div>';
    var b=el.querySelector("button[data-unpin]");
    if(b) b.onclick=function(){ STEW.pinned=null; try{window.localStorage.removeItem("polaris.pin.trace");}catch(e){ } renderPin(); };
  }
  function render(s){
    if(!s||!s.ok){ return; }
    S = s;
    var h=s.health||{}, loop=h.loop||{}, c=s.counters||{}, b=s.budget||{}, r=s.rules||{};
    var heapPct = h.heapLimitMB ? Math.round(h.heapUsedMB*100/h.heapLimitMB) : 0;
    var level = heapPct>=80?"err":(heapPct>=65?"warn":"ok");
    var ctl=s.control||{};
    var rowsAll = s.agents||[];
    var apprsAll = s.approvals||[];
    var runningCount = rowsAll.filter(function(a){return a.status==="running"}).length;
    var stalledCount = rowsAll.filter(function(a){return a.stalled}).length;
    var busyRuns = (s.runs||[]).filter(function(x){return x.status!=="done"&&x.status!=="failed"}).length;
    var critCount = (s.signals||[]).filter(function(x){return x.severity==="critical"}).length;
    var word = level==="ok"?"平稳":(level==="warn"?"偏高":"吃紧");
    var sum = runningCount+" 个 agent 在跑";
    if(stalledCount) sum += " · "+stalledCount+" 个卡住";
    sum += apprsAll.length ? (" · "+apprsAll.length+" 项等你批") : " · 无待批";
    sum += " · 堆 "+h.heapUsedMB+"/"+h.heapLimitMB+" MB（"+heapPct+"%）";
    sum += " · 预算 "+(b.used||0)+"/"+(b.max||0)+" 每小时";
    var kpi = function(label, value, tone){ return '<div class="k">'+label+'<b'+(tone?' class="'+tone+'"':'')+'>'+value+'</b></div>'; };
    var heroEl = document.getElementById("hero");
    heroEl.className = "hero verdict "+level;
    heroEl.innerHTML =
      '<div><div class="vword '+level+'">'+esc(word)+'</div><div class="vsum">'+esc(sum)+'</div></div>'+
      '<div class="kpis">'+
        kpi("宿主堆", esc(h.heapUsedMB)+" / "+esc(h.heapLimitMB)+" MB", level==="ok"?"":level)+
        kpi("P99", esc(loop.p99Ms)+" ms"+(loop.maxMs>200?(" · max "+esc(loop.maxMs)):""), loop.maxMs>200?"warn":"")+
        kpi("Agent", esc(rowsAll.length)+"（跑 "+esc(runningCount)+"）")+
        kpi("流程 / 待批", esc(busyRuns)+" / "+esc(apprsAll.length), apprsAll.length?"warn":"")+
        kpi("信号", esc(critCount?("critical "+critCount):(s.signals||[]).filter(function(x){return x.severity!=="info"}).length), critCount?"err":"")+
        kpi("策略", (ctl.autoAct?"自动":"只通知")+" / "+(ctl.actMode==="live"?"live":"echo"), ctl.autoAct?"warn":"")+
      '</div>';
    var ba=document.getElementById("btn-auto"); ba.className = ctl.autoAct?"on":"";
    var bm=document.getElementById("btn-mode");
    bm.textContent = "act: "+(ctl.actMode==="live"?"live":"echo");
    bm.className = ctl.actMode==="live"?"danger":"on";
    var bl=document.getElementById("btn-lark"); bl.className = ctl.notify&&ctl.notify.larkEnabled?"on":"";
    var bld=document.getElementById("btn-larkdoc"); bld.className = ctl.notify&&ctl.notify.larkDocEnabled?"on":"";
    // 模块编辑走表单（mod-editor），不再有 JSON textarea

    var mods=(s.modules||[]).slice().sort(function(a,b){
      if(a.id==="unassigned") return 1;
      if(b.id==="unassigned") return -1;
      return (b.count||0)-(a.count||0);
    });
    var modTotal=0;
    for(var mi=0;mi<mods.length;mi++) modTotal += (mods[mi].count||0);
    document.getElementById("mods-count").textContent = String(mods.length);
    var defs=s.moduleDefs||[];
    var defOf=function(id){ for(var i=0;i<defs.length;i++) if(defs[i].id===id) return defs[i]; return null; };
    document.getElementById("mods").innerHTML = mods.length? mods.map(function(m){
      var d=defOf(m.id)||{};
      var ws=(d.workspaces||[]).length? (d.workspaces||[]).join(" · ") : "（未限定目录）";
      var ti=(d.titles||[]).length? (d.titles||[]).join(", ") : "（无关键词）";
      return '<div class="mod'+(m.attention>0?" attention":"")+'"><div class="name"><span>'+esc(m.name)+'</span><span class="pill">'+esc(m.id)+'</span>'+
        (m.id==="unassigned"?'':'<span style="margin-left:auto"><button onclick="editModule(&quot;'+esc(m.id)+'&quot;)">编辑</button> <button class="danger" onclick="delModule(&quot;'+esc(m.id)+'&quot;)">删除</button></span>')+'</div>'+
        '<div class="meta">'+esc(m.host)+' · agent '+esc(m.count)+' · 运行 '+esc(m.running)+(m.attention?(' · 待决 '+m.attention):'')+'</div>'+
        '<div class="meta mono" style="margin-top:4px">目录 '+esc(ws)+'</div>'+
        '<div class="meta mono">关键词 '+esc(ti)+'</div>'+
        '<div class="bar" title="占全部 agent 的比例"><i style="width:'+(modTotal?Math.round((m.count||0)*100/modTotal):0)+'%"></i></div></div>';
    }).join("") : '<div class="empty">没有模块定义</div>';

    var apprs=apprsAll;
    var asks=[];
    for(var qi=0;qi<rowsAll.length;qi++){ var qrow=rowsAll[qi]; if(qrow.question&&Number(qrow.question.count||0)>0) asks.push(qrow); }
    document.getElementById("attn-count").textContent = String(apprs.length+asks.length);
    document.getElementById("approvals").innerHTML = apprs.length? apprs.map(function(a){
      return '<div class="appr"><div class="t">'+esc(a.title)+' <span class="pill '+cls(a.level)+'">'+esc(a.level||"warning")+'</span> <span class="pill">'+esc(a.subject||"-")+'</span></div>'+
        '<div class="d">'+esc(a.detail||"")+'</div>'+
        '<div class="tools"><button onclick="answer(&quot;'+esc(a.id)+'&quot;,&quot;approve&quot;,'+Number(a.version||0)+')">同意</button>'+
        '<button class="danger" onclick="answer(&quot;'+esc(a.id)+'&quot;,&quot;reject&quot;,'+Number(a.version||0)+')">拒绝</button>'+
        '<span class="mono">过期 '+ago(a.deadline)+' · #'+esc(a.id)+'</span></div></div>';
    }).join("") : '<div class="attn none">没有待批事项，它现在不需要你点头。</div>';
    var extra=[];
    if(stalledCount) extra.push(stalledCount+" 个 agent 卡住（运行中但长时间没有事件），在 Agent 明细里标了 stalled");
    if(critCount) extra.push(critCount+" 条 critical 信号，见下方记录");
    document.getElementById("attn-more").innerHTML = extra.length? '<div class="attn none">'+esc(extra.join(" · "))+'</div>' : "";
    document.getElementById("asks").innerHTML = asks.length? asks.map(function(a3){
      var q3=a3.question||{}, items=Array.isArray(q3.items)?q3.items:[];
      var last=items.length?items[items.length-1]:null;
      var body3="";
      if(last&&Array.isArray(last.questions)){
        body3=last.questions.map(function(x){
          var opts=(x.options||[]).length? '<div class="mono">选项 '+esc((x.options||[]).join(" / "))+'</div>' : "";
          return '<div class="d">'+esc(x.question)+opts+'</div>';
        }).join("");
      }
      var label=last&&last.title? last.title : (a3.title||a3.id);
      return '<div class="appr"><div class="t">'+esc(label)+' <span class="pill warn">提问</span> <span class="pill">'+esc(a3.moduleId||"-")+'</span></div>'+
        body3+
        '<div class="tools"><button onclick="openDetail(&quot;'+esc(a3.sessionId)+'&quot;)">看会话</button>'+
        '<button onclick="answerQuestion(&quot;'+esc(a3.id)+'&quot;,&quot;'+esc(a3.sessionId)+'&quot;,&quot;'+esc(q3.lastCallId||"")+'&quot;)">代答</button>'+
        '<span class="mono">等待 '+ago(q3.since)+' · '+esc(q3.count)+' 个问题</span></div></div>';
    }).join("") : "";

    var runs=s.runs||[];
    document.getElementById("runs-count").textContent = String(runs.filter(function(x){return x.status!=="done"&&x.status!=="failed"}).length);
    document.getElementById("runs").innerHTML = runs.length? '<table><thead><tr><th>流程</th><th>主题</th><th>状态</th><th>步骤</th><th>尝试</th><th>更新</th><th></th></tr></thead><tbody>'+
      runs.map(function(r2){
        var st='<span class="pill '+cls(r2.status==="failed"?"error":(r2.status==="waiting"?"warn":"ok"))+'">'+esc(r2.status)+'</span>'+(r2.shadow?' <span class="pill">shadow</span>':'');
        return '<tr><td class="mono" title="'+esc(r2.id)+'">'+esc(r2.wf)+'</td><td class="mono">'+esc(String(r2.subject||"").slice(0,18))+'</td><td>'+st+'</td><td class="mono">'+esc(r2.step||"-")+'</td><td class="mono">'+esc(r2.attempts||0)+'</td><td class="mono">'+ago(r2.updatedAt)+'</td><td><button onclick="replay(&quot;'+esc(r2.id)+'&quot;)">重放</button></td></tr>';
      }).join("")+'</tbody></table>' : '<div class="empty">暂无工作流</div>';

    var ech=s.echoes||[];
    document.getElementById("echoes").innerHTML = ech.length? ech.map(function(x){
      return '<div class="sig"><span class="t">'+esc(ago(x.at))+'</span><span class="k">'+esc(x.kind)+'</span><span class="mono">'+esc(x.message||"")+'</span></div>';
    }).join("") : '<div class="empty">没有待确认动作（actMode='+esc(ctl.actMode||"echo")+'）</div>';

    var rows=(s.agents||[]).slice().sort(function(a,b){
      var rank=function(x){ return x.stalled?0:(x.attention?1:(x.status==="running"?2:3)); };
      var d=rank(a)-rank(b); if(d) return d; return (b.lastEventAt||0)-(a.lastEventAt||0);
    });
    document.getElementById("agents-count").textContent = String(rows.length);
    var modsAll=s.modules||[];
    var optsOf=function(cur){
      var o='<option value="auto"'+(cur==="unassigned"?" selected":"")+'>自动</option>';
      for(var i=0;i<modsAll.length;i++){
        var m=modsAll[i];
        o+='<option value="'+esc(m.id)+'"'+(m.id===cur?" selected":"")+'>'+esc(m.name)+'</option>';
      }
      return o;
    };
    document.getElementById("agents").innerHTML = rows.length? '<table><thead><tr><th>会话名</th><th>模块</th><th>状态</th><th>静默</th><th>轮次</th><th>目标</th><th>工作目录</th><th>归属依据</th><th></th></tr></thead><tbody>'+
      rows.map(function(a){
        var t=a.title||("session "+String(a.sessionId||a.id).slice(0,8));
        var st=(a.stalled?'<span class="pill warn">stalled</span> ':'')+(a.attention?'<span class="pill warn">待决</span> ':'')+esc(a.status)+(a.question?(' · 提问 '+a.question.count):'');
        return '<tr><td title="'+esc(a.id)+'">'+esc(t)+'</td><td><select data-pin="'+esc(a.id)+'" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;font-size:11px;padding:2px 4px">'+optsOf(a.moduleId)+'</select></td><td>'+st+'</td><td class="mono">'+ago(a.lastEventAt)+'</td><td class="mono">'+esc(a.turns||0)+'</td><td class="mono" title="'+esc(goalOf(a).full)+'">'+esc(goalOf(a).short)+'</td><td class="mono" title="'+esc(a.cwd||"")+'" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.cwd?String(a.cwd).replace(/^.*[\\\\/]/,""):"-")+'</td><td class="mono">'+esc(a.routeReason||'-')+'</td><td><button data-look="'+esc(a.sessionId||"")+'">看</button> <button data-cls="'+esc(a.id)+'">重判</button></td></tr>';
      }).join("")+'</tbody></table>' : '<div class="empty">还没有观察到 agent</div>';
    var sels=document.querySelectorAll("#agents select[data-pin]");
    for(var si=0;si<sels.length;si++){
      sels[si].onchange=(function(el){return function(){pin(el.getAttribute("data-pin"), el.value);};})(sels[si]);
    }
    var lbs=document.querySelectorAll("#agents button[data-look]");
    for(var li=0;li<lbs.length;li++){
      lbs[li].onclick=(function(el){return function(){openDetail(el.getAttribute("data-look"));};})(lbs[li]);
    }
    var cbs=document.querySelectorAll("#agents button[data-cls]");
    for(var ci=0;ci<cbs.length;ci++){
      cbs[ci].onclick=(function(el){return function(){classifyOne(el.getAttribute("data-cls"));};})(cbs[ci]);
    }

    var sigs=s.signals||[];
    document.getElementById("signals").innerHTML = sigs.length? sigs.map(function(x){
      return '<div class="sig"><span class="t">'+esc(ago(x.at))+'</span><span class="k">'+esc(x.kind)+'</span><span>'+esc(x.message||"")+(x.count>1?(' ×'+x.count):'')+'</span></div>';
    }).join("") : '<div class="empty">暂无信号</div>';

    var tsel=document.getElementById("tk-target");
    if(tsel){
      var cur=tsel.value||"";
      var o='<option value="">新开会话</option>';
      for(var ai=0;ai<rows.length;ai++){
        if(!rows[ai].sessionId) continue;
        var ov="session:"+rows[ai].sessionId;
        var ol=(rows[ai].title||String(rows[ai].sessionId).slice(0,12));
        o+='<option value="'+esc(ov)+'"'+(cur===ov?" selected":"")+'>'+esc(String(ol).slice(0,28))+'</option>';
      }
      tsel.innerHTML=o;
    }

    var cl=ctl.classifier||{}, ex=ctl.export||{};
    document.getElementById("foot").textContent = "journal "+(s.journal?s.journal.file:"-")+" · 能力 "+(r.count||0)+" ("+(r.hash||"-")+") · 编制 "+(r.stewards||0)+" · trace "+((s.plane&&s.plane.trace&&s.plane.trace.traces)||0)+" · 效果 "+((s.plane&&s.plane.trace&&s.plane.trace.effects)||0)+" · 会话名缓存 "+(s.titles?s.titles.size:0)+" · classifier "+(cl.enabled?"on":"off")+" "+(cl.model||"host-default")+" 缓存 "+(cl.cached||0)+" 判过 "+(ctl.classifyStarted||0)+" · export prometheus "+(ex.prometheus?"on":"off")+(ex.otlpEnabled?(" otlp "+ex.endpoint):"")+" · 事件 "+c.events+(s.degraded&&s.degraded.length?(" · 降级 "+s.degraded.join(" | ")):"");
  }
  var TASKS = [];
  var DETAIL = {};
  function clip(v,n){ var x=String(v==null?"":v); return x.length>n? x.slice(0,n)+"…" : x; }
  function goalOf(a){
    var d=a&&a.sessionId? DETAIL[a.sessionId] : null;
    if(!d) return {short:"-",full:""};
    var td=d.todos||{};
    var short=(d.goal? clip(d.goal,26) : (td.current? clip(td.current,26) : "-"))+(td.total? (" "+(td.done||0)+"/"+td.total) : "");
    return {short:short,full:(d.goal||"")+(td.current?(" · 正在 "+td.current):"")+(td.next?(" · 下一步 "+td.next):"")};
  }
  function loadTasks(){
    fetch(API+"tasks",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      TASKS=(d&&d.tasks)||[];
      var sum=(d&&d.summary)||{};
      var cnt=document.getElementById("tasks-count"); if(cnt) cnt.textContent=String(sum.open||0);
      var el=document.getElementById("tasks"); if(!el) return;
      el.innerHTML = TASKS.length? TASKS.map(function(t2){
        var st='<span class="pill '+cls(t2.status==="failed"?"error":(t2.status==="running"?"ok":(t2.status==="review"?"warn":"")))+'">'+esc(t2.status)+'</span>';
        var ops='';
        if(t2.status==="queued") ops+='<button onclick="taskOp(&quot;dispatch&quot;,'+t2.id+')">派发</button> ';
        if(t2.status==="review"||t2.status==="running"||t2.status==="assigned") ops+='<button onclick="taskOp(&quot;complete&quot;,'+t2.id+')">完成</button> <button class="danger" onclick="taskOp(&quot;fail&quot;,'+t2.id+')">失败</button> ';
        if(t2.status!=="done"&&t2.status!=="cancelled"&&t2.status!=="failed") ops+='<button class="danger" onclick="taskOp(&quot;cancel&quot;,'+t2.id+')">取消</button>';
        return '<div class="tk"><span class="mono">#'+t2.id+'</span><span class="ttl">'+esc(t2.title)+'</span>'+st+
          '<span class="res" title="'+esc(t2.result||t2.error||"")+'">'+esc(clip(t2.result||t2.error||t2.brief||"",90))+'</span>'+
          '<span class="mono">'+esc(t2.sessionId?String(t2.sessionId).slice(0,14):"-")+' · 试 '+esc(t2.attempts)+'</span><span class="tools">'+ops+'</span></div>';
      }).join("") : '<div class="empty">还没有交办单</div>';
    }).catch(function(){});
  }
  function taskOp(op,id){
    post("tasks",{op:op,id:id,result:"面板标记完成",reason:"面板标记失败"}).then(function(r){
      if(!r||!r.ok) alert("操作失败: "+((r&&r.reason)||"unknown"));
      loadTasks(); load();
    });
  }
  function addTask(){
    var el=document.getElementById("tk-title");
    var title=(el.value||"").trim();
    if(!title){ alert("先写一句要它做什么"); return; }
    var target=(document.getElementById("tk-target").value||"");
    post("tasks",{op:"create",title:title,acceptance:(document.getElementById("tk-accept").value||"").trim(),target:target}).then(function(r){
      if(!r||!r.ok){ alert("交办失败: "+((r&&r.reason)||"unknown")); return; }
      el.value=""; document.getElementById("tk-accept").value="";
      loadTasks(); load();
    });
  }
  function loadChat(){
    fetch(API+"chat",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      var c=(d&&d.chat)||null, tr=(d&&d.transcript)||{};
      var pill=document.getElementById("chat-state");
      if(pill){ pill.textContent = c&&c.bound? "已绑定" : "未绑定"; pill.className = "pill"+(c&&c.bound?" ok":""); }
      var idEl=document.getElementById("chat-id");
      if(idEl) idEl.textContent = c&&c.id? String(c.id).slice(0,18) : (c&&c.available===false? "sessionController 不可用" : "");
      var el=document.getElementById("chat-log"); if(!el) return;
      var entries=(tr&&tr.entries)||[];
      var who=function(r){ return r==="you"?"你":(r==="steward"?"主管":(r==="tool"?"工具":"系统")); };
      el.innerHTML = entries.length? entries.map(function(e){
        var role=e.role==="you"?"you":(e.role==="steward"?"steward":(e.role==="tool"?"steward":"sys"));
        return '<div class="line '+role+'"><span class="who">'+who(e.role)+'</span>'+esc(e.text)+'</div>';
      }).join("") : '<div class="empty">'+(c&&c.bound? "还没有对话" : "未绑定主管会话 —— 点「新建主管会话」或「绑定现有会话」")+'</div>';
      el.scrollTop = el.scrollHeight;
    }).catch(function(){});
  }
  function chatSend(){
    var el=document.getElementById("chat-text");
    var t=(el.value||"").trim();
    if(!t) return;
    el.value="";
    post("chat",{op:"send",text:t,mode:"followup"}).then(function(r){
      if(!r||!r.ok) alert("发送失败: "+((r&&r.reason)||"unknown"));
      loadChat();
    });
  }
  function chatCreate(){
    post("chat",{op:"create"}).then(function(r){
      if(!r||!r.ok) alert("新建失败: "+((r&&r.reason)||"unknown"));
      loadChat(); load();
    });
  }
  function chatBind(){
    var id=prompt("绑定哪个会话？填 session id（也可以填 Agent 明细里那一行的完整 id）");
    if(!id) return;
    post("chat",{op:"bind",sessionId:String(id).trim()}).then(function(r){
      if(!r||!r.ok) alert("绑定失败: "+((r&&r.reason)||"unknown"));
      loadChat(); load();
    });
  }
  function chatUnbind(){
    post("chat",{op:"unbind"}).then(function(){ loadChat(); load(); });
  }
  function openDetail(sessionId){
    var d=document.getElementById("drawer");
    if(!sessionId){ alert("这一行没有 session id"); return; }
    d.className="on"; d.innerHTML='<div class="empty">读取中…</div>';
    fetch(API+"detail?session="+encodeURIComponent(sessionId),{cache:"no-store"}).then(function(r){return r.json()}).then(function(res){
      if(!res||!res.ok){
        d.innerHTML='<h4>'+esc(String(sessionId).slice(0,18))+'</h4><div class="empty">读不到详情：'+esc((res&&res.reason)||"unknown")+'</div><button onclick="closeDetail()">关闭</button>';
        return;
      }
      var x=res.detail||{}; DETAIL[sessionId]=x;
      var td=x.todos||{};
      var kv=function(k,v){ return '<div class="kv">'+k+'：<b>'+esc(v==null||v===""?"-":v)+'</b></div>'; };
      d.innerHTML='<h4>'+esc(String(sessionId).slice(0,18))+'</h4>'+
        kv("目标", x.goal)+
        kv("进度", (td.done||0)+"/"+(td.total||0)+(td.current?(" · 正在 "+td.current):"")+(td.next?(" · 下一步 "+td.next):""))+
        kv("轮次", String(x.turns||0))+
        kv("最后活动", ago(x.lastAt))+
        kv("最后一句", clip(x.lastAssistant||"-",400))+
        ((x.trace&&x.trace.length)? '<div class="trace">'+x.trace.map(function(t3){ return '<div class="tr">'+esc(ago(t3.at))+' · <b>'+esc(t3.kind)+'</b> · '+esc(t3.text)+'</div>'; }).join("")+'</div>' : "")+
        '<button onclick="closeDetail()">关闭</button>';
      load();
    }).catch(function(e){ d.innerHTML='<div class="empty">读取失败: '+esc(e)+'</div><button onclick="closeDetail()">关闭</button>'; });
  }
  function closeDetail(){ var d=document.getElementById("drawer"); d.className=""; d.innerHTML=""; }

  function kvRow(k, v){ return '<div class="kv">'+k+'：<b>'+esc(v==null||v===""?"-":v)+'</b></div>'; }
  var TR = { traces: [] };
  function loadTraces(){
    fetch(API+"trace?limit=25",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      TR = d||{traces:[]}; renderTraces();
    }).catch(function(e){ var el=document.getElementById("traces"); if(el) el.innerHTML='<div class="empty">读取失败: '+esc(e)+'</div>'; });
  }
  function renderTraces(){
    var el=document.getElementById("traces"); if(!el) return;
    var all=(TR&&TR.traces)||[];
    var sel=document.getElementById("tr-filter");
    var mode=sel?sel.value:"";
    var rows=mode==="bad"?all.filter(function(t){return t.status!=="ok"||t.ok===false;}):all;
    var cnt=document.getElementById("traces-count"); if(cnt) cnt.textContent=String(all.length);
    el.innerHTML=rows.length?'<table><thead><tr><th>时间</th><th>触发</th><th>编制</th><th>主题</th><th>状态</th><th>span</th><th>耗时</th><th></th></tr></thead><tbody>'+
      rows.map(function(t){
        var st='<span class="pill '+cls(t.status==="ok"&&t.ok!==false?"ok":"error")+'">'+esc(t.status||"-")+'</span>';
        return '<tr><td class="mono">'+esc(ago(t.startedAt))+'</td><td class="mono">'+esc(t.trigger||"-")+'</td><td class="mono">'+esc(t.stewardId||"-")+'</td><td class="mono">'+esc(String(t.subject||"-").slice(0,16))+'</td><td>'+st+'</td><td class="mono">'+esc(t.spanCount||0)+'</td><td class="mono">'+esc(t.ms||0)+'ms</td><td><button data-trace="'+esc(t.id)+'">瀑布</button></td></tr>';
      }).join("")+'</tbody></table>':'<div class="empty">没有符合条件的 trace</div>';
    var bs=document.querySelectorAll("#traces button[data-trace]");
    for(var i=0;i<bs.length;i++){ bs[i].onclick=(function(e2){return function(){openTrace(e2.getAttribute("data-trace"));};})(bs[i]); }
  }
  function openTrace(id){
    var d=document.getElementById("drawer");
    d.className="on"; d.innerHTML='<div class="empty">读取中…</div>';
    fetch(API+"trace?id="+encodeURIComponent(id),{cache:"no-store"}).then(function(r){return r.json()}).then(function(res){
      if(!res||!res.ok||!res.waterfall){
        d.innerHTML='<h4>'+esc(String(id).slice(0,24))+'</h4><div class="empty">读不到 trace：'+esc((res&&(res.error||res.reason))||"unknown")+'</div><button onclick="closeDetail()">关闭</button>';
        return;
      }
      var w=res.waterfall; var tr=w.trace||{}; var spans=w.spans||[]; var intents=w.intents||[]; var effects=w.effects||[];
      var rows=spans.map(function(s2){
        var kids=(s2.effects&&s2.effects.length)?s2.effects.map(function(e3){ return '<div class="tr">　↳ '+esc(e3.cap||"-")+(e3.extId?(" → "+esc(e3.extId)):"")+(e3.ok===false?(" 失败 "+esc(e3.errorCode||"")):"")+'</div>'; }).join(""):"";
        return '<div class="tr">'+esc(ago(s2.startedAt))+' · <b>'+esc(s2.kind||"span")+'</b> '+esc(s2.ref||"")+' · <span class="pill '+cls(s2.status==="ok"?"ok":"error")+'">'+esc(s2.status||"-")+'</span> · '+esc(s2.ms||0)+'ms</div>'+kids;
      }).join("");
      var why=intents.map(function(t2, i2){
        return '<div class="tr">'+esc(ago(t2.at))+' · <b>'+esc(t2.cap||"-")+'</b> · '+esc(t2.payload||"")+' × '+esc(t2.target||"-")+' · 决定 '+esc(t2.decision||"-")+(t2.preview?"（预览）":"")+(t2.reason?(" · "+esc(t2.reason)):"")+'</div>';
      }).join("");
      d.innerHTML='<h4>'+esc(tr.id||id)+'</h4>'+
        kvRow("触发", (tr.trigger||"-")+" · 编制 "+(tr.stewardId||"-"))+
        kvRow("状态", (tr.status||"-")+" · "+(tr.ms||0)+"ms · span "+spans.length+" · 效果 "+effects.length)+
        kvRow("主题", tr.subject)+
        (rows?'<div class="trace">'+rows+'</div>':'<div class="empty">这条 trace 没有 span</div>')+
        (why?'<div class="trace"><div class="tr"><b>为什么</b></div>'+why+'</div>':'<div class="empty">没有留下意图记录（被前置闸门拦住时会记在这里）</div>')+
        '<div class="tools">'+
        '<button data-tra="replay">重放</button><button data-tra="export">导出</button>'+
        '<button data-tra="diff">对比上一条</button><button data-tra="pin">钉住</button>'+
        '<button onclick="closeDetail()">关闭</button></div>';
      var tbs=d.querySelectorAll("button[data-tra]");
      for(var ti=0;ti<tbs.length;ti++){ tbs[ti].onclick=(function(b){ return function(){
        var k2=b.getAttribute("data-tra"); var tid=tr.id||id;
        if(k2==="replay") replayTrace(tid); else if(k2==="export") exportTrace(tid); else if(k2==="diff") diffTrace(tid); else pinTrace(tid);
      }; })(tbs[ti]); }
    }).catch(function(e){ d.innerHTML='<div class="empty">读取失败: '+esc(e)+'</div><button onclick="closeDetail()">关闭</button>'; });
  }
  var browse=document.getElementById("tr-filter");
  if(browse) browse.onchange=renderTraces;
  // 内联 onclick 在全局作用域求值：本面板的函数必须显式挂到 window，否则点击会报 xxx is not defined。
  // ---- P2 能力仓 ----
  var CAT={list:[]};
  function loadCatalog(){
    var q=document.getElementById("cat-q").value||"";
    var p=document.getElementById("cat-payload").value||"";
    var c=document.getElementById("cat-carrier").value||"";
    fetch(API+"catalog?q="+encodeURIComponent(q)+"&payload="+encodeURIComponent(p)+"&carrier="+encodeURIComponent(c),{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      CAT.list=(d&&d.capabilities)||[];
      var el=document.getElementById("catalog");
      var head="共 "+(d.count||0)+" 条 · hash "+(d.hash||"-")+" · 判定 "+((d.byPayload||{}).verdict||0)+" · 片段 "+((d.byPayload||{}).plan||0);
      if(d.errors&&d.errors.length) head+=" · "+d.errors.length+" 条装载错误";
      document.getElementById("catalog-count").textContent=String(CAT.list.length);
      el.innerHTML="<div class=\\"meta\\">"+esc(head)+"</div>"+CAT.list.map(function(c){
        var used=(c.usedBy||[]).map(function(u){return u.name||u.id;}).join("、")||"无人装备";
        return "<div class=\\"modcat\\"><div class=\\"name\\"><span class=\\"mono\\">"+esc(c.id)+"</span> "+esc(c.title||"")+"</div>"+
          "<div class=\\"meta\\">"+esc(c.payload)+" × "+esc(c.carrier)+" × "+esc(c.protocol)+" → "+esc((c.targets||[]).join(","))+" · 授权 "+esc(c.grant)+" · 装备："+esc(used)+"</div>"+
          (c.plan?"<details><summary class=\\"mono\\">片段树</summary><pre>"+esc(JSON.stringify(c.plan,null,1))+"</pre></details>":"")+
          "</div>";
      }).join("");
    }).catch(function(){});
  }
  // ---- P2 路由矩阵 ----
  function loadRoutes(){ fetch(API+"routes",{cache:"no-store"}).then(function(r){return r.json()}).then(renderRoutes).catch(function(){}); }
  function renderRoutes(d){
    var el=document.getElementById("routes");
    if(!d||!d.routes){ el.innerHTML="<div class=\\"empty\\">能力平面不可用</div>"; return; }
    var mx=d.routes.matrix||[];
    document.getElementById("routes-count").textContent=String((d.routes.rules||[]).length);
    el.innerHTML="<div class=\\"meta\\">默认 "+esc(d.routes.default)+" · 例外 "+(d.routes.rules||[]).length+" 条 · actLevel "+esc(d.actLevel||"-")+"</div>"+
      "<table><thead><tr><th>主管</th><th>能力 → 路由</th></tr></thead><tbody>"+mx.map(function(row){
        return "<tr><td class=\\"mono\\">"+esc(row.id)+"</td><td>"+row.cells.map(function(cell){
          return "<button class=\\"rcell "+esc(cell.route)+"\\" data-rs=\\""+esc(row.id)+"\\" data-rc=\\""+esc(cell.cap)+"\\" data-rt=\\""+esc(cell.target||"")+"\\" data-rr=\\""+esc(cell.route)+"\\" title=\\"grant "+esc(cell.grant)+"\\">"+esc(cell.cap)+"<span>"+esc(cell.route)+"</span></button>";
        }).join(" ")+"</td></tr>";
      }).join("")+"</tbody></table>";
    var cells=el.querySelectorAll("button.rcell");
    for(var i=0;i<cells.length;i++) cells[i].onclick=function(){ cycleRoute(this); };
  }
  function cycleRoute(btn){
    var order=["allow","approval","deny","inherit"];
    var cur=btn.getAttribute("data-rr"); var idx=order.indexOf(cur); var next=order[(idx+1)%order.length];
    post("routes",{op:"cell",steward:btn.getAttribute("data-rs"),cap:btn.getAttribute("data-rc"),target:btn.getAttribute("data-rt"),route:next}).then(function(r){ if(r&&r.ok) loadRoutes(); else alert("改路由失败: "+((r&&r.error)||"unknown")); });
  }
  // ---- P2 审计 + 导出 ----
  function loadAudit(){
    var sel=document.getElementById("au-filter"); var fv=sel?sel.value:"";
    var url=API+"audit?limit=60"+(fv?"&decision="+encodeURIComponent(fv):"");
    fetch(url,{cache:"no-store"}).then(function(r){return r.json()}).then(renderAudit).catch(function(){});
  }
  function renderAudit(d){
    var el=document.getElementById("audit"); var rows=(d&&d.rows)||[];
    document.getElementById("audit-count").textContent=String(rows.length);
    if(!rows.length){ el.innerHTML="<div class=\\"empty\\">还没有审计记录</div>"; return; }
    el.innerHTML="<table><thead><tr><th>时间</th><th>主管</th><th>能力</th><th>决定</th><th>目标</th><th>说明</th></tr></thead><tbody>"+rows.map(function(r){
      var bad=r.decision!=="run"&&r.decision!=="ok";
      return "<tr><td>"+ago(r.at)+"</td><td class=\\"mono\\">"+esc(r.stewardId)+"</td><td class=\\"mono\\">"+esc(r.cap)+"</td><td><span class=\\"pill "+(bad?"warn":"")+"\\">"+esc(r.decision||"-")+"</span></td><td class=\\"mono\\">"+esc(r.target)+"</td><td>"+esc(clip(r.reason,60))+"</td></tr>";
    }).join("")+"</tbody></table>";
  }
  function exportAudit(){ window.open(API+"audit/export?limit=500"); }
  function exportJournal(){ window.open(API+"journal/export?limit=500"); }
  function exportOtlp(){ window.open(API+"trace/otlp?limit=200"); }
  // ---- P2 决策树校验 + 片段插入 ----
  function validateSteward(){
    var box=document.getElementById("sw-json"); var msg=document.getElementById("sw-msg2");
    var rec; try{ rec=JSON.parse(box.value); }catch(e){ msg.textContent="JSON 解析失败: "+e; return; }
    post("tree/validate",{steward:rec}).then(function(r){ msg.textContent=(r&&r.ok)?"校验通过":"校验失败: "+((r&&r.errors)||[]).join("; "); });
  }
  function loadSnippets(){
    fetch(API+"tree/snippets",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){
      var el=document.getElementById("sw-snippets"); if(!el) return;
      el.innerHTML="<span class=\\"mono\\">插入片段：</span>"+((d&&d.snippets)||[]).map(function(s){
        return "<button data-snip=\\""+esc(s.id)+"\\">"+esc(s.title||s.id)+"</button>";
      }).join("");
      var bs=el.querySelectorAll("button[data-snip]");
      for(var i=0;i<bs.length;i++) bs[i].onclick=function(){ insertSnippet(this.getAttribute("data-snip")); };
    }).catch(function(){});
  }
  function insertSnippet(id){
    var box=document.getElementById("sw-json"); var msg=document.getElementById("sw-msg2");
    var rec; try{ rec=JSON.parse(box.value); }catch(e){ msg.textContent="JSON 解析失败: "+e; return; }
    var tree=rec.tree&&rec.tree.seq?rec.tree:{seq:[]};
    var steps=(tree.seq||[]).slice();
    steps.push({call:id,params:{},onError:"continue"});
    rec.tree={seq:steps};
    box.value=JSON.stringify(rec,null,1);
    msg.textContent="已插入 "+id+"（树里新增一步 call）";
  }

  var GLOBAL_FNS=[load,loadSettings,saveSettings,openRawSettings,answerQuestion,loadTraces,renderTraces,openTrace,closeDetail,openDetail,act,toggleAuto,toggleLark,toggleLarkDoc,toggleMode,answer,pin,classifyOne,classifyAll,editModule,closeEditor,saveModule,delModule,resetModules,replay,addTask,taskOp,loadTasks,loadChat,chatCreate,chatBind,chatUnbind,chatSend,loadStewards,renderStewards,toggleSteward,editSteward,closeStewardEditor,saveSteward,addSteward,delSteward,loadDoctor,renderDoctor,jump,replayTrace,exportTrace,diffTrace,pinTrace,loadCatalog,loadRoutes,renderRoutes,cycleRoute,loadAudit,renderAudit,exportAudit,exportJournal,exportOtlp,validateSteward,loadSnippets,insertSnippet];
  for(var gi=0;gi<GLOBAL_FNS.length;gi++){ try { window[GLOBAL_FNS[gi].name]=GLOBAL_FNS[gi]; } catch(e){ } }
  load(); if(K.poll){ K.poll(load, 5000); } else { setInterval(load, 5000); }
})();
</script>
</body></html>`;
}

export default { stewardPanelHtml };
