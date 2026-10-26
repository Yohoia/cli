# Ink 与 Clack 迁移

用户已确认采用 Commander、Ink + React + Ink UI、Clack 和已有 string-width；不添加 Chalk 或 Listr2 直接依赖。

## 阶段

1. 已完成：安装固定版本依赖，验证 Node.js 24 的 ESM 打包和离线安装包。
2. 已完成：用 Ink 组件及 Ink UI 主题替换普通列表、详情、状态和错误输出；保留英文表头、installed / not installed、底部 Total 及无标题列表。
3. 已完成：用 Clack 替换手写选择器与加载提示，安装 / 更新执行期间也使用 Clack 进度；同一时刻仅一个渲染器拥有终端。
4. 已完成：验证 JSON 通道、完整参数的非交互执行、来源范围、声明版本、更新逐目标恢复，运行安装包 CLI 与真实 PTY 检查并查看实际画面。
5. 已完成：更新文档、生成发行包并升级用户级全局命令；不提交或推送代码。

## 运行边界

- Commander 继续解析命令，业务层安装和更新语义不改变。
- 普通输出通过 Ink renderToString 渲染 React 树与 Yoga 布局，不创建输入循环。Clack 结束输入与 spinner 后才能开始结果渲染。
- 交互统一使用 stdin / stderr；JSON 始终只向 stdout 写一个结果。非交互完整参数调用不打开选择器。
- 取消仍为 130，不能覆盖真实 Skill 做开发验收；下载、目标权限错误和逐目标恢复仍由现有业务层决定。
- 旧 ANSI 排版及原始 keypress 重绘由新实现接管后移除，不保留两套渲染路径。
- 发行入口改为 ESM，解决 Yoga 顶层 await；验证 bundle 中的 CommonJS 依赖与 WASM 加载。

## 验证记录

- 全量安装包 CLI 回归 94/94 通过，覆盖博客、授权、Skill 来源、安装、更新、恢复、普通输出与 JSON。
- 新增真实 PTY 验证 Clack 到 Ink 的终端交接、进度条取消与锁释放、两处目标的安装及更新计数。
- Clack core 1.5.1 的直接 process.exit 行为由 pnpm 补丁改为 SIGINT，使取消进入业务清理流程；见 patches/README.md。
- 最后一次菜单文案调整后，14 项安装包及真实终端针对性回归全部通过。类型、格式、git diff --check 及 frozen-lockfile 离线安装检查通过。
- 实际终端预览位于 artifacts/cli-style/preview-0.5.0.png，展示真实更新中途 2/3 的进度、列表、无更新、选择、更新结果与错误。独立视觉复核一轮，无影响已确认目标的发现。
- 0.5.0 已离线安装到 ~/.local；项目外版本、帮助及 Skill 列表可用，发行入口与所有 chunks 和验证构建逐字节一致。
