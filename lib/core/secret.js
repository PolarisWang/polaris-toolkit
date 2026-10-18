/**
 * 安装级写操作令牌（评审 P0-3）。
 *
 * 宿主自己的 web 鉴权只保护 "/"，/__polaris/* 过去是匿名可写的：任何本机进程
 * 都能 slim 会话、切 actMode、批审批。这里生成一个只属于当前用户的随机令牌，
 * 放在状态目录（0600），所有 mutating 路由都要带上它。
 *
 * 边界（文档里也写了）：它挡的是"别的用户 / 别的站点 / 不读文件的脚本"，
 * 挡不住同账号下已经能读 ~/.dsh 的进程——那需要操作系统级隔离，不在这里的
 * 职责范围内。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.js";

const TOKEN_RE = /^[0-9a-f]{32,}$/;

export function createSecret(dir, options) {
  const opt = options === undefined || options === null ? {} : options;
  const file = path.join(ensureDir(dir), "secret");
  let token = "";
  try { token = String(fs.readFileSync(file, "utf8")).trim(); } catch { token = ""; }
  if (!TOKEN_RE.test(token)) {
    token = typeof opt.token === "string" && TOKEN_RE.test(opt.token.trim())
      ? opt.token.trim()
      : crypto.randomBytes(24).toString("hex");
    try {
      fs.writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    } catch { /* read-only state dir: the in-memory token still gates this process */ }
  }
  return { token, file };
}

export default { createSecret };
