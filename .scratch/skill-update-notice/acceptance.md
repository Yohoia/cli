# Skill 更新提示验收

2026-10-29，版本 `@yohoia/cli@0.8.2`。

- `pnpm check`：类型与结构检查通过（98 个文件）。
- `pnpm format:check`：通过。
- `pnpm test`：161/161 通过，完整覆盖 CLI、远程博客与 Skill 回归。
- `pnpm release:pack v0.8.2`：19 个发行文件，生成规范 tarball 与 SHA256SUMS。
- `pnpm release:verify artifacts/release/yohoia-cli-0.8.2.tgz`：全局安装、离线 npx、版本升级、旧包迁移、卸载以及配置与 Skill 保留通过。
- 120/60 列真实 PTY：更新数量、黄色提示、绿色更新操作、版本变化、确认及更新后清除标识通过；两个安装位置按一个 Skill 计数。
- 语义版本比较涵盖数值大小、`v` 前缀、预发布数字、无效预发布标识、构建元数据与较旧版本。
- 检测不修改已安装文件或为手动安装新建来源关联；范围过滤、来源歧义、无版本提交变化、来源不可用和部分更新失败后保留标识均通过。

详细日志与终端渲染图保存在本机忽略目录 `artifacts/skill-update-notice/`。自动发布与官方 npm 安装的最终结果由 GitHub `v0.8.2` Release 和发布工作流记录。
