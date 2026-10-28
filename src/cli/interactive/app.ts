import { z } from "zod";
import stringWidth from "string-width";
import { homedir } from "node:os";
import manifest from "../../../package.json" with { type: "json" };
import { normalizeError } from "../../core/errors.js";
import { articleSchema, listSchema } from "../../remote/model.js";
import { resolveServer } from "../../remote/config.js";
import type { CatalogItem, SkillResult } from "../../skills/model.js";
import { cleanText, wrapText } from "../presentation.js";
import { Terminal, color, fit, pad, type Key } from "./terminal.js";
import { command, type CommandResponse } from "./command.js";
import {
  listState,
  visibleRows,
  type ListState,
  type Page,
  type Row,
} from "./model.js";

const back = (key: Key) =>
  key.name === "escape" ||
  (key.name === "text" && key.text.toLowerCase() === "q");
const letter = (key: Key) =>
  key.name === "text" ? key.text.toLowerCase() : "";
const titleFor = { blog: "Blog", skill: "Skills", sources: "Skill Sources" };
const countVersion = (version?: string) =>
  version ? (version.startsWith("v") ? version : `v${version}`) : "未标注";

class InteractiveApp {
  private terminal: Terminal;
  private global: string[];
  constructor(
    private signal: AbortSignal,
    server?: string,
  ) {
    this.terminal = new Terminal(signal);
    this.global = server ? ["--server", server] : [];
  }
  private lines(text: string) {
    return wrapText(cleanText(text), this.terminal.width - 4).map(
      (line) => " " + line,
    );
  }
  private async run(args: string[], title: string): Promise<CommandResponse> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.signal]);
    let result: CommandResponse | undefined;
    let diagnostics = "";
    let ticks = 0;
    const draw = () =>
      this.terminal.frame(
        title,
        [
          " " +
            color(
              ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
                ticks++ % 10
              ] ?? "⠋",
              "cyan",
            ) +
            " " +
            (controller.signal.aborted
              ? "正在取消，等待操作清理…"
              : "正在处理…"),
          "",
          ...this.lines(diagnostics).slice(-(this.terminal.height - 8)),
        ],
        "Esc / Q Cancel  |  Ctrl+C Quit",
      );
    draw();
    const timer = setInterval(draw, 100);
    const pending = command([...this.global, ...args], signal, (text) => {
      diagnostics = text;
      draw();
    })
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        const failure = normalizeError(error, signal);
        result = {
          ok: false,
          error: { code: failure.code, message: failure.message },
        };
      })
      .finally(() => this.terminal.notify());
    // Input remains owned by the app while the command drains and restores files.
    try {
      while (!result) {
        const key = await this.terminal.read();
        if (back(key)) controller.abort();
      }
    } finally {
      controller.abort();
      await pending;
      clearInterval(timer);
    }
    this.terminal.discardInput();
    this.signal.throwIfAborted();
    return result;
  }
  private resultLines(result: CommandResponse): string[] {
    const lines: string[] = [];
    if (result.error)
      lines.push(`${result.error.code}: ${result.error.message}`, "");
    const data = result.data as
      | {
          items?: {
            name?: string;
            repo?: string;
            path?: string;
            status: string;
            message?: string;
          }[];
          requestId?: string;
          article?: { title: string };
          changed?: boolean;
        }
      | undefined;
    if (data?.items)
      for (const item of data.items) {
        lines.push(`${item.status}  ${item.name ?? item.repo ?? ""}`);
        if (item.path) lines.push(`  ${item.path}`);
        if (item.message) lines.push(`  ${item.message}`);
        lines.push("");
      }
    else if (data?.article)
      lines.push(
        data.article.title,
        data.changed ? "操作已完成" : "未修改",
        `请求编号：${data.requestId ?? ""}`,
      );
    else if (data !== undefined) lines.push(JSON.stringify(data, null, 2));
    if (!lines.length) lines.push(result.ok ? "操作已完成" : "操作失败");
    return lines;
  }
  private async textPage(
    title: string,
    text: string,
    controls = "↑↓ Scroll  |  H/L Page  |  Enter / Q Back",
    actions: Record<string, () => Promise<void>> = {},
  ) {
    let offset = 0;
    for (;;) {
      const lines = this.lines(text);
      const height = this.terminal.contentHeight(controls);
      offset = Math.max(0, Math.min(offset, lines.length - height));
      this.terminal.frame(
        title,
        lines.slice(offset, offset + height),
        controls,
        lines.length > height
          ? `${offset + 1}–${Math.min(offset + height, lines.length)} / ${lines.length}`
          : "",
      );
      const key = await this.terminal.read();
      if (back(key)) return false;
      if (key.name === "enter") return true;
      const value = letter(key);
      if (key.name === "up" || value === "k") offset--;
      if (key.name === "down" || value === "j") offset++;
      if (key.name === "pageup" || value === "h") offset -= height;
      if (key.name === "pagedown" || value === "l") offset += height;
      if (actions[value]) {
        await actions[value]();
        return true;
      }
    }
  }
  private async result(title: string, response: CommandResponse) {
    await this.textPage(
      response.ok ? title : `${title} · 操作未完成`,
      this.resultLines(response).join("\n"),
    );
  }
  private async input(
    title: string,
    label: string,
    initial = "",
  ): Promise<string | undefined> {
    let value = initial;
    for (;;) {
      this.terminal.frame(
        title,
        [
          " " + label,
          "",
          " " +
            color(fit(value || " ", this.terminal.width - 4), "cyan") +
            color("▏", "cyan"),
        ],
        "Type to edit  |  Enter Save  |  Esc Cancel",
      );
      const key = await this.terminal.read();
      if (key.name === "escape") return undefined;
      if (key.name === "enter") return value.trim();
      if (key.name === "backspace")
        value = Array.from(value).slice(0, -1).join("");
      else if (key.name === "text") value += key.text;
    }
  }
  private async menu(
    title: string,
    choices: { label: string; description: string }[],
    options: { multiple?: boolean; details?: string[]; confirm?: boolean } = {},
  ): Promise<number[] | undefined> {
    let cursor = 0;
    const selected = new Set<number>();
    for (;;) {
      const controls = options.multiple
        ? "↑↓  |  Space Select  |  A All  |  I Invert  |  Enter Continue  |  Q Back"
        : "↑↓  |  Enter Select  |  Q Back";
      const body = [
        ...(options.details?.flatMap((line) => this.lines(line)) ?? []),
        ...(options.details?.length ? [""] : []),
      ];
      for (const [index, choice] of choices.entries()) {
        const marker = options.multiple
          ? selected.has(index)
            ? "●"
            : "○"
          : `${index + 1}.`;
        const row = `${cursor === index ? "➤" : " "} ${marker} ${pad(choice.label, Math.min(23, Math.floor(this.terminal.width / 3)))} ${fit(choice.description, Math.max(1, this.terminal.width - Math.min(23, Math.floor(this.terminal.width / 3)) - 8))}`;
        body.push(cursor === index ? color(row, "cyan") : row);
      }
      this.terminal.frame(
        title,
        body,
        controls,
        options.multiple ? `${selected.size}/${choices.length} selected` : "",
      );
      const key = await this.terminal.read();
      if (back(key)) return undefined;
      const value = letter(key);
      if (key.name === "up" || value === "k") cursor = Math.max(0, cursor - 1);
      if (key.name === "down" || value === "j")
        cursor = Math.min(choices.length - 1, cursor + 1);
      if (options.multiple && value === " ")
        selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
      if (options.multiple && value === "a") {
        const all = selected.size === choices.length;
        selected.clear();
        if (!all) choices.forEach((_, index) => selected.add(index));
      }
      if (options.multiple && value === "i")
        choices.forEach((_, index) =>
          selected.has(index) ? selected.delete(index) : selected.add(index),
        );
      if (key.name === "enter") {
        if (!options.multiple) return [cursor];
        if (selected.size) return [...selected];
      }
      const numeric = Number(value);
      if (
        !options.multiple &&
        /^[1-9]$/u.test(value) &&
        numeric <= choices.length
      )
        return [numeric - 1];
    }
  }
  private async confirm(
    title: string,
    details: string[],
    action: string,
  ): Promise<boolean> {
    if (
      details.flatMap((line) => this.lines(line)).length >
      this.terminal.height - 8
    ) {
      if (
        !(await this.textPage(
          title,
          details.join("\n"),
          "↑↓ Scroll  |  H/L Page  |  Enter Continue  |  Q Cancel",
        ))
      )
        return false;
      details = ["已预览以上目标。请选择操作，默认取消。"];
    }
    const selection = await this.menu(
      title,
      [
        { label: "取消", description: "返回列表" },
        { label: action, description: "执行以上操作" },
      ],
      { details },
    );
    return selection?.[0] === 1;
  }
  private async load(page: Page, state: ListState) {
    let rows: Row[] = [];
    if (page === "blog") {
      let next: number | null = 1;
      const seen = new Set<number>();
      while (next !== null) {
        if (seen.has(next)) {
          state.notice = "服务器分页异常，请刷新重试";
          return;
        }
        seen.add(next);
        const result = await this.run(
          ["blog", "list", "--page", String(next), "--page-size", "200"],
          `Blog · 正在读取第 ${next} 页`,
        );
        if (!result.ok) {
          state.notice = result.error?.message ?? "文章读取失败";
          return;
        }
        const data = listSchema.parse(result.data);
        rows.push(
          ...data.items.map((article) => ({
            id: article.id,
            name: article.title,
            detail: `${article.status === "draft" ? "draft" : "published"} | ${(article.publishedAt ?? article.recordCreatedAt).slice(0, 10)}`,
            search: `${article.title} ${article.id} ${article.shortId ?? ""} ${article.description}`,
            date: article.recordUpdatedAt,
            status: article.status,
            version: article.revision,
            article,
          })),
        );
        next = data.nextPage;
      }
    } else {
      const result = await this.run(
        page === "skill" ? ["skill", "list"] : ["skill", "source", "list"],
        `${titleFor[page]} · 正在读取`,
      );
      if (!result.ok) {
        state.notice = result.error?.message ?? "Skill 读取失败";
        return;
      }
      const data = result.data as SkillResult;
      rows = (data.items as CatalogItem[]).map((skill) => {
        const installed =
          skill.targets?.filter((target) => target.installed) ?? [];
        const version = installed.length
          ? [
              ...new Set(
                installed.map((target) => countVersion(target.version)),
              ),
            ].join(" / ")
          : countVersion(skill.version);
        const status =
          page === "sources"
            ? skill.status === "registered"
              ? "registered"
              : skill.status
            : installed.length
              ? "installed"
              : "not installed";
        return {
          id: skill.repo,
          name: skill.name ?? skill.repo,
          detail: page === "sources" ? skill.repo : `${version} | ${status}`,
          search: `${skill.name ?? ""} ${skill.repo} ${skill.description ?? ""}`,
          date: "",
          status,
          version,
          skill,
        };
      });
    }
    state.rows = [...new Map(rows.map((row) => [row.id, row])).values()];
    state.selected = new Set(
      [...state.selected].filter((id) =>
        state.rows.some((row) => row.id === id),
      ),
    );
    state.notice = "";
  }
  private selected(state: ListState): Row[] {
    const rows = visibleRows(state);
    return state.selected.size
      ? rows.filter((row) => state.selected.has(row.id))
      : rows[state.cursor]
        ? [rows[state.cursor]!]
        : [];
  }
  private async articleAction(action: "publish" | "delete", rows: Row[]) {
    const prepared: {
      id: string;
      title: string;
      revision: string;
      status: string;
    }[] = [];
    for (const row of rows) {
      const response = await this.run(
        action === "delete"
          ? ["blog", "delete", row.id, "--dry-run"]
          : ["blog", "show", row.id],
        "Blog · 正在核对文章版本",
      );
      if (!response.ok) {
        await this.result("核对文章", response);
        return;
      }
      const article = z
        .object({
          id: z.string(),
          title: z.string(),
          revision: z.string(),
          status: z.string(),
        })
        .parse(response.data);
      prepared.push(article);
    }
    const verb = action === "delete" ? "删除" : "发布";
    const details = prepared.flatMap((article) => [
      `${article.title} · ${article.status}`,
      `ID: ${article.id}`,
      `Version: ${article.revision}`,
      "",
    ]);
    if (
      !(await this.confirm(
        `${verb} ${prepared.length} 篇文章`,
        [
          ...details,
          action === "delete"
            ? "软删除后文章将从正常读取中隐藏。"
            : "发布后文章可在博客公开展示。",
        ],
        `确认${verb}`,
      ))
    )
      return;
    const results: string[] = [];
    for (const [index, article] of prepared.entries()) {
      const result = await this.run(
        [
          "blog",
          action,
          article.id,
          "--if-match",
          article.revision,
          ...(action === "delete" ? ["--yes"] : []),
        ],
        `${verb}文章 · ${index + 1}/${prepared.length}`,
      );
      results.push(...this.resultLines(result), "");
      if (
        result.error?.code === "RESULT_UNKNOWN" ||
        result.error?.code === "CANCELLED"
      )
        break;
    }
    await this.textPage(`${verb}结果`, results.join("\n"));
  }
  private async skillAction(
    action: "install" | "update" | "uninstall",
    rows: Row[],
  ) {
    const names = rows.map((row) => row.id);
    let args: string[] = ["skill", action, ...names];
    if (action === "install") {
      const scope = await this.menu(
        "安装范围",
        [
          { label: "当前项目", description: process.cwd() },
          { label: "当前用户", description: "供多个项目使用" },
        ],
        { details: [`当前项目：${process.cwd()}`, `当前用户：${homedir()}`] },
      );
      if (!scope) return;
      const targets = await this.menu(
        "安装目标",
        [
          { label: "Claude Code", description: ".claude/skills" },
          { label: "Codex / Agents", description: ".agents/skills" },
          { label: "Codex 兼容", description: ".codex/skills" },
        ],
        {
          multiple: true,
          details: [`安装到：${scope[0] === 1 ? homedir() : process.cwd()}`],
        },
      );
      if (!targets) return;
      args.push(
        "--scope",
        scope[0] === 1 ? "user" : "project",
        ...targets.flatMap((index) => [
          "--target",
          ["claude", "agents", "codex"][index]!,
        ]),
      );
    } else if (action === "uninstall") {
      const preview = await this.run(
        [...args, "--dry-run"],
        "Skills · 正在预览删除位置",
      );
      if (!preview.ok) {
        await this.result("删除预览", preview);
        return;
      }
      const data = preview.data as SkillResult;
      if (!data.items.length) {
        await this.textPage("Skills", "没有已安装的受管 Skill。");
        return;
      }
      const details = data.items.flatMap((item) => [
        `${item.name ?? item.repo}`,
        "path" in item ? item.path : "",
        item.message ?? "",
        "",
      ]);
      if (
        !(await this.confirm(
          "删除本地 Skill",
          [...details, "将删除以上目录及内容，保留来源登记。"],
          "确认删除",
        ))
      )
        return;
      args.push("--yes");
    } else if (
      !(await this.confirm(
        "更新 Skill",
        [
          ...rows.flatMap((row) => [row.name, row.id]),
          "更新所有已记录安装位置，覆盖本地修改。",
        ],
        "确认更新",
      ))
    )
      return;
    await this.result(
      "Skill 操作结果",
      await this.run(args, `Skills · ${action}`),
    );
  }
  private async open(page: Page, row: Row) {
    if (page === "blog") {
      const result = await this.run(
        ["blog", "show", row.id],
        "Blog · 正在打开文章",
      );
      if (!result.ok) {
        await this.result("文章详情", result);
        return;
      }
      const article = articleSchema.parse(result.data);
      await this.textPage(
        article.title,
        `${article.status} · ${article.language}\nID: ${article.id}\nVersion: ${article.revision}\n\n${article.content}`,
        "↑↓ Scroll  |  H/L Page  |  P Publish  |  D Delete  |  Q Back",
        {
          p: () => this.articleAction("publish", [{ ...row, article }]),
          d: () => this.articleAction("delete", [{ ...row, article }]),
        },
      );
    } else {
      const skill = row.skill;
      await this.textPage(
        row.name,
        [
          row.id,
          "",
          skill?.description ?? "",
          "",
          `Version: ${row.version}`,
          `Status: ${row.status}`,
          skill?.message ?? "",
          "",
          ...(skill?.targets?.flatMap((target) => [
            `${target.installed ? "installed" : "not installed"} · ${countVersion(target.version)}`,
            target.path,
            target.message ?? "",
            "",
          ]) ?? []),
        ].join("\n"),
        page === "skill"
          ? "↑↓ Scroll  |  I Install  |  U Update  |  D Delete  |  Q Back"
          : "↑↓ Scroll  |  Q Back",
        page === "skill"
          ? {
              i: () => this.skillAction("install", [row]),
              u: () => this.skillAction("update", [row]),
              d: () => this.skillAction("uninstall", [row]),
            }
          : {},
      );
    }
  }
  private controls(page: Page, state: ListState): string {
    const action =
      page === "blog"
        ? "Enter Open  |  D Delete  |  P Publish  |  N New"
        : page === "skill"
          ? "Enter Open  |  I Install  |  U Update  |  D Delete  |  M Sources"
          : "Enter Open  |  N Add  |  D Remove";
    return `↑↓ | Space Select | ${action.replaceAll("  |  ", " | ")} | / Search | S ${state.sort === "date" ? "Date" : state.sort === "status" ? "Status" : "Name"} | O ${state.ascending ? "↑" : "↓"} | H/L Page | Q Back | ? More`;
  }
  private async list(page: Page) {
    const state = listState(page);
    let searching = false;
    let originalQuery = "";
    await this.load(page, state);
    for (;;) {
      const rows = visibleRows(state);
      state.cursor = Math.max(0, Math.min(state.cursor, rows.length - 1));
      const controls = searching
        ? "Type to search  |  Enter Apply  |  Esc Cancel"
        : this.controls(page, state);
      // Reserve one line for the query/error without displacing the key legend.
      const height = Math.max(
        1,
        this.terminal.contentHeight(controls) -
          (state.notice || state.search || searching ? 1 : 0),
      );
      const start = Math.floor(state.cursor / height) * height;
      const body: string[] = [];
      if (state.notice)
        body.push(
          " " + color(fit(state.notice, this.terminal.width - 2), "red"),
        );
      else if (state.search || searching)
        body.push(
          " " +
            color(
              `/ ${fit(state.search, this.terminal.width - 6)}${searching ? "▏" : ""}`,
              searching ? "cyan" : "gray",
            ),
        );
      if (!rows.length)
        body.push(
          " " +
            (state.search
              ? "没有匹配项，按 / 修改搜索。"
              : state.notice
                ? "按 R 重试；Q 返回，Auth 菜单可登录。"
                : page === "blog"
                  ? "暂无文章，按 N 上传 Markdown 草稿。"
                  : "暂无 Skill，按 M 管理来源。"),
        );
      const secondary = Math.min(
        page === "sources" ? 58 : 34,
        Math.floor(this.terminal.width * 0.45),
      );
      const natural = Math.max(
        24,
        ...rows.map((row) => stringWidth(cleanText(row.name))),
      );
      const primary = Math.max(
        4,
        Math.min(48, natural, this.terminal.width - secondary - 7),
      );
      for (const [offset, row] of rows.slice(start, start + height).entries()) {
        const index = start + offset;
        const line = `${index === state.cursor ? "➤" : " "} ${state.selected.has(row.id) ? "●" : "○"} ${pad(row.name, primary)} ${fit(row.detail, secondary)}`;
        body.push(
          index === state.cursor
            ? color(line, "cyan")
            : state.selected.has(row.id)
              ? color(line, "green")
              : line,
        );
      }
      this.terminal.frame(
        titleFor[page],
        body,
        controls,
        `${state.selected.size}/${rows.length} selected · ${rows.length ? Math.floor(state.cursor / height) + 1 : 1}/${Math.max(1, Math.ceil(rows.length / height))}`,
      );
      const key = await this.terminal.read();
      if (searching) {
        if (key.name === "escape") {
          state.search = originalQuery;
          searching = false;
        } else if (key.name === "enter") searching = false;
        else if (key.name === "backspace")
          state.search = Array.from(state.search).slice(0, -1).join("");
        else if (key.name === "text") state.search += key.text;
        state.cursor = 0;
        continue;
      }
      if (back(key)) return;
      const value = letter(key);
      if (key.name === "up" || value === "k") state.cursor--;
      else if (key.name === "down" || value === "j") state.cursor++;
      else if (key.name === "left" || key.name === "pageup" || value === "h")
        state.cursor -= height;
      else if (key.name === "right" || key.name === "pagedown" || value === "l")
        state.cursor += height;
      else if (key.name === "home") state.cursor = 0;
      else if (key.name === "end") state.cursor = rows.length - 1;
      else if (value === " " && rows[state.cursor]) {
        const id = rows[state.cursor]!.id;
        state.selected.has(id)
          ? state.selected.delete(id)
          : state.selected.add(id);
      } else if (value === "a") {
        const all = rows.every((row) => state.selected.has(row.id));
        rows.forEach((row) =>
          all ? state.selected.delete(row.id) : state.selected.add(row.id),
        );
      } else if (value === "/") {
        originalQuery = state.search;
        searching = true;
        state.selected.clear();
      } else if (key.name === "tab") {
        rows.forEach((row) =>
          state.selected.has(row.id)
            ? state.selected.delete(row.id)
            : state.selected.add(row.id),
        );
      } else if (value === "s") {
        state.sort =
          state.sort === "name"
            ? "status"
            : state.sort === "status" && page === "blog"
              ? "date"
              : "name";
        state.cursor = 0;
      } else if (value === "o") state.ascending = !state.ascending;
      else if (value === "r") await this.load(page, state);
      else if (value === "?")
        await this.textPage(
          "List Shortcuts",
          "↑↓ / J K  移动焦点\nSpace  选择当前项\nA  全选或清空\nTab  反选\nEnter  打开详情\n/  即时搜索\nS  切换排序字段\nO  切换升降序\nH / L  翻页\nR  刷新列表\nQ / Esc  返回\n\n没有勾选项时，操作作用于焦点项。",
        );
      else if (value === "m" && page === "skill") {
        await this.list("sources");
        await this.load(page, state);
      } else if (key.name === "enter" && rows[state.cursor]) {
        await this.open(page, rows[state.cursor]!);
        await this.load(page, state);
      } else if (value === "n" && page === "blog") {
        const path = await this.input(
          "New Article",
          "Markdown 文件路径（相对当前目录或绝对路径）",
        );
        if (path) {
          await this.result(
            "上传草稿",
            await this.run(
              ["blog", "create", path.replace(/^['"]|['"]$/gu, "")],
              "Blog · 正在上传草稿",
            ),
          );
          await this.load(page, state);
        }
      } else if (value === "n" && page === "sources") {
        const repo = await this.input(
          "Add Source",
          "Codeup 命名空间/仓库路径或克隆地址",
        );
        if (repo) {
          await this.result(
            "登记来源",
            await this.run(["skill", "source", "add", repo], "正在登记来源"),
          );
          await this.load(page, state);
        }
      } else {
        const targets = this.selected(state);
        if (!targets.length) continue;
        if (page === "blog" && (value === "d" || value === "p")) {
          await this.articleAction(
            value === "d" ? "delete" : "publish",
            targets,
          );
          await this.load(page, state);
          state.selected.clear();
        }
        if (page === "skill" && ["i", "u", "d"].includes(value)) {
          await this.skillAction(
            value === "i" ? "install" : value === "u" ? "update" : "uninstall",
            targets,
          );
          await this.load(page, state);
          state.selected.clear();
        }
        if (
          page === "sources" &&
          value === "d" &&
          (await this.confirm(
            "移除 Skill 来源",
            targets
              .map((row) => row.id)
              .concat("保留已安装文件，暂停相应来源更新。"),
            "确认移除",
          ))
        ) {
          for (const row of targets)
            await this.result(
              "移除来源",
              await this.run(
                ["skill", "source", "remove", row.id],
                "正在移除来源",
              ),
            );
          await this.load(page, state);
          state.selected.clear();
        }
      }
    }
  }
  private async auth() {
    for (;;) {
      const choice = await this.menu("Device Authorization", [
        { label: "Login", description: "打开网页，批准此 CLI 设备" },
        { label: "Status", description: "查看当前设备授权" },
        { label: "Logout", description: "撤销当前设备授权" },
      ]);
      if (!choice) return;
      const action = ["login", "status", "logout"][choice[0] ?? 0]!;
      if (
        action === "logout" &&
        !(await this.confirm(
          "撤销设备授权",
          ["注销后需要重新登录才能管理文章。"],
          "确认注销",
        ))
      )
        continue;
      await this.result(
        "设备授权",
        await this.run(["auth", action], "设备授权"),
      );
    }
  }
  private async settings() {
    const server = await resolveServer(this.global[1]);
    const value = await this.input(
      "PageHush Server",
      "保存默认 PageHush 服务地址",
      server,
    );
    if (value) {
      const result = await this.run(
        ["config", "server", value],
        "正在保存服务地址",
      );
      if (result.ok) this.global = [];
      await this.result("服务地址", result);
    }
  }
  async start(page?: "blog" | "skill") {
    this.terminal.open();
    try {
      if (page) {
        await this.list(page);
        return;
      }
      let cursor = 0;
      const choices = [
        {
          name: "Blog",
          description: "管理远程文章",
          open: () => this.list("blog"),
        },
        {
          name: "Skill",
          description: "安装、更新和删除 Agent Skills",
          open: () => this.list("skill"),
        },
        {
          name: "Auth",
          description: "登录和管理设备授权",
          open: () => this.auth(),
        },
        {
          name: "Settings",
          description: "配置 PageHush 服务",
          open: () => this.settings(),
        },
      ];
      for (;;) {
        const logo = [
          " __   __     _",
          " \\ \\ / /__ | |__   ___",
          "  \\ V / _ \\| '_ \\ / _ \\",
          "   | | (_) | | | | (_) |",
          "   |_|\\___/|_| |_|\\___/",
        ];
        const banner =
          this.terminal.width >= 66 && this.terminal.height >= 19
            ? logo.map(
                (line, index) =>
                  color(line.padEnd(30), "green") +
                  (index === 2
                    ? color(`Yoho CLI v${manifest.version}`, "cyan", true)
                    : index === 3
                      ? color("Articles and Agent Skills.", "green")
                      : ""),
              )
            : [
                color(" Yoho", "green", true),
                color(` CLI v${manifest.version}`, "cyan"),
                "",
              ];
        const lines = [
          "",
          ...banner,
          "",
          ...choices.map((choice, index) => {
            const line = `${cursor === index ? "➤" : " "} ${index + 1}. ${pad(choice.name, 12)} ${fit(choice.description, this.terminal.width - 20)}`;
            return index === cursor ? color(line, "cyan") : line;
          }),
          "",
          "",
          ...this.lines(
            "↑↓  |  Enter  |  1–4 Select  |  M More  |  V Version  |  Q Quit",
          ).map((line) => color(line, "gray")),
        ];
        this.terminal.draw(lines);
        const key = await this.terminal.read();
        if (back(key)) return;
        const value = letter(key);
        if (key.name === "up" || value === "k")
          cursor = Math.max(0, cursor - 1);
        if (key.name === "down" || value === "j")
          cursor = Math.min(choices.length - 1, cursor + 1);
        if (key.name === "enter") await choices[cursor]?.open();
        if (/^[1-4]$/u.test(value)) {
          cursor = Number(value) - 1;
          await choices[cursor]?.open();
        }
        if (value === "v")
          await this.textPage(
            "Version",
            `Yoho CLI v${manifest.version}\nNode.js ${process.version}\n\n输入 yoho 打开交互界面。\n输入 yoho --help 查看命令行用法。`,
          );
        if (value === "m")
          await this.textPage(
            "Keyboard Shortcuts",
            "↑ / ↓ 或 J / K  移动焦点\nEnter  打开菜单或详情\nSpace  勾选当前项\nA  全选或清空当前筛选\n/  搜索\nS  切换排序字段\nO  切换升序和降序\nH / L  上一页和下一页\nR  刷新\nQ / Esc  返回；首页退出\nCtrl+C  取消当前操作并退出\n\n列表操作处理已勾选项；未勾选时处理焦点项。\n搜索条件改变时清除选择。删除与发布会展示目标并确认。\n\n命令行与 --json 接口继续可用：yoho --help",
          );
      }
    } finally {
      this.terminal.close();
    }
  }
}

export async function interactive(
  signal: AbortSignal,
  options: { server?: string; page?: "blog" | "skill" } = {},
) {
  await new InteractiveApp(signal, options.server).start(options.page);
}
