import { Box, Text } from "ink";
import stringWidth from "string-width";
import { cleanText, textStyles, type Tone } from "./presentation.js";
export type Column<Row> = {
  heading: string;
  maxWidth: number;
  value: (row: Row) => string;
  tone?: Tone | ((row: Row) => Tone);
};
export function Table<Row>({
  rows,
  columns,
  width,
}: {
  rows: Row[];
  columns: Column<Row>[];
  width: number;
}) {
  const cells = columns.map((column) => {
    const values = rows.map((row) => cleanText(column.value(row)));
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
      tones: rows.map((row) =>
        typeof column.tone === "function"
          ? column.tone(row)
          : (column.tone ?? "normal"),
      ),
      minimum,
      width: Math.max(minimum, Math.min(column.maxWidth, natural)),
    };
  });
  const gaps = Math.max(0, cells.length - 1) * 2;
  if (
    width < 56 ||
    cells.reduce((sum, cell) => sum + cell.minimum, gaps) > width
  ) {
    const labelWidth = Math.min(
      Math.max(...cells.map((cell) => stringWidth(cell.heading))),
      Math.floor(width / 3),
    );
    return (
      <Box flexDirection="column" gap={1}>
        {rows.map((_, row) => (
          <Box key={row} flexDirection="column">
            {cells.map((cell, column) => (
              <Box key={column} columnGap={2}>
                <Box width={labelWidth} flexShrink={0}>
                  <Text {...textStyles.accent}>{cell.heading}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text {...textStyles[cell.tones[row] ?? "normal"]}>
                    {cell.values[row] ?? ""}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    );
  }
  while (cells.reduce((sum, cell) => sum + cell.width, gaps) > width) {
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
  return (
    <Box flexDirection="column">
      <Box columnGap={2}>
        {cells.map((cell, index) => (
          <Box
            key={index}
            width={cell.width}
            flexShrink={0}
            justifyContent="center"
          >
            <Text {...textStyles.accent}>{cell.heading}</Text>
          </Box>
        ))}
      </Box>
      <Box columnGap={2}>
        {cells.map((cell, index) => (
          <Box key={index} width={cell.width} flexShrink={0}>
            <Text>{"─".repeat(cell.width)}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" gap={1}>
        {rows.map((_, row) => (
          <Box key={row} columnGap={2} alignItems="flex-start">
            {cells.map((cell, column) => (
              <Box key={column} width={cell.width} flexShrink={0}>
                <Text {...textStyles[cell.tones[row] ?? "normal"]}>
                  {cell.values[row] ?? ""}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
