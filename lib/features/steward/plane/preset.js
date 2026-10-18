/**
 * 预置编制（能力平面 §2）：主管不是类型，是一条数据记录 —— 装了什么能力就是什么职责。
 *
 * "堆守望"是装机预置：它 1:1 覆盖原来 rules/builtin/system.json 的 5 条规则与
 * wf.host.protect，所以删掉规则引擎后开箱行为不变。想改行为就改这棵树。
 * "带班"从 agent 视角盯会话，默认关闭（开启前先确认 autoAct 与 actLevel）。
 */
import { validateTree } from "./tree.js";

const JUDGES = ["judge.host.crash.new", "judge.host.heap.critical", "judge.host.heap.high", "judge.host.loop.lag", "judge.host.disk.low"];

function voiceOf(raw) {
  const v = raw !== undefined && raw !== null && typeof raw === "object" ? raw : {};
  const mode = v.mode === undefined ? "virtual" : String(v.mode);
  return { mode: mode === "session" ? "session" : "virtual", sessionId: v.sessionId === undefined || v.sessionId === null ? "" : String(v.sessionId) };
}

function call(id, save, params) {
  const node = { call: id, onError: "continue", params: params === undefined ? {} : params };
  if (save !== undefined) node.save = save;
  return node;
}

function branch(path, cap, params) {
  return { if: { eq: [path, true] }, then: call(cap, undefined, params), else: { noop: true } };
}

function watchTree() {
  return {
    seq: [
      {
        when: "host/tick",
        do: {
          seq: [
            call("judge.host.crash.new", "vCrash"),
            call("judge.host.heap.critical", "vHeapCritical"),
            call("judge.host.heap.high", "vHeapHigh"),
            call("judge.host.loop.lag", "vLoop"),
            call("judge.host.disk.low", "vDisk"),
            branch("vCrash.hit", "plan.notify", { title: "出现新的崩溃日志", text: "{vCrash.reason}", level: "critical", subject: "host" }),
            {
              if: { eq: ["vHeapCritical.hit", true] },
              then: call("plan.host.protect", undefined, { level: "critical", text: "{vHeapCritical.reason}" }),
              else: {
                if: { eq: ["vHeapHigh.hit", true] },
                then: call("plan.notify", undefined, { title: "宿主堆占用偏高", text: "堆 {heapPct}%（{usedMB}MB/{limitMB}MB）", level: "warning", subject: "host" }),
                else: { noop: true }
              }
            },
            branch("vLoop.hit", "plan.notify", { title: "事件循环卡顿", text: "P99 {loopP99Ms}ms", level: "warning", subject: "host" }),
            branch("vDisk.hit", "plan.notify", { title: "磁盘剩余不足", text: "剩余 {freeDiskMB}MB", level: "error", subject: "host" })
          ]
        }
      },
      {
        when: "heap/critical",
        do: call("plan.host.protect", undefined, { level: "critical", text: "{text}" })
      }
    ]
  };
}

function agentTree() {
  return {
    when: "agent/tick",
    do: {
      seq: [
        call("judge.agent.stalled", "vStall"),
        branch("vStall.hit", "plan.agent.stall", { title: "{title}", text: "{vStall.reason}", subject: "{subject}", parentSessionId: "{sessionId}" })
      ]
    }
  };
}

export function builtinStewards() {
  return [
    {
      id: "watch",
      name: "堆守望",
      enabled: true,
      host: "host:*",
      audience: "owner",
      grant: "act",
      note: "装机预置：原 5 条内置规则 + wf.host.protect 的等价编制",
      equips: JUDGES.concat(["plan.notify", "plan.host.protect", "notify.desktop", "slim.host", "steer.session"]),
      events: ["host/tick", "heap/critical"],
      tree: watchTree()
    },
    {
      id: "agent",
      name: "带班",
      enabled: false,
      host: "session:*",
      audience: "owner",
      grant: "act",
      note: "从 agent 视角盯会话；默认关闭，开启前确认 autoAct 与 actLevel",
      equips: ["judge.agent.stalled", "plan.agent.stall", "notify.desktop", "steer.session"],
      events: ["agent/tick"],
      tree: agentTree()
    }
  ];
}

/** 校验 + 归一化：无效编制被丢弃并留下原因（面板的体检页会显示）。 */
export function normalizeStewards(raw) {
  const list = [];
  const errors = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (s === null || typeof s !== "object") { errors.push("steward must be an object"); continue; }
    if (typeof s.id !== "string" || s.id === "") { errors.push("steward needs an id"); continue; }
    if (s.tree === undefined || s.tree === null) { errors.push(s.id + ": needs a tree"); continue; }
    const checked = validateTree(s.tree, { equips: Array.isArray(s.equips) ? s.equips : [] });
    if (!checked.ok) { errors.push(s.id + ": " + checked.errors.slice(0, 3).join("; ")); continue; }
    list.push({
      id: s.id,
      name: s.name === undefined ? s.id : String(s.name),
      enabled: s.enabled !== false,
      host: s.host === undefined ? "" : String(s.host),
      audience: s.audience === undefined ? "owner" : String(s.audience),
      grant: s.grant === undefined ? "act" : String(s.grant),
      note: s.note === undefined ? "" : String(s.note),
      voice: voiceOf(s.voice),
      equips: Array.isArray(s.equips) ? s.equips.slice() : [],
      events: Array.isArray(s.events) ? s.events.map(String) : [],
      scope: Array.isArray(s.scope) ? s.scope.map(String) : [],
      overrides: s.overrides !== undefined && s.overrides !== null && typeof s.overrides === "object" ? s.overrides : {},
      tree: s.tree
    });
  }
  return { list: list, errors: errors };
}

export { JUDGES, watchTree, agentTree, voiceOf };

export default { builtinStewards, normalizeStewards };
