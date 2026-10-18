/**
 * 分级授权（C 方案）：总管的手能伸多远，由 actLevel 决定。
 *
 *   L1  只通知：能看、能汇报，不能动任何东西。
 *   L2  只读动作：可以采样、瘦身、重载规则（改的是工具包自身，不碰别人的会话）。
 *   L3  写动作：可以派活、steer、cancel、新建会话。
 *
 * 人类在面板上的点击不受这一层限制 —— 这一层管的是"总管自己要动手"的时候。
 * actMode=echo 仍然在最外层生效：即使到了 L3，动作也先打印 message 等主人 ack。
 */
const LEVELS = ["L1", "L2", "L3"];

/** 动作 → 需要的最低等级。未列出的动作按 L3 处理（默认收紧）。 */
const NEEDS = {
  "notify.send": "L1",
  "digest.send": "L1",
  "collect": "L2",
  "slim": "L2",
  "rules.reload": "L2",
  "task.create": "L2",
  "task.dispatch": "L3",
  "session.create": "L3",
  "agent.steer": "L3",
  "agent.cancel": "L3",
  "settings.write": "L3"
};

function rank(level) {
  const index = LEVELS.indexOf(level);
  return index < 0 ? -1 : index;
}

export function createPolicy({ readSettings, log }) {
  function level() {
    let raw = "L2";
    try { raw = readSettings().actLevel; } catch { raw = "L2"; }
    return rank(raw) < 0 ? "L2" : raw;
  }

  function needs(action) {
    const id = String(action === undefined || action === null ? "" : action);
    return NEEDS[id] !== undefined ? NEEDS[id] : "L3";
  }

  function allows(action) {
    return rank(level()) >= rank(needs(action));
  }

  function gate(action) {
    const need = needs(action);
    const have = level();
    if (rank(have) >= rank(need)) return { ok: true, action: String(action), level: have, needs: need };
    log("debug", "steward: policy denied " + String(action) + " (needs " + need + ", have " + have + ")");
    return { ok: false, action: String(action), level: have, needs: need, reason: "needs-" + need };
  }

  function describe() {
    const have = level();
    return {
      level: have,
      levels: LEVELS.slice(),
      allows: Object.keys(NEEDS).filter((action) => rank(have) >= rank(NEEDS[action])),
      denies: Object.keys(NEEDS).filter((action) => rank(have) < rank(NEEDS[action]))
    };
  }

  return { level, needs, allows, gate, describe, LEVELS };
}

export const ACTION_LEVELS = NEEDS;
