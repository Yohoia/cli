import type { CommandResult } from "./program.js";
import { renderTable } from "./table.js";
import type { SkillItem } from "../skills/model.js";

const skillStatuses = {
  available: "可安装",
  unavailable: "不可用",
  registered: "已登记",
  removed: "已移除",
  installed: "已安装",
  updated: "已更新",
  unchanged: "无变化",
  skipped: "已跳过",
  failed: "失败",
} satisfies Record<SkillItem["status"], string>;

function skillLocation(item: SkillItem): string {
  if ("path" in item) return item.path;
  return (
    item.targets
      ?.map(
        (target) =>
          `${target.installed ? "✓ 已安装" : "未安装"}\n${target.path}`,
      )
      .join("\n\n") ?? ""
  );
}

export function renderText(
  result: CommandResult,
  width = process.stdout.columns ?? 100,
): string {
  switch (result.kind) {
    case "skills": {
      const table = result.data.items.length
        ? renderTable<SkillItem>(
            result.data.items,
            [
              {
                heading: "Skill",
                maxWidth: 26,
                value: (item) => item.name ?? "未确认",
              },
              { heading: "来源", maxWidth: 36, value: (item) => item.repo },
              {
                heading: "状态",
                maxWidth: 8,
                value: (item) => skillStatuses[item.status],
              },
              {
                heading: "说明",
                maxWidth: 60,
                value: (item) =>
                  [item.description, item.message].filter(Boolean).join("\n") ||
                  "—",
              },
              ...(result.data.items.some((item) => skillLocation(item))
                ? [{ heading: "安装位置", maxWidth: 48, value: skillLocation }]
                : []),
            ],
            width,
          )
        : "暂无 Skill 条目";
      const count =
        result.data.operation === "list"
          ? `已知 Skill 数：${result.data.total}；当前可获取：${result.data.available}；未确认来源：${result.data.unknown}`
          : `条目数：${result.data.total}`;
      return table + "\n" + count + "\n";
    }
    case "list": {
      const table = result.data.items.length
        ? renderTable(
            result.data.items,
            [
              {
                heading: "文章 ID",
                maxWidth: 36,
                value: (item) =>
                  item.shortId ? `${item.shortId}\n${item.id}` : item.id,
              },
              { heading: "标题", maxWidth: 64, value: (item) => item.title },
              {
                heading: "状态",
                maxWidth: 8,
                value: (item) => (item.status === "draft" ? "草稿" : "已发布"),
              },
              {
                heading: "发布时间",
                maxWidth: 24,
                value: (item) => item.publishedAt ?? "未发布",
              },
              { heading: "版本", maxWidth: 24, value: (item) => item.revision },
            ],
            width,
          )
        : "暂无文章";
      return `${table}\n本页 ${result.data.items.length} 篇 · ${result.data.nextPage === null ? "已到末页" : `下一页：${result.data.nextPage}`}\n`;
    }
    case "show":
      return `${result.data.title}\nID：${result.data.id}\n短 ID：${result.data.shortId ?? ""}\n状态：${result.data.status}\n版本：${result.data.revision}\n${JSON.stringify({ ...result.data, content: undefined }, null, 2)}\n\n${result.data.content}\n`;
    case "auth":
      return result.data.authenticated
        ? `已授权 ${result.data.name}\n服务：${result.data.server}\n到期：${result.data.expiresAt}\n`
        : `设备授权已撤销：${result.data.server}\n`;
    case "config":
      return `默认服务：${result.data.server}\n`;
    case "delete-preview":
      return `删除预览（尚未删除）\n${result.data.title}\nID：${result.data.id}\n状态：${result.data.status}\n版本：${result.data.revision}\n`;
    case "write":
      return `${result.data.changed ? "操作已完成" : "未修改"}：${result.data.article.title}\nID：${result.data.article.id}\n状态：${result.data.article.status}\n版本：${result.data.article.revision}\n请求编号：${result.data.requestId}\n`;
    case "operation": {
      const operation = result.data;
      if (operation.status === "succeeded")
        return renderText(
          {
            kind: "write",
            data: { requestId: operation.requestId, ...operation.result },
          },
          width,
        );
      return operation.status === "pending"
        ? `操作仍在处理中：${operation.requestId}\n`
        : `操作失败：${operation.requestId}\n${operation.error.code}：${operation.error.message}\n`;
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
