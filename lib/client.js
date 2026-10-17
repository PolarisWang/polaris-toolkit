/**
 * Polaris Toolkit —— 客户端（浏览器侧）半边。
 *
 * 这是一个经典脚本：加载时把模块交给 __ModuleLoader__，随后由客户端运行时调用
 * apply(ctx)。它只做三件事：注册左侧栏入口、注册中栏面板（iframe 指向
 * /__polaris/panel）、注册会话头部的小按钮。真正的界面都在宿主侧 HTML 里，
 * 因此这里不需要任何构建步骤。
 *
 * URL 规则：插件路由必须相对 document.baseURI 解析（不要前导斜杠）。
 */
window.__ModuleLoader__.load({
  id: "polaris-toolkit",
  factory: function (require) {
    var React = require("react");
    var PANEL_ID = "polaris-toolkit";
    var PANEL_ORDER = 95;
    var PANEL_PATH = "__polaris/panel";

    function panelUrl() {
      try {
        return new URL(PANEL_PATH, document.baseURI).href;
      } catch (error) {
        return "/__polaris/panel";
      }
    }

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

    function apply(ctx) {
      var slots = ctx.slots;
      if (slots === undefined || typeof slots.register !== "function") return;
      var disposers = [];
      var register = function (seat, spec, component) {
        try {
          disposers.push(slots.inject(seat, function () { return slots.register(spec, component); }));
        } catch (error) {
          console.warn("[polaris-toolkit] slot " + seat + " registration failed", error);
        }
      };

      register("sidebar.panellist", { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: function () { return "Polaris Toolkit"; } }, Glyph);
      register("main", { name: "main", key: PANEL_ID }, Frame);
      register("conversation.session.header.utilities", {
        name: "conversation.session.header.utilities",
        id: PANEL_ID,
        order: PANEL_ORDER
      }, function PolarisChip() {
        return React.createElement(
          "button",
          {
            type: "button",
            title: "Polaris Toolkit",
            onClick: function () {
              try {
                if (ctx.layout !== undefined && typeof ctx.layout.selectPanel === "function") ctx.layout.selectPanel(PANEL_ID);
              } catch (error) {
                console.warn("[polaris-toolkit] selectPanel failed", error);
              }
            },
            style: { display: "inline-flex", alignItems: "center", gap: "5px", background: "transparent", border: "0", color: "inherit", cursor: "pointer", font: "inherit" }
          },
          React.createElement(Glyph, null),
          React.createElement("span", null, "Polaris")
        );
      });

      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch (error) { /* ignore */ }
          }
          disposers.length = 0;
        };
      }, "polaris-toolkit: client slots");
    }

    var module_ = { exports: {} };
    module_.exports.apply = apply;
    module_.exports.inject = [];
    return module_.exports;
  }
});
