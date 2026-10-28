# npm 分发验收

2026-10-28，macOS / Node.js 24.22.1 / npm 11.19.1 / pnpm 11.25.0。包为 `@yohoia/cli@0.8.0`，命令名仍为 `yoho`。

- `pnpm check`：通过类型及结构检查（96 个受检文件）。
- `pnpm format:check`、工作流/发布文档的单独 Prettier 检查、`git diff --check`：通过。
- `actionlint 1.7.12`：两个 GitHub Actions 工作流通过静态检查。
- `npm_config_cache=/var/empty/yoho-cache-repro pnpm test`：155 项通过，无失败、取消或跳过。故意配置不可写的用户缓存，验证安装测试改用独立临时缓存。
- 修改前，同样的不可写缓存配置使诊断测试安装阶段出现 EPERM；隔离缓存后同一命令 4 项全部通过。完整回归首次遇到的 EACCES 也来自用户 npm 缓存，不修改该缓存的所有权或权限。
- `pnpm release:pack v0.8.0`：19 个发布文件，包含完整 ESM 分块、MIT 许可证、两种语言的 README 和配套素材，不含源码、测试或本地工作文件。
- 默认和 `umask 077` 两次打包得到相同 SHA256：`07b6276d6a29fb76d79a5c8372984809077a4e788ed3bc5973695d72e1ba5436`。
- `pnpm release:verify artifacts/release/yohoia-cli-0.8.0.tgz`：全局安装、离线 npx、版本升级、旧包名迁移及卸载通过，配置/安装记录/已有 Skill 文件保留。历史包夹具使用当前完整构建配合旧包名/版本元数据。
- `npm publish <tarball> --dry-run --ignore-scripts --access public`：通过，dry-run 的 SHA512 integrity 与最终 tarball 一致；没有执行真实 npm 发布。
- 诊断探针超时在约 3 秒返回退出码 2，取消约 0.4 秒返回退出码 130；stdout 保留一个完整 JSON 结果。
- 直接执行发布工作流中的 Bash，使用离线 npm 边界夹具验证：新版本进入发布分支；相同内容已发布版本跳过发布；内容不一致、注册表网络失败、校验值错误均停止，不进入发布分支。
- 两种语言 README 的图片/SVG 审计通过；诊断命令的真实 PTY 输出已渲染检查。

安装包和校验文件在 `artifacts/release/`，详细日志与演练结果在 `artifacts/distribution/`，均被 Git 忽略。

实际 GitHub 托管 runner、npm OIDC 授权及线上发布尚未执行。维护者需要确认 npm 命名空间权限、完成首次发布，并按 `docs/distribution.md` 配置 `Yohoia/cli` 的 `release.yml` Trusted Publisher；后续推送匹配版本标签才会触发自动发布。
