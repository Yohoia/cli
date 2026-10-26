import { stripVTControlCharacters, styleText } from "node:util";
import stringWidth from "string-width";
import type { WriteStream } from "node:tty";
import type { ComponentProps, ReactNode } from "react";
import { Box, Text, renderToString, type TextProps } from "ink";
import {
  StatusMessage,
  ThemeProvider,
  defaultTheme,
  extendTheme,
} from "@inkjs/ui";
import { spinner, progress } from "@clack/prompts";
import type { ReportProgress } from "../core/progress.js";

export type Tone =
  | "normal"
  | "accent"
  | "strong"
  | "muted"
  | "subtle"
  | "success"
  | "warning"
  | "error";
export const textStyles = {
  normal: {},
  accent: { color: "cyan", bold: true },
  strong: { bold: true },
  muted: {},
  subtle: { color: "white" },
  success: { color: "green" },
  warning: { color: "yellow" },
  error: { color: "red" },
} satisfies Record<Tone, TextProps>;
const formats = {
  normal: [],
  accent: ["bold", "cyan"],
  strong: ["bold"],
  muted: [],
  subtle: ["white"],
  success: ["green"],
  warning: ["yellow"],
  error: ["red"],
} satisfies Record<Tone, Parameters<typeof styleText>[0]>;
type Variant = ComponentProps<typeof StatusMessage>["variant"];
const icons = {
  success: "✓",
  warning: "!",
  error: "×",
  info: "i",
} satisfies Record<Variant, string>;
const theme = extendTheme(defaultTheme, {
  components: {
    StatusMessage: {
      config: ({ variant }: { variant: Variant }) => ({ icon: icons[variant] }),
    },
  },
});
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function paint(
  value: string,
  tone: Tone,
  stream: WriteStream = process.stdout,
): string {
  if (
    !stream.isTTY ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === "dumb"
  )
    return value;
  return styleText(formats[tone], value, { stream });
}
export function cleanText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}
export function wrapText(value: string, width: number): string[] {
  return value.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    let used = 0;
    for (const { segment } of graphemes.segment(line)) {
      const size = stringWidth(segment);
      if (used + size > width && current) {
        lines.push(current);
        current = "";
        used = 0;
      }
      current += segment;
      used += size;
    }
    lines.push(current);
    return lines;
  });
}
export function note(value: string, width: number): string {
  return wrapText(cleanText(value), Math.max(2, width - 2))
    .map((line) => "  " + line)
    .join("\n");
}
export function Section({
  title,
  summary,
}: {
  title: string;
  summary?: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{cleanText(title)}</Text>
      {summary ? <Text>{cleanText(summary)}</Text> : null}
    </Box>
  );
}
export function Note({ children }: { children: string }) {
  return <Text>{cleanText(children)}</Text>;
}
export function Metadata({ fields }: { fields: [string, string][] }) {
  const labels = fields.map(
    ([label, value]) =>
      [cleanText(label), cleanText(value)] satisfies [string, string],
  );
  const width = Math.min(
    16,
    labels.reduce((size, [label]) => Math.max(size, stringWidth(label)), 0),
  );
  return (
    <Box flexDirection="column">
      {labels.map(([label, value], index) => (
        <Box key={index} columnGap={2}>
          <Box width={width} flexShrink={0}>
            <Text>{label}</Text>
          </Box>
          <Box flexShrink={1} flexGrow={1}>
            <Text>{value || "—"}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
export function Feedback({
  children,
  variant,
}: {
  children: string;
  variant: Variant;
}) {
  return <StatusMessage variant={variant}>{cleanText(children)}</StatusMessage>;
}
export function renderUi(
  node: ReactNode,
  width: number,
  stream: WriteStream = process.stdout,
): string {
  const output = renderToString(
    <ThemeProvider theme={theme}>
      <Box
        width={Math.max(10, width)}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        gap={1}
      >
        {node}
      </Box>
    </ThemeProvider>,
    { columns: Math.max(10, width) },
  );
  return (
    (stream.isTTY &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb"
      ? output
      : stripVTControlCharacters(output)
    ).trimEnd() + "\n"
  );
}
export function feedback(
  value: string,
  tone: "success" | "warning" | "error",
  width: number,
  stream: WriteStream = process.stdout,
): string {
  return renderUi(<Feedback variant={tone}>{value}</Feedback>, width, stream);
}
export async function withProgress<T>(
  message: string,
  operation: (report: ReportProgress) => Promise<T>,
): Promise<T> {
  if (!process.stderr.isTTY || process.env.TERM === "dumb")
    return operation(() => {});
  const options = {
    output: process.stderr,
    withGuide: false,
    cancelMessage: "操作已取消",
    errorMessage: "操作失败",
  };
  const loading = spinner(options);
  let bar: ReturnType<typeof progress> | undefined;
  let completed = 0;
  let total = 0;
  loading.start(cleanText(message));
  const report: ReportProgress = (update) => {
    if (!update.total) return;
    if (!bar) {
      loading.clear();
      total = update.total;
      bar = progress({
        ...options,
        style: "block",
        max: total,
        size: Math.max(8, Math.min(24, (process.stderr.columns ?? 80) - 42)),
      });
      bar.start(`0/${total} · ${cleanText(update.message)}`);
    }
    bar.advance(
      update.completed - completed,
      `${update.completed}/${total} · ${cleanText(update.message)}`,
    );
    completed = update.completed;
  };
  try {
    const result = await operation(report);
    if (bar) bar.stop(`已处理 ${completed}/${total} 个位置`);
    return result;
  } finally {
    loading.clear();
    bar?.clear();
  }
}
