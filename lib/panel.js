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
    '<div class="shell">',
    '  <aside class="list">',
    '    <header class="brand"><div class="brand-name">' + displayName + '</div><div class="brand-sub" id="sub">加载中…</div></header>',
    '    <nav id="features" class="cards"></nav>',
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
    '.card .t{display:flex;align-items:center;justify-content:space-between;gap:6px;font-weight:600}',
    '.card .s{font-size:11px;opacity:.62;margin-top:2px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--pk-ok);flex:0 0 auto}',
    '.dot.warn{background:var(--pk-warn)}.dot.high{background:var(--pk-high)}.dot.critical,.dot.emergency{background:var(--pk-crit)}',
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
    '  var bad = features.filter(function(f){ return f.degraded; }).length;',
    '  el("sub").textContent = features.length + " 个功能" + (bad ? " · " + bad + " 个降级" : "") + " · " + (d.stateDir || "");',
    '  if (K) { var tips = el("tips"); if (tips) tips.innerHTML = "版本 " + esc(VERSION || (d.install && d.install.version) || "?") + (INSTALLED ? " · 装机 " + esc(INSTALLED) : "") + "<br />指标 " + esc((d.metrics == null ? "?" : d.metrics)) + " 条 · 调度 " + esc(((d.scheduler || []).length)) + " 项<br />卡片每 5 秒刷新，切换/隐藏时自动暂停。"; }',
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
    'function load(){ if (!visible()) return; (K ? K.json(new URL("api/features", BASE).href) : fetch(new URL("api/features", BASE).href).then(function(r){return r.json();})).then(render).catch(function(e){ el("sub").textContent = "读取失败：" + e; }); }',
    'load();',
    'setInterval(load, 5000);',
    'window.addEventListener("message", function(ev){ var d = ev.data || {}; if (d.type === "polaris:hello") announce(); });',
    'document.addEventListener("visibilitychange", function(){ STOPPED = !visible(); if (visible()) load(); announce(); });',
    'window.addEventListener("focus", function(){ announce(); });'
  ].join("\n");
}

export default { toolkitPanelHtml };
