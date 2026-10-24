import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { failure } from "./model.js";
export type SkillFile = { bytes: Buffer; executable: boolean };
export type SkillFiles = Map<string, SkillFile>;
function safe(path: string) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((x) => x !== ".." && x !== ".")
  );
}
export function unpack(archive: Buffer): SkillFiles {
  try {
    const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
    const files: SkillFiles = new Map();
    let offset = 0;
    let prefix: string | undefined;
    let extended: Record<string, string> = {};
    let entries = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((x) => x === 0)) break;
      if (++entries > 20000) throw new Error("归档条目过多");
      const field = (start: number, len: number) =>
        header
          .subarray(start, start + len)
          .toString("utf8")
          .replace(/\0.*$/s, "");
      const number = (start: number, len: number) => {
        const text = field(start, len).trim();
        if (!/^[0-7]*$/.test(text)) throw new Error("归档数值无效");
        return parseInt(text || "0", 8);
      };
      const checksum = number(148, 8);
      let sum = 0;
      for (let i = 0; i < 512; i++)
        sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
      if (sum !== checksum) throw new Error("归档校验和无效");
      const size = number(124, 12);
      offset += 512;
      if (offset + size > tar.length) throw new Error("归档被截断");
      const bytes = tar.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;
      const type = field(156, 1);
      if (type === "g" || type === "x") {
        const fields: Record<string, string> = {};
        let pos = 0;
        while (pos < bytes.length) {
          const space = bytes.indexOf(32, pos);
          const length = Number(bytes.subarray(pos, space).toString());
          if (
            space < pos ||
            !Number.isSafeInteger(length) ||
            length <= space - pos + 1 ||
            pos + length > bytes.length
          )
            throw new Error("PAX 条目无效");
          const pair = bytes.subarray(space + 1, pos + length - 1).toString();
          const equal = pair.indexOf("=");
          if (equal > 0) fields[pair.slice(0, equal)] = pair.slice(equal + 1);
          pos += length;
        }
        if (type === "x") extended = fields;
        continue;
      }
      const raw =
        extended.path ??
        [field(345, 155), field(0, 100)].filter(Boolean).join("/");
      extended = {};
      const path = raw.replace(/\/$/, "").normalize("NFC");
      if (!safe(path)) throw new Error("归档路径越界");
      const parts = path.split("/");
      const first = parts.shift();
      if (!prefix) prefix = first;
      if (first !== prefix) throw new Error("归档根目录不一致");
      if (type === "5") continue;
      if (type !== "0" && type !== "")
        throw new Error("不支持归档链接或特殊文件");
      if (!parts.length) throw new Error("归档缺少根目录");
      if (parts.includes(".git")) continue;
      const relative = parts.join("/");
      if (files.has(relative)) throw new Error("归档存在重复路径");
      files.set(relative, {
        bytes: Buffer.from(bytes),
        executable: (number(100, 8) & 0o111) !== 0,
      });
    }
    if (!files.has("SKILL.md")) throw new Error("归档缺少根 SKILL.md");
    const lower = new Set<string>();
    for (const path of files.keys()) {
      if (lower.has(path.toLowerCase())) throw new Error("大小写路径冲突");
      lower.add(path.toLowerCase());
    }
    for (const path of lower) {
      const parts = path.split("/");
      parts.pop();
      while (parts.length) {
        if (lower.has(parts.join("/"))) throw new Error("文件与目录路径冲突");
        parts.pop();
      }
    }
    return files;
  } catch (error) {
    throw failure(
      "SKILL_ARCHIVE_INVALID",
      error instanceof Error ? error.message : "Skill 归档无效",
    );
  }
}
export function fingerprint(files: SkillFiles): string {
  const hash = createHash("sha256");
  for (const [path, file] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(JSON.stringify([path, file.executable, file.bytes.length]));
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}
