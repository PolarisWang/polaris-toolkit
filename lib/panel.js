/**
 * 工具包外壳页面：左侧功能清单（带实时状态），右侧用 iframe 承载所选功能的面板。
 * 所有请求都相对本页 base 解析：外壳在 /__polaris/panel，所以功能面板是
 * <feature-id>/panel，工具包接口是 api/features。
 *
 * 性能约定（重要）：
 *   - iframe 的 src 只在"切换功能"时设置。轮询只更新左侧卡片，绝不重建 iframe，
 *     否则每 5 秒整页重载会把滚动位置和 <details> 展开状态全部丢掉。
 *   - 卡片 DOM 只在功能签名的实质内容（标题/等级/结论/降级）变化时重建。
 *   - 页面隐藏时停止轮询；并把"当前功能是否可见"告诉内嵌面板，让它也暂停。
 *
 * 公共件（esc / json / badge / toast / poll）来自 /__polaris/kit.js，见 panel/kit.js。
 */
import { kitCss, kitTag } from "./panel/kit.js";

export function toolkitPanelHtml(options) {
  const opt = options === undefined ? {} : options;
  const prefix = typeof opt.prefix === "string" ? opt.prefix : "/__polaris";
  const displayName = typeof opt.displayName === "string" ? opt.displayName : "Polaris Toolkit";
  const embed = opt.embed === true;
  const version = typeof opt.version === "string" ? opt.version : "";
  const installedAt = typeof opt.installedAt === "string" ? opt.installedAt : "";
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>' + displayName + '</title>',
    '<style>',
    kitCss(),
    CSS(),
    '</style></head>',
    '<body class="' + (embed ? 'embed' : 'standalone') + '">',
    '<div class="stale" id="stale" hidden></div>',
    '<div class="shell">',
    '  <aside class="list">',
    '    <header class="brand"><div class="brand-name">' + displayName + '</div><div class="brand-sub" id="sub">加载中…</div></header>',
    '    <nav id="features" class="cards"></nav>',
    '    <div class="tools"><button class="mini" id="btn-token">复制写操作令牌</button><button class="mini" id="btn-open">打开独立页</button></div>',
    '    <details class="settings" id="settings">',
    '      <summary>设置（直接编辑 settings.json）</summary>',
    '      <div class="setrow" id="set-file"></div>',
    '      <textarea id="raw-json" spellcheck="false" placeholder="{\"v\":1,\"d\":{}}"></textarea>',
    '      <div class="tools"><button class="mini" id="btn-raw-save">保存全文</button><button class="mini" id="btn-raw-reload">重新读取</button></div>',
    '      <div class="tipmsg" id="set-msg"></div>',
    '    </details>',
    '    <div class="tipmsg" id="tipmsg"></div>',
    '    <footer class="tips" id="tips">功能以独立面板呈现；点开左侧卡片切换。<br />卡片状态每 5 秒刷新，切换/隐藏时自动暂停。</footer>',
    '  </aside>',
    '  <main class="pane"><iframe id="frame" title="feature panel" src="about:blank"></iframe></main>',
    '</div>',
    kitTag("."),
    '<script>',
    JS(prefix, version, installedAt),
    '</script>',
    '</body></html>'
  ].join("\n");
}

function CSS() {
  return [
    '*{box-sizing:border-box}',
    'html,body{height:100%;margin:0}',
    'body{font:13px/1.5 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color:var(--vscode-foreground,#d4d4d4);background:transparent}',
    'body.standalone{background:var(--pk-bg);padding:10px}',
    '.shell{display:grid;grid-template-columns:238px 1fr;gap:10px;height:100%;min-height:520px}',
    '.list{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:var(--vscode-editorWidget-background,var(--pk-panel));border:1px solid var(--pk-line);overflow:auto}',
    '.brand-name{font-size:15px;font-weight:650;letter-spacing:.02em}',
    '.brand-sub{font-size:11px;opacity:.6;word-break:break-all}',
    '.cards{display:flex;flex-direction:column;gap:8px}',
    '.card{appearance:none;text-align:left;cursor:pointer;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:inherit;font:inherit;padding:9px 11px}',
    '.card:hover{background:rgba(255,255,255,.09)}',
    '.card.active{border-color:rgba(96,165,250,.75);background:rgba(96,165,250,.14)}',
    '.card.degraded{border-color:rgba(220,38,38,.6);background:rgba(220,38,38,.12)}',
    '.stale{margin:0 0 10px;padding:9px 12px;border-radius:10px;border:1px solid rgba(251,191,36,.6);background:rgba(251,191,36,.13);color:var(--vscode-foreground,#d4d4d4);font-size:12px;line-height:1.5}',
    '.stale b{color:var(--pk-warn,#fbbf24)}',
    '.card .t{display:flex;align-items:center;justify-content:space-between;gap:6px;font-weight:600}',
    '.card .s{font-size:11px;opacity:.62;margin-top:2px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--pk-ok);flex:0 0 auto}',
    '.dot.warn{background:var(--pk-warn)}.dot.high{background:var(--pk-high)}.dot.critical,.dot.emergency{background:var(--pk-crit)}',
    '.tools{display:flex;gap:6px;flex-wrap:wrap}',
    '.mini{appearance:none;cursor:pointer;font:inherit;font-size:11px;padding:4px 8px;border-radius:7px;border:1px solid var(--pk-line,rgba(255,255,255,.16));background:rgba(255,255,255,.05);color:inherit}',
    '.mini:hover{background:rgba(255,255,255,.11)}',
    '.settings{font-size:12px}',
    '.settings summary{cursor:pointer;opacity:.8;padding:2px 0}',
    '.settings summary:hover{opacity:1}',
    '.settings textarea{width:100%;height:170px;margin-top:6px;font:11px/1.45 ui-monospace,Consolas,"Cascadia Mono",monospace;background:rgba(0,0,0,.25);color:inherit;border:1px solid var(--pk-line,rgba(255,255,255,.16));border-radius:8px;padding:7px;resize:vertical}',
    '.settings .tools{margin-top:6px}',
    '.setrow{font-size:10px;opacity:.5;word-break:break-all;margin-top:6px}',
    '.tipmsg{font-size:11px;opacity:.75;word-break:break-all}',
    '.tips{font-size:11px;opacity:.5;margin-top:auto;line-height:1.45}',
    '.pane{border-radius:12px;background:var(--vscode-editorWidget-background,var(--pk-panel));border:1px solid var(--pk-line);overflow:hidden;min-height:520px}',
    '.pane iframe{width:100%;height:100%;min-height:520px;border:0;display:block;background:transparent}'
  ].join("\n");
}

