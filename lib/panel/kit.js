/**
 * 面板公共件（评审 P2-7）的宿主侧：把 kit.client.js 原样提供给浏览器。
 *
 *   <script src="../kit.js"></script>   // 功能面板（<prefix>/<id>/panel）
 *   <script src="kit.js"></script>      // 工具包外壳（<prefix>/panel）
 *
 * 浏览器侧只有一份实现（kit.client.js）：esc / n0 / n1 / when / ago / json / post /
 * poll / badge / toast / levelClass。写请求不用手动带令牌——polaris_token 是
 * HttpOnly cookie，同源 fetch 会自动带上。
 */
import fs from "node:fs";

export const KIT_FILE = "kit.js";
const SOURCE_URL = new URL("./kit.client.js", import.meta.url);
let cached = null;

export function kitSource() {
  if (cached !== null) return cached;
  cached = fs.readFileSync(SOURCE_URL, "utf8");
  return cached;
}

/** 公共配色变量：三个面板共用，排版样式仍各写各的。 */
export function kitCss() {
  return [
    ":root{--pk-fg:#d4d4d4;--pk-dim:rgba(255,255,255,.55);--pk-line:rgba(255,255,255,.08);--pk-panel:#232327;--pk-bg:#1b1b1f;--pk-ok:#3f9d63;--pk-warn:#c9a227;--pk-high:#d97706;--pk-crit:#dc2626;color-scheme:dark light}",
    "body{color:var(--vscode-foreground,var(--pk-fg))}"
  ].join("\n");
}

/** 面板里引入 kit 的标签；depth 传 ".."（功能面板）或 "."（外壳）。 */
export function kitTag(depth) {
  return '<script src="' + (depth === ".." ? "../" : "") + KIT_FILE + '"></script>';
}

export default { KIT_FILE, kitSource, kitCss, kitTag };
