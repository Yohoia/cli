# Yoho CLI

通过终端或本地产品直接管理 PageHush 远程文章库：列出文章、查看详情、上传 Markdown 草稿、按版本发布、预览并软删除文章，以及查询或恢复写入操作。

PageHush 是文章的唯一权威来源。CLI 0.3.0 替换原有本地文章管理，不再扫描博客目录、修改本地文章，也不提供双向同步。已有文章的正文、标题及元数据修改继续在 PageHush 网页完成。

## 安装并全局使用

需要 Node.js 24 或更高版本。源码开发使用 `pnpm@11.25.0`。在 CLI 项目目录安装依赖、检查并打包，再安装本地包：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination artifacts
npm install --global ./artifacts/yoho-cli-0.3.0.tgz
yoho --version
yoho --help
```

安装包包含运行依赖；安装后可从任意目录使用 `yoho`，不需要位于博客项目中。当前安装验收优先覆盖 macOS。仓库保持私有包配置，没有公开发布到 npm。

远程命令需要配套的 PageHush API 和网页版本。此仓库的实现与隔离验收不表示线上服务已经部署；使用前应先完成相应 PageHush 版本部署核对。

## 服务地址与配置

内置默认服务为 `https://pagehush.yohoia.cn`。可保存一个默认服务，或仅为一次命令覆盖：

```bash
yoho config server https://your-pagehush.example
yoho --server https://your-pagehush.example blog list
```

优先顺序为 `--server`、`YOHO_SERVER`、已保存默认服务、内置默认服务。不支持多个命名 profile。地址规范化为服务 origin，不能包含访问凭据、路径或查询参数；远程服务要求 HTTPS，本机隔离测试允许 HTTP。

| 环境变量          | 用途                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `YOHO_SERVER`     | 覆盖默认 PageHush 服务地址。                                                 |
| `YOHO_TOKEN`      | 提供已有的有效设备令牌，适合非交互脚本；CLI 不将其写入凭据存储。             |
| `YOHO_CONFIG_DIR` | 指定配置和最少操作记录目录。                                                 |
| `XDG_CONFIG_HOME` | 未设置 `YOHO_CONFIG_DIR` 时使用其下的 `yoho` 目录；缺省为 `~/.config/yoho`。 |

不同服务的系统凭据及操作记录相互隔离。切换服务后，需要为目标服务重新授权或提供对应令牌。配置文件和操作记录不保存文章正文、图片字节或访问凭据。

## 设备授权

```bash
yoho auth login
yoho auth status
yoho auth logout
```

`login` 显示设备码与授权网址，并尝试打开浏览器。使用 PageHush 访问码登录网页，核对设备码后批准，终端会等待结果；也可以拒绝授权。浏览器无法自动打开时，手动打开终端显示的网址。远程终端可用：

```bash
yoho auth login --no-browser
```

授权默认有效 30 天，到期重新登录。本期没有自动刷新。设备权限仅覆盖本期文章操作与文章上传所需的内嵌图片上传，不能修改已有正文、撤回发布或独立管理素材。

令牌保存到系统凭据存储：macOS 钥匙串，Linux 使用可用的 Secret Service。存储不可用时明确失败，不降级为明文文件。Linux 和 Windows 尚未纳入本期完整安装验收。

网页的「设备」入口可以查看授权元数据并撤销设备，不显示可复用令牌。`logout` 先撤销服务端授权再移除本机凭据；网络失败等情况不能确认撤销时，会保留凭据供重试。使用 `YOHO_TOKEN` 时，注销仍撤销该令牌，调用方需自行清除环境变量。

## 列表与文章详情

```bash
yoho blog list
yoho blog list --status draft --keyword '命令行' --page 1 --page-size 20
yoho blog list --status published --page 2 --json
yoho blog show 'ARTICLE_UUID'
yoho blog show 'COMPLETE_SHORT_ID' --json
```

