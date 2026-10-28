# 项目结构与命名

项目保持单包结构，源码按运行入口、命令适配、终端展示和业务功能划分。

```text
src/
  bin/cli.ts                可执行入口、进程信号、JSON 通道与退出码
  cli/
    program.ts              根命令装配与参数解析
    result.ts               命令结果类型
    commands/               auth、blog、config、skills 命令注册
      context.ts            命令共享选项与执行上下文类型
    views/                  auth、blog、skill 的终端展示
    interactive/            Mole 风格菜单、列表、键盘与业务命令适配
    output.tsx              展示分发与文本渲染入口
    presentation.tsx        共享样式、布局与进度展示
    table.tsx               通用终端表格
  core/                     公共错误、配置路径与进度协议
  remote/                   PageHush 客户端、授权、文章上传与操作恢复
  skills/                   来源、安装、发现、更新、卸载与状态存储
    manifest.ts             SKILL.md 元数据解析
    installed-status.ts     目录占位及已安装状态
    install-selection.ts    安装交互
    update-selection.ts     更新交互
    uninstall-selection.ts  卸载交互
tests/
  cli/                      输出、表格及终端生命周期测试
  remote/                   远程博客、授权及测试后端校验
  skills/                   Skill 功能与恢复测试
  helpers/                  安装包运行器、隔离服务、PTY 与固定后端清单
scripts/                    构建、测试后端准备与结构检查
docs/                       当前文档入口、项目结构、ADR 与历史资料
.scratch/                   按功能保存的规格、任务及验收记录
patches/                    依赖补丁及其说明
```

## 命名约定

- 源码、测试辅助程序和脚本使用小写短横线命名，例如 `installed-status.ts`。
- JSX 组件文件使用 `.tsx`，其他 TypeScript 源码使用 `.ts`。文件名保持小写，组件名采用 PascalCase。
- 每个业务目录的模型入口统一命名为 `model.ts`，包含对应 Schema 与派生类型。
- 测试按行为命名并使用 `.test.mjs`，例如 `tests/skills/update-safety.test.mjs`。审查来源记录在验收文档中，测试文件按它保护的行为归类。
- 测试目录已经表达业务范围，文件名使用 `install.test.mjs`，不重复添加 `skill-` 前缀。
- `package.json`、`AGENTS.md`、`README.md` 和 pnpm 补丁文件等工具约定名称沿用原格式。

## 职责边界

命令注册集中在 `cli/commands/`，业务能力保存在 `remote/` 和 `skills/`。命令处理器负责参数解析与流程编排，展示组件放在 `cli/views/`，公共样式由 `presentation.tsx` 提供。

`core/` 保存跨功能能力，依赖方向指向它。公共配置目录位于 `core/paths.ts`；服务器地址配置属于 `remote/config.ts`。Skill 状态存储直接使用公共路径，不经过远程博客模块。Skill 的选择器与业务模块就近存放，可复用 CLI 展示工具。

`skills/codeup.ts` 通过 Git + SSH 获取 Codeup 固定提交及内容，管理按来源隔离的 bare Git 缓存；`skills/manifest.ts` 解释 `SKILL.md`，本地发现与远程获取共同调用解析器。

## 检查与测试

`pnpm check` 执行类型和结构检查。结构检查覆盖源码、测试及脚本的文件命名、测试位置、静态相对导入，以及 core、remote、skills 的部分依赖边界。它不替代代码审查。

```bash
pnpm test:prepare
pnpm test
# 单独执行某一功能的测试
pnpm test:file tests/skills/update.test.mjs
```

完整测试入口显式覆盖 `tests/cli/`、`tests/remote/` 和 `tests/skills/`。新增测试归入其中一个目录；新增测试分组时同时更新 `package.json` 的测试入口和结构检查。

生成的后端检出、发行包和构建产物分别保存在 `.cache/`、`artifacts/` 和 `dist/`，由 Git 忽略。长期文档从 `docs/README.md` 导航，早期探索资料保存在 `docs/archive/`。

测试后端在准备时清理旧产物，按固定锁文件安装依赖并构建，再保存构建校验记录。启动测试时同时核对 Git 提交、干净工作树、锁文件、Node 版本、构建命令、加载器与共享包完整产物；旧缓存缺少记录或内容发生变化时，需要重新运行 `pnpm test:prepare`。正常缓存可复用，`--offline` 准备要求依赖包已在 npm 缓存中。
