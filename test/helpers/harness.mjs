/**
 * 共享测试脚手架：假 ctx + 真实 mountToolkit + 真实 HTTP handler 调用。
 *
 * 以前每个测试文件各写一份假宿主（feature/classify/titles 三份 ctx 假体），
 * 行为漂移没人发现。现在统一从这里拿；面板 vm 冒烟也用它取真实数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

/** 每个测试文件一个临时 DSH_HOME；必须在插件模块加载期就设好。 */
export const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-home-"));
process.env.DSH_HOME = HOME;

const { FEATURES } = await import("../../lib/features/index.js");
const { mountToolkit } = await import("../../lib/core/host.js");

export { FEATURES };

let token = "";
export function getToken() { return token; }
export function setToken(value) {
  token = value === undefined || value === null ? "" : String(value);
  return token;
}

/** 假宿主 ctx：只实现插件真正 inject 的服务。 */
export function makeCtx(overrides = {}) {
  const effects = [];
  const routes = [];
  const tools = [];
  const logs = [];
  const listeners = new Map();
  const ctx = {
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
    },
    emit(event, payload) { for (const fn of (listeners.get(event) || []).slice()) fn(payload); },
    logger: {
      info: (m) => logs.push("info " + m),
      warn: (m) => logs.push("warn " + m),
      error: (m) => logs.push("error " + m)
    },
    effect(fn) { const off = fn(); effects.push(off); return () => {}; },
    webServer: { register(opts) { routes.push(opts); return () => {}; } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    agents: { list: () => [], get: () => undefined },
    get: () => undefined,
    ...overrides
  };
  return { ctx, effects, routes, tools, logs };
}

/** 挂载整个工具包；返回可用的路由 handler 与一个 dispose()。 */
export function mount(overrides) {
  const env = makeCtx(overrides);
  const result = mountToolkit(env.ctx, { features: {} }, {
    name: "polaris-toolkit",
    prefix: "/__polaris",
    displayName: "Polaris Toolkit",
    features: FEATURES
  });
  setToken(result.token);
  const handler = (name) => env.routes.filter((r) => r.path === "/__polaris/" + name)[0].handler;
  const toolkit = env.routes.filter((r) => r.path === "/__polaris")[0].handler;
  const dispose = () => { for (const off of env.effects) { try { off(); } catch { /* ignore */ } } };
  return { ...env, result, handler, toolkit, dispose };
}

export function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(body) { this.body = body === undefined ? "" : String(body); }
  };
}

export function fakeReq(method, url, body) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:1" };
  if (token !== "") req.headers["x-polaris-token"] = token;
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body), "utf8"));
  req.push(null);
  return req;
}

export async function call(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

export async function json(res) { return JSON.parse(res.body); }
