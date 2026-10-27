import { z } from "zod";
export const articleSchema = z.looseObject({
  id: z.uuid(),
  shortId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  content: z.string(),
  format: z.enum(["md", "mdx"]),
  status: z.enum(["draft", "published"]),
  language: z.enum(["zh", "en"]),
  revision: z.string().min(1),
  publishedAt: z.string().nullable(),
  recordCreatedAt: z.string(),
  recordUpdatedAt: z.string(),
});
export type RemoteArticle = z.infer<typeof articleSchema>;
export const listSchema = z.object({
  items: z.array(articleSchema),
  nextPage: z.number().int().positive().nullable(),
});
export const outcomeSchema = z.discriminatedUnion("status", [
  z.object({
    requestId: z.uuid(),
    status: z.literal("succeeded"),
    result: z.object({ article: articleSchema, changed: z.boolean() }),
  }),
  z.object({ requestId: z.uuid(), status: z.literal("pending") }),
  z.object({
    requestId: z.uuid(),
    status: z.literal("failed"),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type OperationOutcome = z.infer<typeof outcomeSchema>;
