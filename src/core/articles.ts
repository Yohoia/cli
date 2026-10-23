import { z } from "zod";

export const articleStatusSchema = z.enum(["draft", "published", "archived"]);
export const articleIdSchema = z.string().min(1).refine(value => !/[\\\0]/.test(value) && !/^[a-z]:/i.test(value) && value.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."), "文章标识必须是文章目录内的相对标识").brand<"ArticleId">();
export const articleRevisionSchema = z.string().min(1).brand<"ArticleRevision">();
export const articleTitleSchema = z.string().refine(value => !/[\r\n\u0085\u2028\u2029\0]/.test(value), "标题必须是单行文本").transform(value => value.trim()).pipe(z.string().min(1, "标题不能为空")).brand<"ArticleTitle">();
export const articleMetadataSchema = z.object({
  title: z.string(),
  description: z.string(),
  publishedAt: z.coerce.date(),
  status: articleStatusSchema.default("draft"),
  draft: z.boolean().default(false),
  updatedAt: z.coerce.date().optional(),
  language: z.enum(["zh", "en"]).default("zh"),
  tags: z.array(z.string()).default([]),
  cover: z.string().optional(),
  coverAlt: z.string().optional(),
  thumbnail: z.string().optional(),
  thumbnailAlt: z.string().optional(),
}).catchall(z.unknown());

export type ArticleMetadata = z.infer<typeof articleMetadataSchema>;
export type ArticleStatus = z.infer<typeof articleStatusSchema>;
export type ArticleId = z.infer<typeof articleIdSchema>;
export type ArticleRevision = z.infer<typeof articleRevisionSchema>;
export type ArticleTitle = z.infer<typeof articleTitleSchema>;
export type Article = { id: ArticleId; path: string; metadata: ArticleMetadata; content: string; revision: ArticleRevision };
export type ArticleSummary = { id: ArticleId; title: string; status: ArticleStatus; publishedAt: string };
export type TitleChange = { kind: "unchanged" } | { kind: "title"; title: ArticleTitle };
export type ArticleUpdate = { id: ArticleId; title: string; revision: ArticleRevision; changed: boolean };

export interface ArticleStore {
  list(): Promise<Article[]>;
  read(input: { id: ArticleId }): Promise<Article>;
  edit(input: { id: ArticleId; decide: (article: Article) => TitleChange }): Promise<ArticleUpdate>;
}

export function createArticleService(store: ArticleStore) {
  return {
    show: store.read,
    async update({ id, title }: { id: ArticleId; title: ArticleTitle }): Promise<ArticleUpdate> {
      return store.edit({ id, decide: article => article.metadata.title === title ? { kind: "unchanged" } : { kind: "title", title } });
    },
    async list(status: ArticleStatus | undefined): Promise<ArticleSummary[]> {
      const articles = await store.list();
      return articles
        .filter(article => status === undefined || article.metadata.status === status)
        .sort((a, b) => b.metadata.publishedAt.getTime() - a.metadata.publishedAt.getTime() || a.id.localeCompare(b.id))
        .map(article => ({ id: article.id, title: article.metadata.title, status: article.metadata.status, publishedAt: article.metadata.publishedAt.toISOString() }));
    },
  };
}
