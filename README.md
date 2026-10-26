# Yoho CLI

A local TypeScript CLI for managing PageHush remote articles and GitHub Agent Skills.

[简体中文](README.zh-CN.md)

[![Node.js 24+](docs/assets/nodejs.svg)](https://nodejs.org/) [![pnpm 11](docs/assets/pnpm.svg)](https://pnpm.io/) [![TypeScript 7.0.2](docs/assets/typescript.svg)](https://www.typescriptlang.org/)

Yoho gives a terminal or local product one deterministic interface for two jobs:

- `yoho blog` reads and writes articles through the PageHush API.
- `yoho skill` discovers GitHub Skill sources and installs or updates complete Skill directories.

Use `--json` when another program needs a stable result. PageHush is the authoritative article store: this CLI does not scan local blog folders, edit local article files, or provide bidirectional synchronization.

## Quick start

### Requirements

- Node.js 24 or newer.
- pnpm 11.25.0 when building this repository.
- A compatible PageHush API for `yoho blog` and `yoho auth` commands.
- macOS is the current installation-validation target. Linux and Windows installation are not covered by the current acceptance record.

The package is marked private in `package.json` and is not published to npm. From the repository root, install the local package from a tarball:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack --pack-destination artifacts
npm install --global ./artifacts/yoho-cli-0.6.3.tgz
yoho --version
yoho --help
```

If the system-wide npm prefix is not writable, install into a user directory:

```bash
npm install --global --prefix "$HOME/.local" ./artifacts/yoho-cli-0.6.3.tgz
```

Add `$HOME/.local/bin` to `PATH` if it is not already there.

### First successful run

Skill management does not require PageHush login. List the registered GitHub sources and the Skills they expose:

```bash
yoho skill list
```

To install a Skill without opening the interactive menu, provide its name and at least one target:

```bash
yoho skill install speckit --target codex
```

For article commands, configure or accept the default PageHush service, authorize the device, then list articles:

```bash
yoho auth login
yoho blog list
```

## Terminal interface

Ink, React, and Ink UI render lists, details, and results. Clack provides menus, loading indicators, and block progress bars for installation, updates, and removal. Progress counts actual destination directories and names the Skill being processed.

Use Space to select, `a` to select or clear all, and `i` to invert a selection. Press Enter to continue or Ctrl+C to cancel. Updates use recorded installation locations. Set `NO_COLOR=1` to disable colors. Redirected output has no progress animation. With `--json`, stdout contains one result; interaction and progress use stderr.

The build bundles dependencies into ESM with `dist/cli.js` as its entry and additional files in `dist/chunks/`. The source has no direct Chalk or Listr2 dependency.

## How the CLI fits together

| Command group | Source of truth                                              | Main result                                                          |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `yoho blog`   | PageHush remote article API                                  | Articles, revisions, publish/delete operations, and recovery records |
| `yoho skill`  | Registered GitHub repositories plus local target directories | Skill catalog, installation state, and per-target update results     |
| `yoho auth`   | PageHush device authorization                                | A service-scoped token stored in the system credential store         |
| `yoho --json` | The same command execution                                   | Machine-readable success or failure on stdout                        |

## Configure the PageHush service

The built-in service is `https://pagehush.yohoia.cn`. Save a default service or override it for one command:

```bash
yoho config server https://your-pagehush.example
yoho --server https://your-pagehush.example blog list
```

The service-resolution order is `--server`, `YOHO_SERVER`, the saved default, then the built-in default. Service URLs must be HTTPS origins without credentials, paths, queries, or fragments; HTTP is accepted only for localhost test fixtures.

| Variable          | Purpose                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `YOHO_SERVER`     | Overrides the default PageHush service.                                                   |
| `YOHO_TOKEN`      | Supplies an existing device token for scripts without writing it to the credential store. |
| `YOHO_CONFIG_DIR` | Isolates configuration, Skill state, and the minimum operation records.                   |
| `XDG_CONFIG_HOME` | Provides the parent directory for `~/.config/yoho` when `YOHO_CONFIG_DIR` is unset.       |

Configuration and operation records do not contain article bodies, image bytes, or stored credentials. Service credentials are kept separate for each service origin. Server-side operation results are retained for at least seven days; after that, an unresolved result may need manual verification.

## Authorize a device

```bash
yoho auth login
yoho auth status
yoho auth logout
```

`login` prints a device code and approval URL, then waits for approval in PageHush. Use `--no-browser` on a remote terminal. Authorization lasts 30 days and is not automatically refreshed. On macOS, tokens use the Keychain; Linux uses an available Secret Service. If the credential store is unavailable, the CLI fails instead of writing a plaintext token.

## Manage remote articles

### List and inspect

```bash
yoho blog list
yoho blog list --status draft --keyword 'command line' --page 1 --page-size 20
yoho blog list --status published --page 2 --json
yoho blog show 'ARTICLE_UUID'
yoho blog show 'COMPLETE_SHORT_ID' --json
```

`list` returns non-deleted drafts and published articles, 20 per page by default. Filters run before pagination. Results are ordered by the server's recorded update time and include the next-page cursor when one exists. Terminal output is a width-aware table; JSON retains the complete structured result.

Article identity is a UUID or complete short ID. Titles, slugs, short-ID prefixes, and local paths are not remote identities. `show` returns the complete Markdown body, server metadata, and an opaque `revision` value that must be passed back for guarded writes.

### Upload a Markdown draft

```bash
yoho blog create ./article.md
yoho blog create '/absolute/path/article.md' --json
```

`create` accepts one readable UTF-8 `.md` file. It does not accept directories, MDX, stdin, or a separate body argument. The source document and local images remain unchanged. A draft title comes from non-empty frontmatter `title`, the first level-one heading outside code blocks, or the file name. Supported frontmatter imports are `title`, `description`, and `language` (`zh` or `en`, default `zh`). Invalid fields, empty content, or a document containing only frontmatter fail before a remote write.

Local Markdown images are preflighted and uploaded through the PageHush asset API. JPEG, PNG, and WebP are supported up to 5 MiB per image. Remote images, existing PageHush asset URLs, and anchors stay unchanged. HTML images, reference-style image definitions, MDX components, unresolved local resources, and recursive attachment uploads are outside this flow. The CLI never connects directly to MinIO.

Each `create` starts a new article and returns a request ID. If a write times out or is interrupted, query or resume that request instead of running `create` again:

```bash
yoho blog operation 'REQUEST_UUID' --json
yoho blog resume 'REQUEST_UUID' ./article.md --json
```

### Publish with a revision precondition

```bash
yoho blog show 'ARTICLE_UUID' --json
yoho blog publish 'ARTICLE_UUID' --if-match 'REVISION_FROM_SHOW' --json
```

`publish` requires the revision returned by `show`. The server checks the revision atomically, so a stale value does not publish or overwrite newer web edits. Publishing an already-published article with the same revision returns `changed=false` without changing its timestamps.

### Preview and soft-delete

```bash
yoho blog delete 'ARTICLE_UUID' --dry-run --json
yoho blog delete 'ARTICLE_UUID' --yes --if-match 'REVISION_FROM_PREVIEW' --json
```

`--dry-run` only reads the target. Actual deletion requires both `--yes` and `--if-match`; the server performs an atomic revision check and marks the article as soft-deleted. The record and assets remain available to the service, but the article leaves normal lists, details, and blog reads. Permanent deletion and recovery are not CLI operations.

## Install, update, and remove Skills

Skill commands use the current user's registered GitHub sources and do not require PageHush authorization. A new configuration starts with these sources:

- `Yohoia/yoho-standard-readme`
- `Yohoia/yoho-retro-poster`
- `Yohoia/yoho-speckit` (the Skill name is `speckit`)

Manage sources with:

```bash
yoho skill source list
yoho skill source add owner/repo
yoho skill source add https://github.com/owner/repo
yoho skill source refresh
yoho skill source remove owner/repo
```

Sources are saved for the current user and shared across projects. An unavailable source keeps its last catalog entry and reports the reason, but installation and updates require the current commit. Public repositories can be downloaded without GitHub login; private repositories reuse the local `gh auth login` session. The CLI does not store a GitHub token. Removing a source pauses updates without uninstalling its Skills; adding it again resumes management.

### Installation targets

Installation defaults to the current project. Use `--project-path` to select another project or `--scope user` for the current user's target directories.

| Target   | Project scope    | User scope         |
| -------- | ---------------- | ------------------ |
| `claude` | `.claude/skills` | `~/.claude/skills` |
| `agents` | `.agents/skills` | `~/.agents/skills` |
| `codex`  | `.codex/skills`  | `~/.codex/skills`  |

Installation can prompt for names and targets. Updates prompt only for Skills:

```bash
yoho skill install
yoho skill update
```

The picker uses a compact list with details for the focused item. Use arrow keys to move, Space to toggle, `a` to select or clear all enabled items, `i` to invert, Enter to confirm, and Ctrl+C to cancel. Long lists scroll, and completed steps collapse to a summary.

`yoho skill list` uses English column headings and displays green `installed` or light-gray `not installed` states. Lists omit section titles and show a footer such as `Total: 3 · 1 installed · 2 not installed`. Versions come from YAML metadata in the root `SKILL.md`, including `metadata.version`:

```yaml
metadata:
  version: "0.1.1"
```

Top-level `version: "0.1.1"` is also supported and takes precedence when both fields exist. The terminal displays `v0.1.1`, or 未标注 when no version is declared. Installed rows show local versions; other rows show repository versions. Use `--target` to include installation paths.

The CLI manages only Skills linked to registered sources or existing installation records. Manually copied Skills match registered names from root `SKILL.md` files. Unrelated third-party Skills without a match or record do not appear in the update menu, update-all results, or installation records. Previously managed installations retain recovery guidance when their source is removed.

`yoho skill update` compares the latest source commit and actual files, then lists only Skills with changes. When everything matches, it displays 无可用更新，Skill 均为最新版. Local edits also count as changes. Selecting a Skill immediately updates all its recorded installation paths, including other projects, without asking for a scope or tool. Unrecorded manual installations are discovered only in the three standard directories under the current project and user home, and associated by a unique root `SKILL.md` name.

Removed, unavailable, ambiguous, and renamed sources produce separate diagnostics and stay outside the choices. Failed checks are never reported as current. Update result tables contain only Skill, status, and version. Status is 已更新 for success or 更新失败 for failure; the version is the latest declaration fetched for the operation. Network, permission, and write failures return a nonzero exit code.

For automation, provide every selection explicitly:

```bash
yoho skill install speckit yoho-retro-poster --target claude --target agents
yoho skill install speckit --scope user --target codex
yoho skill install speckit --project-path /path/to/project --target agents
yoho skill list --target claude --target agents --json
yoho skill update speckit
yoho skill update --all --json
yoho skill update speckit --target agents
yoho skill update speckit yoho-retro-poster --target claude --json
yoho skill update --all --scope user --target agents --target codex --json
```

Explicit `--scope`, `--target`, or `--project-path` options narrow an update to those locations. Without these options, updates use existing installation paths. They do not scan other projects for unrecorded installations or fill missing targets. Version labels are for display; updates still use the latest default-branch commit rather than sorting versions or selecting historical releases.

Installation protects existing target directories and fills only missing targets. Each operation downloads the latest default-branch commit once per source, copies the complete Skill tree without Git metadata, and never runs Skill scripts or installs npm/pip dependencies. Updates treat the repository as authoritative: local edits are overwritten, deleted repository files are restored, and local files absent from the repository are removed. Update failures recover the affected target and continue with other targets; initial batch-install failures roll back the new batch while preserving existing installations.

### Uninstall a Skill while keeping its source

```bash
# List installed Skills, select one or several, then confirm removal
yoho skill uninstall

# Remove all recorded locations and installation records; keep the source
yoho skill uninstall speckit

# Preview directories and installation records without deleting them
yoho skill uninstall speckit --dry-run

# Explicit confirmation for scripts; accepts names or owner/repo
yoho skill uninstall speckit yoho-retro-poster --yes

# Remove all managed installations while keeping the catalog
yoho skill uninstall --all --yes
```

Run `yoho skill uninstall` without names to choose from installed, managed Skills. Use arrows to move, Space to select one or several, and Enter to continue. Use `a` to select or clear all, `i` to invert, and Ctrl+C to cancel. The picker groups installation locations by Skill and shows their count; confirmation lists the actual directories. Uninstalled and unrelated third-party Skills are excluded. If nothing is installed, the command reports that and exits.

`yoho skill remove` aliases `uninstall`. Uninstall deletes only local files and installation records. It always keeps source registrations: `yoho skill list` still shows the Skill as `not installed`, and you can reinstall it directly. Only `yoho skill source remove owner/repo` removes a source registration; that command keeps installed files.

Uninstall works offline. It includes managed installations in the current project and user directories, plus recorded locations in other projects, without asking for an installation scope. Unrelated third-party Skills are excluded. Manual copies require a unique match between SKILL.md and a locally cached source name. The CLI does not scan unrecorded projects.

Noninteractive calls require `--yes` or `--dry-run`. Providing both still only previews. Interactive confirmation defaults to cancel. If one location fails, completed deletions remain complete, and the failed location's record remains available for retry. Source registrations always remain unchanged. Interrupted backups are reported and preserved. If files were deleted but saving their records failed, retry the command to clear the remaining records.

## JSON results and exit codes

Human-readable output follows a compact terminal style inspired by Codex CLI. Content shares a left edge. Lists omit section titles and use centered English column headings with aligned columns and separator lines instead of outer borders. An up-to-date result uses one success line. Body text and notes use the terminal foreground color; focus and status use restrained accents. Full IDs, revisions, and paths wrap without truncation. Progress, pickers, details, errors, and operation results share these rules. `NO_COLOR` is supported, and redirected output has no color codes. JSON preserves source availability and full descriptions, with added declared versions and installed target versions. Human-readable installation states do not replace the source states in JSON.

Add `--json` to a business command to receive exactly one result on stdout for both success and failure. Progress, approval URLs, and import notices go to stderr. This keeps the result stream safe for local products and shell scripts.

```json
{ "ok": true, "data": { "items": [], "nextPage": null } }
```

```json
{
  "ok": false,
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "文章版本已变化"
  }
}
```

| Exit code | Meaning                                                                       |
| --------: | ----------------------------------------------------------------------------- |
|       `0` | Success                                                                       |
|       `2` | Invalid arguments or configuration                                            |
|       `3` | Article or Skill data error, revision conflict, or identity conflict          |
|       `4` | Authentication, device authorization, or permission error                     |
|       `5` | Local file, network, remote I/O, or unknown-result error                      |
|     `130` | User cancellation; an issued remote write still needs request-ID verification |

## Migration and limits

The old local-article mode is removed. `--project`, path-based article IDs, `blog update`, MDX creation, and local metadata editing are rejected with a migration message. Keep local source documents and use `yoho blog create <path-to-md>` to upload a new draft; edit existing remote article content and metadata in PageHush.

The CLI does not provide editing of an existing article body, title, or metadata, article withdrawal, article archive or restore, permanent deletion, global project binding, or public npm distribution. Skill version rollback and scheduled updates are also unavailable. The CLI and PageHush API/web version must remain compatible.

## Development and validation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm test:file tests/remote-migration.test.mjs
pnpm test
```

The test suite builds and exercises the installed CLI in child processes. Remote protocol tests use isolated local HTTP fixtures, configuration, credentials, and storage; they do not write to the production article store. The remote tests normally use the adjacent `../PageHush` source tree. Set `PAGEHUSH_SOURCE` when it lives elsewhere:

```bash
PAGEHUSH_SOURCE=/path/to/PageHush pnpm test
```

Skill tests use isolated GitHub protocol fixtures, a fake `gh` boundary, temporary directories, Python 3, and the system `tar` command. They do not read real GitHub credentials or modify real Skill directories.

## License

This repository currently has no `LICENSE` file or declared package license. Confirm redistribution terms with the project owner before publishing or embedding the code.
