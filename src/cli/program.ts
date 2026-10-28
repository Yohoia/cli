import { Command, CommanderError } from "commander";
import manifest from "../../package.json" with { type: "json" };
import { AppError } from "../core/errors.js";
import { resolveServer } from "../remote/config.js";
import { requireToken } from "../remote/credentials.js";
import { RemoteClient } from "../remote/http.js";
import { registerAuth } from "./commands/auth.js";
import { registerBlog } from "./commands/blog.js";
import { registerConfig } from "./commands/config.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSkills } from "./commands/skills.js";
import { optionsSchema, type CommandContext } from "./commands/context.js";
import type { CommandResult } from "./result.js";
import { paint } from "./presentation.js";
export async function runProgram({
  argv,
  signal,
}: {
  argv: string[];
  signal: AbortSignal;
}): Promise<CommandResult | undefined> {
  const optionArguments = argv.slice(
    0,
    argv.indexOf("--") === -1 ? undefined : argv.indexOf("--"),
  );
  if (
    optionArguments.some(
      (argument) =>
        argument === "--project" || argument.startsWith("--project="),
    ) ||
    (optionArguments[0] === "blog" && optionArguments[1] === "update")
  ) {
    throw new AppError({
      code: "LOCAL_MODE_REMOVED",
      message:
        "本地文章管理已迁移为远程 PageHush API。使用 yoho blog list 查询、yoho blog create <path.md> 上传草稿；修改已有文章请使用 PageHush 网页。",
      exitCode: 2,
    });
  }
  let result: CommandResult | undefined;
  async function client(command: Command) {
    const options = optionsSchema.parse(command.optsWithGlobals());
    const server = await resolveServer(options.server);
    return new RemoteClient(server, signal, await requireToken(server));
  }
  const program = new Command()
    .name("yoho")
    .version(manifest.version)
    .option("--server <url>", "PageHush 服务地址")
    .option("--json", "输出 JSON 结果")
    .configureHelp({
      styleTitle: (value) => paint(value, "strong"),
      styleOptionTerm: (value) => paint(value, "accent"),
      styleSubcommandTerm: (value) => paint(value, "strong"),
    })
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  const context: CommandContext = {
    signal,
    client,
    publish: (value) => {
      result = value;
    },
  };
  registerAuth(program, context);
  registerSkills(program, context);
  registerConfig(program, context);
  registerDoctor(program, context);
  registerBlog(program, context);
  const launch = async (page?: "blog" | "skill") => {
    const options = optionsSchema.parse(program.opts());
    if (options.json)
      throw new AppError({
        code: "INVALID_ARGUMENT",
        message: "JSON 调用请指定业务子命令；交互界面使用 yoho",
        exitCode: 2,
      });
    if (
      !process.stdin.isTTY ||
      !process.stdout.isTTY ||
      process.env.TERM === "dumb"
    ) {
      (page
        ? program.commands.find((command) => command.name() === page)
        : program
      )?.outputHelp();
      return;
    }
    const { interactive } = await import("./interactive/app.js");
    await interactive(signal, {
      ...(page ? { page } : {}),
      ...(options.server ? { server: options.server } : {}),
    });
  };
  program.action(() => launch());
  for (const page of ["blog", "skill"] as const)
    program.commands
      .find((command) => command.name() === page)
      ?.action(() => launch(page));
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return undefined;
      throw new AppError({
        code: "INVALID_ARGUMENT",
        message: error.message,
        exitCode: 2,
      });
    }
    throw error;
  }
  return result;
}
