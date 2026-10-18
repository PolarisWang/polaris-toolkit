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

<!-- 2 需要你处理：待批 / 卡住的 agent，没有就收成一行 -->
<section class="sec">
  <div class="sech"><span class="tier">1</span> 需要你处理 <span class="pill" id="attn-count">0</span>
    <span class="sechint">待批要点过才会继续；卡住的 agent 也在这里点名</span></div>
  <div id="approvals"><div class="empty">没有待批事项</div></div>
  <div id="attn-more"></div>
</section>

<!-- 3 控制：会立刻改变它下一步怎么动 -->
<section class="sec">
  <div class="sech"><span class="tier">2</span> 控制 <span class="sechint">自动动作 / echo-live / 飞书 三个开关是行为面</span></div>
  <div class="tools">
    <button id="btn-auto" onclick="toggleAuto()">自动动作</button>
    <button id="btn-mode" onclick="toggleMode()">act: echo</button>
    <button id="btn-lark" onclick="toggleLark()">飞书通知</button>
    <button onclick="act('digest')">立即汇报</button>
  </div>
</section>

<!-- 4 交办：把活交给它 -->
<section class="sec">
  <div class="sech"><span class="tier">3</span> 交办 <span class="pill" id="tasks-count">0</span>
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
  <div class="sech"><span class="tier">4</span> 对话 <span class="pill" id="chat-state">未绑定</span>
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
  <div class="sech"><span class="tier">5</span> 正在发生 <span class="pill" id="runs-count">0</span>
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

<!-- 5 明细：agent 表 -->
<section class="sec">
  <div class="sech"><span class="tier">6</span> Agent 明细 <span class="pill" id="agents-count">0</span>
    <span class="sechint">卡住 → 待决 → 运行中 → 空闲；点「看」打开详情抽屉（目标 / 待办 / 最近轨迹）</span></div>
<div id="agents"><div class="empty">读取中…</div></div>
</section>

<!-- 7 记录：echo 拟执行 + 信号流 -->
<section class="sec">
  <div class="sech"><span class="tier">7</span> 记录 <span class="sechint">echo 拟执行 · 信号流</span></div>
<h3>拟执行（echo，只打印不执行）</h3><div id="echoes"><div class="empty">没有待确认动作</div></div>
<h3>信号流</h3><div id="signals"><div class="empty">暂无信号</div></div>
</section>

<!-- 8 追查：能力平面 trace -->
<section class="sec">
  <div class="sech"><span class="tier">8</span> 追查 <span class="pill" id="traces-count">0</span>
    <span class="sechint">每次判定/动作一条 trace；点「瀑布」看调用链与「为什么」</span></div>
  <div class="tools">
    <select id="tr-filter"><option value="">全部</option><option value="bad">被拦 / 失败</option></select>
    <button onclick="loadTraces()">刷新</button>
  </div>
  <div id="traces"><div class="empty">暂无 trace</div></div>
</section>

<div id="drawer"></div>
<!-- 8 维护：低频操作收进折叠区 -->
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
  var K = window.PolarisKit || {};
  function esc(s){ return K.esc ? K.esc(s) : String(s==null?"":s); }
  function ago(t){ if(!t) return "-"; var d=Date.now()-t; if(d<60000) return Math.round(d/1000)+"s"; if(d<3600000) return Math.round(d/60000)+"m"; return Math.round(d/3600000)+"h"; }
  function cls(v){ return v==="high"||v==="error"||v==="critical"?"err":(v==="warn"||v==="warning"?"warn":"ok"); }
  function load(){
    fetch(API+"state",{cache:"no-store"}).then(function(r){return r.json()}).then(render).catch(function(e){
      document.getElementById("hero").innerHTML='<div class="empty">读取失败: '+esc(e)+'</div>';
    });
    loadTasks(); loadChat(); loadTraces();
  }
  function post(path, body){
    if (K.post) return K.post(API+path, body);
    return fetch(API+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json()});
  }
  function act(id){ post("action",{id:id}).then(load); }
  function toggleAuto(){ if(!S||!S.control) return; post("settings",{patch:{autoAct:S.control.autoAct!==true}}).then(load); }
  function toggleLark(){ if(!S||!S.control||!S.control.notify) return; post("settings",{patch:{notify:{larkEnabled:S.control.notify.larkEnabled!==true}}}).then(load); }
  function answer(id, value, version){ post("answer",{id:id,answer:value,version:version,by:"panel"}).then(load); }
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
    document.getElementById("attn-count").textContent = String(apprs.length);
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
        '<button onclick="closeDetail()">关闭</button>';
    }).catch(function(e){ d.innerHTML='<div class="empty">读取失败: '+esc(e)+'</div><button onclick="closeDetail()">关闭</button>'; });
  }
  var browse=document.getElementById("tr-filter");
  if(browse) browse.onchange=renderTraces;
  // 内联 onclick 在全局作用域求值：本面板的函数必须显式挂到 window，否则点击会报 xxx is not defined。
  var GLOBAL_FNS=[load,loadTraces,renderTraces,openTrace,closeDetail,openDetail,act,toggleAuto,toggleLark,toggleMode,answer,pin,classifyOne,classifyAll,editModule,closeEditor,saveModule,delModule,resetModules,replay,addTask,taskOp,loadTasks,loadChat,chatCreate,chatBind,chatUnbind,chatSend];
  for(var gi=0;gi<GLOBAL_FNS.length;gi++){ try { window[GLOBAL_FNS[gi].name]=GLOBAL_FNS[gi]; } catch(e){ } }
  load(); if(K.poll){ K.poll(load, 5000); } else { setInterval(load, 5000); }
})();
</script>
</body></html>`;
}

export default { stewardPanelHtml };
