# 目录与命名整理

日期：2026-10-26。保持单包结构和已确认的命令行为，整理上一轮检查指出的位置及命名问题。

- 公共配置路径放入 `src/core/paths.ts`，Skill 状态不再依赖远程博客配置模块。
- 通用 `SKILL.md` 解析放入 `src/skills/manifest.ts`，本地发现与 GitHub 获取共用解析器。
- 命令注册统一放入 `src/cli/commands/`；根命令装配、结果类型和终端展示分别保留明确入口。
- 终端展示按 Skill、博客和授权划分到 `src/cli/views/`，保持原输出及共享样式。
- 安装选择和安装状态分别命名为 `install-selection.ts`、`installed-status.ts`；业务模型入口统一为 `model.ts`。
- 测试按 cli、remote、skills 分类，辅助程序和固定后端清单放入 helpers；审查回归按保护的行为归类，保留全部用例。
- 历史探索文档移入 `docs/archive/`；增加文档索引、目录约定和当前有效规格导航，更新 `AGENTS.md`。
- 结构检查纳入 `pnpm check`，完整测试入口覆盖迁移后的全部分组。

保留已有未提交功能修复和用户工作区内容。本次不提交、推送或公开发布。
