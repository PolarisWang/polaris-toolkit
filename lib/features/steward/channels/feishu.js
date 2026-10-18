/**
 * 飞书通道：调用本机 lark-cli（默认关闭，需 settings.notify.larkEnabled = true）。
 *
 * 刻意做成“模板 + 参数数组”，不拼 shell 字符串：Windows 上拼接命令会被引号
 * 撕开，也会给注入留口子。任何失败都只返回 { ok:false }，绝不让工作流崩。
 */
import { spawn } from "node:child_process";

const DEFAULT_ARGS = ["im", "+send", "--to", "me", "--text", "{text}"];

export function createFeishuChannel(options) {
  const o = options === undefined ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  const command = typeof o.command === "string" ? o.command : "lark-cli";
  const args = Array.isArray(o.args) ? o.args : DEFAULT_ARGS;
  const timeoutMs = Number(o.timeoutMs === undefined ? 20_000 : o.timeoutMs);
  const spawnImpl = typeof o.spawn === "function" ? o.spawn : spawn;

  function materialize(message) {
    return args.map((arg) => String(arg)
      .replace(/\{text\}/g, String(message.text === undefined ? "" : message.text))
      .replace(/\{title\}/g, String(message.title === undefined ? "" : message.title))
      .replace(/\{level\}/g, String(message.level === undefined ? "" : message.level)));
  }

  return {
    id: "feishu",
    async send(message) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (value) => { if (!done) { done = true; resolve(value); } };
        let child;
        try {
          child = spawnImpl(command, materialize(message), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          log("warn", "feishu spawn failed: " + String(error));
          finish({ ok: false, channel: "feishu", error: String(error) });
          return;
        }
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          log("warn", "feishu notify timed out");
          finish({ ok: false, channel: "feishu", error: "timeout" });
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        child.on("error", (error) => { clearTimeout(timer); finish({ ok: false, channel: "feishu", error: String(error) }); });
        child.on("close", (code) => {
          clearTimeout(timer);
          finish(code === 0 ? { ok: true, channel: "feishu", code } : { ok: false, channel: "feishu", code });
        });
      });
    }
  };
}
