#!/usr/bin/env node
import { runProgram } from "../cli/program.js";
import { renderText } from "../cli/output.js";
import { normalizeError } from "../core/errors.js";
import { SkillOperationError } from "../skills/model.js";
import { feedback } from "../cli/presentation.js";

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const argv = process.argv.slice(2);
  const json = argv
    .slice(0, argv.indexOf("--") === -1 ? undefined : argv.indexOf("--"))
    .includes("--json");

  try {
    const result = await runProgram({ argv, signal: controller.signal });
    if (result) {
      if (json)
        process.stdout.write(
          `${JSON.stringify({ ok: true, data: result.data })}\n`,
        );
      else process.stdout.write(renderText(result));
    }
  } catch (error) {
    const failure = normalizeError(error, controller.signal);
    if (json)
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message }, ...(failure.data === undefined ? {} : { data: failure.data }) })}\n`,
      );
    else {
      if (failure instanceof SkillOperationError)
        process.stderr.write(
          renderText(
            { kind: "skills", data: failure.result },
            process.stderr.columns ?? 100,
            process.stderr,
          ),
        );
      process.stderr.write(
        feedback(
          `${failure.code}: ${failure.message}`,
          "error",
          process.stderr.columns ?? 100,
          process.stderr,
        ),
      );
    }
    process.exitCode = failure.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

void main();
