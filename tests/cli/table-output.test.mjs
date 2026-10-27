import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import stringWidth from "string-width";
import { installedCli, runCli } from "../helpers/support.mjs";
import { remoteFixture } from "../helpers/remote-support.mjs";
import { skillFixture } from "../helpers/skill-support.mjs";

const execute = promisify(execFile);
async function terminal(args, options, width, color = false) {
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
      env: {
        ...process.env,
        ...options.env,
        TERM: "xterm-256color",
        NO_COLOR: color ? undefined : "1",
      },
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
  const lines = output.split("\n");
  const rule = lines.findIndex((line) => /^  ─+(?:  ─+)+$/u.test(line));
  if (rule < 0) {
    const rows = [];
    let headings = [];
    let values = [];
    for (const line of lines) {
      assert.ok(stringWidth(line) <= width, line);
      if (!line.trim()) {
        if (values.length) rows.push(values);
        values = [];
        continue;
      }
      const field = /^  (\S(?:.*?\S)?) {2,}(.*)$/u.exec(line);
      if (field) {
        if (!rows.length) headings.push(field[1]);
        else assert.equal(field[1], headings[values.length]);
        values.push(field[2]);
      } else if (values.length && /^ {4,}\S/u.test(line)) {
        values[values.length - 1] += line.trim();
      } else if (rows.length || values.length) break;
    }
    if (values.length) rows.push(values);
    assert.ok(rows.length > 0, output);
    return [headings, ...rows];
  }
  assert.ok(rule > 0, output);
  const widths = lines[rule]
    .slice(2)
    .split("  ")
    .map((cell) => cell.length);
  const actualWidth = stringWidth(lines[rule]);
  assert.ok(actualWidth <= width, output);
  const rows = [];
  let current = [];
  function append(line) {
    assert.ok(stringWidth(line) <= actualWidth, line);
    line += " ".repeat(actualWidth - stringWidth(line));
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        line.slice(2),
      ),
    ].map((entry) => entry.segment);
    const values = [];
    for (const [column, width] of widths.entries()) {
      let value = "";
      let used = 0;
      while (segments.length && used < width) {
        const segment = segments.shift();
        used += stringWidth(segment);
        value += segment;
      }
      assert.equal(used, width);
      values.push(value.trim());
      if (column < widths.length - 1)
        if (segments.splice(0, 2).join("") !== "  ") return false;
    }
    values.forEach((value, column) => {
      current[column] = (current[column] ?? "") + value;
    });
    return true;
  }
  append(lines[rule - 1]);
  rows.push(current);
  current = [];
  for (const line of lines.slice(rule + 1)) {
    if (!line) {
      if (current.length) rows.push(current);
      current = [];
    } else if (line.startsWith("  ") && stringWidth(line) <= actualWidth) {
      if (!append(line)) break;
    } else break;
  }
  if (current.length) rows.push(current);
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
    assert.ok(!output.includes("文章列表"), output);
    assert.deepEqual(rows[0], [
      "Title",
      "Status",
      "Published",
      "Article ID",
      "Version",
    ]);
    assert.ok(rows[1][3].includes(data.items[0].id));
    assert.ok(rows[1][3].includes(data.items[0].shortId));
    assert.equal(rows[1][0].normalize("NFC"), title.normalize("NFC"));
    assert.equal(rows[1][1], "草稿");
    assert.equal(rows[1][2], "未发布");
    assert.equal(rows[1][4], data.items[0].revision);
    assert.match(output, /下一页：2/);
    assert.ok(
      output.includes("👩🏽‍💻"),
      "graphemes must remain intact when wrapped",
    );
  }
  const shown = await runCli(["blog", "show", data.items[0].id], options);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes(data.items[0].id));
  assert.ok(shown.stdout.includes(data.items[0].revision));
  assert.ok(shown.stdout.endsWith("正文\n"));
});

