# Codeup Skill 来源改造验收

日期：2026-10-26，macOS / Node.js 24.22.1。

## 实现结果

- Skill 来源、列表、安装与更新均由 `src/skills/codeup.ts` 通过 Git + SSH 读取 Codeup；原 GitHub API 客户端删除，不调用 gh，也不回退 GitHub。
- 初始三个来源指向组织 `69aa892db28d0aba0f5ed47e`。来源解析支持 Codeup HTTPS / SSH 地址、嵌套代码组和大小写。
- 旧 skills.json 升级至 version 2，已确认镜像的来源及安装记录自动迁移，保留已移除来源的状态、安装位置、名称、版本和提交。未知旧 GitHub 来源保留且不可更新，不猜测映射。
- bare Git 缓存按来源隔离；在线读取默认提交、按需读取 SKILL.md，安装时批量获取资源 blob，使用固定提交复制全部文件。保留原归档检查、安装整批回滚、更新逐目标恢复和离线卸载契约。
- 默认使用本机已配置的 `~/.ssh/github_codeup_sync_ed25519`，支持 `YOHO_SKILL_SSH_KEY` 或标准 `GIT_SSH_COMMAND`。默认严格校验 Codeup 主机公钥，私钥内容不进入状态、缓存及结果。

## 自动化验证

- `pnpm check`：类型及结构检查通过，83 个源码/测试/脚本文件。
- `pnpm format:check`：通过。
- `npm_config_cache=/tmp/yoho-codeup-npm-cache pnpm test`：全量 119/119 通过，涵盖 CLI 展示、博客、Skill 安装、更新、卸载、恢复和真实 PTY。
- 其后对真实 Codeup 复测发现的 SSH 路径引用及 HEAD 广告兼容行为补充验证。最终执行 `node --test --test-concurrency=1 tests/skills/codeup.test.mjs tests/skills/boundaries.test.mjs tests/skills/update-selection.test.mjs`：19/19 通过。
- 新覆盖：旧配置及安装记录迁移、未知旧来源阻止联网和更新、来源移除不重播种、嵌套组/大小写/越界 URL、warm list 不重复下载资源、不调用 gh、Git 子进程取消、批量资源下载、可执行位、export-ignore/export-subst 不影响完整复制、真实 Git 符号链接拒绝，以及带空格/引号的配置目录和相对私钥路径。
- Codeup 实测有时省略 Git HEAD；在线符号引用或唯一实际分支可固定提交，多分支无法确认默认分支时有限重试并报错。对应测试同时验证不会用缓存提交冒充最新。

初始完整回归被既有测试后端的缺失依赖和用户 npm 缓存权限影响。只修复生成的测试后端依赖，后续使用独立临时 npm 缓存完成回归，没有修改全局缓存权限或博客业务代码。

## 真实安装包与 Codeup 验证

安装包：`artifacts/yoho-cli-0.6.5.tgz`。具体大小、SHA256 和耗时见 [安装包验收记录](package-verification.json)。

通过临时 npm prefix 安装发行包，使用隔离 HOME、配置与项目目录，以及显式指定的现有 Codeup SSH 密钥，完成：

1. 两次列表均读取三个可用的 Codeup 来源；最终一次验收首次约 2.12 秒，缓存后约 0.74 秒。
2. 三个 Skill 全部从真实 Codeup 安装成功，约 3.43 秒。
3. 修改已安装 SKILL.md、加入本地文件后，在同一来源提交下更新，恢复原文件并删除本地新增文件；其余两项返回 unchanged，约 1.06 秒。
4. 禁用 SSH 后离线卸载全部临时安装成功，来源登记仍为三项。
5. 隔离的 gh 哨兵从未运行。未安装、更新或删除用户原有 Skill 目录。

## 本机交付

通过本地 tarball 离线安装到当前用户 `~/.local` prefix，`yoho` 位于 `~/.local/bin/yoho`，该目录已在 PATH 中。真实本机命令及来源检查见 [本机安装记录](local-installation.json)。

本轮没有提交或推送 CLI 仓库；保留进入本轮时已有的未提交代码与结构调整。
