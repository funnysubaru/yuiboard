---
name: devboard-add-project
description: Onboard the current git repository into the local devboard (YUIBoard) progress board, or remove it from the board. Use when the user says "add this project to devboard", "generate a board", "put this on the board", "update this project's doc sources in devboard", "remove this project from devboard", or the same in Chinese or Japanese (e.g. 「把这个项目加到 devboard」「生成面板」「接入看板」「从 devboard 移除这个项目」「このプロジェクトを devboard に追加して」「devboard からこのプロジェクトを削除して」). Detects spec tasks.md, ADR, plan and TODO documents, writes the devboard config, starts or restarts the service, and returns the board link.
---

# Onboard a repository into devboard

devboard generates six pages from the config: Overview, Gantt, Graph, Next up, Needs attention, Diagnostics. Your only job: identify the task documents → get the user's confirmation → write the config → make sure the service is running → report.

Talk to the user in the language they write in. This skill is in English, but every question, confirmation listing and report follows the user's language.

## Rules

- The **current repository is read-only** for this skill: no file writes, no commits, no git write operations. The one exception is the convention fix after a first onboarding (step 7), which follows the `devboard-fix-convention` skill: each change to a document or PR title only after the user confirms that single change.
- Change only `<DEVBOARD>/devboard.config.json`, and only through `devboard-ctl` `save` / `remove` (it holds a lock, backs up to `.bak`, validates, and restores on failure). Do not write your own script to edit the config. Start/stop the service only through `devboard-ctl up`.
- `<DEVBOARD>` and `<REPO>` below are the **absolute paths** from step 1. Your working directory is usually the watched repository; some platforms run each command in a fresh shell without keeping variables, so spell out absolute paths in every command.
- Do not write the config before the user explicitly agrees.
- On "**Stop**": tell the user the reason and what to do next. Do not work around it some other way.

## 1. Locate

