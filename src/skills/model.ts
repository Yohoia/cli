import { z } from "zod";
import { AppError } from "../core/errors.js";
export const skillName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const metadataSchema = z.object({
  name: skillName,
  description: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  version: z
    .string()
    .regex(/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/)
    .optional(),
});
export type Metadata = z.infer<typeof metadataSchema>;
const repoSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+$/)
  .refine(
    (value) => !value.split("/").some((part) => part === "." || part === ".."),
  );
export const sourceSchema = z.object({
  repo: repoSchema,
  metadata: metadataSchema.optional(),
  legacyGithub: z.literal(true).optional(),
});
export const recordSchema = z.object({
  repo: repoSchema,
  name: skillName,
  path: z.string().startsWith("/"),
  commit: metadataSchema.shape.commit.nullable(),
  version: metadataSchema.shape.version,
});
export type InstallRecord = z.infer<typeof recordSchema>;
export const stateSchema = z.object({
  version: z.literal(2),
  sources: z.array(sourceSchema),
  records: z.array(recordSchema),
});
export type SkillState = z.infer<typeof stateSchema>;
export type Source = z.infer<typeof sourceSchema>;
export const targets = {
  claude: ".claude",
  agents: ".agents",
  codex: ".codex",
};
export const targetSchema = z.enum(["claude", "agents", "codex"]);
export type Target = z.infer<typeof targetSchema>;
export const selectionSchema = z.object({
  scope: z.enum(["project", "user"]).default("project"),
  target: z.array(targetSchema).default([]),
  projectPath: z.string().optional(),
  all: z.boolean().default(false),
});
export type Selection = z.infer<typeof selectionSchema>;
export type UpdateScope =
  | { kind: "automatic"; all: boolean }
  | { kind: "selected"; selection: Selection };
export type CatalogItem = {
  repo: string;
  version?: Metadata["version"];
  targets?: {
    path: string;
    installed: boolean;
    occupied?: boolean;
    version?: string;
    message?: string;
  }[];
} & (
  | {
      status: "available";
      name: string;
      description: string;
      commit: string;
      message?: never;
    }
  | {
      status: "registered" | "removed";
      name?: string;
      description?: string;
      commit?: string;
      message?: never;
    }
  | {
      status: "unavailable";
      name?: string;
      description?: string;
      commit?: string;
      message: string;
    }
);
export type TargetItem = {
  repo: string;
  name: string;
  path: string;
  version?: Metadata["version"];
} & (
  | {
      status: "installed" | "updated" | "unchanged";
      commit: string;
      description: string;
      message?: string;
    }
  | {
      status: "skipped" | "failed";
      message: string;
      commit?: string;
      description?: never;
    }
  | {
      status: "uninstalled" | "planned";
      message?: string;
      commit?: never;
      description?: never;
    }
);
export type SkillItem = CatalogItem | TargetItem;
export type SkillResult = { items: SkillItem[]; total: number } & (
  | {
      operation: "list";
      available: number;
      unknown: number;
      showLocations?: boolean;
    }
  | {
      operation:
        | "sources"
        | "source-add"
        | "source-remove"
        | "refresh"
        | "install"
        | "update";
    }
  | { operation: "uninstall"; removedSources: [] }
  | { operation: "uninstall-preview"; sources: string[] }
);
export class SkillOperationError extends AppError {
  constructor(
    problem: AppError,
    readonly result: SkillResult,
  ) {
    super({
      code: problem.code,
      message: problem.message,
      exitCode: problem.exitCode,
      data: result,
    });
  }
}
export function failure(
  code: string,
  message: string,
  exitCode: 2 | 3 | 4 | 5 = 3,
): AppError {
  return new AppError({ code, message, exitCode });
}
export function repository(raw: string): string {
  const value = raw
    .replace(/^https:\/\/codeup\.aliyun\.com\//i, "")
    .replace(/^git@codeup\.aliyun\.com:/i, "")
    .replace(/^ssh:\/\/git@codeup\.aliyun\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "");
  const parsed = repoSchema.safeParse(value);
  if (!parsed.success)
    throw failure(
      "INVALID_SOURCE",
      "来源必须是 Codeup 命名空间/仓库路径、HTTPS 链接或 SSH 克隆地址",
      2,
    );
  return parsed.data;
}
export const codeupNamespace = "69aa892db28d0aba0f5ed47e";
export const initialSkills = [
  "yoho-standard-readme",
  "yoho-retro-poster",
  "yoho-speckit",
];
export function migratedRepository(repo: string): string {
  const skill = initialSkills.find((name) => repo === `yohoia/${name}`);
  return skill ? `${codeupNamespace}/${skill}` : repo;
}
