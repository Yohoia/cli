import { select, multiselect, isCancel, log } from "@clack/prompts";
import { AppError } from "../core/errors.js";
import { failure } from "./model.js";
import { cleanText, wrapText } from "../cli/presentation.js";
export type Choice = {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  status?: string;
  disabled?: boolean | string;
};
export function terminal() {
  return !!process.stdin.isTTY && !!process.stderr.isTTY;
}
function disabledReason(choice: Choice) {
  return typeof choice.disabled === "string"
    ? choice.disabled
    : choice.disabled
      ? "当前不可用"
      : undefined;
}
export async function prompt(
  title: string,
  choices: Choice[],
  multiple: boolean,
  signal: AbortSignal,
): Promise<string[]> {
  if (!terminal())
    throw failure(
      "INVALID_ARGUMENT",
      "无交互终端，请完整指定 Skill、范围及 --target",
      2,
    );
  if (!choices.length || choices.every((choice) => disabledReason(choice)))
    throw failure(
      "SKILL_NOT_SELECTABLE",
      choices.length
        ? choices
            .map((choice) => `${choice.label}：${disabledReason(choice)}`)
            .join("\n")
        : "没有可选择的 Skill 或目标",
      3,
    );
  signal.throwIfAborted();
  const width = process.stderr.columns ?? 100;
  const options = choices.map((choice) => ({
    value: choice.id,
    label: [
      cleanText(`${choice.label}${choice.status ? ` [${choice.status}]` : ""}`),
      ...(choice.detail ? [`  ${cleanText(choice.detail)}`] : []),
    ].join("\n"),
    hint: wrapText(
      cleanText(disabledReason(choice) ?? choice.description ?? ""),
      Math.max(8, width - 10),
    )
      .slice(0, 3)
      .join("\n"),
    disabled: !!disabledReason(choice),
  }));
  const common = {
    message: cleanText(title),
    options,
    input: process.stdin,
    output: process.stderr,
    signal,
    showInstructions: false,
    withGuide: false,
    maxItems: Math.max(1, Math.min(8, (process.stderr.rows ?? 24) - 10)),
  };
  if (multiple)
    log.info(
      `可选 ${options.filter((option) => !option.disabled).length} 项 · a 全选/清空 · i 反选`,
      { output: process.stderr, withGuide: false },
    );
  log.info(
    multiple
      ? "↑↓ 移动 · 空格选择 · Enter 确认 · Ctrl+C 取消"
      : "↑↓ 移动 · Enter 确认 · Ctrl+C 取消",
    { output: process.stderr, withGuide: false },
  );
  while (true) {
    const value = multiple
      ? await multiselect({ ...common, required: false })
      : await select(common);
    if (isCancel(value))
      throw new AppError({
        code: "CANCELLED",
        message: "操作已取消",
        exitCode: 130,
      });
    const selected = typeof value === "string" ? [value] : value;
    if (selected.length) return selected;
    log.warn("至少选择一项", { output: process.stderr });
  }
}
