/**
 * 通知执行器：把一条 decision 变成一条或多条请勿阻塞的投递。
 *
 * settings.notify = { minSeverity, larkEnabled, channels? }
 * 通道失败只记录，不抛——通知永远不该让工作流进 DLQ。
 */
import { severityRank } from "../plane/expr.js";

export function createNotifier(options) {
  const opt = options === undefined || options === null ? {} : options;
  const log = typeof opt.log === "function" ? opt.log : () => {};
  const desktop = opt.desktop;
  const feishu = opt.feishu;
  const settings = typeof opt.settings === "function" ? opt.settings : () => ({});

  function threshold() {
    const notify = settings().notify === undefined ? {} : settings().notify;
    const min = typeof notify.minSeverity === "string" ? notify.minSeverity : "warning";
    return severityRank(min) || severityRank("warning");
  }

  async function send(message) {
    const level = typeof message.level === "string" ? message.level : "warning";
    if (severityRank(level) < threshold()) return { ok: true, skipped: "below-threshold", level };
    const targets = [];
    if (desktop !== undefined) targets.push(desktop);
    const notifyCfg = settings().notify === undefined ? {} : settings().notify;
    if (notifyCfg.larkEnabled === true && feishu !== undefined) targets.push(feishu);
    const results = [];
    for (const channel of targets) {
      try {
        results.push(await channel.send(message));
      } catch (error) {
        log("warn", "channel " + channel.id + " failed: " + String(error));
        results.push({ ok: false, channel: channel.id, error: String(error) });
      }
    }
    return { ok: results.some((r) => r.ok), results, channels: targets.map((t) => t.id) };
  }

  return { send, threshold };
}
