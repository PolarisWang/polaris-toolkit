/**
 * 功能清单：工具包的入口只认这一个数组。新增功能时在这里登记，
 * 其余（挂载、路由前缀、设置、面板卡片、工具注册）都由 host 统一处理。
 */
import heapGuard from "./heap-guard/index.js";

export const FEATURES = [heapGuard].sort((a, b) => (a.order === undefined ? 100 : a.order) - (b.order === undefined ? 100 : b.order));
