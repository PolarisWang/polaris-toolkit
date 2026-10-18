/**
 * 首批能力实例（能力平面 §11）。两批来源：
 *   · 原 rules/builtin/system.json 的 5 条规则 → 5 个判定能力（judge.*，carrier=expr，无副作用）
 *   · 原 wf/defs.js 的 5 个剧本       → 5 个片段能力（plan.*，carrier=tree，只是树）
 *   · 常用的动作能力（通知/请示/催办/瘦身/汇报/记录）
 *
 * 判定能力只回答 { hit, level, reason, evidence }，不做事；
 * 片段能力只是一棵树，里面 call 的是别的能力。
 * tool 载体的动词表（宿主装配时提供 services.tool）：
 *   approval.create / approval.get / heap.slim / digest.send / collect.sample / rules.reload
 */

function notifyInstances() {
  return [
    {
      id: "notify.desktop", title: "通知主人（桌面）", payload: "notice", carrier: "desktop",
      target: "owner", protocol: "fire", grant: "act", tags: ["notify", "desktop"],
      params: { title: "Polaris 通知", text: "", level: "warning", subject: "" },
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 15000, maxAttempts: 2 }
    },
    {
      id: "notify.lark", title: "通知主人（飞书）", payload: "notice", carrier: "lark.im",
      target: "owner", protocol: "fire", grant: "act", tags: ["notify", "lark"],
      params: { title: "Polaris 通知", text: "", level: "warning", subject: "" },
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 15000, maxAttempts: 2 }
    }
  ];
}

