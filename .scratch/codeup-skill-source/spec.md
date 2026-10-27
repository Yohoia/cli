# Skill 来源切换到 Codeup

2026-10-26 用户明确要求：CLI 的 Skill 来源、列表、安装和更新统一读取 Codeup，不再读取 GitHub。此规格替代旧 Skill 管理规格中 GitHub 来源及 gh 授权的限定；其余安装、更新、卸载、恢复及 JSON 行为继续遵循原规格。

## 来源与访问

- 初始来源为 `69aa892db28d0aba0f5ed47e/yoho-standard-readme`、`69aa892db28d0aba0f5ed47e/yoho-retro-poster` 和 `69aa892db28d0aba0f5ed47e/yoho-speckit`。
- 接受 Codeup 命名空间/仓库路径、HTTPS 链接、SCP SSH 地址和 `ssh://git@codeup.aliyun.com/` 地址；保留大小写，支持嵌套代码组。拒绝其他平台 URL、凭据、参数、路径越界及选项注入。
- 所有读取使用 Git + SSH，默认发现当前用户 `~/.ssh/github_codeup_sync_ed25519`，也可使用 `YOHO_SKILL_SSH_KEY` 指定私钥，或通过标准 `GIT_SSH_COMMAND` 自定义 SSH 配置。未指定私钥时复用本机 SSH 配置/agent。不会提示输入密码、调用 gh、读取 GitHub Token 或回退 GitHub。
- 默认严格校验 Codeup 主机公钥，不把私钥内容写入配置、缓存、结果或日志。需要 Git 和 OpenSSH。

## 固定提交与缓存

- 每次操作在线确定 Codeup 默认分支最新提交；每个来源在本次操作中只确定一个提交。不能将本地缓存当成已验证的最新内容。
- Codeup 的 Git 服务实测会偶发省略 HEAD。优先使用在线 HEAD 或其符号引用；只有唯一实际分支时，才允许使用该分支的在线提交。多分支且不能确认默认分支时有限重试后报错，不猜测 main，不使用缓存提交冒充最新。
- 使用按来源隔离的 bare Git 缓存及 shallow/partial fetch。列表按需读取根 SKILL.md；安装和更新读取同一提交完整文件树，不受来源 export-ignore/export-subst 配置影响，不 checkout、执行仓库钩子或运行 Skill 脚本。
- 多来源最多四路并发刷新，一个失败不阻断其他来源。缓存元数据继续保留并明确标注不可用。
- 网络失败、权限失败、内容过大、无效元数据及取消均维持退出码契约。取消终止 Git/SSH 子进程并释放操作锁；内容继续经过既有归档边界校验和目标写入保护。

## 本地状态迁移

- skills.json 升级到 version 2。旧三个 Yohoia 来源及所有相应安装记录映射到已确认的 Codeup 镜像，保留实际路径、名称、提交、声明版本和来源移除状态。
- 不清空或重新初始化损坏配置，不重新登记已移除来源，不改动已安装 Skill 文件。
- 未确认 Codeup 对应仓库的旧 GitHub 来源保留身份和缓存并标注待迁移，不猜测仓库映射、不访问 GitHub，也不从该项执行安装或更新。

## 验收

- 通过安装包 CLI、真实 Git 仓库、隔离 SSH 协议边界、本机故障控制服务和真实 PTY 验证。保留全部安装、更新、卸载和博客回归。
- 覆盖旧状态迁移、保留已移除来源、未知旧来源、Codeup URL/嵌套组/大小写、SSH 权限、快照固定、缓存在线校验、完整资源、故障恢复、取消和 gh 不被调用。
- 使用隔离配置进行真实 Codeup 只读列表验证；临时目标可用于显式验收安装与更新，不修改用户原有 Skill 目录。
