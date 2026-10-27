import { z } from "zod";
import { prompt, terminal } from "./prompt.js";
import { withProgress } from "../cli/presentation.js";
import { Codeup, refresh } from "./codeup.js";
import { installedStatus } from "./installed-status.js";
import {
  failure,
  targetSchema,
  type Selection,
  type SkillState,
} from "./model.js";
export async function selectInstallation(
  state: SkillState,
  codeup: Codeup,
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
      codeup.signal,
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
        codeup.signal,
      ),
    );
  if (!names.length && !selection.all) {
    const catalog = await withProgress("正在检查 Skill 来源…", () =>
      refresh(state, codeup),
    );
    const items = await installedStatus(catalog, selection, state);
    names = await prompt(
      "选择安装 Skill（可多选）",
      items.map((item) => {
        const targets = item.targets ?? [];
        const allInstalled = targets.every((x) => x.installed);
        const allOccupied = targets.every((x) => x.installed || x.occupied);
        const disabled =
          item.status !== "available"
            ? `来源暂不可用：${item.message ?? "无法取得来源内容"}`
            : allOccupied
              ? allInstalled
                ? "所选目标均已安装；请使用 yoho skill update 更新"
                : "同名目标目录已存在；请选择其他目标或先卸载"
              : undefined;
        return {
          id: item.repo,
          label: `${item.name ?? item.repo} · ${item.repo}`,
          status: allInstalled
            ? "✓ 已安装"
            : allOccupied
              ? "同名目录已存在"
              : targets.some((target) => target.installed || target.occupied)
                ? "部分已安装"
                : "未安装",
          description: [
            item.description,
            ...targets.map(
              (target) =>
                `${target.installed ? "✓ 已安装" : target.occupied ? "目录已占用" : "○ 未安装"} ${target.path}`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          ...(disabled ? { disabled } : {}),
        };
      }),
      true,
      codeup.signal,
    );
  }
  return { names, selection };
}
