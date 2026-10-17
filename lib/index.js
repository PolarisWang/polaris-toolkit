/**
 * Polaris Toolkit —— 多功能的宿主侧工具包。
 *
 * 一个插件入口，内部按 feature 组织：每个 feature 自带配置 schema、面板、
 * 路由与工具；工具包统一挂在 /__polaris 下，并把每个 feature 挂到
 * /__polaris/<feature-id>。新增功能只需要写 lib/features/<id>/ 并在
 * lib/features/index.js 登记。
 */
import z from "@deepseek-ai/schemastery";
import { FEATURES } from "./features/index.js";
import { mountToolkit } from "./core/host.js";

export const name = "polaris-toolkit";
export const inject = ["webServer", "agents", "webRuntime", "tools"];
export const PREFIX = "/__polaris";

export const Config = z.object({
  /** 按 feature id 给出的配置切片；缺省时每个 feature 用自己的默认值。 */
  features: z.any().default({})
});

export function apply(ctx, config) {
  mountToolkit(ctx, config === undefined ? {} : config, {
    name,
    prefix: PREFIX,
    displayName: "Polaris Toolkit",
    features: FEATURES
  });
}

export default { name, inject, Config, apply };
