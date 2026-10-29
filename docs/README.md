# 文档索引

命令使用和安装方法见[中文 README](../README.zh-CN.md)或[English README](../README.md)。目录职责与命名约定见[项目结构](structure.md)。

## 当前有效规格

| 范围                     | 规格与说明                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 博客、设备授权与文章上传 | [远程博客管理规格](../.scratch/remote-blog-management/spec.md)                                                                |
| Skill 来源、安装与更新   | [Codeup 来源切换](../.scratch/codeup-skill-source/spec.md)，其余行为见 [Skill 管理规格](../.scratch/skill-management/spec.md) |
| Skill 卸载               | [卸载规格](../.scratch/skill-uninstall/spec.md)，包括保留来源登记和终端多选                                                   |
| Skill 更新提示           | [更新提示规格](../.scratch/skill-update-notice/spec.md)，包括版本标识、逐目标检测和 Mole 风格提示                             |
| 交互入口                 | [Mole 风格交互规格](../.scratch/mole-interactive/spec.md)                                                                     |
| CLI 展示                 | [样式设计](../.scratch/cli-style/design.md)、[UI 迁移记录](../.scratch/cli-style/migration.md)                                |
| npm 分发与环境诊断       | [分发规格](../.scratch/npm-distribution/spec.md)、[安装与发布指南](distribution.md)                                           |

规格与任务按[本地任务约定](agents/issue-tracker.md)保存在 `.scratch/`。验收记录保留当时的版本、命令及文件路径；当前路径以项目结构和源码为准。

## 领域与架构决策

- [领域术语](../GLOSSARY.md)
- [JSON 输出通道](adr/0002-json-results-on-stdout.md)
- [远程文章库作为权威来源](adr/0003-manage-authoritative-remote-articles-through-api.md)
- [设备授权](adr/0004-authorize-cli-devices-through-pagehush.md)
- [服务端写入保护](adr/0005-enforce-remote-write-guards-on-server.md)
- [正文内嵌图片上传](adr/0006-upload-inline-images-through-pagehush-assets-api.md)
- [Skill 更新与逐目标恢复](adr/0007-keep-skill-updates-authoritative-per-target.md)

## 历史资料

- [启动时的架构方案](archive/cli-architecture-guide.md)和[仓库调研](archive/cli-architecture-research.md)：候选技术与设计取舍，不作为当前实现要求。
- [首个本地博客里程碑](../.scratch/cli-design/spec.md)和[本地文章编辑规格](../.scratch/blog-authoring/spec.md)：由远程博客管理替代。
- [首个里程碑审查](reviews/first-milestone.md)和[本地文章编辑审查](reviews/blog-authoring.md)：对应历史版本。
