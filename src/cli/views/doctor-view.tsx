import type { DoctorReport, DiagnosticCheck } from "../../core/diagnostics.js";
import { Note, Section } from "../presentation.js";
import { Table } from "../table.js";

const labels = { pass: "通过", warn: "待验证", fail: "失败" };
const tones = { pass: "success", warn: "warning", fail: "error" } as const;

export function DoctorView({
  data,
  width,
}: {
  data: DoctorReport;
  width: number;
}) {
  return (
    <>
      <Section title="环境诊断" />
      <Table<DiagnosticCheck>
        rows={data.checks}
        width={width}
        columns={[
          { heading: "Check", maxWidth: 14, value: (check) => check.name },
          {
            heading: "Status",
            maxWidth: 8,
            value: (check) => labels[check.status],
            tone: (check) => tones[check.status],
          },
          { heading: "Details", maxWidth: 100, value: (check) => check.detail },
        ]}
      />
      <Note>只读本机检查；不会登录、访问远程服务或修改配置。</Note>
    </>
  );
}
