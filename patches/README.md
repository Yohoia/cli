# Clack 取消行为补丁

`@clack/core@1.5.1` 的 `block()` 在进度条接收 Ctrl+C 或 Escape 时直接调用 `process.exit(0)`。这会跳过 CLI 的中止处理和文件恢复，并返回成功退出码。

补丁将该调用改为 `process.emit("SIGINT")`，使现有 AbortController 中止操作，等待目标恢复和锁释放后返回 130。Clack 继续负责显示、键盘读取和终端恢复。`pnpm install --frozen-lockfile` 自动应用补丁，构建后的安装包包含修正，不需要安装时运行脚本。

验收位于 `tests/cli-ui-lifecycle.test.mjs`：通过真实 PTY 在更新进度条中发送 Ctrl+C，验证退出码、原文件及后续更新。升级 Clack 时先检查上游行为，再决定是否删除补丁。
