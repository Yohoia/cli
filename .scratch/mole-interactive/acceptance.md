# Mole 交互入口验收

版本：0.7.0。日期：2026-10-28。

- 样式依据：本机 Mole 1.64.0 与用户提供的 120×30 主菜单/选择列表截图。绿色 ASCII Yoho、青色焦点、紫色标题、圆圈多选、底部快捷键；终端字体和背景由用户环境决定。
- 代表状态的真实 PTY 单元格屏幕：`artifacts/cli-style/mole-interactive/final-shots/`，包含首页、Blog 多选、Skill 列表。预览 HTML 与原始终端字节保存在同级目录。
- 参考比较：`artifacts/cli-style/mole-interactive/reference-comparison/`。参考含系统窗口边框且内容不同，像素差异不作为相同内容的逐像素还原证明。
- 视觉独立复核 `/root/mole_visual_review`：最终通过，确认配色、状态、对齐与底部快捷键符合参考。第一条底部坐标判断经重看当前截图后撤回。
- UX 独立走查 `/root/mole_ux_review`：120×30 和 60×24 均从入口完成查看 Skill、选择范围/目标、安装、返回及退出；实际文件和列表状态可观察。发现安装范围路径尾部截断，改为菜单上方完整换行后，经 60×24 实际复核通过。证据保存在 `artifacts/cli-style/mole-interactive/ux-review/`。
- 交互专项：7/7 通过。覆盖主菜单、Skill 安装/取消/卸载/来源、即时搜索选择范围、Blog 批量删除默认取消、中文空格路径创建与发布、显式服务器覆盖、非终端/JSON、Ctrl+C 和终端恢复。
- 同步反馈：焦点和选择即时原地重绘、搜索即时更新列表、操作中显示可取消 spinner；不添加与 Mole 参照无关的过渡动画。
- 取证工具提示“页面文件较大/超长行”源于逐终端单元格生成 span 的证据格式，不是交付网页；检查无横向溢出、图片失败或控制台错误。
- 完整命令模式继续保留 Ink/Clack 与 JSON 通道。用户要求暂缓的三个审查问题未纳入本次修复。

## 最终检查

- `pnpm check`、`pnpm format:check`、`git diff --check` 通过。
- `pnpm test` 完整回归 146/146 通过，记录在 `.cache/mole-interactive-final-regression.log`；随后新增的交互上传/发布专项通过。最终 7 项交互专项在完整路径展示修正后连续三轮 7/7 通过，记录在 `.cache/mole-interactive-repeat-1.log` 至 `-3.log`。
- 0.7.0 安装包为 `artifacts/yoho-cli-0.7.0.tgz`；已离线替换 `/Users/yohoia/.local` 的现有全局安装。5 个 dist 文件与工作区逐字节匹配，项目外版本/帮助通过，120×30 真实 PTY 验证无参数入口、Q 退出和终端恢复。记录在 `artifacts/cli-style/mole-interactive/global-terminal.json`。

## 0.7.1 搜索与底部工具栏

- 读取本机 Mole 1.64.0 的真实搜索头部与颜色定义：搜索使用黄色 ANSI 33，灰色使用 `0;38;5;244`。Yoho 搜索改在顶部替换标题，以 `_` 提示输入位置，显示匹配/总数与选择数；搜索工具栏使用 Enter Apply、Backspace、Ctrl+U Clear、Esc Clear。全部页面的工具栏共用同一灰色。
- 真实 PTY 对照：在隔离 HOME 和 Codeup 夹具中分别运行 Yoho 及 Mole 的实际多选组件，120/60 列的空搜索、输入、应用、清除均 code 0、pending 为空。Mole 只接收固定 Skill 行，不读取或操作真实应用。实际屏幕与截图位于 `artifacts/cli-style/mole-search-toolbar/`；已实际查看宽窄屏结果。
- 类型、结构、格式与 diff 检查通过，相关 CLI 测试 16/16 通过，覆盖搜索颜色、计数、清空/应用、窄屏及既有命令。记录为 `.cache/mole-search-toolbar-cli-tests.log`。此轮没有结构调整，未重跑无改动的远程与 Skill 业务全量回归。
- 已离线更新本机安装到 0.7.1，发行包为 `artifacts/yoho-cli-0.7.1.tgz`，5 个 dist 文件与工作区逐字节一致。
- 取证 HTML 文件较大仍源于按终端单元格保存 span；此为过程证据。此次为明确指定样式的小改，主代理对比实际画面自检，未另派独立评审。
