import type { CommandResult } from "./program.js";
export function renderText(result: CommandResult): string {
  switch (result.kind) {
    case "skills": {
      const lines = result.data.items.map((item) => {
        const path = "path" in item ? item.path : "";
        const targets =
          "targets" in item
            ? item.targets
                ?.map(
                  (target) =>
                    `${target.path} ${target.installed ? "✓ 已安装" : "未安装"}`,
                )
                .join("；")
            : "";
        return `${item.name ?? item.repo}\t${item.repo}\t${item.status}\t${item.description ?? ""}\t${path}\t${targets ?? ""}\t${item.message ?? ""}`;
      });
      const count =
        result.data.operation === "list"
          ? `已知 Skill 数：${result.data.total}；当前可获取：${result.data.available}；未确认来源：${result.data.unknown}`
          : `条目数：${result.data.total}`;
      return lines.join("\n") + "\n" + count + "\n";
    }
    case "list":
      return `${result.data.items.map((item) => `${item.id}\t${item.shortId ?? ""}\t${item.status}\t${item.publishedAt ?? "未发布"}\t${item.revision}\t${item.title}`).join("\n")}\n${result.data.nextPage === null ? "已到末页" : `下一页：${result.data.nextPage}`}\n`;
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
        return renderText({
          kind: "write",
          data: { requestId: operation.requestId, ...operation.result },
        });
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
