/**
 * 带队视图的数据面（C 方案里的"眼"）。
 *
 * 一个会话到底在干什么，日志里其实都有：goal/change 是目标、todo/write 是进度、
 * assistant/message 是最后一句、turn/end 是轮次。这里把它们折成一行事实，
 * 供面板的详情抽屉与带队表使用。
 *
 * 读整份日志是重操作，所以只在"有人看"的时候触发（面板打开抽屉 / 带队表前 N 行），
 * 并且带 20 秒 TTL 缓存；tick 不碰这里。
 */
import { textOf, toolNameOf } from "./events.js";

const TTL = 20000;
const MAX_ENTRIES = 40;
const MAX_TEXT = 280;

function clip(value, limit) {
  const text = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

function goalTextOf(data) {
  if (data === null || typeof data !== "object") return "";
  const goal = data.goal !== null && typeof data.goal === "object" ? data.goal : undefined;
  if (goal !== undefined) {
    for (const key of ["objective", "text", "title"]) {
      if (typeof goal[key] === "string" && goal[key].trim() !== "") return goal[key].trim();
    }
  }
  for (const key of ["objective", "text", "title"]) {
    if (typeof data[key] === "string" && data[key].trim() !== "") return data[key].trim();
  }
  return "";
}

function summarize(sessionId, list) {
  const out = {
    sessionId,
    at: Date.now(),
    goal: "",
    todos: { total: 0, done: 0, doing: 0, current: "", next: "" },
    turns: 0,
    lastAssistant: "",
    lastUser: "",
    lastTool: "",
    lastAt: 0,
    events: list.length,
    trace: []
  };
  for (const ev of list) {
    if (ev === null || typeof ev !== "object") continue;
    const data = ev.data !== null && typeof ev.data === "object" ? ev.data : {};
    const at = Number(ev.time) > 0 ? Number(ev.time) : 0;
    if (at > out.lastAt) out.lastAt = at;
    if (ev.type === "goal/change") {
      const text = goalTextOf(data);
      if (text !== "") out.goal = clip(text, MAX_TEXT);
    } else if (ev.type === "todo/write") {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      let done = 0;
      let doing = 0;
      let current = "";
      let next = "";
      for (const todo of todos) {
        if (todo === null || typeof todo !== "object") continue;
        const status = String(todo.status === undefined ? "" : todo.status);
        if (status === "completed") done += 1;
        else if (status === "in_progress") { doing += 1; if (current === "") current = clip(todo.content, 80); }
        else if (next === "") next = clip(todo.content, 80);
      }
      out.todos = { total: todos.length, done, doing, current, next };
    } else if (ev.type === "turn/end") {
      const turn = Number(data.turn);
      if (Number.isFinite(turn) && turn > out.turns) out.turns = turn;
    } else if (ev.type === "assistant/message") {
      const message = data.message !== null && typeof data.message === "object" ? data.message : {};
      const text = textOf(message.content);
      if (text !== "") out.lastAssistant = clip(text, MAX_TEXT);
      const name = toolNameOf(message.content);
      if (name !== "") out.lastTool = name;
    } else if (ev.type === "user/message") {
      const text = textOf(data.content);
      if (text !== "") out.lastUser = clip(text, MAX_TEXT);
    }
  }
  // 抽屉用的人话轨迹：只留会改变判断的几类事件。
  for (let i = list.length - 1; i >= 0 && out.trace.length < 12; i -= 1) {
    const ev = list[i];
    if (ev === null || typeof ev !== "object") continue;
    const data = ev.data !== null && typeof ev.data === "object" ? ev.data : {};
    const at = Number(ev.time) > 0 ? Number(ev.time) : 0;
    if (ev.type === "user/message") out.trace.push({ at, kind: "user", text: clip(textOf(data.content), 160) });
    else if (ev.type === "assistant/message") {
      const message = data.message !== null && typeof data.message === "object" ? data.message : {};
      const text = textOf(message.content);
      const name = toolNameOf(message.content);
      out.trace.push({ at, kind: text === "" ? "tool" : "assistant", text: text === "" ? "调用 " + name : clip(text, 160) });
    } else if (ev.type === "tool/result") {
      out.trace.push({ at, kind: "tool-result", text: "工具返回" });
    } else if (ev.type === "turn/end") {
      out.trace.push({ at, kind: "turn", text: "第 " + String(Number(data.turn) || 0) + " 轮结束" });
    } else if (ev.type === "goal/change") {
      out.trace.push({ at, kind: "goal", text: clip(goalTextOf(data), 120) });
    } else if (ev.type === "todo/write") {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      const done = todos.filter((todo) => todo !== null && typeof todo === "object" && todo.status === "completed").length;
      out.trace.push({ at, kind: "todo", text: "待办 " + done + "/" + todos.length });
    }
  }
  out.trace.reverse();
  return out;
}

export function createDetail({ events, log }) {
  const cache = new Map();

  async function of(sessionId, opts) {
    const id = String(sessionId === undefined || sessionId === null ? "" : sessionId).trim();
    if (id === "") return undefined;
    const ttl = opts !== null && typeof opts === "object" && Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : TTL;
    const now = Date.now();
    const hit = cache.get(id);
    if (hit !== undefined && now - hit.at < ttl) return hit.value;
    const list = await events.read(id, ttl);
    if (list === undefined) return undefined;
    const value = summarize(id, list);
    cache.delete(id);
    cache.set(id, { at: now, value });
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    return value;
  }

  return {
    of,
    forget(sessionId) { cache.delete(String(sessionId)); },
    clear() { cache.clear(); },
    size() { return cache.size; }
  };
}