test("installed skill tables retain source, installation state, failures and empty state", async (t) => {
  const f = await skillFixture(t);
  const description = "中文说明é👨‍👩‍👧‍👦".repeat(5) + "\u001b[31m红色文本\u001b[0m";
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": `---\nname: speckit\ndescription: ${JSON.stringify(description)}\n---\n`,
  });
  for (const source of [
    "69aa892db28d0aba0f5ed47e/yoho-standard-readme",
    "69aa892db28d0aba0f5ed47e/yoho-retro-poster",
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
    assert.deepEqual(rows[0], [
      "Skill",
      "Source",
      "Status",
      "Version",
      "Location",
    ]);
    assert.equal(rows[1][0], "speckit");
    assert.equal(rows[1][1], "69aa892db28d0aba0f5ed47e/yoho-speckit");
    assert.equal(rows[1][2], "installed");
    assert.equal(rows[1][3], "未标注");
    const location = rows[1][4].replaceAll(" ", "");
    assert.ok(location.includes("✓installed"));
    assert.ok(location.includes("notinstalled"));
    assert.ok(
      location.includes(
        join(f.project, ".agents/skills/speckit").replaceAll(" ", ""),
      ),
    );
    assert.match(output, /Total: 1 · 1 installed · 0 not installed/);
    assert.ok(!output.includes("Skill 列表"), output);
    assert.ok(!output.includes("安装：yoho"), output);
  }
  const json = await f.command(["list", "--target", "agents"]);
  assert.equal(json.data.items[0].description, description);
  assert.equal(json.data.items[0].targets[0].installed, true);
  await f.command([
    "source",
    "add",
    "69aa892db28d0aba0f5ed47e/yoho-retro-poster",
  ]);
  const colored = await terminal(["skill", "list"], f.options, 80, true);
  assert.match(colored, /\u001b\[32minstalled\u001b\[(?:0|39)m/u);
  assert.match(colored, /\u001b\[37mnot installed\u001b\[(?:0|39)m/u);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-retro-poster",
  ]);
  assert.ok(
    /\u001b\[(?:1;36m|1m\u001b\[36m)/u.test(colored),
    "interactive headers should use the accent color",
  );
  assert.ok(
    !colored.includes("\u001b[31m"),
    "source descriptions cannot inject their own terminal colors",
  );
  const sources = await terminal(["skill", "source", "list"], f.options, 80);
  assert.ok(!sources.includes("Skill 来源"), sources);
  assert.match(sources, /Total: 1/);
  assert.equal(
    tableRows(sources, 80)[1][1],
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  );
  f.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit").status = 503;
  const unavailable = await terminal(["skill", "list"], f.options, 80);
  const unavailableRows = tableRows(unavailable, 80);
  assert.equal(unavailableRows[1][2], "installed");
  assert.match(unavailable, /Codeup Git 读取失败/);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  const empty = await runCli(["skill", "list"], f.options);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /暂无 Skill 条目/);
});

test("article bodies cannot inject terminal colors or hyperlinks while JSON preserves the original content", async (t) => {
  const api = await remoteFixture(t);
  const options = api.options(await api.device());
  const content =
    "正文\n\u001b[31mInjected color\u001b[0m\n\u001b]8;;https://untrusted.example\u0007Visible link\u001b]8;;\u0007\n";
  const response = await fetch(`${api.url}/v1/articles`, {
    method: "POST",
    headers: { cookie: api.cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "终端正文", description: "说明", content }),
  });
  assert.equal(response.status, 201);
  const article = await response.json();
  const output = await terminal(
    ["blog", "show", article.id],
    options,
    100,
    true,
  );
  assert.ok(output.includes("Injected color"));
  assert.ok(output.includes("Visible link"));
  assert.ok(!output.includes("\u001b[31m"), output);
  assert.ok(!output.includes("\u001b]8;"), output);
  const json = await runCli(["blog", "show", article.id, "--json"], options);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).data.content, content);
});
