# 分发与版本发布

Yoho 的 npm 包名是 `@yohoia/cli`，命令名是 `yoho`，使用 MIT 许可证。用户需要 Node.js 24+，不需要 pnpm、TypeScript 或源码。Git 和 OpenSSH 仅用于 Skill 来源访问；PageHush 设备授权在用户运行 `yoho auth login` 时完成。

当前仓库准备首个 npm 版本 `0.8.0`。首次发布完成之前，npm 安装命令尚不可用，可以使用源码构建的 tarball。正式发布以 [npm 包页面](https://www.npmjs.com/package/@yohoia/cli)和 [GitHub Releases](https://github.com/Yohoia/cli/releases) 为准。

## 用户安装与升级

```bash
npm install --global @yohoia/cli@latest
yoho --version
yoho doctor
yoho
```

再次执行同一条安装命令即可升级。临时运行与固定版本安装：

```bash
npx --package=@yohoia/cli@latest yoho
npm install --global @yohoia/cli@0.8.0
```

没有系统目录写权限时，优先使用 Node.js 版本管理器，或明确指定用户前缀：

```bash
npm install --global --prefix "$HOME/.local" @yohoia/cli@latest
```

将 `$HOME/.local/bin` 加入 shell 的 `PATH`。升级、卸载时使用相同的 `--prefix`，不要混用不同安装前缀。

从旧包名 `yoho-cli` 迁移时，先释放已有的 `yoho` 命令：

```bash
npm uninstall --global yoho-cli
npm install --global @yohoia/cli@latest
yoho --version
yoho doctor
```

这只替换 CLI 安装。`~/.config/yoho`、`YOHO_CONFIG_DIR` 指定的配置目录、系统凭据和已安装 Skill 不需要迁移。自定义 npm 前缀的旧安装必须在原前缀下卸载。

卸载新包：

```bash
npm uninstall --global @yohoia/cli
```

## GitHub Release 安装包

从对应版本的 Release 下载 `yohoia-cli-<version>.tgz` 和 `SHA256SUMS`，在下载目录验证校验值后安装。例如 `v0.8.0`：

```bash
# macOS
shasum -a 256 -c SHA256SUMS
# Linux 对应命令：sha256sum --check SHA256SUMS
npm install --global ./yohoia-cli-0.8.0.tgz
```

升级时下载新版本并安装其 tarball。安装包仍需要 Node.js；它不是独立可执行文件。当前完整验收目标为 macOS，Linux 和 Windows 的安装兼容性尚未宣称通过。

## 环境诊断

```bash
yoho doctor
yoho doctor --json
yoho --server https://pagehush.example doctor
```

检查内容包括 Node.js 版本、Git、OpenSSH、Codeup SSH 选择和 PageHush 地址配置。Git/SSH 缺失、明确指定的私钥不可读、地址或配置无效会返回退出码 2；待验证的 SSH 权限只产生警告，其他检查通过时仍返回 0。

诊断不连接远程服务、不执行 `GIT_SSH_COMMAND`、不读取私钥内容或设备令牌，也不创建缓存或配置。SSH agent/仓库权限需要运行 `yoho skill list` 验证；服务可达性和设备授权通过 `yoho auth login`、`yoho auth status` 及实际文章命令验证。地址检查通过不代表服务在线或设备已获授权。

JSON 成功时使用 `ok: true` 和 `data.healthy/checks`；失败时使用 `ok: false`、`error.code: ENVIRONMENT_CHECK_FAILED`，并在 `data.checks` 保留全部结果。取消使用退出码 130。

## 本地构建与发布前验证

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm test:prepare
pnpm test
pnpm release:pack v0.8.0
pnpm release:verify artifacts/release/yohoia-cli-0.8.0.tgz
npm publish ./artifacts/release/yohoia-cli-0.8.0.tgz --dry-run --ignore-scripts --access public
```

`release:pack` 校验包元数据和标签后重新构建，将发布文件复制到临时目录、统一文件权限，再使用 `npm pack --ignore-scripts` 创建最终 tarball，检查内容白名单并生成 `SHA256SUMS`。统一权限避免本地和 CI 的文件权限差异改变安装包校验值，不会改动源文件权限。标签省略时仅准备本地包；GitHub 标签运行会自动读取标签。脚本拒绝标签与 `package.json` 版本不一致的发布。

`release:verify` 使用临时 npm 缓存、安装前缀和配置，实际检查全局安装、离线 npx、版本升级、旧包名迁移及卸载。版本升级和迁移的旧包夹具使用当前完整构建内容配合旧版元数据，验证 npm 的包与命令替换；历史业务行为仍由完整回归覆盖。脚本不会替换开发者的全局 CLI 或实际配置。

## npm 账号的一次性准备

维护者需要拥有 npm 的 `yohoia` 用户/组织命名空间和发布权限。GitHub 用户名不会自动授予同名 npm 命名空间权限。

首次创建包时，在已验收的工作区由维护者登录 npm，发布已验证的同一个 tarball：

```bash
npm login
npm whoami
npm publish ./artifacts/release/yohoia-cli-0.8.0.tgz --access public --ignore-scripts
```

这一步会真实公开发布，不能用本地 dry-run 代替。账号登录、2FA 和首次发布由维护者完成；仓库不保存 npm Token。

包创建后，在 npm 包设置的 **Trusted Publisher** 中选择 GitHub Actions，并配置：

| 字段                      | 值                               |
| ------------------------- | -------------------------------- |
| Organization or user      | `Yohoia`                         |
| Repository                | `cli`                            |
| Workflow filename         | `release.yml`                    |
| Environment               | 留空；工作流没有配置 environment |
| Allowed actions（如显示） | 允许 `npm publish` 直接发布      |

OIDC 使用 GitHub 托管 runner。当前 npm 文档要求 npm CLI 至少 11.5.1、Node.js 至少 22.14.0；工作流使用 Node.js 24 自带的兼容 npm。无需设置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub Node.js 包发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)。

## 日常自动发版

版本变更通过普通代码提交完成。更新 `package.json` 的版本及文档中的版本示例，检查通过后，在对应提交上创建并推送匹配标签：

```bash
# 示例：版本已更新到 0.8.1，并完成提交与推送
git tag v0.8.1
git push origin v0.8.1
```

`.github/workflows/release.yml` 按顺序执行：

1. 调用 `ci.yml`：macOS 上安装锁定依赖、检查、准备固定后端、完整回归、打包及安装验证。
2. 将 tarball 和 SHA256 校验文件作为 Actions artifact 传递；发布 runner 校验后，用 OIDC 向 npm 发布同一份 tarball。
3. npm 发布成功后创建 GitHub Release，附上同一份 tarball 和校验文件。使用 `v0.9.0-beta.1` 这类预发布标签时，npm 使用 `next`，GitHub Release 标记为预发布。

构建/验收任务只有仓库读取权限，npm 发布任务单独获得 `id-token: write`，最后的 Release 任务单独获得 `contents: write`。发布任务不安装依赖、不执行包脚本。

如果首次手动发布或前次运行已完成 npm 发布，重跑只在已发布 `dist.integrity` 与当前 tarball 的 SHA512 完全一致时跳过 npm 步骤，再补齐 Release。相同版本内容不一致时必须使用新版本，不能覆盖；网络/认证等注册表查询错误也不会被当作“尚未发布”。

不要移动已发布的版本标签。Homebrew 配方和独立可执行文件不在本次分发范围。
