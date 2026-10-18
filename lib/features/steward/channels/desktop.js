/**
 * 桌面通道：只写账本（actions 已经由引擎记过），面板靠它渲染“最近通知”。
 * 它的意义是给 notify 一个永远可用的兜底，不依赖任何外部进程。
 */
export function createDesktopChannel(options) {
  const o = options === undefined ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  const sent = [];
  return {
    id: "desktop",
    async send(message) {
      sent.push({ at: Date.now(), message });
      if (sent.length > 200) sent.shift();
      log("info", "desktop notify: " + String(message.title));
      return { ok: true, channel: "desktop" };
    },
    recent() { return sent.slice(); }
  };
}
