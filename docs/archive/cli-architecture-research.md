# TypeScript CLI 架构调研：12 个仓库的设计取舍

> 历史探索资料（2026-10-23），记录项目启动时的候选方案。当前结构与有效规格见[文档索引](../README.md)。

调研时间：2026-10-23

目标：从公开 TypeScript CLI 仓库中提炼适合“博客管理 + Skill 管理 + 本地 AI 调用”的架构，而不是单纯比较命令解析库。

## 结论

最值得你的项目整体参考的是 **AsyncAPI CLI、Astro、Cloudflare Wrangler 和 create-t3-app**：

- AsyncAPI 展示如何让 CLI 与本地 HTTP/API 共用同一套 Domain Services。
- Astro 展示如何把每个命令拆成 `core` 与 `infra`，并按需加载。
- Wrangler 展示如何用统一的 `createCommand` 和 `HandlerContext` 管理配置、日志、API、提示与错误。
- create-t3-app 展示如何通过 `InstallerMap` 组合可扩展的功能安装器，与 Skill 安装非常接近。

Vercel CLI、Shopify CLI 和 Supabase CLI 适合借鉴局部设计：

- Vercel：命令元数据、帮助系统和输出管理器。
- Shopify：oclif 插件体系、非 TTY 规则、JSON Schema。
- Supabase：Effect Layer、统一 Output Service、只依赖接口而不依赖全局进程状态。

Kimi Code、Gemini CLI、Firecrawl CLI 和 MiniMax CLI 代表 Agent 时代的不同接入方式：

- Kimi Code：内嵌完整 Agent Core 和自研 TUI。
- Gemini CLI：可交互 Agent 产品，CLI/Core/Server 分包。
- Firecrawl CLI：CLI + Skills + MCP 三入口。
- MiniMax CLI：小而直接的自定义命令注册表。

针对你的项目，不建议照搬 Kimi 或 Gemini 的完整 Agent 架构，也不建议现在引入 Effect。建议采用：

```text
Commander + Zod
+
Typed Command Definition
+
Domain Services / Ports / Adapters
+
Output Service
+
Tool Registry
```

先把 CLI、AI Tool Schema 和 Skill 安装共享的能力定义做好，再按需增加 MCP。

## 样本总览

| 仓库 | 命令框架 | 代表性架构 | 对你的价值 |
| --- | --- | --- | --- |
| Astro | `yargs-parser` + 自建命令分发 | 每个命令拆为 `core`、`infra`，按需动态加载 | 高，适合本地项目 CLI |
| Vite | CAC | CLI 是配置适配层，底层是 server/builder/plugin engine | 中，适合学习项目控制边界 |
| create-t3-app | Commander + Clack | 每个功能是独立 Installer，最后按选择组合 | 很高，适合 Skill 安装器 |
| Vercel CLI | `arg` + 自建 Registry | 命令元数据与 handler 分离，统一输出管理 | 高，适合大量命令 |
| Wrangler | yargs + 自建 Registry | `createCommand` + `HandlerContext` 依赖注入 | 很高，推荐直接借鉴 |
| AsyncAPI CLI | oclif | CLI 和 Express API 共用 Domain Services | 很高，匹配本地产品调用 |
| Shopify CLI | oclif | BaseCommand、插件包、非 TTY 规则、JSON Schema | 高，适合未来插件生态 |
| Supabase CLI | Effect CLI | Effect Service/Layer、统一输出、渐进迁移 | 中高，借鉴边界，不照搬复杂度 |
| Firecrawl CLI | Commander | CLI、Agent Skills、MCP 配置三入口 | 很高，适合 Agent 接入 |
| Kimi Code | Commander | CLI、Agent Core、TUI、ACP Server 分层 | 中，Agent 产品专用 |
| Gemini CLI | yargs | CLI/Core/A2A/SDK/编辑器插件分包 | 中，Agent 产品专用 |
| MiniMax CLI | 自研 Registry + Parser | 小型 CLI 的轻量结构 | 中，适合理解最小实现 |

## 最值得整体参考的四个仓库

### 1. AsyncAPI CLI：CLI 与本地产品共用 Domain Services

AsyncAPI CLI 的架构文档明确分为：

```text
CLI (oclif)          HTTP API (Express)
       \                 /
        Domain Services
              │
        Domain Models
              │
           Utilities
```

