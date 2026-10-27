import type { z } from "zod";
import type { SkillResult } from "../skills/model.js";
import type { authStatus, logout } from "../remote/auth.js";
import type { performOperation, queryOperation } from "../remote/operations.js";
import type { articleSchema, listSchema } from "../remote/model.js";
export type CommandResult =
  | { kind: "skills"; data: SkillResult }
  | { kind: "list"; data: z.infer<typeof listSchema> }
  | { kind: "show"; data: z.infer<typeof articleSchema> }
  | { kind: "write"; data: Awaited<ReturnType<typeof performOperation>> }
  | { kind: "operation"; data: Awaited<ReturnType<typeof queryOperation>> }
  | {
      kind: "auth";
      data:
        | Awaited<ReturnType<typeof authStatus>>
        | Awaited<ReturnType<typeof logout>>;
    }
  | { kind: "config"; data: { server: string } }
  | {
      kind: "delete-preview";
      data: Pick<
        z.infer<typeof articleSchema>,
        "id" | "title" | "status" | "revision"
      > & { deleted: false };
    };
