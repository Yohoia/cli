import { z } from "zod";

export const articleStatusSchema = z.enum(["draft", "published", "archived"]);
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
export type Article = { id: string; path: string; metadata: ArticleMetadata; content: string };
export type ArticleSummary = { id: string; title: string; status: ArticleStatus; publishedAt: string };

export interface ArticleStore {
  list(): Promise<Article[]>;
}

export function createArticleService(store: ArticleStore) {
  return {
    async list(status: ArticleStatus | undefined): Promise<ArticleSummary[]> {
      const articles = await store.list();
      return articles
        .filter(article => status === undefined || article.metadata.status === status)
        .sort((a, b) => b.metadata.publishedAt.getTime() - a.metadata.publishedAt.getTime() || a.id.localeCompare(b.id))
        .map(article => ({ id: article.id, title: article.metadata.title, status: article.metadata.status, publishedAt: article.metadata.publishedAt.toISOString() }));
    },
  };
}