列表默认包含未删除的草稿和已发布文章，每页 20 篇。筛选在分页前执行，按服务器记录更新时间倒序稳定排序，并返回下一页信息。当前页不代表完整文章库。

文章身份使用 UUID 或完整短 ID；不接受标题、slug、短 ID 前缀或本地路径作为远程身份。详情返回完整 Markdown、服务器元数据及 `revision`。版本是不透明的服务器比较值，发布和删除时应原样传回。草稿创建时间与首次发布时间分别保留，未发布文章不会被标为已发布。

## 从 Markdown 上传草稿

```bash
yoho blog create ./文章.md
yoho blog create '/absolute/path/含空格的文章.md' --json
```

只接受一个可读的普通 UTF-8 `.md` 文件。相对路径以调用目录为基准；不接受目录批量导入、MDX、标准输入或独立正文参数。源文档与本地图片保持只读，不写入远程标识、不替换源文件中的图片地址。

可以使用普通 Markdown，或包含 YAML frontmatter：

```markdown
---
title: 我的文章
description: 简短介绍这篇文章。
language: zh
---

# 我的文章

文章正文。

![示意图](./images/example.png)
```

仅导入 `title`、`description`、`language`。标题按非空 frontmatter `title`、代码块外首个一级标题、去扩展名文件名依次回退，正文中的标题保留。描述缺省时从正文确定性提取摘要；无法得到摘要时需补充描述。语言支持 `zh`、`en`，默认 `zh`。非法字段类型、空正文、仅空白或只有 frontmatter 会在任何远程上传之前失败。其他元数据会提示未导入，不自动传递日期、状态、标签、主题、封面或 slug。

上传结果始终为草稿，发布是独立命令。每次主动运行 `create` 都新建文章，不按文件路径或内容覆盖已有文章。一次操作的恢复请使用 `resume`，避免把再次 `create` 当成重试。

### 内嵌图片与 MinIO

- 支持标准 Markdown 行内本地图片；相对路径从 `.md` 所在目录解析，允许 `../` 引用。代码块内的图片示例不上传，同一文档重复引用同一张图只上传一次。
- 支持 JPEG、PNG、WebP，单张最多 5 MiB。文档和全部本地图片先预检；缺失、不可读、错误类型、不支持或超限的图片会阻止远程写入。
- 图片通过受设备授权保护的 PageHush 素材 API 上传，由服务器写入 MinIO。CLI 不连接 MinIO，也不需要 MinIO endpoint、对象键或密钥。
- 仅在内存正文中将本地图片改为稳定的 `/v1/assets/<id>/content` 地址。全部图片就绪后才创建草稿；图片失败不会创建部分文章。
- HTTP(S) 图片、已有 PageHush 素材地址和文章内锚点保持原样。不下载远程图，不递归上传本地附件或其他 Markdown 文档；未解决的本地资源链接会阻止提交。
- HTML 图片、引用式图片定义、MDX 组件等不在本期导入范围；不支持的本地资源明确报错，不静默留下损坏链接。
- 服务端处理上传去重及失败素材清理。至少七天后，仍未被引用且属于失败上传流程的素材才可回收；草稿、已提交文章和软删除文章引用的素材继续保留。

## 按版本发布

先查看文章取得当前 `revision`，再发布自己已核对的版本：

```bash
yoho blog show 'ARTICLE_UUID' --json
yoho blog publish 'ARTICLE_UUID' --if-match 'REVISION_FROM_SHOW' --json
```

缺少 `--if-match` 会失败。服务器原子校验版本并统一检查标题、正文和描述；版本过期时不发布，也不覆盖网页的新内容。首次有效发布由服务器记录时间。对匹配版本的已发布文章再次发布返回 `changed=false`，不修改发布时间、版本和更新时间。

CLI 不提供修改已有文章、撤回、归档或恢复操作。这些能力不能通过设备令牌绕过限制调用通用管理接口。

## 预览与软删除

