import { Section, Metadata } from "../presentation.js";
import type { CommandResult } from "../result.js";
export function AuthView({
  data,
}: {
  data: Extract<CommandResult, { kind: "auth" }>["data"];
}) {
  return data.authenticated ? (
    <>
      <Section title={`已授权 ${data.name}`} summary="设备授权" />
      <Metadata
        fields={[
          ["服务", data.server],
          ["到期", data.expiresAt],
        ]}
      />
    </>
  ) : (
    <>
      <Section title="设备授权已撤销" />
      <Metadata fields={[["服务", data.server]]} />
    </>
  );
}
