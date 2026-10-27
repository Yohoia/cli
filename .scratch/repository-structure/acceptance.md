# 目录与命名整理验收

日期：2026-10-26。版本：0.6.5。整理范围见[规格](spec.md)，当前导航见[项目结构](../../docs/structure.md)。

## 验证结果

- 类型与结构检查、项目格式检查及 `git diff --check` 通过。
- 迁移前后测试标题及模板的多重集合完全相同；原审查回归已分入对应功能测试。
- 定向回归 18 项通过；迁移后的 `pnpm test` 完整执行 112 项，全部通过，零失败、零跳过。
- 对照本机上一版 0.6.4，10 个命令路径的帮助输出及退出码逐字节一致。
- 本地 Markdown 链接检查覆盖根 README、AGENTS 及 docs 文档，链接目标均存在。
- 结构检查已通过反例验证：临时错误命名文件和 Skill 对远程博客模块的错误依赖均被拒绝；临时探针已清理。
- 固定后端准备脚本从新 helper 位置正常运行，并复用原固定版本检出。测试继续使用安装包、隔离配置和临时 Skill，未操作真实 Skill。

## 主要位置变化

| 原位置 | 当前位置 |
| --- | --- |
| `remote/config.ts` 中的公共目录函数 | `src/core/paths.ts` |
| `skills/github.ts` 中的元数据解析 | `src/skills/manifest.ts` |
| `skills/commands.ts` 与 `cli/program.ts` 中的命令注册 | `src/cli/commands/` |
| `cli/output.tsx` 中的功能展示 | `src/cli/views/` |
| `skills/interaction.ts` | `src/skills/install-selection.ts`、`installed-status.ts` |
| `remote/models.ts` | `src/remote/model.ts` |
| 平铺测试与辅助程序 | `tests/cli/`、`remote/`、`skills/`、`helpers/` |
| `docs/guide.md`、`docs/research.md` | `docs/archive/cli-architecture-guide.md`、`cli-architecture-research.md` |

## 安装包

`artifacts/yoho-cli-0.6.5.tgz` 的 SHA-256：

`c378003ac374a714f6f55ac88196214fd926c3af7d4c146cbea7401b713b7d59`。

已离线更新本机用户级全局命令，`yoho --version` 返回 `0.6.5`。尚未执行 Git 提交、推送、GitHub Release 或 npm 发布。
