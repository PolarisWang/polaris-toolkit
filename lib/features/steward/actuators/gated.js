/**
 * actMode 闸门（评审第 8 项拆分的产物）：把三个真执行器包一层，
 * actMode="echo" 时只把「本来要发出去的 message」写进 journal 与面板，
 * 等主人 ack 后把 actMode 切成 "live" 才会真正调用 notify/prompt/answer。
 */
export function createGated({ readSettings, store, log, notifier, prompter, answerer }) {
  function echoAction(kind, text, agentId) {
    const message = "[" + kind + "] " + String(text === undefined ? "" : text).slice(0, 400);
    store.pushAction({ kind: "echo", agentId, ok: true, message });
    try { log("info", "steward echo " + message); } catch { /* ignore */ }
    return { ok: true, echo: true, message };
  }

  // actMode="echo"：动作只把 message 打进 journal 与面板，等主人 ack 后再切 "live"。
  const gatedNotifier = {
    send: async (message) => {
      const base = message === undefined || message === null ? {} : message;
      if (readSettings().actMode !== "live") {
        return echoAction("notify:" + String(base.level === undefined ? "info" : base.level), String(base.title === undefined ? "" : base.title) + " — " + String(base.text === undefined ? "" : base.text), base.subject === undefined ? undefined : String(base.subject));
      }
      if (notifier === undefined) return { ok: false, reason: "no-notifier" };
      return notifier.send(message);
    },
    threshold: () => (notifier === undefined ? 0 : notifier.threshold())
  };

  const gatedPrompter = {
    prompt: async (ctx, request) => {
      const req = request === undefined || request === null ? {} : request;
      if (readSettings().actMode !== "live") return echoAction("prompt:" + String(req.mode === undefined ? "followup" : req.mode), "-> " + String(req.sessionId === undefined ? "?" : req.sessionId) + ": " + String(req.content === undefined ? "" : req.content), req.sessionId === undefined ? undefined : String(req.sessionId));
      if (prompter === undefined) return { ok: false, reason: "no-prompter" };
      return prompter.prompt(ctx, request);
    }
  };

  const gatedAnswerer = {
    answer: async (ctx, request) => {
      const req = request === undefined || request === null ? {} : request;
      if (readSettings().actMode !== "live") return echoAction("answer", String(req.agent === undefined ? "?" : req.agent) + " / " + String(req.callId === undefined ? "?" : req.callId) + ": " + JSON.stringify(req.answers === undefined ? {} : req.answers), req.agent === undefined ? undefined : String(req.agent));
      if (answerer === undefined) return { ok: false, reason: "no-answerer" };
      return answerer.answer(ctx, request);
    }
  };

  return { echoAction, notifier: gatedNotifier, prompter: gatedPrompter, answerer: gatedAnswerer };
}
