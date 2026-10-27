import { Box } from "ink";
import { Table, type Column } from "../table.js";
import type { SkillItem, SkillResult } from "../../skills/model.js";
import {
  Section,
  Note,
  Metadata,
  Feedback,
  type Tone,
} from "../presentation.js";
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
function diagnosticMessages(items: SkillItem[]): string[] {
  const messages: string[] = [];
  for (const item of items) {
    if (item.message)
      messages.push(`${item.name ?? item.repo}：${item.message}`);
    if ("targets" in item)
      for (const target of item.targets ?? [])
        if (target.message)
          messages.push(
            `${item.name ?? item.repo} · ${target.path}：${target.message}`,
          );
  }
  return messages;
}
function Diagnostics({ items }: { items: SkillItem[] }) {
  return (
    <Box flexDirection="column">
      {diagnosticMessages(items).map((message, index) => (
        <Note key={index}>{message}</Note>
      ))}
    </Box>
  );
}

export function SkillView({
  data,
  width,
}: {
  data: SkillResult;
  width: number;
}) {
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
        {diagnosticMessages(data.items).length > 0 ? (
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
        {diagnosticMessages(data.items).length > 0 ? (
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
      {diagnosticMessages(data.items).length > 0 ? (
        <Diagnostics items={data.items} />
      ) : null}
    </>
  );
}
