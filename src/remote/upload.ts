import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { readDocument } from "./document.js";
import { RemoteClient, remoteResponse } from "./http.js";
import { AppError } from "../core/errors.js";
type Document = Awaited<ReturnType<typeof readDocument>>;
const assetSchema = z.object({
  id: z.uuid(),
  url: z.string().regex(/^\/v1\/assets\/[0-9a-f-]+\/content$/i),
});
function assetRequestId(operationId: string, hash: string): string {
  const bytes = createHash("sha256").update(`${operationId}:${hash}`).digest();
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function uploadImages(
  client: RemoteClient,
  requestId: string,
  document: Document,
) {
  const replacements: { start: number; end: number; url: string }[] = [];
  for (const image of document.images) {
    const form = new FormData();
    form.set("kind", "inline_image");
    form.set(
      "file",
      new Blob([Uint8Array.from(image.bytes)], { type: image.mime }),
      basename(image.path),
    );
    try {
      const asset = remoteResponse(
        assetSchema,
        await client.request(`/v1/cli/uploads/${requestId}/assets`, {
          method: "POST",
          headers: {
            "x-asset-id": assetRequestId(requestId, image.hash),
            "x-content-sha256": image.hash,
          },
          body: form,
        }),
      );
      for (const reference of image.references)
        replacements.push({ ...reference, url: asset.url });
    } catch (error) {
      if (error instanceof AppError && error.exitCode === 4) throw error;
      throw new AppError({
        code: "IMAGE_UPLOAD_FAILED",
        message: `图片上传未完成，尚未提交文章。请求编号：${requestId}；请使用 yoho blog resume ${requestId} <原文档路径> 恢复`,
        exitCode: client.signal.aborted ? 130 : 5,
      });
    }
  }
  let content = document.payload.content;
  for (const reference of replacements.sort((a, b) => b.start - a.start))
    content =
      content.slice(0, reference.start) +
      reference.url +
      content.slice(reference.end);
  return { ...document.payload, content };
}
