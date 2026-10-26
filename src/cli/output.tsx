import { Box, Text } from "ink";
import type { CommandResult } from "./program.js";
import { Table, type Column } from "./table.js";
import type { SkillItem, SkillResult } from "../skills/model.js";
import {
  Section,
  Note,
  Metadata,
  Feedback,
  renderUi,
  type Tone,
} from "./presentation.js";
import type { WriteStream } from "node:tty";

const skillTitles = {
  "source-add": "来源已登记",
  "source-remove": "来源已移除",
  refresh: "来源检查",
  install: "Skill 安装结果",
  update: "Skill 更新结果",
  uninstall: "Skill 删除结果",
  "uninstall-preview": "Skill 删除预览",
} satisfies Record<
  Exclude<SkillResult["operation"], "list" | "sources">,
  string
>;
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
const skillStatuses = {
  available: "可用",
  unavailable: "不可用",
  registered: "已登记",
  removed: "已移除",
  installed: "已安装",
  updated: "已更新",
  unchanged: "无变化",
  skipped: "已跳过",
  failed: "失败",
  uninstalled: "已删除",
  planned: "待删除",
} satisfies Record<SkillItem["status"], string>;
function skillTone(item: SkillItem): Tone {
  switch (item.status) {
    case "available":
    case "installed":
    case "updated":
    case "uninstalled":
      return "success";
    case "unavailable":
    case "skipped":
    case "planned":
      return "warning";
    case "failed":
      return "error";
    case "registered":
    case "removed":
    case "unchanged":
      return "muted";
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
const articleStatus = (status: "draft" | "published") =>
  status === "draft" ? "草稿" : "已发布";
const declaredVersion = (value: string | undefined) =>
  value ? (value.startsWith("v") ? value : `v${value}`) : "未标注";
function installed(item: SkillItem): boolean {
  return (
    "targets" in item && !!item.targets?.some((target) => target.installed)
  );
}
function listVersion(item: SkillItem): string {
  const current =
    "targets" in item
      ? (item.targets?.filter((target) => target.installed) ?? [])
      : [];
  return current.length
    ? [
        ...new Set(current.map((target) => declaredVersion(target.version))),
      ].join(" / ")
    : declaredVersion(item.version);
}
function skillLocation(item: SkillItem): string {
  return "path" in item
    ? item.path
    : (item.targets
        ?.map(
          (target) =>
            `${target.installed ? "✓ installed" : "not installed"}\n${target.path}`,
        )
        .join("\n") ?? "");
}
function Diagnostics({ items }: { items: SkillItem[] }) {
  return (
    <Box flexDirection="column">
      {items
        .filter((item) => item.message)
        .map((item, index) => (
          <Note
            key={index}
          >{`${item.name ?? item.repo}：${item.message}`}</Note>
        ))}
    </Box>
  );
}
function Skills({ data, width }: { data: SkillResult; width: number }) {
  if (
    data.operation === "uninstall" ||
    data.operation === "uninstall-preview"
  ) {
    if (!data.items.length)
      return (
        <Feedback variant="info">
          没有已安装的受管 Skill，来源登记保持不变。
        </Feedback>
      );
    const preview = data.operation === "uninstall-preview";
    return (
      <>
        <Section
          title={skillTitles[data.operation]}
          {...(preview
            ? {
                summary:
                  "确认后将删除列出的目录、全部内容和安装记录，保留来源。",
              }
            : {})}
        />
        <Table
          rows={data.items}
          width={width}
          columns={[
            {
              heading: "Skill",
              maxWidth: 26,
              value: (item) => item.name ?? item.repo,
              tone: "strong",
            },
            {
              heading: "Status",
              maxWidth: 14,
              value: (item) => skillStatuses[item.status],
              tone: skillTone,
            },
            {
              heading: "Location",
              maxWidth: 64,
              value: (item) => skillLocation(item) || "—",
            },
          ]}
        />
        <Note>来源登记已保留，卸载后仍可在列表中查看和重新安装。</Note>
        {data.items.some((item) => item.message) ? (
          <Diagnostics items={data.items} />
        ) : null}
      </>
    );
  }
  if (data.operation === "update") {
    if (!data.items.length)
      return <Feedback variant="warning">没有已安装的受管 Skill。</Feedback>;
    if (data.items.every((item) => item.status === "unchanged"))
      return (
        <Feedback variant="success">无可用更新，Skill 均为最新版。</Feedback>
      );
    return (
      <>
        <Section title="Skill 更新结果" />
        <Table
          rows={data.items}
          width={width}
          columns={[
            {
              heading: "Skill",
              maxWidth: 40,
              value: (item) => item.name ?? item.repo,
              tone: "strong",
            },
            {
              heading: "Status",
              maxWidth: 12,
              value: (item) =>
                item.status === "updated" || item.status === "unchanged"
                  ? "已更新"
                  : "更新失败",
              tone: (item) =>
                item.status === "updated" || item.status === "unchanged"
                  ? "success"
                  : "error",
            },
            {
              heading: "Version",
              maxWidth: 24,
              value: (item) =>
                item.status === "skipped" ||
                (item.status === "failed" && !item.commit)
                  ? "未获取"
                  : declaredVersion(item.version),
            },
          ]}
        />
        {data.items.some((item) => item.message) ? (
          <Diagnostics items={data.items} />
        ) : null}
      </>
    );
  }
  if (data.operation === "source-add" || data.operation === "source-remove")
    return (
      <>
        <Section
          title={skillTitles[data.operation]}
          summary={`已登记来源 ${data.total} 个`}
        />
        <Metadata fields={data.items.map((item) => ["仓库", item.repo])} />
      </>
    );
  const count = data.items.filter(installed).length;
  const hint =
    data.operation === "sources"
      ? `Total: ${data.items.length}`
      : data.operation === "list"
        ? `Total: ${data.items.length} · ${count} installed · ${data.items.length - count} not installed`
        : "仅管理已登记来源及已有 CLI 安装记录的 Skill。";
  const locations: Column<SkillItem>[] =
    (data.operation !== "list" || data.showLocations) &&
    data.items.some(skillLocation)
      ? [
          {
            heading: "Location",
            maxWidth: 48,
            value: skillLocation,
            tone: "muted",
          },
        ]
      : [];
  return (
    <>
      {data.operation !== "list" && data.operation !== "sources" ? (
        <Section
          title={skillTitles[data.operation]}
          summary={`条目数：${data.total}`}
        />
      ) : null}
      {data.items.length ? (
        <Table
          rows={data.items}
          width={width}
          columns={[
            {
              heading: "Skill",
              maxWidth: 26,
              value: (item) => item.name ?? "未确认",
              tone: "strong",
            },
            {
              heading: "Source",
              maxWidth: 36,
              value: (item) => item.repo,
              tone: "muted",
            },
            {
              heading: "Status",
              maxWidth: 14,
              value: (item) =>
                data.operation === "list"
                  ? installed(item)
                    ? "installed"
                    : "not installed"
                  : skillStatuses[item.status],
              tone: (item) =>
                data.operation === "list"
                  ? installed(item)
                    ? "success"
                    : "subtle"
                  : skillTone(item),
            },
            {
              heading: "Version",
              maxWidth: 24,
              value: (item) =>
                data.operation === "list"
                  ? listVersion(item)
                  : declaredVersion(item.version),
            },
            ...locations,
          ]}
        />
      ) : (
        <Note>暂无 Skill 条目</Note>
      )}
      <Note>{hint}</Note>
      {data.items.some((item) => item.message) ? (
        <Diagnostics items={data.items} />
      ) : null}
    </>
  );
}
function Output({ result, width }: { result: CommandResult; width: number }) {
  switch (result.kind) {
    case "skills":
      return <Skills data={result.data} width={width} />;
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
          <Text>{result.data.content}</Text>
        </>
      );
    case "auth":
      return result.data.authenticated ? (
        <>
          <Section title={`已授权 ${result.data.name}`} summary="设备授权" />
          <Metadata
            fields={[
              ["服务", result.data.server],
              ["到期", result.data.expiresAt],
            ]}
          />
        </>
      ) : (
        <>
          <Section title="设备授权已撤销" />
          <Metadata fields={[["服务", result.data.server]]} />
        </>
      );
    case "config":
      return (
        <>
          <Section title="服务配置" />
          <Metadata fields={[["默认服务", result.data.server]]} />
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
          <Output
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
export function renderText(
  result: CommandResult,
  width = process.stdout.columns ?? 100,
  stream: WriteStream = process.stdout,
): string {
  return renderUi(
    <Output result={result} width={Math.max(8, width - 2)} />,
    width,
    stream,
  );
}
