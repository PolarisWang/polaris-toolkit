/**
 * 工具包宿主：把一组 feature 挂成一个插件。
 *
 * 约定（新增功能必须遵守）：
 *   feature = { id, title, subtitle, order, Config?, settings?(config), actions[], setup(scope), action?(scope,id,body), status?(scope) }
 *   scope   = { id, ctx, config, dir, settings, core, log, route, tool, onDispose, runtime }
 *   - actions 只是元数据；kind:"toggle" 由工具包直接写设置，不会进 feature.action。
 *   - setup(scope) 里用 scope.route / scope.tool / scope.onDispose 登记，工具包负责定义与释放。
 *   - 所有路由挂在 <prefix>/<id> 下；面板用相对 URL 访问，不写前导斜杠。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendCsv, csvRow, ensureDir, featureDir, iso, mb, round1, stamp, stateDir } from "./paths.js";
import { isTrustedApiRequest } from "./fence.js";
import { createRouter, intOf, queryOf, readBody, sendHtml, sendJson, sendText } from "./http.js";
import { createSettingsStore } from "./settings.js";
import { toolkitPanelHtml } from "../panel.js";

export function mountToolkit(ctx, config, options) {
  const opt = options === undefined || options === null ? {} : options;
  const name = typeof opt.name === "string" ? opt.name : "polaris-toolkit";
  const prefix = typeof opt.prefix === "string" ? opt.prefix : "/__polaris";
  const displayName = typeof opt.displayName === "string" ? opt.displayName : "Polaris Toolkit";
  const features = Array.isArray(opt.features) ? opt.features : [];
  const dir = ensureDir(stateDir());
  const settings = createSettingsStore(dir);
  const raw = config !== undefined && config !== null && typeof config === "object" ? config : {};
  const rawFeatures = raw.features !== null && typeof raw.features === "object" && !Array.isArray(raw.features) ? raw.features : {};
  const records = new Map();
  const log = (level, message) => {
    try { if (ctx.logger !== undefined) ctx.logger[level](message); } catch { /* logger is optional */ }
  };
  const fence = (req) => {
    try { return isTrustedApiRequest(req, ctx.webRuntime === undefined ? [] : ctx.webRuntime.trustedHosts); } catch { return true; }
  };

  function validate(feature, slice) {
    if (typeof feature.Config !== "function") return slice;
    try { return feature.Config(slice === undefined ? {} : slice); } catch (error) {
      log("warn", name + ": " + feature.id + " config rejected, using raw slice: " + String(error));
      return slice === undefined ? {} : slice;
    }
  }

  function mountFeature(feature) {
    const id = String(feature.id);
    const featureDirPath = ensureDir(featureDir(id));
    const slice = rawFeatures[id];
    const configSlice = validate(feature, slice);
    const defaults = typeof feature.settings === "function" ? feature.settings(configSlice) : {};
    const featureSettings = settings.feature(id, defaults);
    const router = createRouter();
    const toolSpecs = [];
    const disposers = [];
    const scope = {
      id,
      ctx,
      config: configSlice,
      dir: featureDirPath,
      settings: featureSettings,
      core: { fence, sendJson, sendText, sendHtml, readBody, queryOf, intOf, featureDir, stateDir, ensureDir, stamp, iso, mb, round1, appendCsv, csvRow },
      log,
      route(method, path, handler) { router.add(method, path, handler); },
      tool(spec) { toolSpecs.push(spec); },
      onDispose(fn) { if (typeof fn === "function") disposers.push(fn); },
      runtime: undefined
    };
    const record = {
      id,
      title: feature.title === undefined ? id : feature.title,
      subtitle: feature.subtitle === undefined ? "" : feature.subtitle,
      order: typeof feature.order === "number" ? feature.order : 100,
      actions: Array.isArray(feature.actions) ? feature.actions : [],
      feature,
      scope,
      router,
      settings: () => featureSettings.all(),
      status: () => {
        try { return typeof feature.status === "function" ? feature.status(scope) : undefined; } catch (error) { return { level: "ok", headline: "status error: " + String(error) }; }
      },
      action: async (actionId, body) => {
        if (typeof feature.action !== "function") return { ok: false, reason: "feature " + id + " has no action handler" };
        return feature.action(scope, actionId, body === undefined ? {} : body);
      }
    };

    if (typeof feature.setup === "function") {
      ctx.effect(() => {
        feature.setup(scope);
        const offRoute = ctx.webServer.register({ kind: "prefix", path: prefix + "/" + id, handler: featureHandler(id) });
        const offTools = [];
        for (const spec of toolSpecs) {
          try { offTools.push(ctx.tools.register(defineTool(spec))); } catch (error) { log("warn", name + ": tool " + (spec === undefined ? "?" : spec.name) + " rejected: " + String(error)); }
        }
        return () => {
          for (const fn of disposers.splice(0)) { try { fn(); } catch { /* ignore */ } }
          for (const off of offTools.splice(0)) { try { off(); } catch { /* ignore */ } }
          try { offRoute(); } catch { /* ignore */ }
        };
      }, name + ": feature " + id);
    }
    records.set(id, record);
    return record;
  }

  function featureHandler(id) {
    const basePath = prefix + "/" + id;
    return async (req, res) => {
      if (!fence(req)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
      const record = records.get(id);
      const parsed = new URL(req.url === undefined ? "/" : req.url, "http://127.0.0.1");
      let sub = parsed.pathname;
      if (sub === basePath) sub = "/";
      else if (sub.startsWith(basePath + "/")) sub = sub.slice(basePath.length);
      if (record === undefined) { sendJson(res, 404, { ok: false, error: "feature not mounted", feature: id }); return; }
      try {
        const handled = await record.router.handle(req, res, sub);
        if (!handled) sendJson(res, 404, { ok: false, error: "no such route", path: sub });
      } catch (error) {
        log("warn", name + ": " + id + " route failed: " + String(error));
        sendJson(res, 500, { ok: false, error: String(error), path: sub });
      }
    };
  }

  for (const feature of features) {
    if (feature === undefined || feature === null || feature.id === undefined) continue;
    mountFeature(feature);
  }

  const toolkit = createRouter();
  toolkit.add("GET", "/", (req, res) => sendHtml(res, 200, toolkitPanelHtml({ prefix, displayName, embed: false })));
  toolkit.add("GET", "/panel", (req, res) => sendHtml(res, 200, toolkitPanelHtml({ prefix, displayName, embed: true })));
  toolkit.add("GET", "/api/features", (req, res) => {
    sendJson(res, 200, {
      ok: true,
      name,
      prefix,
      stateDir: dir,
      features: [...records.values()].map((r) => ({
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        order: r.order,
        actions: r.actions,
        settings: r.settings(),
        status: r.status(),
        panelUrl: prefix + "/" + r.id + "/panel"
      }))
    });
  });
  toolkit.add("GET", "/api/settings", (req, res) => {
    const feature = queryOf(req).get("feature");
    const record = feature === null ? undefined : records.get(feature);
    if (feature !== null && record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature }); return; }
    if (record === undefined) {
      const all = {};
      for (const r of records.values()) all[r.id] = r.settings();
      sendJson(res, 200, { ok: true, settings: all, file: settings.file });
      return;
    }
    sendJson(res, 200, { ok: true, feature: record.id, settings: record.settings(), file: settings.file });
  });
  toolkit.add("POST", "/api/settings", async (req, res) => {
    const parsed = await readBody(req);
    if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value;
    const record = records.get(body.feature);
    if (record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature: body.feature }); return; }
    const patch = body.patch !== null && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
    const next = record.scope.settings.set(patch);
    sendJson(res, 200, { ok: true, feature: record.id, settings: next, file: settings.file });
  });
  toolkit.add("POST", "/api/action", async (req, res) => {
    const parsed = await readBody(req);
    if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value;
    const record = records.get(body.feature);
    if (record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature: body.feature }); return; }
    const actionId = String(body.action === undefined ? "" : body.action);
    const meta = record.actions.filter((a) => a.id === actionId)[0];
    try {
      if (meta !== undefined && meta.kind === "toggle") {
        const payload = body.body !== null && typeof body.body === "object" ? body.body : {};
        const current = record.scope.settings.get(meta.setting) === true;
        const value = typeof payload.value === "boolean" ? payload.value : !current;
        const patch = {};
        patch[meta.setting] = value;
        const next = record.scope.settings.set(patch);
        sendJson(res, 200, { ok: true, feature: record.id, action: actionId, toggle: meta.setting, value, settings: next });
        return;
      }
      const result = await record.action(actionId, body.body);
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (error) {
      log("warn", name + ": action " + actionId + " on " + record.id + " failed: " + String(error));
      sendJson(res, 500, { ok: false, error: String(error), feature: record.id, action: actionId });
    }
  });
  toolkit.add("*", (req, res, sub) => sendJson(res, 404, { ok: false, error: "no such toolkit route", path: sub }));

  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: prefix, handler: toolkitHandler }), name + ": toolkit routes");

  function toolkitHandler(req, res) {
    if (!fence(req)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
    const parsed = new URL(req.url === undefined ? "/" : req.url, "http://127.0.0.1");
    let sub = parsed.pathname;
    if (sub === prefix) sub = "/";
    else if (sub.startsWith(prefix + "/")) sub = sub.slice(prefix.length);
    void (async () => {
      try {
        const handled = await toolkit.handle(req, res, sub);
        if (!handled) sendJson(res, 404, { ok: false, error: "no such route", path: sub });
      } catch (error) {
        log("warn", name + ": route " + sub + " failed: " + String(error));
        sendJson(res, 500, { ok: false, error: String(error), path: sub });
      }
    })();
  }

  log("info", name + " mounted: prefix " + prefix + ", features " + [...records.keys()].join(",") + ", state " + dir);
  return { name, prefix, dir, features: [...records.keys()] };
}
