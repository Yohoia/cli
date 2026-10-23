#!/usr/bin/env node
import { runProgram } from "../cli/program.js";
import { normalizeError } from "../core/errors.js";

async function main(): Promise<void> {
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
const argv = process.argv.slice(2);
const json = argv.slice(0, argv.indexOf("--") === -1 ? undefined : argv.indexOf("--")).includes("--json");

try {
  const result = await runProgram({ argv, signal: controller.signal });
  if (result) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, data: result.data })}\n`);
    else process.stdout.write(`${result.data.items.map(item => `${item.id}\t${item.status}\t${item.publishedAt.slice(0, 10)}\t${item.title}`).join("\n")}\n`);
  }
} catch (error) {
  const failure = normalizeError(error, controller.signal);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`);
  else process.stderr.write(`${failure.code}: ${failure.message}\n`);
  process.exitCode = failure.exitCode;
} finally {
  process.removeListener("SIGINT", cancel);
}
}

void main();
