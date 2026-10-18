/**
 * 会话层：主管会话的绑定 / 创建 / 发话 / 读回（C 方案里的"嘴"）。
 *
 * 为什么不用 session/bootstrap.js 的 createSessionBinder：那是早期死代码，
 * 调的是 agents.create({preset,title})（签名不对、也没有 steward 预设），
 * 真正常驻的入口是 ctx.get("sessionController")：
 *   create({cwd, agentPreset}) -> {sessionId}
 *   rename({sessionId, title})
 *   prompt({sessionId, content, mode, requestId}) -> {accepted:true}
 *
 * 人在这里打字属于"主人自己说话"，不走 actMode/actLevel 闸门；
 * 闸门只拦总管自己发起的动作（tasks.dispatch / escalation）。
 */
import { textOf, toolNameOf } from "./events.js";

const BOOTSTRAP = [
  "你是 Polaris 大内总管（steward），常驻在这台机器上。",
  "职责：盯着所有 DSH 会话，按模块归类；主人交办时派活、跟进、收口；发现卡住或异常时先给结论、再给依据。",
  "工具：steward_observe / steward_status 看全局，steward_ask 请主人拍板，steward_report 主动汇报，steward_begin 起一条可审计的工作流。",
  "风格：中文，先结论后依据，能一句话说完就别写三段。"
].join("\n");

