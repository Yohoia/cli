# 任务管理：本地 Markdown

任务和规格文档存放在 `.scratch/`。

## 文件约定

- 每个功能使用独立目录：`.scratch/<feature-slug>/`。
- 规格文档：`.scratch/<feature-slug>/spec.md`。
- 每张任务单独存放：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号。
- 分类状态写在任务文件顶部的 `Status:` 行，取值见 `triage-labels.md`。
- 评论和讨论追加到文件末尾的 `## Comments` 下。

## 技能操作对应关系

- “发布到任务管理系统”：按上述路径创建对应文件。
- “获取相关任务”：读取用户提供的路径；仅有编号时，在对应功能目录中查找。

## Wayfinder 操作

- 工作地图：`.scratch/<effort>/map.md`，包含 Notes、Decisions-so-far 和 Fog。
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`，正文记录待回答的问题。
- 类型：顶部 `Type:` 行，取值为 `research`、`prototype`、`grilling` 或 `task`。
- 依赖：顶部 `Blocked by: NN, NN` 行；全部依赖为 `resolved` 时解除阻塞。
- 下一任务：按编号选择尚未解决、未被认领且没有阻塞的任务。
- 认领：开始工作前，将 `Status:` 设置为 `claimed` 并保存。
- 解决：在 `## Answer` 下追加答案，设置 `Status: resolved`，
  并在地图的 Decisions-so-far 中追加结论摘要和任务链接。

`claimed` 和 `resolved` 是 Wayfinder 的执行状态；普通任务分类使用默认五种状态。
