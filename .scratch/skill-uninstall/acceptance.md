# Skill 删除验收

日期：2026-10-25。版本：0.6.0。

- 新增 yoho skill uninstall，remove 为别名；支持多选、多个名称、owner/repo、--all、--yes、--dry-run。删除本地文件、安装记录与来源，来源只在对应位置全部成功后移除。
- 7 项安装包 CLI 新回归通过，覆盖全部已记录位置、当前项目和用户标准目录的可识别手动副本、其他项目记录、离线、只读预览、确认/取消、多选、未知与歧义来源、全部删除后不重新播种默认来源、缺失目录清理、权限失败和重试、链接与中断备份保护。
- pnpm test 全量 101/101 通过，无失败、取消或跳过。最后整理预览文案后，删除/共享表格/终端生命周期的 12/12 针对性回归通过。pnpm check、pnpm format:check、git diff --check 通过。
- artifacts/skill-uninstall-0.6.0.png 为真实安装包 80 列终端输出的单元格预览，已实际查看，路径与状态可读，无裁切；不是原生 Terminal 截图。交互式 50 列多选与取消另由真实 PTY 验证。
- 已离线安装用户级全局 0.6.0。在 /tmp 验证版本、uninstall 帮助及真实已安装 README Skill 的 --dry-run --json；只读预览准确定位 ~/.codex/skills/yoho-standard-readme，没有删除真实 Skill。全局 ESM 入口和全部 chunks 与验证构建逐字节一致。
- 发行包 artifacts/yoho-cli-0.6.0.tgz SHA-256：f08a5d0903d2b8c03611846cba76f121c4a4bf81ba7b9ca5f56f5362386b3c24。

## 进度样式偏好

用户在实现期间询问是否有其他进度样式。已说明细线、方块和旋转图标加完成数量，并发出偏好选项。尚未收到选择，安装、更新和删除仍沿用共享 Clack 进度组件，不将未确认的推荐当作用户决定。

## 0.6.1：方块进度条

2026-10-26，用户选择方块进度条，替换上一节尚未确认的偏好状态。安装、更新、删除共用 Clack block 样式，保留完成数量和当前 Skill。未知总量阶段仍使用 spinner，JSON 与重定向规则不变。

10/10 项安装包及真实 PTY 针对性检查通过，覆盖方块图形、计数、取消、单 JSON 结果和卸载；类型、格式及 git diff --check 通过。实际 80 列终端预览位于 artifacts/cli-style/preview-0.6.1.png，已查看。此样式调整没有重跑博客全量回归。

已离线升级全局 0.6.1，项目外版本和帮助正常，入口及全部 chunks 与验证构建逐字节一致。发行包 artifacts/yoho-cli-0.6.1.tgz SHA-256：07258892923b3dabd4403faa3b6905ea617fa3c42e5ed42750e6b2454f5725c9。

## 0.6.2：卸载保留来源

2026-10-26：用户明确替换旧语义。uninstall 与 remove 仅删除本地文件和安装记录，来源登记及缓存始终保留；source remove 单独取消登记且保留文件。--all、预览、空安装与重复调用同样不删除来源。

- 移除卸载过程中的来源删除阶段；JSON 兼容字段 removedSources 仍保留，类型固定为空数组。预览 sources 仅表示相关来源。帮助、确认、预览、结果及双语文档同步更新为保留来源。
- 回归验证卸载后来源与元数据逐项不变、list 仍有三个 Skill、speckit 为 not installed，并且无需 source add 即可重新安装；另验证 source remove 保留已安装文件。保留多选/取消、权限失败重试、缺失目录清理、歧义及目录保护回归。
- 52/52 项 Skill、真实 PTY 与共享列表检查通过，无失败、跳过或取消。pnpm check、pnpm format:check、git diff --check 通过。本次未重复运行博客全量回归。
- artifacts/skill-uninstall-0.6.2.png 为真实安装包 CLI 的 80 列预览、卸载结果和随后列表，已实际查看；显示来源保留及三个 not installed。
- 已离线升级全局 0.6.2，验证入口及所有 chunks 与测试构建逐字节一致。在 /tmp 恢复 yohoia/yoho-speckit 来源，真实 skill list 成功展示三项，其中 README 与海报 installed，speckit not installed；没有安装或卸载真实 Skill 文件。
- 发行包 artifacts/yoho-cli-0.6.2.tgz SHA-256：67a867facf9f7f4edbee39c8b2ff6acaafb8eaf3915a6e94b9b6814f8e8aecc9。

## 0.6.3：默认入口为已安装列表多选

2026-10-26。无名称 uninstall / remove 先在本地生成受管安装清单，按 Skill 合并位置并显示数量，通过 Clack 选择一项或多项。仅登记但未安装的来源和不受管的第三方 Skill 不列入；不可用目标禁用并保留原因。空列表直接提示，无选择与确认等待。选择后处理对应的所有位置，来源登记保留。

- 12 项安装包与真实 PTY 针对性检查通过。新增单项选择验证一项的两处目录都被删除、未勾选的 Skill 保留、未安装及第三方项不出现在菜单、来源不变且无需网络；空目录用真实终端验证直接退出及来源不变。原批量、取消、预览、权限失败重试、链接及备份保护继续通过。
- 最后删去菜单重复说明后，9/9 项卸载回归通过；类型、格式和 git diff --check 通过。本次未重跑无关的博客全量回归。
- artifacts/skill-uninstall-0.6.3.png 为真实安装包 80 列终端输出，已查看，包含多选菜单、目录预览、卸载结果和保留来源的后续列表。
- 已离线升级全局 0.6.3，项目外版本正确。真实本机目录只读打开卸载菜单并在选择阶段 Ctrl+C 取消，返回 130，安装配置逐字节保持不变；没有卸载真实 Skill。全局入口与全部 chunks 和验证构建逐字节一致。
- 发行包 artifacts/yoho-cli-0.6.3.tgz SHA-256：af2b67315ccf75322f5166733e002f608ee7f947cd30edeb5ed481a71cdcd10e。
