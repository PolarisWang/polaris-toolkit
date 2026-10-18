/* Polaris Toolkit 面板公共件（浏览器侧，classic script）
 * 由 lib/panel/kit.js 原样读出并通过 <prefix>/kit.js 提供。
 * 不要在这里 import：面板是普通 HTML 页面，没有打包步骤。
 */
(function () {
  if (window.PolarisKit) return;
  var K = {};

  K.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  K.el = function (id) { return document.getElementById(id); };
  K.n0 = function (v) { return v == null || isNaN(v) ? "--" : String(Math.round(v)); };
  K.n1 = function (v) { return v == null || isNaN(v) ? "--" : (Math.round(v * 10) / 10).toFixed(1); };
  K.when = function (ms) { if (!ms) return "--"; try { return new Date(ms).toLocaleString(); } catch (e) { return "--"; } };
  K.ago = function (ms) {
    if (!ms) return "-";
    var d = Date.now() - ms;
    if (d < 60000) return Math.round(d / 1000) + "s";
    if (d < 3600000) return Math.round(d / 60000) + "m";
    return Math.round(d / 3600000) + "h";
  };
  K.levelClass = function (level) {
    return level === "critical" || level === "high" || level === "error" ? "err" : (level === "warn" || level === "warning" ? "warn" : "ok");
  };
  K.badge = function (level, text) {
    var l = String(level || "ok");
    return '<span class="badge ' + K.esc(l) + '">' + K.esc(text == null ? l.toUpperCase() : text) + "</span>";
  };

  /** fetch + JSON，永不抛：失败也返回 { ok:false, __status }。 */
  K.json = function (url, init) {
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var v;
        try { v = JSON.parse(t); } catch (e) { v = { ok: false, raw: t }; }
        v.__status = r.status;
        return v;
      });
    });
  };

  /** POST JSON。写令牌是 HttpOnly cookie，同源 fetch 自动携带。 */
  K.post = function (url, body) {
    return K.json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  };

  /** 轮询：页面隐藏时跳过；enabled() 返回 false 时也跳过。返回停止函数。 */
  K.poll = function (fn, ms, enabled) {
    function tick() {
      if (document.visibilityState === "hidden") return;
      if (typeof enabled === "function" && !enabled()) return;
      try { fn(); } catch (e) { /* 面板自己不该被一次渲染失败拖死 */ }
    }
    tick();
    var id = setInterval(tick, Math.max(1000, ms || 5000));
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") tick(); });
    return function () { clearInterval(id); };
  };

  K.toast = function (message, level) {
    var box = document.getElementById("pk-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "pk-toast";
      box.style.cssText = "position:fixed;right:14px;bottom:14px;display:flex;flex-direction:column;gap:6px;z-index:99";
      document.body.appendChild(box);
    }
    var item = document.createElement("div");
    item.textContent = String(message);
    item.style.cssText = "padding:7px 11px;border-radius:8px;font-size:12px;background:" +
      (level === "error" ? "#7f1d1d" : level === "warn" ? "#78350f" : "#1f2937") +
      ";color:#f3f4f6;border:1px solid rgba(255,255,255,.12)";
    box.appendChild(item);
    setTimeout(function () { try { box.removeChild(item); } catch (e) {} }, 3200);
  };

  window.PolarisKit = K;
})();