```bash
yoho blog delete 'ARTICLE_UUID' --dry-run --json
yoho blog delete 'ARTICLE_UUID' --yes --if-match 'REVISION_FROM_PREVIEW' --json
```

预览返回标题、状态、版本，并明确没有删除；它不锁定或预留目标。`--dry-run` 与 `--yes` 同时出现时仍只预览。

实际删除必须同时提供 `--yes` 和 `--if-match`。服务器原子验证版本后设置软删除标记，文章从正常列表、详情和博客读取中隐藏，但数据库记录与素材保留。旧版本请求不删除任何内容。CLI 不提供永久删除或恢复。

## 查询和恢复写入结果

每次逻辑写入都有稳定请求编号，成功结果及不确定结果会给出编号。同编号的重放返回原结果；不同内容不能复用同一编号。写入超时后 CLI 先查询服务端结果，不盲目再新建文章。

```bash
yoho blog operation 'REQUEST_UUID' --json
yoho blog resume 'REQUEST_UUID' ./原文章.md --json
yoho blog resume 'PUBLISH_OR_DELETE_REQUEST_UUID' --json
```

恢复文章上传必须提供原 `.md` 文件，文档和所需图片指纹必须与原操作一致；恢复发布或删除不需要文档。已确认成功时返回原结果。结果仍未知时会明确报错并提示查询方式，本地取消不代表远程已回滚。

本地只保存服务身份、请求编号、输入指纹等恢复信息。服务端结果至少保留七天。超过保留期仍不能确认时应人工核对；旧编号不会被静默作为新请求执行。请勿删除操作记录后用新 `create` 冒充同一次重试。

## JSON 输出和退出码

业务命令添加 `--json` 后，成功或失败各向 stdout 输出一个独立 JSON 结果。进度、授权网址和未导入字段提示写 stderr，不污染 JSON。参数完整的业务命令不等待交互；设备授权仍需网页批准，删除确认通过 `--yes` 表达。

```json
{ "ok": true, "data": { "items": [], "nextPage": null } }
```

```json
{
  "ok": false,
  "error": { "code": "REVISION_CONFLICT", "message": "文章版本已变化" }
}
```

| 退出码 | 含义                                     |
| ------ | ---------------------------------------- |
| 0      | 成功                                     |
| 2      | 参数或配置错误                           |
| 3      | 文章数据错误、版本冲突或请求冲突         |
| 4      | 认证、设备授权或权限错误                 |
| 5      | 本地文件、网络、远程 I/O 或结果未知      |
| 130    | 用户取消；已发出的远程写入仍需按编号核对 |

## 从 0.2.0 迁移

本地 `--project`、路径型文章标识、`blog update`、MDX 创建以及本地元数据编辑选项不再使用。旧调用会明确提示迁移，不修改原本的本地文章。保留本地源文档，使用 `blog create <path-to-md>` 上传为新草稿；已有远程文章用 `list` / `show` 查找，正文和元数据在 PageHush 网页编辑。

## 开发与隔离验收

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:file tests/remote-migration.test.mjs
pnpm test
```

CLI 测试将本地包安装到临时目录，并运行真实子进程。远程协议测试通过 HTTP 访问自建的临时 PageHush API，使用隔离数据库、FakeStorage、配置和凭据；不加载生产 `.env`，不连接线上文章库做写入验收。

远程测试默认从相邻 `../PageHush` 使用配套源码和已安装依赖。位于其他位置时指定：

```bash
PAGEHUSH_SOURCE=/path/to/PageHush pnpm test
```

网页设备批准、撤销和冲突保留输入的浏览器验收在 PageHush 项目中执行：

```bash
npx playwright test -c playwright.remote.config.ts
```

PGlite 和单请求协议测试不能代替真实多连接并发证明。服务端原子版本保护、请求去重、文章提交与素材回收竞争需要配套 PageHush 的独立临时 PostgreSQL 验收。所有验收结果仅说明隔离环境下的行为，不表示线上已部署。
