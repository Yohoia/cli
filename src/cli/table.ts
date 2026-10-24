import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";

type Column<Row> = {
  heading: string;
  maxWidth: number;
  value: (row: Row) => string;
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cellText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

function wrap(value: string, width: number): string[] {
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

export function renderTable<Row>(
  rows: Row[],
  columns: Column<Row>[],
  width: number,
): string {
  const cells = columns.map((column) => {
    const values = rows.map((row) => cellText(column.value(row)));
    const minimum = Math.max(2, stringWidth(column.heading));
    const natural = values.reduce(
      (largest, value) =>
        value
          .split("\n")
          .reduce((size, line) => Math.max(size, stringWidth(line)), largest),
      minimum,
    );
    return {
      heading: column.heading,
      values,
      minimum,
      width: Math.max(minimum, Math.min(column.maxWidth, natural)),
    };
  });
  while (cells.reduce((total, cell) => total + cell.width + 3, 1) > width) {
    const widest = cells.reduce<(typeof cells)[number] | undefined>(
      (best, cell) =>
        cell.width > cell.minimum && (!best || cell.width > best.width)
          ? cell
          : best,
      undefined,
    );
    if (!widest) break;
    widest.width--;
  }
  const border = (left: string, middle: string, right: string) =>
    left + cells.map((cell) => "─".repeat(cell.width + 2)).join(middle) + right;
  const row = (values: string[]) => {
    const lines = cells.map((cell, index) =>
      wrap(values[index] ?? "", cell.width),
    );
    const height = Math.max(1, ...lines.map((value) => value.length));
    return Array.from(
      { length: height },
      (_, line) =>
        "│" +
        cells
          .map((cell, column) => {
            const value = lines[column]?.[line] ?? "";
            return ` ${value}${" ".repeat(Math.max(0, cell.width - stringWidth(value)))} `;
          })
          .join("│") +
        "│",
    ).join("\n");
  };
  const lines = [
    border("┌", "┬", "┐"),
    row(cells.map((cell) => cell.heading)),
    border("├", "┼", "┤"),
  ];
  rows.forEach((_, index) => {
    if (index) lines.push(border("├", "┼", "┤"));
    lines.push(row(cells.map((cell) => cell.values[index] ?? "")));
  });
  lines.push(border("└", "┴", "┘"));
  return lines.join("\n");
}
