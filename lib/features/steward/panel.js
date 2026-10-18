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
</style></head>
<body class="${bodyClass}">
<h1>大内总管 Steward <span class="pill" id="phase">规则 → 工作流</span></h1>
<div class="sub">观察全部 agent / 归类到模块 / 规则命中后走持久工作流。动作默认只通知，需显式开启才动手。</div>
<div class="hero" id="hero"><div class="empty">读取中…</div></div>
<div class="tools">
  <button id="btn-auto" onclick="toggleAuto()">自动动作</button>
  <button id="btn-mode" onclick="toggleMode()">act: echo</button>
  <button id="btn-lark" onclick="toggleLark()">飞书通知</button>
  <button onclick="act('digest')">立即汇报</button>
  <button onclick="act('collect')">强制采样</button>
  <button onclick="classifyAll()">按 agent 判断归类</button>
  <button onclick="act('reload-rules')">重载规则</button>
  <button onclick="load()">刷新</button>
</div>
<h2>模块 <button onclick="editModule(null)">新增模块</button> <button onclick="resetModules()">恢复默认</button></h2>
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
<h2>拟执行（echo，只打印不执行）</h2><div id="echoes"><div class="empty">没有待确认动作</div></div>
<h2>待批</h2><div id="approvals"><div class="empty">没有待批事项</div></div>
<h2>工作流</h2><div id="runs"><div class="empty">暂无工作流</div></div>
<h2>Agent 明细</h2><div id="agents"><div class="empty">读取中…</div></div>
<h2>信号流</h2><div id="signals"><div class="empty">暂无信号</div></div>
<div class="sub" id="foot" style="margin-top:18px"></div>
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
    var level = h.heapUsedMB>3200?"err":(h.heapUsedMB>2200?"warn":"ok");
    var ctl=s.control||{};
    document.getElementById("hero").innerHTML =
      '<div><div class="kv">宿主堆<b>'+esc(h.heapUsedMB)+' MB / '+esc(h.heapLimitMB)+' MB</b></div></div>'+
      '<div><div class="kv">事件循环 P99<b>'+esc(loop.p99Ms)+' ms'+(loop.maxMs>200?' <span class="pill warn">max '+esc(loop.maxMs)+'</span>':'')+'</b></div></div>'+
      '<div><div class="kv">Agent 总数<b>'+esc((s.agents||[]).length)+'（运行 '+esc((s.agents||[]).filter(function(a){return a.status==="running"}).length)+'）</b></div></div>'+
      '<div><div class="kv">待决信号<b>'+esc((s.signals||[]).filter(function(x){return x.severity!=="info"}).length)+'</b></div></div>'+
      '<div><div class="kv">运行流程 / 待批<b>'+esc((s.runs||[]).filter(function(x){return x.status!=="done"&&x.status!=="failed"}).length)+' / '+esc((s.approvals||[]).length)+'</b></div></div>'+
      '<div><div class="kv">动作预算<b>'+esc(b.used||0)+' / '+esc(b.max||0)+' 每小时</b></div></div>'+
      '<div><div class="kv">状态<b><span class="pill '+level+'">'+esc(level==="ok"?"平稳":(level==="warn"?"偏高":"吃紧"))+'</span> <span class="pill '+(ctl.autoAct?"warn":"")+'">'+esc(ctl.autoAct?"自动动作开":"只通知")+'</span></b></div></div>';
    var ba=document.getElementById("btn-auto"); ba.className = ctl.autoAct?"on":"";
    var bm=document.getElementById("btn-mode");
    bm.textContent = "act: "+(ctl.actMode==="live"?"live":"echo");
    bm.className = ctl.actMode==="live"?"danger":"on";
    var bl=document.getElementById("btn-lark"); bl.className = ctl.notify&&ctl.notify.larkEnabled?"on":"";
    var mj=document.getElementById("mods-json");
    if(mj && document.activeElement!==mj) mj.value = JSON.stringify(s.moduleDefs||[], null, 1);

    var mods=s.modules||[];
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
        '<div class="meta mono">关键词 '+esc(ti)+'</div></div>';
    }).join("") : '<div class="empty">没有模块定义</div>';

    var apprs=s.approvals||[];
    document.getElementById("approvals").innerHTML = apprs.length? apprs.map(function(a){
      return '<div class="appr"><div class="t">'+esc(a.title)+' <span class="pill '+cls(a.level)+'">'+esc(a.level||"warning")+'</span> <span class="pill">'+esc(a.subject||"-")+'</span></div>'+
        '<div class="d">'+esc(a.detail||"")+'</div>'+
        '<div class="tools"><button onclick="answer(&quot;'+esc(a.id)+'&quot;,&quot;approve&quot;,'+Number(a.version||0)+')">同意</button>'+
        '<button class="danger" onclick="answer(&quot;'+esc(a.id)+'&quot;,&quot;reject&quot;,'+Number(a.version||0)+')">拒绝</button>'+
        '<span class="mono">过期 '+ago(a.deadline)+' · #'+esc(a.id)+'</span></div></div>';
    }).join("") : '<div class="empty">没有待批事项</div>';

    var runs=s.runs||[];
    document.getElementById("runs").innerHTML = runs.length? '<table><thead><tr><th>流程</th><th>主题</th><th>状态</th><th>步骤</th><th>尝试</th><th>更新</th><th></th></tr></thead><tbody>'+
      runs.map(function(r2){
        var st='<span class="pill '+cls(r2.status==="failed"?"error":(r2.status==="waiting"?"warn":"ok"))+'">'+esc(r2.status)+'</span>'+(r2.shadow?' <span class="pill">shadow</span>':'');
        return '<tr><td class="mono" title="'+esc(r2.id)+'">'+esc(r2.wf)+'</td><td class="mono">'+esc(String(r2.subject||"").slice(0,18))+'</td><td>'+st+'</td><td class="mono">'+esc(r2.step||"-")+'</td><td class="mono">'+esc(r2.attempts||0)+'</td><td class="mono">'+ago(r2.updatedAt)+'</td><td><button onclick="replay(&quot;'+esc(r2.id)+'&quot;)">重放</button></td></tr>';
      }).join("")+'</tbody></table>' : '<div class="empty">暂无工作流</div>';

    var ech=s.echoes||[];
    document.getElementById("echoes").innerHTML = ech.length? ech.map(function(x){
      return '<div class="sig"><span class="t">'+esc(ago(x.at))+'</span><span class="k">'+esc(x.kind)+'</span><span class="mono">'+esc(x.message||"")+'</span></div>';
    }).join("") : '<div class="empty">没有待确认动作（actMode='+esc(ctl.actMode||"echo")+'）</div>';

    var rows=s.agents||[];
    var modsAll=s.modules||[];
    var optsOf=function(cur){
      var o='<option value="auto"'+(cur==="unassigned"?" selected":"")+'>自动</option>';
      for(var i=0;i<modsAll.length;i++){
        var m=modsAll[i];
        o+='<option value="'+esc(m.id)+'"'+(m.id===cur?" selected":"")+'>'+esc(m.name)+'</option>';
      }
      return o;
    };
    document.getElementById("agents").innerHTML = rows.length? '<table><thead><tr><th>会话名</th><th>模块</th><th>状态</th><th>静默</th><th>轮次</th><th>工作目录</th><th>归属依据</th><th></th></tr></thead><tbody>'+
      rows.map(function(a){
        var t=a.title||("session "+String(a.sessionId||a.id).slice(0,8));
        var st=(a.stalled?'<span class="pill warn">stalled</span> ':'')+(a.attention?'<span class="pill warn">待决</span> ':'')+esc(a.status)+(a.question?(' · 提问 '+a.question.count):'');
        return '<tr><td title="'+esc(a.id)+'">'+esc(t)+'</td><td><select data-pin="'+esc(a.id)+'" style="background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;font-size:11px;padding:2px 4px">'+optsOf(a.moduleId)+'</select></td><td>'+st+'</td><td class="mono">'+ago(a.lastEventAt)+'</td><td class="mono">'+esc(a.turns||0)+'</td><td class="mono" title="'+esc(a.cwd||"")+'" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.cwd?String(a.cwd).replace(/^.*[\\\\/]/,""):"-")+'</td><td class="mono">'+esc(a.routeReason||'-')+'</td><td><button data-cls="'+esc(a.id)+'">重判</button></td></tr>';
      }).join("")+'</tbody></table>' : '<div class="empty">还没有观察到 agent</div>';
    var sels=document.querySelectorAll("#agents select[data-pin]");
    for(var si=0;si<sels.length;si++){
      sels[si].onchange=(function(el){return function(){pin(el.getAttribute("data-pin"), el.value);};})(sels[si]);
    }
    var cbs=document.querySelectorAll("#agents button[data-cls]");
    for(var ci=0;ci<cbs.length;ci++){
      cbs[ci].onclick=(function(el){return function(){classifyOne(el.getAttribute("data-cls"));};})(cbs[ci]);
    }

    var sigs=s.signals||[];
    document.getElementById("signals").innerHTML = sigs.length? sigs.map(function(x){
      return '<div class="sig"><span class="t">'+esc(ago(x.at))+'</span><span class="k">'+esc(x.kind)+'</span><span>'+esc(x.message||"")+(x.count>1?(' ×'+x.count):'')+'</span></div>';
    }).join("") : '<div class="empty">暂无信号</div>';

    var cl=ctl.classifier||{}, ex=ctl.export||{};
    document.getElementById("foot").textContent = "journal "+(s.journal?s.journal.file:"-")+" · 规则 "+(r.count||0)+" ("+(r.hash||"-")+") · 求值 "+((r.stats&&r.stats.evaluated)||0)+" 命中 "+((r.stats&&r.stats.matched)||0)+" · 会话名缓存 "+(s.titles?s.titles.size:0)+" · classifier "+(cl.enabled?"on":"off")+" "+(cl.model||"host-default")+" 缓存 "+(cl.cached||0)+" 判过 "+(ctl.classifyStarted||0)+" · export prometheus "+(ex.prometheus?"on":"off")+(ex.otlpEnabled?(" otlp "+ex.endpoint):"")+" · 事件 "+c.events+(s.degraded&&s.degraded.length?(" · 降级 "+s.degraded.join(" | ")):"");
  }
  load(); setInterval(load, 5000);
})();
</script>
</body></html>`;
}

export default { stewardPanelHtml };
