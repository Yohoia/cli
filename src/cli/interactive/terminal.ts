import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { cleanText, wrapText } from "../presentation.js";

export type Key = { name: string; text: string };
export type Color = "cyan" | "green" | "purple" | "gray" | "red" | "yellow";
const colors = {
  cyan: "36",
  green: "32",
  purple: "35",
  gray: "38;5;244",
  red: "31",
  yellow: "33",
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function color(text: string, tone: Color, bold = false): string {
  return process.env.NO_COLOR !== undefined
    ? text
    : `\x1b[${bold ? "1" : "0"};${colors[tone]}m${text}\x1b[0m`;
}
export function fit(text: string, width: number): string {
  const value = cleanText(text).replace(/\s+/gu, " ");
  if (stringWidth(value) <= width) return value;
  let output = "";
  for (const { segment } of graphemes.segment(value)) {
    if (stringWidth(output + segment) > Math.max(0, width - 1)) break;
    output += segment;
  }
  return output + "…";
}
export function pad(text: string, width: number): string {
  const value = fit(text, width);
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}
export function fitEnd(text: string, width: number): string {
  const value = cleanText(text).replace(/[\r\n]/gu, " ");
  if (stringWidth(value) <= width) return value;
  const ellipsis = ".".repeat(Math.min(3, width));
  let tail = "";
  for (const { segment } of [...graphemes.segment(value)].reverse()) {
    if (stringWidth(ellipsis + segment + tail) > width) break;
    tail = segment + tail;
  }
  return ellipsis + tail;
}
function legendLines(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of text.split(/\s*\|\s*/u)) {
    const joined = line ? `${line} | ${item}` : item;
    if (stringWidth(joined) > width && line) {
      lines.push(line);
      line = item;
    } else line = joined;
  }
  if (line) lines.push(line);
  return lines.flatMap((value) => wrapText(value, width));
}

// One owner for raw input, repainting, resize and terminal restoration.
export class Terminal {
  private keys: Key[] = [];
  private wake: (() => void) | undefined;
  private previous: string[] = [];
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private wasRaw = process.stdin.isRaw;
  private wasFlowing = process.stdin.readableFlowing === true;
  private interrupted = () => this.wake?.();
  constructor(readonly signal: AbortSignal) {}
  get width() {
    return Math.max(20, process.stdout.columns ?? 80);
  }
  get height() {
    return Math.max(8, process.stdout.rows ?? 24);
  }
  private emit(name: string, text = "") {
    if (name === "interrupt") {
      process.emit("SIGINT");
      return;
    }
    this.keys.push({ name, text });
    this.wake?.();
  }
  private input = (bytes: Buffer) => {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(bytes);
    while (this.pending) {
      if (this.pending.startsWith("\x1b[200~")) {
        const end = this.pending.indexOf("\x1b[201~");
        if (end < 0) return;
        this.emit("text", this.pending.slice(6, end).replace(/[\r\n]/gu, ""));
        this.pending = this.pending.slice(end + 6);
        continue;
      }
      const sequence = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/u.exec(this.pending);
      if (sequence) {
        const code = sequence[2];
        const name =
          (
            {
              A: "up",
              B: "down",
              C: "right",
              D: "left",
              H: "home",
              F: "end",
            } as Record<string, string>
          )[code ?? ""] ??
          (sequence[1] === "5"
            ? "pageup"
            : sequence[1] === "6"
              ? "pagedown"
              : "unknown");
        this.emit(name);
        this.pending = this.pending.slice(sequence[0].length);
        continue;
      }
      if (this.pending.startsWith("\x1b")) {
        // Escape may arrive separately from the rest of an arrow-key sequence.
        this.escapeTimer = setTimeout(() => {
          this.pending = "";
          this.emit("escape");
        }, 30);
        return;
      }
      const character = Array.from(this.pending)[0] ?? "";
      this.pending = this.pending.slice(character.length);
      const name =
        character === "\x03"
          ? "interrupt"
          : character === "\r" || character === "\n"
            ? "enter"
            : character === "\x7f" || character === "\b"
              ? "backspace"
              : character === "\t"
                ? "tab"
                : character === "\x15"
                  ? "clear"
                  : "text";
      if (name !== "text" || character >= " ") this.emit(name, character);
    }
  };
  private resize = () => {
    this.previous = [];
    this.emit("resize");
  };
  open() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.input);
    process.stdout.on("resize", this.resize);
    this.signal.addEventListener("abort", this.interrupted);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[H\x1b[2J");
  }
  close() {
    clearTimeout(this.escapeTimer);
    process.stdin.removeListener("data", this.input);
    process.stdout.removeListener("resize", this.resize);
    this.signal.removeEventListener("abort", this.interrupted);
    process.stdin.setRawMode(this.wasRaw ?? false);
    if (!this.wasFlowing) process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }
  async read(): Promise<Key> {
    for (;;) {
      this.signal.throwIfAborted();
      const key = this.keys.shift();
      if (key) return key;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
  discardInput() {
    this.keys = [];
  }
  notify() {
    this.emit("task");
  }
  draw(lines: string[]) {
    const screen = Array.from(
      { length: this.height },
      (_, index) => lines[index] ?? "",
    );
    let output = "";
    for (let index = 0; index < screen.length; index++) {
      const line = screen[index] ?? "";
      if (line !== this.previous[index])
        output += `\x1b[${index + 1};1H\x1b[2K${line}`;
    }
    process.stdout.write(output);
    this.previous = screen;
  }
  frame(
    title: string,
    body: string[],
    controls: string,
    subtitle = "",
    headingTone: Color = "purple",
  ) {
    const footer = legendLines(controls, this.width - 2).map((line) =>
      color(" " + line, "gray"),
    );
    const count = Math.max(1, this.height - footer.length - 4);
    const heading = fit(title, this.width - 2);
    const lines = [
      " " +
        color(heading, headingTone, headingTone === "purple") +
        (subtitle && stringWidth(heading) + 5 < this.width
          ? color(
              "  " + fit(subtitle, this.width - stringWidth(heading) - 4),
              "gray",
            )
          : ""),
      "",
      ...body.slice(0, count),
    ];
    while (lines.length < this.height - footer.length - 1) lines.push("");
    this.draw([...lines, "", ...footer]);
  }
  contentHeight(controls: string) {
    return Math.max(
      1,
      this.height - legendLines(controls, this.width - 2).length - 4,
    );
  }
  plain(text: string) {
    return stripVTControlCharacters(text);
  }
}