export function createChat({ scope, store, log, readSettings, prompter, events }) {
  let lastSend = { at: 0, ok: true, reason: "", mode: "followup" };
  let sendSeq = 0;

  function controller() {
    try { return scope.ctx.get("sessionController"); } catch { return undefined; }
  }

  function sessionOf() {
    const cfg = readSettings();
    const s = cfg.session !== null && typeof cfg.session === "object" ? cfg.session : {};
    return s;
  }

  function sessionIdOf() {
    const s = sessionOf();
    return typeof s.id === "string" ? s.id.trim() : "";
  }

  function state() {
    const s = sessionOf();
    const id = sessionIdOf();
    return {
      id,
      bound: id !== "",
      title: typeof s.title === "string" && s.title.trim() !== "" ? s.title : "大内总管",
      mode: s.mode === "auto" ? "auto" : "manual",
      preset: typeof s.preset === "string" ? s.preset : "",
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      available: controller() !== undefined,
      createdAt: Number(s.createdAt) > 0 ? Number(s.createdAt) : 0,
      lastSend
    };
  }

  function bind(raw) {
    const id = String(raw === undefined || raw === null ? "" : raw).trim();
    if (id === "") return { ok: false, reason: "empty-session-id" };
    try {
      scope.settings.set({ session: { id, createdAt: Date.now() } });
    } catch (error) {
      return { ok: false, reason: "settings-write-failed: " + String(error) };
    }
    store.pushAction({ kind: "session", ok: true, message: "主管会话绑定 -> " + id });
    log("info", "steward: bound chat session " + id);
    return { ok: true, sessionId: id };
  }

  function unbind() {
    try { scope.settings.set({ session: { id: "", createdAt: 0 } }); }
    catch (error) { return { ok: false, reason: String(error) }; }
    store.pushAction({ kind: "session", ok: true, message: "主管会话解绑" });
    return { ok: true };
  }

  async function create(opts) {
    const ctrl = controller();
    if (ctrl === undefined || typeof ctrl.create !== "function") return { ok: false, reason: "sessionController-unavailable" };
    const s = sessionOf();
    const asked = opts !== null && typeof opts === "object" && typeof opts.cwd === "string" ? opts.cwd.trim() : "";
    const cwd = asked !== "" ? asked : (typeof s.cwd === "string" && s.cwd.trim() !== "" ? s.cwd.trim() : process.cwd());
    const preset = typeof s.preset === "string" && s.preset.trim() !== "" ? s.preset.trim() : "";
    let created;
    try {
      created = await ctrl.create(preset === "" ? { cwd } : { cwd, agentPreset: preset });
    } catch (error) {
      // 预设不存在时退回默认组装，绝不因为一个配置项就整条路走不通。
      try { created = await ctrl.create({ cwd }); }
      catch (error2) { return { ok: false, reason: "create-failed: " + String(error2) }; }
    }
    const sessionId = created !== null && typeof created === "object" && typeof created.sessionId === "string" ? created.sessionId : "";
    if (sessionId === "") return { ok: false, reason: "create-returned-no-id" };
    const title = typeof s.title === "string" && s.title.trim() !== "" ? s.title.trim() : "大内总管";
    try { await ctrl.rename({ sessionId, title }); } catch (error) { log("debug", "steward: rename failed: " + String(error)); }
    const bound = bind(sessionId);
    store.pushAction({ kind: "session", ok: bound.ok === true, message: "新建主管会话 " + sessionId + " @ " + cwd });
    if (bound.ok === true && (opts === undefined || opts === null || opts.bootstrap !== false)) {
      const sent = await send({ text: BOOTSTRAP, mode: "followup" });
      if (sent.ok !== true) log("warn", "steward: bootstrap prompt failed: " + String(sent.reason));
    }
    return { ok: true, sessionId, cwd, title };
  }

  /** 人类发话：直接进 sessionController，不经过 echo 闸门。 */
  async function send(input) {
    const text = String(input !== null && typeof input === "object" && input.text !== undefined ? input.text : "").trim();
    if (text === "") return { ok: false, reason: "empty-text" };
    const sessionId = sessionIdOf();
    if (sessionId === "") return { ok: false, reason: "no-bound-session" };
    if (prompter === undefined || typeof prompter.prompt !== "function") return { ok: false, reason: "prompter-unavailable" };
    const mode = input !== null && typeof input === "object" && input.mode === "steer" ? "steer" : "followup";
    sendSeq += 1;
    const requestId = "steward-chat-" + Date.now() + "-" + sendSeq;
    const result = await prompter.prompt(scope.ctx, { sessionId, content: [{ type: "text", text }], mode, requestId });
    const ok = result !== undefined && result.ok === true;
    lastSend = { at: Date.now(), ok, reason: ok ? "" : String(result === undefined ? "no-result" : result.reason), mode };
    store.pushAction({ kind: "chat", ok, message: (ok ? "发话 " : "发话失败 ") + text.slice(0, 60) });
    if (ok) { try { events.forget(sessionId); } catch { /* ignore */ } }
    return { ok, sessionId, mode, reason: lastSend.reason };
  }

  async function transcript(input) {
    const sessionId = sessionIdOf();
    if (sessionId === "") return { ok: false, reason: "no-bound-session", entries: [] };
    const limit = Number(input !== null && typeof input === "object" ? input.limit : 0) > 0 ? Math.min(200, Math.floor(Number(input.limit))) : 40;
    const list = await events.read(sessionId, 3000);
    if (list === undefined) return { ok: false, reason: "events-unavailable", entries: [] };
    const entries = [];
    for (const ev of list) {
      if (ev === null || typeof ev !== "object") continue;
      const at = Number(ev.time) > 0 ? Number(ev.time) : 0;
      const seq = Number(ev.seq) > 0 ? Number(ev.seq) : 0;
      const data = ev.data !== null && typeof ev.data === "object" ? ev.data : {};
      if (ev.type === "user/message") {
        const text = textOf(data.content);
        if (text !== "") entries.push({ seq, at, role: "you", text: text.slice(0, 2000) });
      } else if (ev.type === "assistant/message") {
        const message = data.message !== null && typeof data.message === "object" ? data.message : {};
        const text = textOf(message.content);
        if (text !== "") entries.push({ seq, at, role: "steward", text: text.slice(0, 4000) });
        else {
          const name = toolNameOf(message.content);
          if (name !== "") entries.push({ seq, at, role: "tool", name, text: name });
        }
      } else if (ev.type === "turn/end") {
        entries.push({ seq, at, role: "sys", text: "第 " + String(Number(data.turn) || 0) + " 轮结束（" + String(data.reason === undefined || data.reason === null ? "" : data.reason.kind) + "）" });
      } else if (ev.type === "session/title") {
        if (typeof data.title === "string") entries.push({ seq, at, role: "sys", text: "会话命名：" + data.title });
      }
    }
    return { ok: true, sessionId, total: entries.length, entries: entries.slice(-limit) };
  }

  return { state, bind, unbind, create, send, transcript, sessionIdOf };
}
