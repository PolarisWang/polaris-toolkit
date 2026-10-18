# Changelog

本文件记录面向用户的变更；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-18

### Added

- 能力平面（capability plane）：能力=插件数据（payload × carrier × target × protocol），编制（steward）= 数据记录，
  决策只存在于主管自己的决策树上；新增载体不需要改主管或编排器代码。
- 可观测性：trace / span / effect / intent 四表，追查页（waterfall、为什么、重放、对比、导出）、审计页、体检页（doctor）。
- 面板金字塔布局（结论 → 要我拍板 → 控制 → 设置 → 交办 → 对话 → 正在发生 → 主管 → 能力仓 → 路由 →
  Agent 明细 → 记录 → 审计 → 追查 → 体检 → 维护），含设置表单与 settings.json 全文编辑。
- 交办（tasks 状态机）、和主管对话（chat）、会话明细抽屉、分级授权（L1/L2/L3）、升级退役。
- agent 侧 15 个工具；写操作令牌 x-polaris-token（读接口按设计匿名，见 docs/known-limits.md）。
- 运行态漂移检测：面板琥珀横幅、`polaris_install_stale` 指标、`polaris doctor` 的 install-drift 检查。
- CLI：`polaris install | doctor | token | pack | rollback | release | version`。
- 测试：`node _test/all.mjs`（含面板 vm 冒烟、仓库约定守卫）、覆盖率门槛、GitHub Actions（Linux + Windows）。

### Changed

- 规则引擎（rules/*、wf/defs.js）并入能力平面：5 条内置规则成为判定能力实例，5 个剧本成为计划片段能力。
- 预算只统计真实动作（`store.chargeOf` 的免费 kind 不计入 budgetPerHour）。
- 默认模块不再包含作者机器的绝对路径；DSH 自身目录在运行时推导（`defaultModules()`）。

### Fixed

- 安装器在近乎空的环境变量下不再崩溃；不再产生字面量 `%SystemDrive%` 目录。
- 面板内联 onclick 的函数现在显式挂到 window（IIFE 下曾全部静默失效）。
- steward 工具的输出 render 契约（必须返回 content 块数组）。
- echo 预演不再污染重试计数与并发槽位；授权拦截只记一次；等人回话的会话不再被 steer/cancel。

## [0.2.0] - 2026-10-17

- 大内总管（steward）：agent 观察、模块归类、工作流引擎、审批、飞书通道、导出。
- 工具包核心：令牌、状态版本与保留期、统一指标与调度、capability 注册表、事件总线。

## [0.1.0] - 2026-10-16

- 首个版本：多 feature 宿主插件入口 + Heap Guard（V8 堆监控 / 会话瘦身 / bili 预算）。
