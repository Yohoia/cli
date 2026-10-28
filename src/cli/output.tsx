import type { WriteStream } from "node:tty";
import type { CommandResult } from "./result.js";
import { Section, Metadata, renderUi } from "./presentation.js";
import { SkillView } from "./views/skill-view.js";
import { BlogView } from "./views/blog-view.js";
import { AuthView } from "./views/auth-view.js";
import { DoctorView } from "./views/doctor-view.js";
function Output({ result, width }: { result: CommandResult; width: number }) {
  switch (result.kind) {
    case "doctor":
      return <DoctorView data={result.data} width={width} />;
    case "skills":
      return <SkillView data={result.data} width={width} />;
    case "list":
    case "show":
    case "write":
    case "delete-preview":
    case "operation":
      return <BlogView result={result} width={width} />;
    case "auth":
      return <AuthView data={result.data} />;
    case "config":
      return (
        <>
          <Section title="服务配置" />
          <Metadata fields={[["默认服务", result.data.server]]} />
        </>
      );
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
export function renderText(
  result: CommandResult,
  width = process.stdout.columns ?? 100,
  stream: WriteStream = process.stdout,
): string {
  return renderUi(
    <Output result={result} width={Math.max(6, width - 4)} />,
    width,
    stream,
  );
}
