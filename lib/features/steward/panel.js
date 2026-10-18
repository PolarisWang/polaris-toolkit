/**
 * Steward 面板（P0：只读观察）。
 *
 * 布局按金字塔：顶部一行宿主结论 → 模块卡片 → 模块下的 agent 明细 → 事件信号流。
 * 所有按钮都走 POST api/action，P0 只有"刷新/强制采样"两个无副作用动作。
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
.tools{display:flex;gap:8px;margin:8px 0 0}
button{background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent)}
.empty{color:var(--dim);font-size:12px;padding:6px 0}
</style></head>
<body class="${bodyClass}">
<h1>大内总管 Steward <span class="pill" id="phase">P0 观察</span></h1>
<div class="sub">收集全部 agent 状态 / 归类到模块 / 形成待决信号。当前阶段只读，不下发动作。</div>
<div class="hero" id="hero"><div class="empty">读取中…</div></div>
<div class="tools"><button onclick="collect()">强制采样</button><button onclick="load()">刷新</button></div>
<h2>模块</h2><div class="mods" id="mods"><div class="empty">读取中…</div></div>
<h2>Agent 明细</h2><div id="agents"><div class="empty">读取中…</div></div>
<h2>信号流</h2><div id="signals"><div class="empty">暂无信号</div></div>
<div class="sub" id="foot" style="margin-top:18px"></div>
<script>
(function(){
  var API = "api/";
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  function ago(t){ if(!t) return "-"; var d=Date.now()-t; if(d<60000) return Math.round(d/1000)+"s"; if(d<3600000) return Math.round(d/60000)+"m"; return Math.round(d/3600000)+"h"; }
  function cls(v){ return v==="high"||v==="error"?"err":(v==="warn"||v==="warning"?"warn":"ok"); }
  function load(){
    fetch(API+"state",{cache:"no-store"}).then(function(r){return r.json()}).then(render).catch(function(e){
      document.getElementById("hero").innerHTML='<div class="empty">读取失败: '+esc(e)+'</div>';
    });
  }
  function collect(){ fetch(API+"action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"collect"})}).then(load); }
  function render(s){
    if(!s||!s.ok){ return; }
    var h=s.health||{}, loop=h.loop||{}, c=s.counters||{};
    var level = h.heapUsedMB>3200?"err":(h.heapUsedMB>2200?"warn":"ok");
    document.getElementById("hero").innerHTML =
      '<div><div class="kv">宿主堆<b>'+esc(h.heapUsedMB)+' MB / '+esc(h.heapLimitMB)+' MB</b></div></div>'+
      '<div><div class="kv">事件循环 P99<b>'+esc(loop.p99Ms)+' ms'+(loop.maxMs>200?' <span class="pill warn">max '+esc(loop.maxMs)+'</span>':'')+'</b></div></div>'+
      '<div><div class="kv">Agent 总数<b>'+esc(s.agents.length)+'（运行 '+esc(s.agents.filter(function(a){return a.status==="running"}).length)+'）</b></div></div>'+
      '<div><div class="kv">待决信号<b>'+esc((s.signals||[]).filter(function(x){return x.severity!=="info"}).length)+'</b></div></div>'+
      '<div><div class="kv">崩溃日志<b>'+esc(h.crash?h.crash.total:0)+'（24h '+esc(h.crash?h.crash.last24h:0)+'）</b></div></div>'+
      '<div><div class="kv">状态<b><span class="pill '+level+'">'+esc(level==="ok"?"平稳":(level==="warn"?"偏高":"吃紧"))+'</span></b></div></div>';

    var mods=s.modules||[];
    document.getElementById("mods").innerHTML = mods.length? mods.map(function(m){
      return '<div class="mod'+(m.attention>0?" attention":"")+'"><div class="name"><span>'+esc(m.name)+'</span><span class="pill">'+esc(m.id)+'</span></div>'+
        '<div class="meta">'+esc(m.host)+' · agent '+esc(m.count)+' · 运行 '+esc(m.running)+(m.attention?(' · 待决 '+m.attention):'')+'</div></div>';
    }).join("") : '<div class="empty">没有模块定义</div>';

    var rows=s.agents||[];
    document.getElementById("agents").innerHTML = rows.length? '<table><thead><tr><th>会话名</th><th>模块</th><th>状态</th><th>静默</th><th>轮次</th><th>归属依据</th></tr></thead><tbody>'+
      rows.map(function(a){
        var t=a.title||("session "+String(a.sessionId||a.id).slice(0,8));
        var st=(a.stalled?'<span class="pill warn">stalled</span> ':'')+(a.attention?'<span class="pill warn">待决</span> ':'')+esc(a.status)+(a.question?(' · 提问 '+a.question.count):'');
        return '<tr><td title="'+esc(a.id)+'">'+esc(t)+'</td><td class="mono">'+esc(a.moduleId)+'</td><td>'+st+'</td><td class="mono">'+ago(a.lastEventAt)+'</td><td class="mono">'+esc(a.turns||0)+'</td><td class="mono">'+esc(a.routeReason||'-')+'</td></tr>';
      }).join("")+'</tbody></table>' : '<div class="empty">还没有观察到 agent</div>';

    var sigs=s.signals||[];
    document.getElementById("signals").innerHTML = sigs.length? sigs.map(function(x){
      return '<div class="sig"><span class="t">'+esc(ago(x.at))+'</span><span class="k">'+esc(x.kind)+'</span><span>'+esc(x.message||"")+(x.count>1?(' ×'+x.count):'')+'</span></div>';
    }).join("") : '<div class="empty">暂无信号</div>';

    document.getElementById("foot").textContent = "journal "+(s.journal?s.journal.file:"-")+" · 会话名缓存 "+(s.titles?s.titles.size:0)+" · 事件 "+c.events+" · 状态变更 "+(c.statusChanges||0);
  }
  load(); setInterval(load, 5000);
})();
</script>
</body></html>`;
}

export default { stewardPanelHtml };
