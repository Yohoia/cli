# Yoho CLI

通过终端或本地产品管理现有博客的 Markdown、MDX 文章。当前支持列出文章、查看完整文章和修改标题、正文。

## 安装

需要 Node.js 24 或更高版本。获得本地打包文件后安装：

```bash
npm install --global ./yoho-cli-0.1.0.tgz
yoho --version
```

安装包已包含运行依赖。本里程碑通过 macOS 验收。

## 管理文章

在博客项目内运行命令，CLI 会从当前目录向上查找博客项目：

```bash
yoho blog list
yoho blog list --status draft
yoho blog show nested/article
yoho blog update nested/article --title '新的文章标题'
yoho blog update nested/article --body-file ./article-body.md
yoho blog update nested/article --title '新的文章标题' --body-file ./article-body.md
```

从其他目录运行时，通过 `--project` 指定博客项目：

```bash
yoho --project /path/to/blog blog list --json
```

文章标识是相对于文章目录的路径，去掉 `.md` 或 `.mdx` 扩展名。修改标题保持文件名、文章标识和访问地址不变。管理列表默认包含草稿、已发布和已归档文章，文章状态不等同于网站公开可见性。

## 程序调用

在业务命令中添加 `--json`。完整参数的调用无需交互。成功和失败各返回一个 JSON 结果到 stdout，诊断日志写到 stderr。

```json
{ "ok": true, "data": { "items": [] } }
```

```json
{
  "ok": false,
  "error": { "code": "ARTICLE_NOT_FOUND", "message": "找不到指定文章：missing" }
}
```

列表结果的 `data.items` 包含文章标识、标题、状态和发布日期。查看结果的 `data` 包含 `id`、`path`、`metadata`、`content` 和 `revision`。更新结果包含 `id`、`title`、`revision` 和 `changed`。

查看文章后，可将 `revision` 原样传给条件更新：

```bash
yoho blog show nested/article --json
yoho blog update nested/article --title '新的标题' --if-match 'REVISION_FROM_SHOW' --json
```

版本过期时返回 `ARTICLE_CONFLICT`，文件保持当前内容。并发 CLI 更新使用文章锁，将版本检查和写入放在同一次操作中。未传 `--if-match` 时，CLI 基于当前文件只修改指定的标题或正文。

## 删除预览

删除前可以核对目标文章、实际位置与当前版本：

```bash
yoho blog delete nested/article --dry-run
yoho blog delete nested/article --dry-run --if-match 'REVISION_FROM_SHOW' --json
```

预览是只读操作，不创建锁、不修改文章或目录。JSON 结果包含 `id`、`path`、`revision`、`dryRun=true` 和 `deleted=false`；文本明确标记尚未删除。`--yes` 与 `--dry-run` 同时使用仍只执行预览。本阶段未接通实际删除，省略 `--dry-run` 会直接报参数错误，无需交互。

预览会验证目标文章及可选的文章版本，拒绝损坏、歧义、越界或包含符号链接的删除路径。它不预留目标；之后实际删除时，调用方需将预览得到的版本传给 `--if-match`，才能确保删除的仍是预览时的文章。

| 退出码 | 含义                             |
| ------ | -------------------------------- |
| 0      | 成功                             |
| 2      | 参数错误或路径越界               |
| 3      | 文章数据错误、标识歧义或版本冲突 |
| 4      | 权限错误                         |
| 5      | 文件读写失败                     |
| 130    | 用户取消                         |

## 内容保护

更新至少提供 `--title` 或 `--body-file`。标题去除首尾空白后必须为非空单行文本。正文输入路径相对于调用命令的当前目录解析，与 `--project` 无关，可以位于项目之外。输入必须是可读取的普通 UTF-8 文件；空文件清空正文，`-` 仅表示名为 `-` 的文件，不读取 stdin。不能把目标文章本身（含指向它的链接）作为正文输入。

CLI 不修剪正文空白、不转换换行或图片路径、不提取正文输入中的 frontmatter，也不修改输入文件。仅修改正文时保留原 frontmatter，必要时在原本位于文件末尾的结束分隔符后加入一行分隔换行。仅修改标题时保留原正文。组合修改一次提交，任一输入无效时整个请求失败。

未知字段、日期、注释和未指定内容保持原样。相同正文及规范化后相同标题不写文件，返回 `changed=false`，版本和修改时间保持不变。CLI 不自动更新文章更新时间。

元数据的语义解析与现有博客使用同一套 `gray-matter` 规则。无法完整表示为 JSON 的非有限数字或循环引用会作为文章数据错误报告，避免静默丢失字段和值。

写入采用同目录暂存文件与原子替换，保留原文件权限，并在写回前再次核对内容。无法单独修改标题而不改变其他元数据时，操作会失败并保留原文件，例如其他字段引用了标题锚点。

列表遇到损坏文章时明确失败。查看和更新只检查目标文章，其他文章损坏不影响正常目标。文章标识及符号链接均受文章目录边界约束。

## 开发与验收

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:file tests/list.test.mjs
pnpm test
pnpm pack --pack-destination artifacts
```

测试通过本地包安装后的真实 CLI 子进程，观察输出、退出码和文件结果。写入测试使用临时副本。

兼容性测试使用相邻 `yoho-blog` 项目的实际内容加载器。若博客位于其他位置，显式指定项目：

```bash
YOHO_BLOG_PROJECT=/path/to/yoho-blog pnpm test
```

兼容性测试显式使用本地内容模式，验证修改后的临时文章能被站点读取。PageHush 同步、文章新增与发布、Skill 管理及公开分发属于后续里程碑。
