# Security Policy

## 报告漏洞

请用 GitHub 的 [private security advisory](https://github.com/PolarisWang/polaris-toolkit/security/advisories/new)
报告，不要开公开 issue。请在报告里写：影响版本、复现步骤、以及（如果可以）最小 PoC。
我们会在 7 天内答复，修好后在 CHANGELOG 里致谢（如你愿意署名）。

## 支持范围

只维护最新的 0.x 版本；0.x 阶段不承诺 ABI 兼容，但会尽量在 CHANGELOG 标注破坏性变更。

## 部署模型与信任边界

polaris-toolkit 是**本机插件**，装在 DSH 宿主的进程里，和宿主同权限。请按下面几点评估风险：

- HTTP 控制面挂在宿主同端口的 `/__polaris/*` 前缀下。**写接口要求 `x-polaris-token`**（面板自动带 cookie；命令行用 `node bin/polaris.mjs token` 取），
  但**读接口按设计是匿名的**：本机上任何进程都能读到 `/api/state`、`/api/chat`、`/api/detail`、`/api/audit`、`/api/trace`。
  不要在多用户机器上把宿主端口暴露给不可信的人；详见 [docs/known-limits.md](docs/known-limits.md)。
- 令牌文件在 `~/.dsh/polaris-toolkit/secret`（仅本用户可读）；不要提交到仓库、不要贴到聊天里。
- 面板里的 `steward` 能力平面能对**你自己的** DSH 会话发消息、催/取消卡住的会话、写本地文件、跑 `git` 之外的只读命令。
  默认 `actMode: "echo"`（只预演不执行），`actLevel` 默认 `L2`；要真正动手必须显式打开，见 README 的授权章节。
- 能力插件是本地 JS（`lib/features/steward/plane/*`），安装第三方能力等于让它在宿主进程里执行代码：只装你读过的。
- 联邦 peer 用共享密钥做 HMAC；`/api/federation/receive` 需要本地令牌，所以默认只接受本机/受信转发。

## 我们做过的基本功

- 写接口令牌用 `sha256` + `timingSafeEqual` 常量时间比较；
- 所有 HTTP 处理器都只在 loopback 上被信任（`fence.js`）；
- 依赖声明为宿主 peer（`@deepseek-ai/*`），仓库不打包宿主代码；
- CI（Linux + Windows × Node 20/22/24）跑 `pnpm test` 与仓库卫生检查。
