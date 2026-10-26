import { join } from "node:path";
import { dirname } from "node:path";
import { z } from "zod";
import { prompt, terminal } from "./prompt.js";
import { roots, exists } from "./files.js";
import { withProgress } from "../cli/presentation.js";
import { GitHub, refresh } from "./github.js";
import { discover, discoverUpdates, installedVersion } from "./inventory.js";
import {
  failure,
  targetSchema,
  type Selection,
  type SkillState,
  type CatalogItem,
} from "./model.js";
export async function installedStatus(
  items: CatalogItem[],
  selection: Selection,
  state: SkillState,
  automatic = false,
) {
  const destinations = await roots(selection);
  const existing = automatic
    ? await discoverUpdates(state, { kind: "automatic", all: false })
    : await discover(state, selection);
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      targets: await Promise.all(
        (automatic
          ? existing
              .filter((entry) =>
                entry.record
                  ? entry.record.repo === item.repo
                  : entry.name === item.name,
              )
              .map((entry) => ({ path: entry.path }))
          : destinations.map((root) => ({ root }))
        ).map(async (destination) => {
          if ("path" in destination) {
            const version = await installedVersion(state, destination.path);
            return {
              path: destination.path,
              installed: true,
              ...(version ? { version } : {}),
            };
          }
          const root = destination.root;
          const matching = existing.find(
            (x) =>
              dirname(x.path) === root && x.name === item.name && !x.problem,
          );
          const path = matching?.path ?? join(root, item.name ?? "invalid");
          const installed = await exists(path);
          const version = installed
            ? await installedVersion(state, path)
            : undefined;
          return { path, installed, ...(version ? { version } : {}) };
        }),
      ),
    })),
  );
}
export async function selectInstallation(
  state: SkillState,
  github: GitHub,
  names: string[],
  selection: Selection,
  scopeExplicit: boolean,
): Promise<{ names: string[]; selection: Selection }> {
  if (!terminal()) {
    if (!selection.target.length || (!names.length && !selection.all))
      throw failure(
        "INVALID_ARGUMENT",
        "无交互终端，请指定 Skill 或更新 --all，并提供 --target",
        2,
      );
    return { names, selection };
  }
  const incomplete =
    !selection.target.length || (!names.length && !selection.all);
  if (incomplete && !scopeExplicit) {
    const [scope] = await prompt(
      "安装范围",
      [
        {
          id: "project",
          label: "当前项目（默认）",
          description: `仅处理项目目录：${selection.projectPath ?? process.cwd()}`,
        },
        {
          id: "user",
          label: "当前用户",
          description: "处理用户目录中的 Skill，可供多个项目使用",
        },
      ],
      false,
      github.signal,
    );
    selection.scope = z.enum(["project", "user"]).parse(scope);
  }
  if (!selection.target.length)
    selection.target = z.array(targetSchema).parse(
      await prompt(
        "目标工具（可多选）",
        [
          { id: "claude", label: "Claude Code", description: ".claude/skills" },
          {
            id: "agents",
            label: "Codex及通用 Agent",
            description: ".agents/skills",
          },
          { id: "codex", label: "Codex兼容目录", description: ".codex/skills" },
        ],
        true,
        github.signal,
      ),
    );
  if (!names.length && !selection.all) {
    const catalog = await withProgress("正在检查 Skill 来源…", () =>
      refresh(state, github),
    );
    const items = await installedStatus(catalog, selection, state);
    names = await prompt(
      "选择安装 Skill（可多选）",
      items.map((item) => {
        const targets = item.targets ?? [];
        const all = targets.every((x) => x.installed);
        const disabled =
          item.status !== "available"
            ? `来源暂不可用：${item.message ?? "无法取得来源内容"}`
            : all
              ? "所选目标均已安装；请使用 yoho skill update 更新"
              : undefined;
        return {
          id: item.repo,
          label: `${item.name ?? item.repo} · ${item.repo}`,
          status: all
            ? "✓ 已安装"
            : targets.some((target) => target.installed)
              ? "部分已安装"
              : "未安装",
          description: [
            item.description,
            ...targets.map(
              (target) =>
                `${target.installed ? "✓ 已安装" : "○ 未安装"} ${target.path}`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          ...(disabled ? { disabled } : {}),
        };
      }),
      true,
      github.signal,
    );
  }
  return { names, selection };
}
