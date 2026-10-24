import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import stringWidth from "string-width";
import { installedCli, runCli } from "./support.mjs";
import { remoteFixture } from "./remote-support.mjs";
import { skillFixture } from "./skill-support.mjs";

const execute = promisify(execFile);
async function terminal(args, options, width) {
  const script = `
import os, sys, json, pty, fcntl, termios, struct, subprocess, select, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, int(sys.argv[2]), 0, 0))
child = subprocess.Popen(json.loads(sys.argv[1]), stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
output = b''
deadline = time.monotonic() + 10
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if child.poll() is None:
        child.kill()
    _, errors = child.communicate()
    print(json.dumps({'code': child.returncode, 'stdout': output.decode(), 'stderr': errors.decode()}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
`;
  const { stdout } = await execute(
    "python3",
    [
      "-c",
      script,
      JSON.stringify([process.execPath, await installedCli(), ...args]),
      String(width),
    ],
    {
      ...options,
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
      timeout: 15000,
      maxBuffer: 4_000_000,
    },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  return out.stdout.replace(/\r\n/g, "\n");
}

function tableRows(output, width) {
  assert.ok(!output.includes("\t"), "tables must not use tab stops");
  assert.ok(
    !output.includes("\u001b"),
    "data must not inject terminal control codes",
  );
  const lines = output.split("\n").filter((line) => /^[┌├│└]/u.test(line));
  assert.ok(lines.length > 3, output);
  const actualWidth = stringWidth(lines[0]);
  assert.ok(
    actualWidth <= width,
    `table width ${actualWidth} exceeds ${width}`,
  );
  const rows = [];
  let current = [];
  for (const line of lines) {
    assert.equal(stringWidth(line), actualWidth, line);
    if (line.startsWith("│")) {
      line
        .slice(1, -1)
        .split("│")
        .forEach((cell, column) => {
          current[column] = (current[column] ?? "") + cell.trim();
        });
    } else if (current.length) {
      rows.push(current);
      current = [];
    }
  }
  return rows;
}

test("installed blog list renders aligned tables in real terminals and keeps JSON complete", async (t) => {
  const api = await remoteFixture(t);
  const options = api.options(await api.device());
  const empty = await runCli(["blog", "list"], options);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /暂无文章/);
  const title = "中文标题与组合字符é及表情👩🏽‍💻".repeat(4);
  for (const name of ["简单标题", title]) {
    const response = await fetch(`${api.url}/v1/articles`, {
      method: "POST",
      headers: { cookie: api.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: name,
        content: "正文",
        description: "说明",
      }),
    });
    assert.equal(response.status, 201, await response.text());
  }
  const data = JSON.parse(
    (await runCli(["blog", "list", "--json"], options)).stdout,
  ).data;
  assert.equal(data.items.length, 2);
  assert.ok(
    data.items.every((item) => item.id && item.revision && item.content),
  );
  for (const width of [80, 50]) {
    const output = await terminal(
      ["blog", "list", "--page-size", "1"],
      options,
      width,
    );
    const rows = tableRows(output, width);
    assert.deepEqual(rows[0], ["文章 ID", "标题", "状态", "发布时间", "版本"]);
    assert.ok(rows[1][0].includes(data.items[0].id));
    assert.ok(rows[1][0].includes(data.items[0].shortId));
    assert.equal(rows[1][1], title);
    assert.equal(rows[1][2], "草稿");
    assert.equal(rows[1][3], "未发布");
    assert.equal(rows[1][4], data.items[0].revision);
    assert.match(output, /下一页：2/);
    assert.ok(
      output.includes("👩🏽‍💻"),
      "graphemes must remain intact when wrapped",
    );
  }
});

test("installed skill tables retain source, installation state, failures and empty state", async (t) => {
  const f = await skillFixture(t);
  const description = "中文说明é👨‍👩‍👧‍👦".repeat(5) + "\u001b[31m红色文本\u001b[0m";
  await f.repo("yohoia/yoho-speckit", "speckit", {
    "SKILL.md": `---\nname: speckit\ndescription: ${JSON.stringify(description)}\n---\n`,
  });
  for (const source of [
    "yohoia/yoho-standard-readme",
    "yohoia/yoho-retro-poster",
  ])
    await f.command(["source", "remove", source]);
  await f.command(["install", "speckit", "--target", "agents"]);
  for (const width of [80, 50]) {
    const output = await terminal(
      ["skill", "list", "--target", "agents", "--target", "claude"],
      f.options,
      width,
    );
    const rows = tableRows(output, width);
    assert.deepEqual(rows[0], ["Skill", "来源", "状态", "说明", "安装位置"]);
    assert.equal(rows[1][0], "speckit");
    assert.equal(rows[1][1], "yohoia/yoho-speckit");
    assert.equal(rows[1][2], "可安装");
    assert.equal(rows[1][3], description.replace(/\u001b\[\d+m/g, ""));
    const location = rows[1][4].replaceAll(" ", "");
    assert.ok(location.includes("✓已安装"));
    assert.ok(location.includes("未安装"));
    assert.ok(
      location.includes(
        join(f.project, ".agents/skills/speckit").replaceAll(" ", ""),
      ),
    );
    assert.match(output, /已知 Skill 数：1/);
  }
  const json = await f.command(["list", "--target", "agents"]);
  assert.equal(json.data.items[0].description, description);
  assert.equal(json.data.items[0].targets[0].installed, true);
  f.repos.get("yohoia/yoho-speckit").status = 503;
  const unavailable = await terminal(["skill", "list"], f.options, 80);
  const unavailableRows = tableRows(unavailable, 80);
  assert.equal(unavailableRows[1][2], "不可用");
  assert.ok(unavailableRows[1][3].includes("503"));
  await f.command(["source", "remove", "yohoia/yoho-speckit"]);
  const empty = await runCli(["skill", "list"], f.options);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /暂无 Skill 条目/);
});
