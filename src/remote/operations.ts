import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { configDirectory } from "./config.js";
import { RemoteClient } from "./http.js";
import { outcomeSchema, type OperationOutcome } from "./models.js";
import { AppError } from "../core/errors.js";
const common = {
  requestId: z.uuid(),
  server: z.string(),
  createdAt: z.iso.datetime(),
};
const recordSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("create"), fingerprint: z.string() }),
  z.object({
    ...common,
    kind: z.enum(["publish", "delete"]),
    id: z.string(),
    revision: z.string(),
  }),
]);
export type OperationRecord = z.infer<typeof recordSchema>;
function pathFor(server: string, id: string): string {
  return join(
    configDirectory(),
    "operations",
    createHash("sha256").update(server).digest("hex"),
    `${z.uuid().parse(id)}.json`,
  );
}
export async function saveOperation(record: OperationRecord): Promise<void> {
  const path = pathFor(record.server, record.requestId);
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
export async function readOperation(
  server: string,
  id: string,
): Promise<OperationRecord> {
  try {
    const record = recordSchema.parse(
      JSON.parse(await readFile(pathFor(server, id), "utf8")),
    );
    if (record.server !== server || record.requestId !== id)
      throw new Error("Record mismatch");
    if (Date.now() - Date.parse(record.createdAt) >= 7 * 24 * 60 * 60 * 1000)
      throw new AppError({
        code: "OPERATION_EXPIRED",
        message:
          "本地操作记录已超过七天恢复窗口，请查询服务器结果或人工核对；不能重用此编号重新执行",
        exitCode: 5,
      });
    return record;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "OPERATION_RECORD_NOT_FOUND",
      message:
        "找不到此服务的本地操作记录；请先通过 blog operation 查询服务器结果",
      exitCode: 5,
    });
  }
}
function completed(outcome: OperationOutcome) {
  if (outcome.status === "succeeded")
    return { requestId: outcome.requestId, ...outcome.result };
  if (outcome.status === "failed")
    throw new AppError({
      code: outcome.error.code.toUpperCase(),
      message: outcome.error.message,
      exitCode: 3,
    });
  throw unknownResult(outcome.requestId, false);
}
function unknownResult(id: string, cancelled: boolean) {
  return new AppError({
    code: "RESULT_UNKNOWN",
    message: `操作结果未知，请运行 yoho blog operation ${id} 查询；恢复时使用同一编号，不能重新 create 冒充重试。${cancelled ? "操作曾被取消，但服务器可能已提交。" : ""}`,
    exitCode: cancelled ? 130 : 5,
  });
}
export async function queryOperation(client: RemoteClient, id: string) {
  return outcomeSchema.parse(
    await client.request(`/v1/cli/operations/${z.uuid().parse(id)}`),
  );
}
export async function performOperation(
  client: RemoteClient,
  record: OperationRecord,
  payload?: unknown,
) {
  const path =
    record.kind === "create"
      ? "/v1/cli/articles"
      : `/v1/cli/articles/${encodeURIComponent(record.id)}${record.kind === "publish" ? "/publish" : ""}`;
  try {
    const headers = {
      "x-request-id": record.requestId,
      ...(record.kind === "create" ? {} : { "if-match": record.revision }),
    };
    const response =
      record.kind === "delete"
        ? await client.request(path, { method: "DELETE", headers })
        : await client.json(
            path,
            "POST",
            record.kind === "create" ? payload : {},
            headers,
          );
    return completed(outcomeSchema.parse(response));
  } catch (error) {
    if (
      error instanceof AppError &&
      error.exitCode !== 5 &&
      !client.signal.aborted
    )
      throw error;
    try {
      const recoveryClient = new RemoteClient(
        client.server,
        AbortSignal.timeout(5000),
        client.token,
      );
      return completed(await queryOperation(recoveryClient, record.requestId));
    } catch (error) {
      if (
        error instanceof AppError &&
        !["NETWORK_ERROR", "OPERATION_UNKNOWN", "RESULT_UNKNOWN"].includes(
          error.code,
        )
      )
        throw error;
      throw unknownResult(record.requestId, client.signal.aborted);
    }
  }
}
