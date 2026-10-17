/**
 * Polaris Toolkit —— 客户端（浏览器侧）半边。
 *
 * 经典脚本：加载时把模块工厂交给 __ModuleLoader__，运行时再调用 apply(ctx)。
 * 只做三件事：注册左侧栏入口、注册中栏面板（iframe 指向 /__polaris/panel）、
 * 注册会话头部的小按钮。真正的界面都在宿主侧 HTML 里。
 *
 * 两条必须遵守的规则（0.2.1 起）：
 *  1) 用 ctx.inject(["slots"], scope => ...) 等服务就绪；不要在 package.json 的
 *     dsh.client.inject 里堆包名 —— 客户端 loader 把每个 inject 名字当作 ctx 服务
 *     等待，等不到会停在 pending。@deepseek-ai/dsh-client-ui-slots 并未被移除，
 *     它仍是 web 端内置核心模块（工厂里可直接 require）；真正致命的是注册抛异常：
 *     条目变 failed，web boot 报 "1 entry did not activate"。因此下面每个座席
 *     注册都 try/catch 只告警。
 *  2) 插件路由相对 document.baseURI 解析（不要前导斜杠）。
 */
window.__ModuleLoader__.load({
  id: "polaris-toolkit",
  factory: function (require) {
    var React = require("react");
    var PANEL_ID = "polaris-toolkit";
    var PANEL_ORDER = 95;
    var PANEL_PATH = "__polaris/panel";
    var TAG = "[polaris-toolkit]";

    function panelUrl() {
      try {
        return new URL(PANEL_PATH, document.baseURI).href;
      } catch (error) {
        return "/__polaris/panel";
      }
    }

    function openPanel() {
      try {
        if (ctxRef !== undefined && ctxRef.layout !== undefined && typeof ctxRef.layout.selectPanel === "function") {
          ctxRef.layout.selectPanel(PANEL_ID);
        }
      } catch (error) {
        console.warn(TAG + " selectPanel failed", error);
      }
    }

    var ctxRef;

    function Frame() {
      return React.createElement("iframe", {
        src: panelUrl(),
        title: "Polaris Toolkit",
        style: { width: "100%", height: "100%", minHeight: "420px", border: "0", display: "block", background: "transparent" }
      });
    }

    function Glyph() {
      return React.createElement(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        React.createElement("circle", { cx: 8, cy: 8, r: 6.2, stroke: "currentColor", strokeWidth: 1.3 }),
        React.createElement("path", { d: "M8 1.8 L8 8 L13 12", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    function Chip() {
      return React.createElement(
        "button",
        {
          type: "button",
          title: "Polaris Toolkit",
          onClick: openPanel,
          style: { display: "inline-flex", alignItems: "center", gap: "5px", background: "transparent", border: "0", color: "inherit", cursor: "pointer", font: "inherit" }
        },
        React.createElement(Glyph, null),
        React.createElement("span", null, "Polaris")
      );
    }

    /** 注册全部座席；全部失败都只告警，绝不让条目激活失败。 */
    function mount(scope) {
      var slots = scope.slots;
      if (slots === undefined || typeof slots.register !== "function") {
        console.warn(TAG + " slots service unavailable; panel not mounted");
        return;
      }
      var disposers = [];
      function keep(fn) {
        try {
          var off = fn();
          if (typeof off === "function") disposers.push(off);
        } catch (error) {
          console.warn(TAG + " slot registration failed", error);
        }
      }
      keep(function () {
        return slots.inject("sidebar.panellist", function () {
          return slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: function () { return "Polaris Toolkit"; } }, Glyph);
        });
      });
      keep(function () {
        return slots.inject("main", function () {
          return slots.register({ name: "main", key: PANEL_ID }, Frame);
        });
      });
      keep(function () {
        return slots.inject("conversation.session.header.utilities", function () {
          return slots.register({ name: "conversation.session.header.utilities", id: PANEL_ID, order: PANEL_ORDER }, Chip);
        });
      });
      try {
        scope.effect(function () {
          return function () {
            for (var i = 0; i < disposers.length; i += 1) {
              try { disposers[i](); } catch (error) { /* ignore */ }
            }
            disposers.length = 0;
          };
        }, "polaris-toolkit: client slots");
      } catch (error) {
        console.warn(TAG + " effect registration failed", error);
      }
    }

    function apply(ctx) {
      ctxRef = ctx;
      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["slots"], function (scope) { mount(scope); });
          return;
        }
        if (ctx.slots !== undefined) {
          mount(ctx);
          return;
        }
        console.warn(TAG + " neither ctx.inject nor ctx.slots is available");
      } catch (error) {
        console.warn(TAG + " apply failed", error);
      }
    }

    var module_ = { exports: {} };
    module_.exports.apply = apply;
    module_.exports.inject = [];
    return module_.exports;
  }
});