CLI 命令和 HTTP 请求最终都调用同一个业务服务，例如 ValidationService、GeneratorService、ConfigService。服务返回统一的 `ServiceResult<T>`。

这几乎就是你的产品需要的结构：

```text
CLI Adapter ─────┐
                 ├── BlogService / SkillService
本地 AI Tool ────┤
                 │
未来 MCP Adapter ┘
```

值得借鉴：

- CLI 和 API 只做输入适配与响应转换。
- 业务服务不关心调用方来自终端、HTTP 还是 AI。
- 错误类型与返回结构集中在 Domain 层。
- Monorepo 可以让 optimizer、diff 等能力作为独立包发布。

不建议照搬：

- 为了一个本地产品同时维护 Express API 和 CLI。
- 把每个简单函数都包装成 Service 类。
- 如果暂时只有 CLI，不需要在本机额外启动 HTTP Server。

源码：[架构说明](https://github.com/asyncapi/cli/blob/afe4981f249ba6f166b6c6075b0c61a088ada6cb/docs/architecture.md)、[package.json](https://github.com/asyncapi/cli/blob/afe4981f249ba6f166b6c6075b0c61a088ada6cb/package.json)

### 2. Astro：命令的 core/infra 分层与按需加载

Astro CLI 没有使用 Commander，而是用 `yargs-parser` 得到参数，然后通过一个明确的 `resolveCommand` 映射到受限命令集合。

更有价值的是每个命令内部的组织：

```text
src/cli/info/
  core/       业务逻辑与端口
  infra/      文件系统、进程、提示等适配器

src/cli/create-key/
  core/
  infra/
```

CLI 入口只负责：

1. 解析命令。
2. 动态 import 对应模块。
3. 实例化文件系统、进程、提示等 Adapter。
4. 把它们注入 Command Core。
5. 执行并映射退出码。

这种结构很适合博客和 Skill 管理：

```text
blog/create/
  core/create-post.ts
  core/ports.ts
  infra/markdown-store.ts
  infra/git-adapter.ts

skills/install/
  core/install-skill.ts
  core/ports.ts
  infra/http-downloader.ts
  infra/archive-extractor.ts
```

值得借鉴：

- 使用接口或 TypeScript 类型定义端口。
- Infra 可以替换为真实文件系统、测试内存系统或远程实现。
- 命令按需加载，避免启动时 import 整个 CLI。
- 每个命令可以独立测试，不依赖全局 `process` 状态。

需要克制：

- 每个三行命令不必强行创建十层抽象。
- 自建 `switch` 路由适合约十几个顶层命令；深层子命令更多时，Commander 或 oclif 更省维护成本。

源码：[CLI 入口](https://github.com/withastro/astro/blob/6cf3423e4c62af5e54a2676c8304a209ab1e064d/packages/astro/src/cli/index.ts)、[package.json](https://github.com/withastro/astro/blob/6cf3423e4c62af5e54a2676c8304a209ab1e064d/packages/astro/package.json)

### 3. Wrangler：统一命令定义与 HandlerContext

Wrangler 使用 yargs 做底层解析，但大多数命令不直接接触 yargs。它们使用 `createCommand`：

```ts
export const buildCommand = createCommand({
  metadata: {
    description: "Build a Worker",
    status: "stable",
    owner: "Workers: Authoring and Testing"
  },
  behaviour: {
    provideConfig: false,
    suggestSkillsAfterHandler: true
  },
  args: {
    // 类型化参数定义
  },
  validateArgs(args) {
    // 只负责参数组合校验
  },
  async handler(args, context) {
    // 业务调用
  }
});
```

其 `HandlerContext` 提供：

- 已加载的 config。
- logger。
- API 请求函数。
- 分页请求函数。
- confirm / prompt。
- non-interactive / CI 判断。
- 标准错误类型。
- Cloudflare SDK。

这是你的 CLI 应该直接借鉴的模式。博客和 Skill 命令都可以收到统一的 `AppContext`：

```ts
interface AppContext {
  cwd: string;
  config: AppConfig;
  logger: Logger;
  output: OutputService;
  prompts: PromptService;
  fs: FileSystemPort;
  git: GitPort;
  http: HttpClientPort;
  skillRegistry: SkillRegistryPort;
}
```

值得借鉴：

- 命令元数据是单一事实来源。
- yargs/Commander 只存在于适配器层。
- handler 不自己创建客户端、读取全局变量或打印文本。
- 共享行为由 `behaviour` 控制，而不是复制到每个命令。
- 命令可以附带 status、owner、examples、hidden 等元数据。

源码：[命令类型](https://github.com/cloudflare/workers-sdk/blob/5c909cc20a01f7321752c868cf0a9acedcea155d/packages/wrangler/src/core/types.ts)、[命令注册器](https://github.com/cloudflare/workers-sdk/blob/5c909cc20a01f7321752c868cf0a9acedcea155d/packages/wrangler/src/core/CommandRegistry.ts)、[build 命令](https://github.com/cloudflare/workers-sdk/blob/5c909cc20a01f7321752c868cf0a9acedcea155d/packages/wrangler/src/build/index.ts)

### 4. create-t3-app：用 InstallerMap 组合 Skill

create-t3-app 使用 Commander 解析参数，Clack 负责交互，然后用 `InstallerMap` 把每个可选能力映射到独立安装器：

```ts
export const buildPkgInstallerMap = (packages, databaseProvider) => ({
  prisma: {
    inUse: packages.includes("prisma"),
    installer: prismaInstaller,
  },
  drizzle: {
    inUse: packages.includes("drizzle"),
    installer: drizzleInstaller,
  },
  tailwind: {
    inUse: packages.includes("tailwind"),
    installer: tailwindInstaller,
  },
});
```

你的 Skill 管理器可以借鉴这个结构：

```ts
type SkillInstaller = {
  name: string;
  versionRange?: string;
  detect(): Promise<boolean>;
  install(ctx: SkillInstallContext): Promise<void>;
  update?(ctx: SkillInstallContext): Promise<void>;
  uninstall?(ctx: SkillInstallContext): Promise<void>;
};
```

值得借鉴：

- 功能安装逻辑互不依赖。
- 安装器由统一映射组合，不写巨型 `if/else`。
- 支持先选择、后执行，便于 dry-run 和计划展示。
- 有显式 `--CI` / `--default` 路径，避免交互阻塞自动化。

需要改进：

- create-t3-app 的流程主要是一次性生成项目；你的 Skill Manager 还需要锁文件、SemVer、checksums、原子安装、回滚和更新检查。

源码：[主流程](https://github.com/t3-oss/create-t3-app/blob/4709861f7e67a15564c0460c13e7b4b6cfcae40d/cli/src/index.ts)、[CLI 与交互](https://github.com/t3-oss/create-t3-app/blob/4709861f7e67a15564c0460c13e7b4b6cfcae40d/cli/src/cli/index.ts)、[InstallerMap](https://github.com/t3-oss/create-t3-app/blob/4709861f7e67a15564c0460c13e7b4b6cfcae40d/cli/src/installers/index.ts)

## 值得局部借鉴的仓库

### Vercel CLI：命令元数据与 handler 分离

Vercel 的 build 命令拆成两个文件：

- `command.ts`：名称、别名、参数、示例、弃用信息。
- `index.ts`：真正的 handler。

命令注册表通过元数据建立帮助系统，handler 通过统一的 Output Manager 输出内容。

值得借鉴：

- 用声明式对象描述命令。
- 从同一份元数据生成 help、文档、JSON Schema 和 Agent Tool 描述。
- 输出只经过一个 Output Service。
- 命令按业务域分目录。

不要照搬：

- 自行实现完整参数解析器，除非你确实需要 Vercel 那种极端兼容性。
- 把所有命令集中在单个 `index.ts` 中；命令多后应从目录自动发现或模块化注册。

源码：[command.ts](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/build/command.ts)、[handler](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/commands/build/index.ts)、[输出管理](https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/output-manager.ts)

### AsyncAPI 的 ServiceResult

AsyncAPI 用统一 `ServiceResult<T>` 表示业务结果。对你的项目，可以改成更轻的 discriminated union：

```ts
type ServiceResult<T> =
  | { ok: true; data: T; warnings?: Warning[] }
  | { ok: false; error: AppError };
```

CLI 再把这个结果转换成文本或 JSON，本地 AI 则直接消费 JSON。不要让 BlogService 返回已经带 ANSI 颜色的字符串。

### Shopify CLI：插件化与 Agent 友好命令契约

Shopify 的 BaseCommand 统一处理：

- `--json-schema`。
- JSON 输出模式。
- 非 TTY 时必须提供哪些 flag。
- 错误处理和插件错误注册。
- 命令事件与输出模式。
- 帮助信息中的 JSON Schema。

它使用 oclif 的插件包拆分 app、theme、store、Cloudflare 等能力。

值得借鉴：

- 每个命令可以声明自己的输出 Schema。
- 非交互环境必须有明确的行为，而不是等待 prompt。
- 插件错误不能破坏父 CLI。

暂不建议：

- 为个人项目第一版引入 oclif 插件体系。它的安装、版本和加载成本会在命令生态真正形成后才划算。

源码：[BaseCommand](https://github.com/Shopify/cli/blob/2218483c30bcb416604db771857709f8465bac96/packages/cli-kit/src/public/node/base-command.ts)、[CLI package](https://github.com/Shopify/cli/blob/2218483c30bcb416604db771857709f8465bac96/packages/cli/package.json)

### Supabase CLI：Output Service 与 Effect Layer

Supabase 把输出抽象成独立 Effect Service，统一处理：

- text / JSON / stream-json。
- TTY 提示。
- 非交互错误。
- progress、spinner、成功和失败。
- stdout 与 stderr 路由。
- 结构化事件。

命令只依赖 `Output` 接口，不直接使用 `console.log`。

值得借鉴：

- 你需要一个类似的 `CliOutput`，但可以用普通 TypeScript interface 实现。
- 输出格式、颜色、交互性、TTY 检测必须集中管理。
- 本地 AI 调用时默认 JSON，人类使用时默认文本。

不需要照搬：

- 全套 Effect Layer 和函数式错误通道。
- 渐进迁移留下的双二进制兼容层。

源码：[输出服务](https://github.com/supabase/cli/blob/522a516ba1eb582115aa23bd48f01b17791aae94/apps/cli/src/shared/output/output.service.ts)、[根命令](https://github.com/supabase/cli/blob/522a516ba1eb582115aa23bd48f01b17791aae94/apps/cli/src/cli/root.ts)

### Firecrawl CLI：CLI、Skills、MCP 三入口

Firecrawl 使用 Commander 为网页抓取、搜索、研究和远程 Agent 任务提供命令。它也提供：

- `setup skills`：把 Skill 安装到多个 Agent。
- `setup mcp`：配置托管 MCP Server。
- `setup defaults`：设置默认 Web Provider。
- `agent`：提交远程 Agent 任务并轮询结果。

值得借鉴：

- CLI 只负责本机操作和任务控制。
- Agent 推理可以放在服务端。
- Skill 安装要识别不同 Agent 的目录和配置语法。
- 同一功能可以同时拥有 CLI、Skill 和 MCP 三种调用界面。

不要照搬：

- 单个 `index.ts` 中注册大量命令的写法；你的项目应从开始就按领域拆分。
- 直接复制厂商专用的 Agent 配置逻辑。

源码：[CLI 入口](https://github.com/firecrawl/cli/blob/1b8a04f1c56cc1fc28bc4e2cc6ee28b50b26bae0/src/index.ts)、[Agent 命令](https://github.com/firecrawl/cli/blob/1b8a04f1c56cc1fc28bc4e2cc6ee28b50b26bae0/src/commands/agent.ts)、[Skill/MCP 安装](https://github.com/firecrawl/cli/blob/1b8a04f1c56cc1fc28bc4e2cc6ee28b50b26bae0/src/commands/setup.ts)

### Kimi Code：Agent Core 与 TUI 完全分离

Kimi Code 是“Agent 产品”而不是普通服务 CLI：

- Commander 负责入口命令。
- `agent-core-v2` 负责模型、工具、会话、MCP、状态机。
- 自研 `pi-tui` 负责终端渲染。
- `acp-server` 负责编辑器协议。
- `node-sdk` 对外暴露 Agent 能力。
- 原生分发使用 Node SEA。

值得借鉴：

- 会话、工具、权限、渲染不应写进命令 handler。
- 支持 headless 和交互模式。
- 使 Agent Core 可以被 SDK、TUI 和命令行分别调用。

不需要照搬：

- 自研 TUI 渲染器。
- 完整的插件市场、子 Agent、ACP 和沙箱。

源码：[CLI package](https://github.com/MoonshotAI/kimi-code/blob/759958afdfeb0f8c7d09cb03cbc2cf85b6255e9e/apps/kimi-code/package.json)、[入口](https://github.com/MoonshotAI/kimi-code/blob/759958afdfeb0f8c7d09cb03cbc2cf85b6255e9e/apps/kimi-code/src/main.ts)、[Agent Core](https://github.com/MoonshotAI/kimi-code/blob/759958afdfeb0f8c7d09cb03cbc2cf85b6255e9e/packages/agent-core-v2/package.json)

### Gemini CLI：可交互 Agent 的包边界

Gemini CLI 拆成：

- `cli`：yargs、Ink、用户交互。
- `core`：模型、工具、策略、会话。
- `a2a-server`：Agent-to-Agent 接口。
- `sdk`：外部程序调用。
- `devtools`、`vscode-ide-companion`：开发与编辑器入口。

它使用轻量父进程启动实际 CLI 子进程，避免父进程 import 大量依赖；支持 text、JSON 和 stream-json 输出。

值得借鉴：

- 交互 UI 与 Agent 核心分包。
- 结构化 stream 输出。
- 启动前只加载必要依赖。
- 明确区分 headless 与交互模式。

源码：[workspace package](https://github.com/google-gemini/gemini-cli/blob/a713410aba5d594594e20d5c822e3aab8f822089/package.json)、[参数定义](https://github.com/google-gemini/gemini-cli/blob/a713410aba5d594594e20d5c822e3aab8f822089/packages/cli/src/config/config.ts)、[Ink UI](https://github.com/google-gemini/gemini-cli/blob/a713410aba5d594594e20d5c822e3aab8f822089/packages/cli/src/ui/App.tsx)

### MiniMax CLI：小型 CLI 的最小结构

MiniMax 没有使用现成 CLI 框架，自建了一个资源-动作命令树：

```text
src/registry.ts  命令树和注册
src/args.ts      scanCommandPath / parseFlags
src/command.ts   Command 与 OptionDef 类型
src/commands/    每个命令一个模块
```

它使用 Clack 做交互，undici 做 HTTP，Bun 只作为构建工具输出 Node ESM。

值得借鉴：

- 小型 CLI 可以先从简单 Registry 开始。
- 命令定义由路径、描述、options 和 execute 组成。
- 每个命令文件只负责一个业务动作。

需要警惕：

- 自定义 parser 还需要处理短参数组合、`--flag=value`、未知参数、负数和跨平台路径。
- 命令数量增长后，帮助、补全和测试成本会迅速上升。

源码：[入口](https://github.com/MiniMax-AI/cli/blob/38aba5f26173dd1065b115b221d79c9ddd87c6bb/src/main.ts)、[Registry](https://github.com/MiniMax-AI/cli/blob/38aba5f26173dd1065b115b221d79c9ddd87c6bb/src/registry.ts)、[参数解析](https://github.com/MiniMax-AI/cli/blob/38aba5f26173dd1065b115b221d79c9ddd87c6bb/src/args.ts)

## 跨仓库共同规律

### 命令层要薄

成熟项目的命令 handler 通常只做四件事：

1. 把 CLI 参数转换为 typed input。
2. 校验参数组合。
3. 调用 Service / Use Case。
4. 把 Result 和 Error 交给输出层。

文件读写、网络请求、Git 操作、Skill 解压都不应该直接堆在 handler 里。

### 业务逻辑不依赖终端

CLI 和本地 AI 产品需要共用业务逻辑。Domain Service 应保持在 Node 层，不依赖 `process.stdout`、`chalk`、`ora` 或交互 prompt。

### 退出码和输出是协议

对 AI Agent 来说，CLI 的输出是 API。应明确：

- stdout：机器结果。
- stderr：诊断日志。
- JSON envelope：`ok`、`data`、`error`、`meta`。
- 退出码：成功、参数错误、业务失败、认证失败。
- NDJSON：长时间任务和批量结果。

### 命令定义是单一事实来源

一个命令定义最好同时提供：

- 人类使用说明。
- 参数与输出 Schema。
- CLI handler。
- Agent Tool 定义。
- MCP Tool 定义。
- 帮助文本和示例。
- 风险等级。

这样可以避免 CLI 文档、Skill 文档和 MCP Schema 各自漂移。

### 扩展通过注册表，不通过巨型条件分支

推荐注册表：

- `CommandRegistry`
- `ToolRegistry`
- `InstallerMap`
- `AdapterRegistry`

新增博客能力或 Skill 来源时，应注册一个新模块，而不是修改多个 `switch`。

### 重型依赖按需加载

以下能力应动态 import：

- Markdown parser/formatter。
- Git 实现。
- 压缩包处理。
- 搜索索引。
- 浏览器/网络引擎。
- TUI。
- MCP SDK。

这样 `--help`、`--version` 和简单列表命令可以保持快速启动。

## 不建议照搬的设计

### 不要一开始拆成十几个包

你当前最重要的是把边界设计对，而非包数量多。可以先在一个包内创建目录，等本地产品确实需要导入时再拆 workspace package：

```text
packages/
  core/
  tools/
  skill-installer/
  mcp/
```

### 不要第一版就做插件市场

先用静态 `InstallerMap` 或 `ToolRegistry`。等出现第三方贡献者、独立发布周期和版本兼容需求后，再做动态插件加载。

### 不要自己实现完整参数解析器

Astro 和 MiniMax 可以这样做，是因为它们已经把命令集合限制在可控范围。你的命令会持续增加，直接使用 Commander 更省维护成本。

### 不要把 Agent 推理写入 CLI Core

本地产品负责对话和模型调用，CLI Core 负责确定性操作。以后需要 MCP 或其他 Agent 接入时，不应重写 BlogService 或 SkillService。

### 不要直接执行模型生成的 shell 字符串

AI 应生成结构化工具参数，适配器使用 `spawn(command, argsArray)` 调 CLI。这样不经过 shell 解释，参数校验和权限控制也可落地。

## 推荐给你的项目结构

第一阶段使用单包，但保持未来可拆：

```text
src/
  bin/
    cli.ts

  cli/
    program.ts
    commands/
      blog/
        list.ts
        create.ts
        update.ts
        delete.ts
      skill/
        install.ts
        update.ts
        remove.ts
    index.ts

  core/
    blog/
      service.ts
      ports.ts
      types.ts
    skills/
      service.ts
      installer.ts
      registry.ts
      types.ts

  adapters/
    filesystem/
    git/
    http/
    archive/
    keyring/
    prompts/

  output/
    service.ts
    text.ts
    json.ts
    ndjson.ts
    errors.ts

  tools/
    definitions.ts
    registry.ts

  config/
    schema.ts
    load.ts

  app/
    context.ts
```

当本地产品开始直接复用核心能力时，再迁移为：

```text
apps/
  cli/
  local-product/

packages/
  core/
  tools/
  output/
  skill-installer/
  mcp/
```

## 具体的领域模型建议

### Blog

```text
ArticleRepository
MarkdownParser
FrontmatterSchema
ArticleIndex
GitAdapter
PublishService
```

写操作采用临时文件 + rename 的原子写入。删除和发布提供 `--dry-run`。

### Skill

```text
SkillManifest
SkillSource
SkillResolver
SkillDownloader
SkillArchive
SkillInstaller
SkillLockfile
AgentTargetAdapter
```

必须支持 SemVer、checksum、原子安装、失败回滚和版本锁。

### AI Tool Bridge

```text
ToolDefinition
ToolRegistry
CliInvocation
PermissionPolicy
OutputEnvelope
```

本地 AI 只能看到允许暴露的工具；read、write、destructive 权限分开。

## 最终推荐

优先级按以下顺序：

1. 学 **AsyncAPI**：CLI 与本地产品共享 Domain Services。
2. 学 **Wrangler**：命令定义和 `HandlerContext`。
3. 学 **Astro**：`core/infra` 分层和按需加载。
4. 学 **create-t3-app**：可组合 InstallerMap。
5. 学 **Vercel / Shopify**：命令元数据、JSON Schema、非 TTY 和输出规范。
6. 学 **Supabase**：输出服务与接口抽象；先不要引入 Effect。
7. 学 **Firecrawl**：Skills/MCP 接入方式；命令目录要自己模块化。
8. 学 **Kimi / Gemini**：只有以后真正做可交互 Agent 产品时再深入。

你的最佳起点是：

```text
Commander
+ Zod
+ createCommand
+ AppContext
+ Domain Service
+ Ports/Adapters
+ CliOutput
+ ToolRegistry
```

这套方案足够轻，能覆盖博客 CRUD、Skill 安装更新和本地 AI 工具调用，同时不会阻断以后增加 MCP、插件或 TUI。

## 调研方法

- 通过 Firecrawl 搜索和抓取公开仓库页面。
- 直接读取固定提交中的 `package.json`、入口代码、架构文档、命令定义和构建脚本。
- 以源码中可验证的依赖和目录边界为准。
- 不按 Star 排名选型，也不把框架官网宣传当作架构证据。
- 对 Agent 产品的相关结论只采用其公开实现。
