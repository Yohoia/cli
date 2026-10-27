import { parse } from "yaml";
import { z } from "zod";
import { metadataSchema, failure } from "./model.js";
export function parseSkill(input: string | Uint8Array) {
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw failure("SKILL_INVALID", "SKILL.md 必须使用有效的 UTF-8 编码");
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) throw failure("SKILL_INVALID", "Skill 缺少有效 frontmatter");
  try {
    const document = metadataSchema
      .omit({ commit: true })
      .extend({
        metadata: z
          .object({ version: metadataSchema.shape.version })
          .optional(),
      })
      .parse(parse(match[1]));
    const version = document.version ?? document.metadata?.version;
    return {
      name: document.name,
      description: document.description,
      ...(version ? { version } : {}),
    };
  } catch {
    throw failure("SKILL_INVALID", "Skill name、description 或 version 无效");
  }
}