1. devboard directory = this skill's directory with symlinks resolved, two levels up. The platform tells you this skill's directory (e.g. Claude Code's "Base directory for this skill").

   ```sh
   node -p "require('node:path').resolve(require('node:fs').realpathSync(process.argv[1]), '../..')" "<this skill's directory>"
   ```

   With `<DEVBOARD>` in hand, check `test -f "<DEVBOARD>/src/server.mjs"`. Missing → **Stop** and ask the user where devboard is installed (the skill may have been copied rather than symlinked).
   If `<DEVBOARD>` is inside `~/.claude/plugins/` (the skill came with the plugin installed from a marketplace, which runs from a copy), **Stop** as well and ask the user where their YUIBoard checkout is; use that path as `<DEVBOARD>`. Never write config or install a service from the plugin copy.
2. Watched repository: `git rev-parse --show-toplevel`; the result is `<REPO>`. Fails → **Stop**: the current directory is not in a git repository.
3. Existing project:

   ```sh
   node "<DEVBOARD>/ops/devboard-ctl.mjs" find "<REPO>"
   ```

   Output `{"ok":true,"project":{…},"matchedBy":"repo"}` or `"matchedBy":"workspace:<branch line id>"` means this repository is already onboarded: take the "update" path. `"project":null` (`matchedBy` also null): take the "new" path.
   When `matchedBy` is `workspace:<id>`, the current repository is a separate checkout of one of `project`'s branch lines (`branchLines[].workspace`), not its main repository. Tell the user "this repository is already onboarded as the workspace of branch line `<id>` of project `<project.name>`", take the "update" path but do not change `repo.path` or `branchLines`; in step 3 only compare `docSources`-level differences against the §2 detection (default: change nothing).

## 2. Read-only detection

- **GitHub**: `git -C "<REPO>" remote get-url origin`, extract `owner/name` with `github\.com[:/]([^/]+)/([^/]+?)(\.git)?$`. No remote or not GitHub → do not write `repo.github`; the board shows "GitHub not connected" and works from documents and AI sessions only.
- **Default branch**: `git -C "<REPO>" symbolic-ref --short refs/remotes/origin/HEAD`, strip the leading `origin/`; on failure use `git -C "<REPO>" branch --show-current`.
  Without an `origin` remote (`remote get-url origin` fails, so `symbolic-ref` fails too), use the `branch --show-current` result directly and skip the sanity check below.
  **Sanity check** (a local clone's `origin/HEAD` can be stale and not follow the remote default branch; only with `origin`): if the branch is not `main`/`master`, also run `git -C "<REPO>" show-ref --verify --quiet refs/remotes/origin/main` (if absent, try `.../origin/master`). Exists → record both branches; in the step 3 confirmation listing write "detected `<X>`, but `origin/main` exists, defaulting to main", default to main/master, and let the user correct it. Absent → keep the detected branch.
- **Documents**:

  ```sh
  git -c core.quotepath=false -C "<REPO>" ls-files --cached --others --exclude-standard -- '*.md' \
    | grep -vE '(^|/)node_modules/' \
    | awk -F/ '
        /^\.claude\/specs\// { if (NF<=4) print; next }
        { bad=0; for (i=1;i<=NF;i++) if (substr($i,1,1)==".") bad=1
          if (!bad && NF<=4) print }
      '
  ```

  Do not drop `-c core.quotepath=false`: by default git turns non-ASCII paths (e.g. Chinese) into quoted octal escapes (`"\346\226\207…"`), which breaks the filtering and the `docSources` paths.
  Use `git ls-files`, not `find`: it respects `.gitignore`, so ignored directories never become document sources. Then filter by path: apart from the single exception `.claude/specs/`, drop any file with a path segment starting with `.` (so `.cursor/`, `.specstory/`, `.superpowers/`, `.claude/agents/` and other tool/config directories never become candidates, without listing them one by one); `node_modules` is filtered separately (it has no dot). Output paths are relative to `<REPO>`; `NF<=4` matches the old `find -maxdepth 4` depth limit. If the user says their plan documents live in a dot-directory, add that directory to the doc sources by hand; do not change this command.

  Group by directory and count. For each candidate directory, count files with task lines, recognizing only forms devboard actually parses (a checkbox starting with a number, or a heading-style `Task N`/`TN`). Do not estimate with "any checkbox", or "planning" files get misjudged as "broken into tasks":

  ```sh
  grep -lE '^\s*[-*] \[[ xX~]\] (~~)?(\*\*)?(Task\s*|タスク\s*|T)?[0-9]+[a-z]?(\.[0-9]+[a-z]?)*\.?[[:space:]:：]|^#{2,4} (Task |タスク ?|T)[0-9]' "<directory>"/*.md | wc -l
  ```

  A file with no match does not mean the skill misjudged: the board shows it as "Planning", and the step 7 stats are the real parse result.

  Classification (details in `<DEVBOARD>/CONVENTION.md`):

  | What you see | Source |
  |---|---|
  | `.claude/specs/<name>/tasks.md` | `{ "type": "spec-dir", "label": "Claude Code spec", "path": ".claude/specs" }` |
  | The directory's **last path segment** contains `adr` as a standalone word (case-insensitive, no letter directly before or after, e.g. `adr`, `ADR`, `02.ADR`, `docs/adr`; `.headroom`, with `adr` inside letters, does not count), files mostly `ADR-<number>…` | `{ "type": "adr-dir", "label": "ADR", "path": "<directory>" }` |
  | `docs/superpowers/plans`, or a directory whose name contains `plan` / `todo` and has files with task lines | `{ "type": "md-dir", "label": "<named after the directory, e.g. \"Implementation plans\", \"TODO\">", "path": "<directory>" }` |
  | `todo.md`, `tasks.md` at the root or scattered | `{ "type": "task-list", "label": "Task list", "files": ["<file>", …] }` |
  | A directory with only prose and not a single checkbox (e.g. `docs/superpowers/specs`; a directory whose name matches `plan`/`todo` but also has 0 task lines falls here too: it fails the md-dir row's "has files with task lines" condition and is not a candidate) | Not included; list it as "Not included" in the confirmation listing with the reason |
  | Files with task lines, but the directory name matches none of the rules above (e.g. `docs/dev/04.WBS`, `01.PRD`) | Not included; list it as "Candidate (not included)" in the confirmation listing with the number of files with task lines, and let the user decide; default is not included |

  Write `path` / `files` relative to `<REPO>`, with `/`.
- **Session sources**: `[{ "source": "claude-code" }, { "source": "codex" }]`.
- **id** (generated only for "new"; "update" always keeps the existing id): directory name lowercased, characters outside `[a-z0-9_-]` replaced with `-`, consecutive `-` merged, leading/trailing `-` removed. List existing ids:

  ```sh
  node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8').replace(/^﻿/, '')).projects.map(p=>p.id).join(' ')" "<DEVBOARD>/devboard.config.json"
  ```

  Result empty, or it duplicates an existing id → append `-` and the first 4 hex chars of the sha1 of `<REPO>`:

  ```sh
  node -p "require('node:crypto').createHash('sha1').update(process.argv[1]).digest('hex').slice(0, 4)" "<REPO>"
  ```

  Skip the duplicate check when the config file does not exist yet. If `save --new` in step 5 reports `id-exists`, also switch to this suffixed id.

## 3. Get the user's confirmation

For **new**, list:

```
Will onboard into devboard:
- id: my-app   Name: My App
- Repository: /Users/x/Projects/My App
- GitHub: acme/my-app (or: GitHub not connected)
- Branch lines: Main (base: main)
- Service: resident (starts at login) | temporary background process
- Doc sources:
  1. spec-dir  .claude/specs                 3 specs
  2. adr-dir   docs/dev/02.ADR               34 files
  3. md-dir    docs/dev/03.PLAN              55 files (4 with task lines)
- Not included: docs/superpowers/specs (design docs, no tasks)
- Candidate (not included): docs/dev/01.PRD (16 files, 4 with task lines; directory name matches no rule, not included by default)
To rename, drop a source, or include a not-included/candidate directory, just tell me; reply "OK" to confirm.
```

If the branch detected from `origin/HEAD` is not `main`/`master` but `origin/main` (or `origin/master`) exists, show both on the branch line row, e.g. "Branch lines: Main (detected base: chore/init-project-docs, but origin/main exists, defaulting to main; tell me if that's wrong)".

When there are many not-included / candidate directories (a dozen or more), do not give each its own line; put them on one comma-separated line.

For **update**, list only the differences (sources detected but missing from the config, sources in the config whose directory no longer exists, GitHub going from none to connected, etc.) and say "everything else in the config stays unchanged".

If the user wants more branch lines, append `{ "id", "name", "base", "docFilter" }` as they say; with a single line, `docFilter` is `"^"` (all documents belong to that line).

**Decide the start mode in this step; every `up` in this run (step 6, failure retries, project removal) uses the same mode**, written `<UP>` below:

- Default (resident service; LaunchAgent on macOS, systemd user service on Linux, starts at login): `<UP>` = `node "<DEVBOARD>/ops/devboard-ctl.mjs" up`
- User says "no resident service / just run it temporarily": `<UP>` = `node "<DEVBOARD>/ops/devboard-ctl.mjs" up --no-launchd`

State the chosen mode in the confirmation listing. If the service is already running as a resident service and the user wants the temporary mode, `up --no-launchd` is refused as "not started by devboard-ctl" (`reason` is `unmanaged`). Then **Stop**: explain that a resident service is already running on this machine and the temporary mode cannot take it over; only with the user's agreement rerun with the default mode.

## 4. Prepare the project object

**New**:

```json
{
  "id": "<id>", "name": "<name>",
  "repo": { "path": "<REPO>", "github": "<owner/name; omit this key if none>" },
  "docSources": [ … ],
  "branchLines": [{ "id": "main", "name": "Main", "base": "<default branch>", "docFilter": "^" }],
  "sessions": [{ "source": "claude-code" }, { "source": "codex" }]
}
```

**Update**: do not prepare a full object, only a **patch** with the fields the user confirmed, which may only be `name`, `docSources`, `repo.github` (written as `{ "repo": { "github": "owner/name" } }`). `id`, `repo.path`, `branchLines`, `github`, `archived`, `excluded`, the various `Pattern` fields, existing `extraCwds` in `sessions`, etc. are kept as-is by `save --update`; do not put them in the patch. For example, changing only the doc sources:

```json
{ "docSources": [ … ] }
```

## 5. Write the config

Always write the config through `devboard-ctl`: inside the config lock (`<DEVBOARD>/devboard.config.json.lock`) it copies the original to `<DEVBOARD>/devboard.config.json.bak`, writes atomically, then runs `check`; if the global or this project's validation fails, it restores the original. If the config file does not exist, it first creates a minimal config.

- **New**: pass the full project object from step 4 via a heredoc (avoids quote-escaping mistakes):

  ```sh
  node "<DEVBOARD>/ops/devboard-ctl.mjs" save --new <<'JSON'
  <project object from step 4>
  JSON
  ```

- **Update**: pass only the step 4 patch; `<id>` is the project id from the `find` output:

  ```sh
  node "<DEVBOARD>/ops/devboard-ctl.mjs" save --update "<id>" <<'JSON'
  <patch from step 4>
  JSON
  ```

Read the one-line JSON output:

- `ok:true` → note `revision` (needed to undo in step 6), tell the user the pre-write config backup is at `<DEVBOARD>/devboard.config.json.bak`, continue to step 6. Non-empty `otherErrors` means other projects already had config errors; this does not affect this project, mention it in the report.
- `reason` is `"id-exists"` (new only) → switch to the hash-suffixed id from step 2 and rerun `save --new`.
- `reason` is `"already-onboarded"` → this repository is already onboarded as project `id` (`matchedBy` says whether as the main repository or a branch line's workspace): go back to step 1.3 and take the "update" path.
- `reason` is `"patch-field-not-allowed"` → the patch has disallowed fields (listed in `fields`): remove them and retry; if the user really wants those fields changed, **Stop** and ask the user to edit the config file by hand.
- `reason` is `"check-failed"` → the config was restored automatically. Read `errors`, fix the project object or patch, and retry; if you can't fix it, **Stop** and tell the user the errors. Do **not** run `up` in this case.
- `reason` is `"config-busy"` → another process is changing the config (lock file `devboard.config.json.lock`); the config is untouched: wait a few seconds and rerun the same command; still busy → **Stop** and tell the user the `error`.
- `reason` is `"stale-lock"` → the config lock was left by an exited process (`pid`); the config is untouched: **Stop**, tell the user the `lock` file path and PID, and ask whether to delete it. After the user confirms, `rm "<lock>"` and rerun the same command; do not decide to delete it yourself.
- Any other `ok:false` (`not-found`, `config-invalid`, `bad-input`) → **Stop** and tell the user the `error`.

## 6. Apply

Run `<UP>` (the start mode decided in step 3).

Read the last line of JSON:

- `ok:true` → note `port`, `portChanged`, `occupant`, `managedBy`, `warnings`, and continue.
- `ok:false` with `reason` `"unmanaged"` (the devboard on the port was not started by devboard-ctl or by this directory's LaunchAgent / systemd user service, e.g. started by hand in a terminal) → **Stop** and tell the user: stop the process with PID `<pid>` first (if `pid` is null, say "the devboard occupying port `<port>`"), then ask you to retry.
- `reason` is `"node-version"` or `"bad-port"` → **Stop** and tell the user the `error` (unrelated to this write; restoring the backup won't help).
- `reason` is `"config-busy"` or `"stale-lock"` → could not get the config lock while writing a new port: handle it as for the same `reason` in step 5, then rerun `<UP>`. Do **not** undo this write.
- Any other `ok:false` → undo this write (do **not** just `mv .bak`: `.bak` may already have been overwritten by a later save, and restoring it directly would lose a project someone else just saved):

  ```sh
  node "<DEVBOARD>/ops/devboard-ctl.mjs" revert "<revision from step 5>"
  ```

  - `ok:true` → the config is back to before this write; run `<UP>` once more and tell the user the `reason`, `error` and `log` of both runs.
  - `reason` is `"config-changed"` → the config changed after this write (another save, or `up` changed the port); nothing was restored and the current config is kept: **Stop** and tell the user the `up` `reason`, `error`, `log`, and "config not restored".
  - `config-busy` / `stale-lock` → handle as in step 5, then rerun `revert`; any other `ok:false` → **Stop** and tell the user the `error`.

## 7. Stats

```sh
curl -s "http://127.0.0.1:<port>/api/projects/<id>/board" | node -e '
const b = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const by = (s) => b.docs.filter((d) => d.parse.state === s).map((d) => d.docId);
console.log(JSON.stringify({ docs: b.docs.length, tasks: b.tasks.length, planning: by("planning").length,
  problems: b.docs.filter((d) => !["ok", "planning"].includes(d.parse.state)).map((d) => `${d.docId}: ${d.parse.reason ?? d.parse.state}`),
  markdown: b.diagnostics.convention.filter((x) => x.rule === 8).map((x) => `${x.docId}:${x.line} ${x.detail}`),
  github: b.freshness.github.state === "off" ? "GitHub not connected" : "GitHub connected",
  convention: b.diagnostics.convention.length, prTitlesChecked: !b.degraded.noPrData,
  conventionSamples: b.diagnostics.convention.slice(0, 8).map((x) => `${x.pr != null ? `PR #${x.pr}` : `${x.docId}:${x.line}`} ${x.detail}`) }));'
```

`markdown` lists Markdown in task bodies that the board cannot render (headings inside a body, horizontal rules, images, footnotes, HTML tags; rule 8 of `<DEVBOARD>/CONVENTION.md`). The board shows these as written with a "not rendered as Markdown here" marker and lists them on the Diagnostics page; it is the same check, so do not grep for them yourself.

### Convention check

The board itself checks the existing documents and PR titles against `<DEVBOARD>/CONVENTION.md`; `convention` / `conventionSamples` above are its "Convention issues" list (each item says where and, for the forms below, how to rewrite it). `prTitlesChecked: false` means GitHub data has not arrived yet: say PR titles will be checked once it does, and the user can ask you to look again later.

- **New onboarding** with `convention > 0` (owner 2026-10-12, NEXT N27.4): do not stop at suggestions. Right after the step 8 report, tell the user you will now go through the convention issues so the board can read the documents and PR titles, then follow the `devboard-fix-convention` skill (it sits next to this one: `<DEVBOARD>/skills/devboard-fix-convention/SKILL.md`): one item at a time, each change confirmed by the user, "skip" leaves the item on the Diagnostics page, "stop" ends the walk.
- **Update** of an already onboarded project: only report the count and samples, and offer the same fix walk; start it only if the user asks.

Do not edit anything for these items outside that walk.

Already recognized, no rewrite needed: partial markers `（部分）` `(partial)` `(part)` `（一部）` `（部分完成）` or a trailing `部分` after `任务 N` / a task key / a milestone code; `ADR-0033#64` when only one ADR-0033 is a candidate; `## 阶段一` / `## 第二阶段`; `依赖 1.1 + 1.2`, `依赖 1~3`.

## 8. Report

```
Onboarded into devboard: <name>
- Board: http://devboard.localhost:<port>/#/overview?project=<id>
- <docs> documents, <tasks> tasks; <planning> in planning (not yet broken into tasks)
- Needs attention: <each of problems; "none" if empty>
- Writing that does not match the convention: <convention, "none" if 0; otherwise the conventionSamples, "full list: Diagnostics page → Convention issues", and for a new onboarding "fixing them now, one at a time" (see Convention check); if prTitlesChecked is false, add "PR titles not checked yet">
- Markdown not rendered: <when markdown is non-empty: the count, then the first 10 entries, and point to rule 8 of CONVENTION.md; they are convention issues too and go through the same fix walk. Omit this line when empty>
- GitHub: <connected owner/name | not connected, working from documents and AI sessions only>
- Port: <port> (<when portChanged is true: "the original port was taken by <occupant.command>, now using <port>">)
- Service: <managedBy launchd:… or systemd:… → "resident service, starts at login (<label>)"; background:… → "background process; after a reboot, ask me to start it again">
- <each of warnings>
```

## Remove a project

When the user says "remove this project from devboard":

1. Get `<DEVBOARD>` and `<REPO>` as in step 1, and find the project with `find`; `project` is null → tell the user this repository was never onboarded.
   When `matchedBy` is `workspace:<id>`, the current repository is only the workspace of `project`'s branch line `<id>`, not the main repository:
   **Stop** and tell the user "this repository is only the workspace of branch line `<id>` of project `<name>`; removing deletes the whole project (including the main repository and other branch lines)".
   Continue only if the user explicitly agrees to delete the whole project; do not offer "remove just this branch line" (out of scope).
2. Confirm: "Will remove <name> (id <id>) from devboard. The board cache `cache/<id>` and manual links `data/<id>` are not deleted; you can delete them by hand if needed. Confirm?"
3. Delete the entry (`devboard-ctl` backs up to `.bak` first, validates after deleting, and restores on failure):

   ```sh
   node "<DEVBOARD>/ops/devboard-ctl.mjs" remove "<id>"
   ```

   `ok:false` → **Stop** and tell the user the `error` (on `check-failed` the config was restored automatically; handle `config-busy` and `stale-lock` as in step 5).
4. `ok:true` → note `revision`, run `<UP>` (start mode per the step 3 rule: default unless the user asked for the temporary mode), handle the result as in step 6, report, and tell the user the pre-removal config backup is at `<DEVBOARD>/devboard.config.json.bak`.