function judgeInstances() {
  return [
    {
      id: "judge.host.heap.high", title: "堆占用超过 88%", payload: "verdict", carrier: "expr",
      target: "host:*", protocol: "ack", grant: "act", tags: ["judge", "host", "heap"],
      params: {
        rules: [
          { id: "host.heap.high", level: "warning", if: { gte: ["heapPct", 88] }, reason: "宿主堆占用偏高", evidence: { fact: "heapPct", threshold: 88 } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 600, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "judge.host.heap.critical", title: "堆占用超过 92%", payload: "verdict", carrier: "expr",
      target: "host:*", protocol: "ack", grant: "act", tags: ["judge", "host", "heap"],
      params: {
        rules: [
          { id: "host.heap.critical", level: "critical", if: { gte: ["heapPct", 92] }, reason: "宿主堆进入危险区", evidence: { fact: "heapPct", threshold: 92 } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 300, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "judge.host.loop.lag", title: "事件循环 p99 超过 250ms", payload: "verdict", carrier: "expr",
      target: "host:*", protocol: "ack", grant: "act", tags: ["judge", "host", "loop"],
      params: {
        rules: [
          { id: "host.loop.lag", level: "warning", if: { gte: ["loopP99Ms", 250] }, reason: "事件循环被阻塞", evidence: { fact: "loopP99Ms", threshold: 250 } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 600, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "judge.host.disk.low", title: "磁盘剩余不足 2GB", payload: "verdict", carrier: "expr",
      target: "host:*", protocol: "ack", grant: "act", tags: ["judge", "host", "disk"],
      params: {
        rules: [
          { id: "host.disk.low", level: "error", if: { lt: ["freeDiskMB", 2048] }, reason: "磁盘剩余空间过低", evidence: { fact: "freeDiskMB", threshold: 2048 } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 3600, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "judge.host.crash.new", title: "本次启动后出现过崩溃日志", payload: "verdict", carrier: "expr",
      target: "host:*", protocol: "ack", grant: "act", tags: ["judge", "host", "crash"],
      params: {
        rules: [
          { id: "host.crash.new", level: "critical", if: { lt: ["crashNewestAgeMin", 90] }, reason: "本次启动后出现过崩溃日志（旧的崩溃归档不会重复提醒）", evidence: { fact: "crashNewestAgeMin", threshold: 90 } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 1800, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "judge.agent.stalled", title: "会话卡住", payload: "verdict", carrier: "expr",
      target: "session:*", protocol: "ack", grant: "act", tags: ["judge", "agent", "stall"],
      params: {
        rules: [
          { id: "agent.stalled", level: "warning", if: { eq: ["stalled", true] }, reason: "会话静默超过阈值", evidence: { fact: "silenceMs" } }
        ]
      },
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 5000, maxAttempts: 1 }
    }
  ];
}

function actionInstances() {
  return [
    {
      id: "ask.owner", title: "请主人拍板", payload: "answer", carrier: "tool",
      target: "owner", protocol: "ask", grant: "act", tags: ["ask"],
      params: { name: "approval.create", title: "请示", detail: "", subject: "", moduleId: "", level: "warning", ttlMs: 1800000 },
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 15000, maxAttempts: 1 }
    },
    {
      id: "steer.session", title: "催一下会话", payload: "directive", carrier: "session",
      target: "session:*", protocol: "fire", grant: "act", tags: ["session", "steer"],
      params: { sessionId: "", text: "", mode: "followup", requestId: "" },
      limits: { budgetPerHour: 0, cooldownSec: 60, timeoutMs: 15000, maxAttempts: 2 }
    },
    {
      id: "cancel.session", title: "停掉一个会话", payload: "directive", carrier: "session",
      target: "session:*", protocol: "fire", grant: "act", tags: ["session", "cancel"],
      params: { sessionId: "" },
      limits: { budgetPerHour: 0, cooldownSec: 120, timeoutMs: 15000, maxAttempts: 1 }
    },
    {
      id: "slim.host", title: "瘦身宿主堆", payload: "directive", carrier: "tool",
      target: "host:*", protocol: "fire", grant: "act", tags: ["heap", "slim"],
      params: { name: "heap.slim", level: 3 },
      limits: { budgetPerHour: 6, cooldownSec: 300, timeoutMs: 60000, maxAttempts: 1 }
    },
    {
      id: "report.digest", title: "汇报汇总", payload: "report", carrier: "tool",
      target: "owner", protocol: "fire", grant: "act", tags: ["digest"],
      params: { name: "digest.send", agents: [], runs: [], signals: [], approvals: [] },
      limits: { budgetPerHour: 12, cooldownSec: 60, timeoutMs: 15000, maxAttempts: 2 }
    },
    {
      id: "record.journal", title: "记一条流水", payload: "record", carrier: "file",
      target: "store:*", protocol: "fire", grant: "act", tags: ["record"],
      params: { name: "journal" },
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 5000, maxAttempts: 1 }
    },
    {
      id: "record.larkdoc", title: "记进飞书文档", payload: "record", carrier: "lark.doc",
      target: "doc:*", protocol: "fire", grant: "act", tags: ["record", "lark"],
      params: { title: "Polaris 记录", text: "" },
      limits: { budgetPerHour: 12, cooldownSec: 60, timeoutMs: 20000, maxAttempts: 2 }
    },
    {
      id: "assign.task", title: "记一条交办", payload: "directive", carrier: "task",
      target: "session:*", protocol: "fire", grant: "act", tags: ["task"],
      params: { title: "交办", brief: "", target: "", acceptance: "" },
      limits: { budgetPerHour: 12, cooldownSec: 60, timeoutMs: 15000, maxAttempts: 1 }
    },
    {
      id: "summarize.llm", title: "问模型一句", payload: "report", carrier: "llm",
      target: "owner", protocol: "stream", grant: "act", tags: ["llm"],
      params: { prompt: "", system: "", timeoutMs: 15000, maxTokens: 512 },
      limits: { budgetPerHour: 12, cooldownSec: 120, timeoutMs: 30000, maxAttempts: 1 }
    }
  ];
}

function planInstances() {
  return [
    {
      id: "plan.notify", title: "片段：发一条通知", payload: "plan", carrier: "tree",
      target: "owner", protocol: "ack", grant: "act", tags: ["plan", "notify"],
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 30000, maxAttempts: 1 },
      plan: {
        seq: [
          {
            call: "notify.desktop",
            params: { title: "{title}", text: "{text}", level: "{level}", subject: "{subject}" },
            onError: "continue"
          }
        ]
      }
    },
    {
      id: "plan.ask", title: "片段：请示并等答复", payload: "plan", carrier: "tree",
      target: "owner", protocol: "ack", grant: "act", tags: ["plan", "ask"],
      limits: { budgetPerHour: 0, cooldownSec: 0, timeoutMs: 60000, maxAttempts: 1 },
      plan: {
        seq: [
          {
            call: "ask.owner",
            params: { title: "{title}", detail: "{detail}", subject: "{subject}", level: "{level}", ttlMs: 1800000 },
            save: "approval",
            onError: "abort"
          },
          { wait: 60, timeout: 1800 }
        ]
      }
    },
    {
      id: "plan.agent.stall", title: "片段：agent 卡住", payload: "plan", carrier: "tree",
      target: "session:*", protocol: "ack", grant: "act", tags: ["plan", "stall"],
      limits: { budgetPerHour: 0, cooldownSec: 600, timeoutMs: 60000, maxAttempts: 1 },
      plan: {
        seq: [
          {
            call: "notify.desktop",
            params: { title: "agent 卡住：{title}", text: "{text}", level: "warning", subject: "{subject}" },
            onError: "continue"
          },
          {
            if: { eq: ["autoAct", true] },
            then: {
              call: "steer.session",
              params: { sessionId: "{parentSessionId}", text: "子系统静默，请确认进度", mode: "followup", requestId: "stall:{subject}" },
              onError: "continue"
            },
            else: { noop: true }
          }
        ]
      }
    },
    {
      id: "plan.host.protect", title: "片段：宿主保护", payload: "plan", carrier: "tree",
      target: "host:*", protocol: "ack", grant: "act", tags: ["plan", "host", "heap"],
      limits: { budgetPerHour: 0, cooldownSec: 300, timeoutMs: 120000, maxAttempts: 1 },
      plan: {
        seq: [
          {
            call: "notify.desktop",
            params: { title: "宿主内存高水位", text: "堆 {usedMB}MB / {limitMB}MB（{pct}%）", level: "{level}", subject: "host" },
            onError: "continue"
          },
          {
            if: { eq: ["autoAct", true] },
            then: { call: "slim.host", params: { level: 3 }, onError: "continue" },
            else: { noop: true }
          }
        ]
      }
    },
    {
      id: "plan.digest", title: "片段：定期汇报", payload: "plan", carrier: "tree",
      target: "owner", protocol: "ack", grant: "act", tags: ["plan", "digest"],
      limits: { budgetPerHour: 0, cooldownSec: 3600, timeoutMs: 30000, maxAttempts: 1 },
      plan: { seq: [{ call: "report.digest", params: {}, onError: "continue" }] }
    }
  ];
}

/** 全部首批实例（判定 + 动作 + 片段）。 */
export function builtinInstances() {
  return judgeInstances().concat(actionInstances(), planInstances(), notifyInstances());
}

/** 5 条原规则的 1:1 迁移对照，供文档与迁移测试使用。 */
export const RULE_MIGRATION = [
  { rule: "host.heap.high", capability: "judge.host.heap.high", plan: "plan.notify" },
  { rule: "host.heap.critical", capability: "judge.host.heap.critical", plan: "plan.host.protect" },
  { rule: "host.loop.lag", capability: "judge.host.loop.lag", plan: "plan.notify" },
  { rule: "host.disk.low", capability: "judge.host.disk.low", plan: "plan.notify" },
  { rule: "host.crash.new", capability: "judge.host.crash.new", plan: "plan.notify" }
];

/** 原 5 个剧本 → 5 个片段能力的对照。 */
export const WORKFLOW_MIGRATION = [
  { workflow: "wf.notify", capability: "plan.notify" },
  { workflow: "wf.ask", capability: "plan.ask" },
  { workflow: "wf.agent.stall", capability: "plan.agent.stall" },
  { workflow: "wf.host.protect", capability: "plan.host.protect" },
  { workflow: "wf.digest", capability: "plan.digest" }
];

export { judgeInstances, actionInstances, planInstances, notifyInstances };

export default { builtinInstances, judgeInstances, actionInstances, planInstances, notifyInstances, RULE_MIGRATION, WORKFLOW_MIGRATION };
