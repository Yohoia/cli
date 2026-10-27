import { Box, Text } from "ink";
import { Table } from "../table.js";
import { Section, Note, Metadata, cleanText } from "../presentation.js";
import type { CommandResult } from "../result.js";
const articleLabels: Record<string, string> = {
  id: "ID",
  shortId: "短 ID",
  slug: "地址",
  description: "描述",
  format: "格式",
  status: "状态",
  language: "语言",
  revision: "版本",
  publishedAt: "发布时间",
  recordCreatedAt: "创建时间",
  recordUpdatedAt: "更新时间",
};
const articleStatus = (status: "draft" | "published") =>
  status === "draft" ? "草稿" : "已发布";
type BlogResult = Extract<
  CommandResult,
  { kind: "list" | "show" | "delete-preview" | "write" | "operation" }
>;
export function BlogView({
  result,
  width,
}: {
  result: BlogResult;
  width: number;
}) {
  switch (result.kind) {
    case "list": {
      const drafts = result.data.items.filter(
        (item) => item.status === "draft",
      ).length;
      return (
        <>
          {result.data.items.length ? (
            <Table
              rows={result.data.items}
              width={width}
              columns={[
                {
                  heading: "Title",
                  maxWidth: 64,
                  value: (item) => item.title,
                  tone: "strong",
                },
                {
                  heading: "Status",
                  maxWidth: 8,
                  value: (item) => articleStatus(item.status),
                  tone: (item) =>
                    item.status === "draft" ? "warning" : "success",
                },
                {
                  heading: "Published",
                  maxWidth: 24,
                  value: (item) => item.publishedAt ?? "未发布",
                  tone: "muted",
                },
                {
                  heading: "Article ID",
                  maxWidth: 36,
                  value: (item) =>
                    item.shortId ? `${item.shortId}\n${item.id}` : item.id,
                  tone: "muted",
                },
                {
                  heading: "Version",
                  maxWidth: 24,
                  value: (item) => item.revision,
                  tone: "muted",
                },
              ]}
            />
          ) : (
            <Note>
              暂无文章 · 使用 yoho blog create &lt;文章.md&gt; 上传草稿。
            </Note>
          )}
          <Box flexDirection="column">
            <Note>{`本页 ${result.data.items.length} 篇 · 草稿 ${drafts} · 已发布 ${result.data.items.length - drafts}`}</Note>
            <Note>
              {result.data.nextPage === null
                ? "已到末页"
                : `下一页：${result.data.nextPage} · 使用 --page ${result.data.nextPage}`}
            </Note>
          </Box>
        </>
      );
    }
    case "show":
      return (
        <>
          <Section title={result.data.title} summary="文章详情" />
          <Metadata
            fields={Object.entries(result.data)
              .filter(([key]) => key !== "content" && key !== "title")
              .map(([key, value]) => [
                articleLabels[key] ?? key,
                key === "status"
                  ? articleStatus(result.data.status)
                  : typeof value === "string"
                    ? value
                    : (JSON.stringify(value) ?? "—"),
              ])}
          />
          <Note>正文</Note>
          <Text>{cleanText(result.data.content)}</Text>
        </>
      );
    case "delete-preview":
      return (
        <>
          <Section title="删除预览（尚未删除）" summary={result.data.title} />
          <Metadata
            fields={[
              ["ID", result.data.id],
              ["状态", articleStatus(result.data.status)],
              ["版本", result.data.revision],
            ]}
          />
        </>
      );
    case "write":
      return (
        <>
          <Section
            title={`${result.data.changed ? "操作已完成" : "未修改"}：${result.data.article.title}`}
          />
          <Metadata
            fields={[
              ["ID", result.data.article.id],
              ["状态", articleStatus(result.data.article.status)],
              ["版本", result.data.article.revision],
              ["请求编号", result.data.requestId],
            ]}
          />
        </>
      );
    case "operation": {
      const operation = result.data;
      if (operation.status === "succeeded")
        return (
          <BlogView
            result={{
              kind: "write",
              data: { requestId: operation.requestId, ...operation.result },
            }}
            width={width}
          />
        );
      return (
        <>
          <Section
            title={
              operation.status === "pending" ? "操作仍在处理中" : "操作失败"
            }
          />
          <Metadata
            fields={
              operation.status === "pending"
                ? [["请求编号", operation.requestId]]
                : [
                    ["请求编号", operation.requestId],
                    ["错误", operation.error.code],
                    ["原因", operation.error.message],
                  ]
            }
          />
        </>
      );
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
