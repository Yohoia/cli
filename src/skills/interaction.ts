import { join } from "node:path";
import { dirname } from "node:path";
import { z } from "zod";
import { prompt, terminal } from "./prompt.js";
import { roots, exists } from "./files.js";
import { GitHub, refresh } from "./github.js";
import { discover } from "./inventory.js";
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
) {
  const destinations = await roots(selection);
  const existing = await discover(state, selection);
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      targets: await Promise.all(
        destinations.map(async (root) => {
          const matching = existing.find(
            (x) =>
              dirname(x.path) === root && x.name === item.name && !x.problem,
          );
          const path = matching?.path ?? join(root, item.name ?? "invalid");
          return { path, installed: await exists(path) };
        }),
      ),
    })),
  );
}
export async function interact(
  kind: "install" | "update",
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
        { id: "project", label: "当前项目（默认）" },
        { id: "user", label: "当前用户" },
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
          { id: "claude", label: "Claude Code" },
          { id: "agents", label: "Codex及通用 Agent" },
          { id: "codex", label: "Codex兼容目录" },
        ],
        true,
        github.signal,
      ),
    );
  if (!names.length && !selection.all) {
    const catalog = await refresh(state, github);
    if (kind === "install") {
      const items = await installedStatus(catalog, selection, state);
      names = await prompt(
        "选择安装 Skill（可多选）",
        items.map((item) => {
          const targets = item.targets ?? [];
          const all = targets.every((x) => x.installed);
          return {
            id: item.repo,
            label: `${item.name ?? item.repo} · ${item.description ?? ""} · ${item.repo} ${targets.map((x) => `${x.path} ${x.installed ? "✓ 已安装" : "未安装"}`).join("；")} ${item.status === "available" ? "" : (item.message ?? "暂不可用")}`,
            disabled: all || item.status !== "available",
          };
        }),
        true,
        github.signal,
      );
    } else {
      const installed = await discover(state, selection);
      const byName = new Map<string, { label: string; disabled: boolean }>();
      for (const item of installed) {
        const sources = state.sources.filter((x) =>
          item.record
            ? x.repo === item.record.repo
            : x.metadata?.name === item.name,
        );
        const available = catalog.some(
          (x) =>
            sources.some((s) => s.repo === x.repo) && x.status === "available",
        );
        const disabled = !!item.problem || sources.length !== 1 || !available;
        const id =
          item.record?.repo ??
          (sources.length === 1 ? sources[0]?.repo : undefined) ??
          item.path;
        const existing = byName.get(id);
        byName.set(id, {
          label: `${existing?.label ? existing.label + "；" : ""}${item.name} · ${item.record?.repo ?? sources[0]?.repo ?? "未知来源"} · ${item.path} ${disabled ? (item.problem ?? "来源移除、不可用或不唯一") : "已有安装"}`,
          disabled: existing ? existing.disabled && disabled : disabled,
        });
      }
      names = await prompt(
        "选择更新 Skill（仓库内容将覆盖本地修改，可多选）",
        [...byName].map(([id, item]) => ({ id, ...item })),
        true,
        github.signal,
      );
    }
  }
  return { names, selection };
}
