import { emitKeypressEvents } from "node:readline";
import { AppError } from "../core/errors.js";
import { failure } from "./model.js";
export type Choice = { id: string; label: string; disabled?: boolean };
export function terminal() {
  return !!process.stdin.isTTY && !!process.stderr.isTTY;
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
  if (!choices.some((x) => !x.disabled))
    throw failure("SKILL_NOT_SELECTABLE", "没有可选择的 Skill 或目标", 3);
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    let index = 0;
    let lines = 0;
    const checked = new Set<string>();
    const wasRaw = process.stdin.isRaw;
    function render() {
      if (lines) process.stderr.write(`\u001b[${lines}A\u001b[J`);
      const text = [
        title,
        ...choices.map(
          (x, i) =>
            `${i === index ? ">" : " "} ${x.disabled ? "—" : checked.has(x.id) ? "☑" : "☐"} ${x.label}`,
        ),
        multiple
          ? "↑↓ 移动，空格选择，a 全选，Enter 继续，Ctrl+C 取消"
          : "↑↓ 选择，Enter 继续，Ctrl+C 取消",
      ];
      process.stderr.write(text.join("\n") + "\n");
      lines = text.length;
    }
    function cleanup() {
      process.stdin.removeListener("keypress", key);
      signal.removeEventListener("abort", cancel);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    }
    function cancel() {
      cleanup();
      reject(
        new AppError({
          code: "CANCELLED",
          message: "操作已取消",
          exitCode: 130,
        }),
      );
    }
    function key(_text: string, pressed: { name?: string; ctrl?: boolean }) {
      if (pressed.ctrl && pressed.name === "c") {
        cancel();
        return;
      }
      if (pressed.name === "up")
        index = (index + choices.length - 1) % choices.length;
      else if (pressed.name === "down") index = (index + 1) % choices.length;
      else if (pressed.name === "space" && multiple) {
        const item = choices[index];
        if (item && !item.disabled) {
          if (checked.has(item.id)) checked.delete(item.id);
          else checked.add(item.id);
        }
      } else if (pressed.name === "a" && multiple) {
        for (const item of choices) if (!item.disabled) checked.add(item.id);
      } else if (pressed.name === "return") {
        const item = choices[index];
        const selected = multiple
          ? [...checked]
          : item && !item.disabled
            ? [item.id]
            : [];
        if (selected.length) {
          cleanup();
          done(selected);
          return;
        }
      }
      render();
    }
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", key);
    signal.addEventListener("abort", cancel, { once: true });
    render();
  });
}