function JS(prefix, version, installedAt) {
  return [
    'var K = window.PolarisKit;',
    'var BASE = new URL("./", location.href);',
    'var PREFIX = "' + prefix + '";',
    'var VERSION = "' + version + '";',
    'var INSTALLED = "' + installedAt + '";',
    'var PICKED = null;',
    'var SIG = "";',
    'var STOPPED = false;',
    'function el(id){return document.getElementById(id);}',
    'function esc(s){return K ? K.esc(s) : String(s==null?"":s);}',
    'function visible(){return document.visibilityState !== "hidden";}',
    '// Tell the embedded panel whether it is on screen so it can pause its own polling.',
    'function announce(){',
    '  var f = el("frame");',
    '  if (!f || !f.contentWindow) return;',
    '  try { f.contentWindow.postMessage({ type: "polaris:active", id: PICKED, active: visible() && !STOPPED }, "*"); } catch (e) {}',
    '}',
    'function mark(){',
    '  var buttons = document.querySelectorAll(".card");',
    '  for (var i=0;i<buttons.length;i++) buttons[i].classList.toggle("active", buttons[i].getAttribute("data-id")===PICKED);',
    '}',
    'function pick(id, push){',
    '  if (id !== PICKED) {',
    '    PICKED = id;',
    '    el("frame").src = new URL(id + "/panel", BASE).href;', // only on a real feature switch
    '  }',
    '  mark();',
    '  announce();',
    '  if (push === true) { try { history.replaceState(null, "", "?feature=" + encodeURIComponent(id)); } catch (e) {} }',
    '}',
    'function cardHtml(f){',
    '  var st = f.status || {};',
    '  var level = f.degraded ? "critical" : (st.level || "ok");',
    '  var line = st.headline || "";',
    '  return \'<button class="card\' + (f.degraded ? " degraded" : "") + \'" data-id="\' + esc(f.id) + \'"><div class="t"><span>\' + esc(f.title) + \'</span><span class="dot \' + esc(level) + \'"></span></div>\' +',
    '    \'<div class="s">\' + esc(f.subtitle || "") + \'</div>\' +',
    '    (line ? \'<div class="s">\' + esc(line) + "</div>" : "") + "</button>";',
    '}',
    'function signature(d){',
    '  return (d.features || []).map(function(f){ var st = f.status || {}; return f.id + "|" + f.title + "|" + (st.level || "") + "|" + (st.headline || "") + "|" + (f.degraded ? "d" : ""); }).join(";");',
    '}',
    'function render(d){',
    '  var features = (d.features || []).slice().sort(function(a,b){',
    '    var rank = function(f){ if (f.degraded) return 0; var l = (f.status || {}).level; return l === "critical" || l === "emergency" ? 1 : (l === "high" ? 2 : (l === "warn" ? 3 : 4)); };',
    '    var dd = rank(a) - rank(b); return dd !== 0 ? dd : ((a.order || 0) - (b.order || 0));',
    '  });',
    '  var ins = d.install || {};',
    '  var banner = el("stale");',
    '  if (banner) {',
    '    if (ins.stale) {',
    '      banner.hidden = false;',
    '      banner.innerHTML = "<b>运行中的是旧代码</b>：磁盘上的插件文件比宿主启动时新" + (ins.newestFile ? "（<code>" + esc(ins.newestFile) + "</code>）" : "") + "，Node 不会热重载已装载的模块。<br />托盘退出 DSH 再启动一次，才能看到最新的面板、能力与路由。" + (ins.bootAt ? " 本次宿主装载于 " + esc(ins.bootAt) + "。" : "");',
    '    } else { banner.hidden = true; banner.innerHTML = ""; }',
    '  }',
    '  var bad = features.filter(function(f){ return f.degraded; }).length;',
    '  el("sub").textContent = features.length + " 个功能" + (bad ? " · " + bad + " 个降级" : "") + " · " + (d.stateDir || "");',
    '  if (K) { var tips = el("tips"); if (tips) tips.innerHTML = "版本 " + esc(VERSION || (d.install && d.install.version) || "?") + (INSTALLED ? " · 装机 " + esc(INSTALLED) : "") + "<br />指标 " + esc((d.metrics == null ? "?" : d.metrics)) + " 条 · 调度 " + esc(((d.scheduler || []).length)) + " 项" + (ins.bootAt ? " · 装载 " + esc(ins.bootAt) : "") + "<br />卡片每 5 秒刷新，切换/隐藏时自动暂停。"; }',
    '  var sig = signature(d);',
    '  if (sig !== SIG) {',
    '    SIG = sig;',
    '    el("features").innerHTML = features.map(cardHtml).join("");',
    '    var buttons = document.querySelectorAll(".card");',
    '    for (var i=0;i<buttons.length;i++) buttons[i].addEventListener("click", function(ev){ pick(ev.currentTarget.getAttribute("data-id"), true); });',
    '  }',
    '  var wanted = new URLSearchParams(location.search).get("feature");',
    '  var id = PICKED || wanted || (features[0] && features[0].id);',
    '  if (id) pick(id, false); else mark();',
    '}',
    'function api(url, init){ return (K ? K.json(url, init) : fetch(url, init).then(function(r){ return r.json(); })); }',
    'function setMsg(text){ var t = el("set-msg"); if (t) t.textContent = text; }',
    'function loadRaw(){',
    '  api(new URL("api/settings/raw", BASE).href).then(function(d){',
    '    if (!d || d.ok !== true) { setMsg("读取失败：" + ((d && d.error) || "unknown")); return; }',
    '    var t = el("raw-json"); if (t) t.value = JSON.stringify(d.doc, null, 2);',
    '    var f = el("set-file"); if (f) f.textContent = d.file || "";',
    '    setMsg("已载入磁盘全文；保存会整份替换（仍然逐个功能过 schema）");',
    '  }).catch(function(e){ setMsg("读取失败：" + e); });',
    '}',
    'function saveRaw(){',
    '  var t = el("raw-json"); if (!t) return;',
    '  var text = t.value;',
    '  setMsg("保存中…");',
    '  api(new URL("api/settings/raw", BASE).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }) }).then(function(d){',
    '    if (!d || d.ok !== true) { setMsg("保存被拒：" + (d && d.feature ? d.feature + "：" : "") + ((d && d.error) || "unknown")); return; }',
    '    setMsg("已保存 " + (d.file || "")); load();',
    '  }).catch(function(e){ setMsg("保存失败：" + e); });',
    '}',
    'function load(){ if (!visible()) return; (K ? K.json(new URL("api/features", BASE).href) : fetch(new URL("api/features", BASE).href).then(function(r){return r.json();})).then(render).catch(function(e){ el("sub").textContent = "读取失败：" + e; }); }',
    'function flash(text){ var t = el("tipmsg"); if (t) { t.textContent = text; setTimeout(function(){ if (t.textContent === text) t.textContent = ""; }, 6000); } }',
    'function copyToken(){',
    '  (K ? K.json(new URL("api/token", BASE).href) : fetch(new URL("api/token", BASE).href).then(function(r){ return r.json(); })).then(function(d){',
    '    if (!d || d.ok !== true) { flash("读不到令牌：先打开一次面板（cookie 会自动带上），或运行 polaris token 命令"); return; }',
    '    var text = d.token;',
    '    var done = function(){ flash("已复制：x-polaris-token: " + text); };',
    '    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done).catch(function(){ flash("令牌： " + text); }); }',
    '    else { flash("令牌： " + text); }',
    '  }).catch(function(e){ flash("读不到令牌：" + e + "（试试 polaris token 命令）"); });',
    '}',
    'var bt = el("btn-token"); if (bt) bt.addEventListener("click", copyToken);',
    'var bo = el("btn-open"); if (bo) bo.addEventListener("click", function(){ window.open(new URL("panel", BASE).href, "_blank"); });',
    'var brl = el("btn-raw-reload"); if (brl) brl.addEventListener("click", loadRaw);',
    'var brs = el("btn-raw-save"); if (brs) brs.addEventListener("click", saveRaw);',
    'var sbox = el("settings"); if (sbox) sbox.addEventListener("toggle", function(){ if (sbox.open) loadRaw(); });',
    'load();',
    'setInterval(load, 5000);',
    'window.addEventListener("message", function(ev){ var d = ev.data || {}; if (d.type === "polaris:hello") announce(); });',
    'document.addEventListener("visibilitychange", function(){ STOPPED = !visible(); if (visible()) load(); announce(); });',
    'window.addEventListener("focus", function(){ announce(); });'
  ].join("\n");
}

export default { toolkitPanelHtml };
