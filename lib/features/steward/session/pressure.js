/**
 * 自适应轮换（design 8.5 的 C6=C 选择）。
 *
 *   pressure = 0.5 * fill + 0.3 * compactRecency + 0.2 * rollupRatio
 *   fill     = max(turns / ceilingTurns, tokens / ceilingTokens)
 *   compactRecency = 最近一次压缩距今越近越高（半小时内线性衰减到 0）
 *   rollupRatio    = 最近一次 rollup 字数 / 允许上限
 *
 * 触发条件：pressure > targetPressure 且 rounds > floorTurns；
 * 或者 fill > hardFill（硬阈值，不看轮数）；
 * 防抖：距上次轮换 < debounceMs 不触发。
 * 间隔过短（< minIntervalMs）要告警而不是静默轮换——说明阈值定错了。
 */

export const DEFAULT_LIMITS = {
  lead: { floorTurns: 40, ceilingTurns: 200, ceilingTokens: 300_000, targetPressure: 0.75, hardFill: 0.88, rollupChars: 4000 },
  module: { floorTurns: 20, ceilingTurns: 80, ceilingTokens: 180_000, targetPressure: 0.75, hardFill: 0.88, rollupChars: 4000 }
};

export function computePressure(input) {
  const i = input === undefined || input === null ? {} : input;
  const role = i.role === "module" ? "module" : "lead";
  const limits = Object.assign({}, DEFAULT_LIMITS[role], i.limits === undefined ? {} : i.limits);
  const turns = Number(i.turns === undefined ? 0 : i.turns);
  const tokens = Number(i.tokens === undefined ? 0 : i.tokens);
  const compactAgeMs = Number(i.compactAgeMs === undefined ? -1 : i.compactAgeMs);
  const rollupChars = Number(i.rollupChars === undefined ? 0 : i.rollupChars);

  const fillTurns = limits.ceilingTurns > 0 ? turns / limits.ceilingTurns : 0;
  const fillTokens = limits.ceilingTokens > 0 ? tokens / limits.ceilingTokens : 0;
  const fill = Math.max(fillTurns, fillTokens);
  const compactRecency = compactAgeMs < 0 ? 0 : Math.max(0, Math.min(1, 1 - compactAgeMs / 1_800_000));
  const rollupRatio = limits.rollupChars > 0 ? Math.min(1.5, rollupChars / limits.rollupChars) : 0;
  const pressure = 0.5 * Math.min(1.5, fill) + 0.3 * compactRecency + 0.2 * rollupRatio;

  return { role, limits, turns, tokens, fill, fillTurns, fillTokens, compactRecency, rollupRatio, pressure: Math.round(pressure * 1000) / 1000 };
}

export function shouldRotate(input) {
  const i = input === undefined || input === null ? {} : input;
  const now = typeof i.now === "number" ? i.now : Date.now();
  const metrics = computePressure(i);
  const limits = metrics.limits;
  const lastRotateAt = typeof i.lastRotateAt === "number" ? i.lastRotateAt : 0;
  const debounceMs = Number(i.debounceMs === undefined ? 600_000 : i.debounceMs);
  const minIntervalMs = Number(i.minIntervalMs === undefined ? 1_800_000 : i.minIntervalMs);

  if (lastRotateAt > 0 && now - lastRotateAt < debounceMs) {
    return { rotate: false, reason: "debounce", metrics };
  }
  if (metrics.fill > limits.hardFill) {
    return { rotate: true, reason: "hard-fill", warn: lastRotateAt > 0 && now - lastRotateAt < minIntervalMs, metrics };
  }
  if (metrics.turns < limits.floorTurns) {
    return { rotate: false, reason: "below-floor", metrics };
  }
  if (metrics.pressure > limits.targetPressure) {
    return { rotate: true, reason: "pressure", warn: lastRotateAt > 0 && now - lastRotateAt < minIntervalMs, metrics };
  }
  return { rotate: false, reason: "ok", metrics };
}
