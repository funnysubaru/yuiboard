# YUIBoard

**English** · [中文](README.zh-CN.md) · [日本語](README.ja.md)

A local, read-only progress board for AI-assisted development.

YUIBoard reads the planning docs in your repository (spec `tasks.md` files, ADRs, plans, TODO lists), your GitHub pull requests, and your local Claude Code / Codex session logs. From these it works out where every task stands: not started, in progress, awaiting review, awaiting merge, or done. It shows the result in your browser as six views: an overview, a Gantt chart, a dependency graph, what to do next, what needs your attention, and diagnostics. It can also show a pane right inside Claude Code that follows the task you're working on (see [Watch it inside Claude Code](#watch-it-inside-claude-code-mod)).

![YUIBoard overview: task tree with status, linked PRs and a running Claude session](docs/images/overview.png)

## Why

When AI agents write most of the code, the hard part is keeping track of what has happened. One task is half-done in a session, another has a draft PR, and a third was merged but never checked off in the plan. YUIBoard puts that picture back together from material you already have:

- **No new tracker.** The task docs your AI already writes are the source of truth. There are no tickets to file and nothing to keep in sync by hand.
- **Evidence over claims.** A task can count as done only once it is checked in the doc, and a linked PR that is still open or merged but not yet pulled locally keeps it from being done. A checked task with no valid PR, or whose local sync can't be verified, still counts as done but is flagged "Checked in doc only" or "Local sync not verified" (a project without GitHub has no PRs to look for, so it is not flagged "Checked in doc only"). Every mismatch shows up under "Needs attention", and every status links back to the line, PR or session it came from.
- **Sees AI work as it happens.** A Claude Code or Codex session that is working on a task shows up on that task within seconds.
- **Local and read-only.** It never writes to your repository, your GitHub account or your session logs. It sends no telemetry and calls no AI APIs.
- **Zero dependencies.** It runs on Node 24's standard library and a native ES-module frontend, with no build step and no `npm install`.

The UI is available in English, 中文 and 日本語. It follows your browser language, and you can switch from the top bar.

![Gantt chart: actual work as solid bars, estimates hatched, ordered by dependencies](docs/images/gantt.png)

## Quick start

Requirements: Node 24.x and git. To see pull requests you also need the [GitHub CLI](https://cli.github.com/), signed in with `gh auth login`; read-only access is enough.

**Try it first** with a fictional project (made-up docs, pull requests and an AI session). No config or GitHub sign-in needed:

```sh
git clone https://github.com/funnysubaru/yuiboard.git
cd yuiboard
npm run demo
```

The demo runs on the first free port from 4318, writes only to your system's temp directory, and deletes its files when you press Ctrl+C.

To watch your own repository:

```sh
cp devboard.config.example.json devboard.config.json   # point it at your repository (see Configuration)
node src/server.mjs                                     # or: npm start
```

Open the URL printed at startup (default http://127.0.0.1:4317/). To keep the config file elsewhere:

```sh
node src/server.mjs --config /path/to/devboard.config.json
```

- If the port is taken, the server exits with an error. A config mistake affects only the project it belongs to: that project shows an error page naming the exact field, and the other projects keep working.
- Server logs and `devboard-ctl` output are in English by default. Set `DEVBOARD_LANG=zh` or `ja` (or run with a Chinese or Japanese `LANG`) to switch. When `devboard-ctl up` creates the LaunchAgent or systemd service, it saves the language of the terminal you ran it from as `DEVBOARD_LANG`, because services usually start without `LANG`.
- Caches go to `cache/<project id>/` and manual links to `data/<project id>/`; both are git-ignored. Deleting `cache/` only makes the next start slower.
- Write your docs and PR titles the way [CONVENTION.md](CONVENTION.md) describes. Most existing `tasks.md` files already work as they are.

## Add a project with AI

Rather than editing the config by hand, you can ask your AI agent: *"add this project to devboard"*. The bundled skill `skills/devboard-add-project` finds the spec `tasks.md` files, ADRs, plans and TODO docs, confirms the list with you, writes the config through `ops/devboard-ctl.mjs`, and restarts the service. Saying *"remove this project from devboard"* removes it.

After a first onboarding, if the board finds writing it cannot read as intended (its Diagnostics page lists these as "Convention issues"), the AI goes straight on to fix them with the second skill, `skills/devboard-fix-convention`: one item at a time, showing you each change to a document line or PR title and applying it only after you confirm. You can skip any item or stop. You can also run it later: *"fix the convention issues"*.

To install the skill, run this in the YUIBoard directory. It must be a symlink, because the skill uses it to find its way back to this directory.

```sh
mkdir -p ~/.claude/skills ~/.agents/skills
for s in devboard-add-project devboard-fix-convention; do
  ln -s "$PWD/skills/$s" ~/.claude/skills/$s
  ln -s "$PWD/skills/$s" ~/.agents/skills/$s
done
```

The AI changes `devboard.config.json` only through `devboard-ctl save` / `remove`, which back up the file to `devboard.config.json.bak` first. Repositories you add are only read, except for the convention fixes you confirm one by one.

## Watch it inside Claude Code (mod)

This repository is also a Claude Code plugin. It opens a YUIBoard pane next to the conversation, in both the terminal and the desktop app. The pane shows the project the session belongs to: the overall numbers, a card with the task this session is working on, the task tree, pull requests, Needs attention and Diagnostics. It reads from your running YUIBoard service and changes nothing. Tested with Claude Code 2.1.293–2.1.296.

Both screenshots show the fictional demo project. The session asked about "sync-engine task 2.3", so the card at the top shows that task and why it has its status, and the tree opens to it.

![YUIBoard pane in the Claude Code desktop app, focused on the task the session is working on](docs/images/claude-app.png)

![YUIBoard pane docked beside a Claude Code terminal session](docs/images/claude-cli.png)

Install it in a Claude Code session:

```
/plugin marketplace add funnysubaru/yuiboard
/plugin install yuiboard@yuiboard
```

Or from a shell in one step (Claude Code 2.1.275 or later):

```sh
claude plugin install yuiboard --marketplace funnysubaru/yuiboard
```

The plugin and your YUIBoard service must be the same version. When you update the service (`git pull`, then restart it), update the plugin too: `claude plugin update yuiboard@yuiboard`.

To try changes from a checkout instead, load the plugin straight from it (the repository root is the plugin): `claude --plugin-dir /path/to/yuiboard` for one terminal session, or add `"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/yuiboard"` to `env` in `~/.claude/settings.json` and start a new session. Loaded this way, the plugin's id is `yuiboard@inline` instead of `yuiboard@yuiboard`.

Options:

| Option | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:4317` | Address of the YUIBoard service. It must run the same version as the plugin. |
| `lang` | `auto` | Pane language: `auto` (follows Claude Code), `zh`, `ja`, `en` |
| `guard` | `on` | Convention guard (below): `on` or `off` |

```sh
echo '{"url":"http://127.0.0.1:4317"}' | claude plugin configure yuiboard@yuiboard --values-stdin
```

- The pane opens by itself once per session, as soon as the session can be matched to a project: the session is linked to one of its tasks, or its working directory is inside a watched workspace. After you close it, it stays closed. Type `/yuiboard` to open it again.
- The card shows the tasks the session is linked to. Name the task the way you would in a PR title, such as "`<doc>` task 3.2"; a bare number isn't enough. Task numbers that Claude or a subagent writes into a commit message (`git commit -m`), a PR title (`gh pr create` / `gh pr edit --title`) or a new branch name (`git worktree add -b`, `git checkout -b`, `git switch -c`) count too; task numbers in Claude's replies don't. When several tasks are active, the one most recently named, edited or linked comes first. Subagents count separately, so each dispatched task stays "running" while its own subagent works. Once every linked task is done or void, the card says the session has no task in progress and shows the one it last worked on. Below the main task's status line, the card lists up to two of its pull requests with their state and how long they have waited.
- The **PR** view (after Overview) groups pull requests the same way as "Waiting on me" on the web page: awaiting review (drafts), awaiting merge (ready, plus merged but not yet pulled locally), and done (merged in the last `recentClosedPrDays` days; collapsed, showing at most three). The number next to PR counts the ones waiting on you, not the done ones. Each PR shows its number (a link to GitHub), title, linked tasks and how long it has waited; with more than one branch line, the line name comes first. Closed PRs that were never merged are left out. Projects without `repo.github` have no PR view.
- Projects with more than one branch line get a row under the navigation with "All" and each line name. Picking a line limits the Overview numbers and task tree, the PR view and its count, and Needs attention to that line, the same way the web page does; the card for the current session and Diagnostics stay as they are. Open in browser opens the same line. The pane starts on the line of the workspace the session runs in (`branchLines[].workspace`; the main repo counts as the line whose `base` is `main`), or All if it can't tell. Your choice lasts for the current session only.
- In the terminal, use the keyboard: press Ctrl+X then Tab to enter the pane, Tab or the arrow keys to move, Enter to press, and Esc to go back to the prompt. In fullscreen mode with at least 110 columns, the pane docks on the right and takes mouse clicks. Task numbers and "Open in browser" open the web page. Terminals without OSC 8 links print the address after the label.
- **Convention guard**: once the session is matched to a project, the plugin adds a short summary of [the document convention](CONVENTION.md) to Claude's system prompt, so tasks, dependencies and PR titles come out in a form YUIBoard reads. When Claude writes one of the project's task documents (Write or Edit) or runs `gh pr create` / `gh pr edit` with a literal `--title`, the plugin checks the result with the board's own parsers. Anything off-convention that this write adds is blocked with the line, the problem and the suggested form, and Claude fixes it before writing again. Problems the document already had are not blocked. A title the plugin cannot read (a variable, `--fill`) passes, and so does everything when the service is unreachable. Commit titles from `git commit -m`, new branch names and instructions dispatched to subagents are checked too: a document name or code that matches nothing (`NEXT#99`, `N99`) is blocked, while a bare number only gets a hint to Claude. Commands are checked only when they act on this project's repository; those run in another repository, or where the plugin cannot tell, pass. Claude's reply text cannot be blocked and relies on the summary alone. The plugin itself still writes nothing. Set `guard` to `off` to turn both the summary and the blocking off. Codex has no such hook; paste the block at the end of [CONVENTION.md](CONVENTION.md) into the repository's `AGENTS.md` instead.
- Option changes reach running sessions. Changes to the plugin's files don't; start a new session.
- The plugin also brings the skills `skills/devboard-add-project` and `skills/devboard-fix-convention`. An installed plugin runs from a copy, so this copy of the skill asks where your YUIBoard checkout is before it writes anything. If you also symlinked the skills as described above, Claude Code lists them twice; either one works. The `~/.agents/skills` link for Codex is not affected.

## Run as a service (macOS / Linux)

Run `devboard-ctl` to install the service or restart it. You don't need to edit any plist or unit file by hand.

```sh
node ops/devboard-ctl.mjs up                # macOS: restart the LaunchAgent for this directory, or create one from ops/devboard.plist.template
                                            # Linux: same, with a systemd user service (ops/devboard.service.template)
node ops/devboard-ctl.mjs up --no-service   # just start a background process (PID in cache/devboard.pid)
node ops/devboard-ctl.mjs check             # validate the config only
node ops/devboard-ctl.mjs find <repo path>  # find the project registered for a repository (read-only)
node ops/devboard-ctl.mjs save --new < project.json        # add a project; refused if the id or repository is already registered
node ops/devboard-ctl.mjs save --update <id> < patch.json  # patch only name / docSources / repo.github
node ops/devboard-ctl.mjs remove <id>                      # remove a project (cache/<id> and data/<id> are kept)
node ops/devboard-ctl.mjs revert <revision>                # undo the save / remove that returned this revision
```

The service is reachable at http://devboard.localhost:4317/ as well as 127.0.0.1. It still listens only on the loopback address. Browsers that support `.localhost` resolve the name to your machine, so you don't need to edit hosts files.

<details>
<summary>Details: <code>up</code>, <code>save</code> / <code>remove</code>, launchd, systemd, logs</summary>

- **`up`** first checks whether the configured port is served by a devboard this directory manages. If it is, `up` restarts it. If another program holds the port, `up` moves to the next free port and writes it back to `server.port`. If the devboard on the port was started by hand, `up` reports its PID and leaves it alone. `up` prints one line of JSON; on `ok:false` it exits with code 1 and gives a machine-readable `reason` (`unmanaged`, `bad-port`, `not-ready`, …).
- **`save` / `remove`** take a lock (`devboard.config.json.lock`; they wait up to 10 s, then report `config-busy`, or `stale-lock` if the lock was left by a process that has exited). They copy the config to `devboard.config.json.bak`, write atomically, and run `check`. If the global section or the touched project fails validation, they restore the original file (`reason: "check-failed"`). Errors that other projects already had don't block the save. On success they return a `revision`; to undo, use `revert <revision>` rather than copying `.bak` back. They don't restart the service, so run `up` afterwards.
- **macOS**: the LaunchAgent label is `com.devboard.agent` (with a hash suffix if another directory already uses it). The plist goes to `~/Library/LaunchAgents/`, and the service runs on the Node binary that ran `up`. It starts at login and launchd restarts it if it exits. Logs: `~/Library/Logs/devboard.log` and `devboard.error.log`. To manage it by hand:

  ```sh
  launchctl print gui/$(id -u)/<label>        # status
  launchctl kickstart -k gui/$(id -u)/<label> # restart after changing the backend
  launchctl bootout gui/$(id -u)/<label>      # stop; delete ~/Library/LaunchAgents/<label>.plist to disable autostart
  ```

  Logs are **not rotated automatically**. To rotate them with macOS's `newsyslog` (each log rotates at 10 MiB and 3 archives are kept), run this from the YUIBoard directory:

  ```sh
  sed "s|/Users/YOU|$HOME|" ops/devboard.newsyslog.conf > cache/devboard.newsyslog.conf
  launchctl bootout gui/$(id -u)/<label> &&
    /usr/sbin/newsyslog -r -f "$PWD/cache/devboard.newsyslog.conf"
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist   # run this even if rotation failed
  ```

  Don't just rename a log while the service is running, because the process keeps writing to the old file handle.
- **Linux**: the unit is `devboard.service` (with a hash suffix if taken). It starts at login and restarts 10 s after it exits, and it appends logs to `cache/devboard.log`. To run it without logging in, use `loginctl enable-linger`. Where no systemd user instance is available (containers, some WSL setups), `up` falls back to a background process and says so in `warnings`.

  ```sh
  systemctl --user status devboard.service
  systemctl --user restart devboard.service
  systemctl --user disable --now devboard.service   # stop and disable autostart
  ```

- The service runs the code currently in this directory. After you switch branches or change `src/`, restart it. If you change only `web/`, a hard refresh in the browser is enough.
- To update to a new release: run `git pull` in this directory, restart the service with `node ops/devboard-ctl.mjs up` (or `launchctl kickstart -k` / `systemctl --user restart` as above), then, if you use the Claude Code pane, run `claude plugin update yuiboard@yuiboard` so the plugin matches the service.

</details>

## Configuration

Copy `devboard.config.example.json` to `devboard.config.json`. Relative paths are resolved against the config file's directory, and `~` expands to your home directory.

```json
{
  "server": { "host": "127.0.0.1", "port": 4317 },
  "defaults": { "hoursPerDay": 8, "defaultDurationDays": 1, "sessionRunningMinutes": 10, "sessionStaleDays": 3,
                "githubRefreshMinutes": 5, "recentClosedPrDays": 14, "recentChangesDays": 7 },
  "projects": [{
    "id": "my-app", "name": "My App",
    "repo": { "path": "~/Projects/my-app", "github": "acme/my-app" },
    "docSources": [
      { "type": "spec-dir", "label": "Claude Code spec", "path": ".claude/specs" },
      { "type": "adr-dir", "label": "ADR", "path": "docs/adr" },
      { "type": "task-list", "label": "Task list", "files": [] }
    ],
    "archived": [], "excluded": [],
    "branchLines": [
      { "id": "main", "name": "Main", "base": "main", "docFilter": "^(?!v2-)" },
      { "id": "v2", "name": "v2", "base": "release/v2",
        "titlePrefix": "[V2]", "labels": ["v2"], "docFilter": "^v2-" }
    ],
    "github": {},
    "sessions": [{ "source": "claude-code" }, { "source": "codex" }]
  }]
}
```

| Field | Meaning |
|---|---|
| `server.host` / `port` | Listens on loopback by default. A non-loopback host triggers a warning in the log and on the page. |
| `defaults` | Working hours per day; default task duration in days; minutes of inactivity before a session stops counting as "running"; days before it counts as "stalled"; GitHub refresh interval in minutes (minimum 2); and how many days back to list unlinked PRs and recent changes. |
| `projects[].id` | Letters, digits, `-` and `_` only. It is used in cache paths and page URLs. |
| `repo.path` / `repo.github` | The local working copy (must be a git repository) and the GitHub `owner/name`. `repo.github` is optional; without it, status comes from docs and AI sessions only. |
| `docSources` | Where the docs live. `spec-dir`: one spec per subdirectory; subdirectories without `tasks.md` are listed as "Planning". `adr-dir`: an ADR directory. `md-dir`: a plan or TODO directory, where every `.md` at that level is one doc and docs without task lines are "Planning". `task-list`: individual task-list files. |
| `archived` / `excluded` | docIds to archive (hidden by default, can be filtered in) or to exclude entirely. `*` and `?` wildcards are supported. |
| `milestoneCodePattern` / `prerequisiteIdPattern` | Optional regexes for milestone codes and prerequisite IDs. By default `Milestone M1` / `里程碑 M1` / `マイルストーン M1` and `P1` are recognized. |
| `branchLines` | Release lines. `base` is the target branch. PRs are assigned to a line by `titlePrefix` / `labels` / base branch, and docs by `docFilter`, a regex matched against the docId. Add `workspace` to read a separate checkout. Alternatively, use `docRef` (e.g. `origin/next/v3`) plus `docFiles` to read specific files from that ref of the main repository without a separate checkout. Those docs get an `<line id>:` prefix, so set this line's `docFilter` to `^<id>:` and exclude that prefix from the other lines. YUIBoard never fetches, so the content is whatever your last fetch brought in. |
| `github.ghPath` | Optional path to the `gh` executable, if it isn't on `PATH`. |
| `sessions` | AI session sources. Each source is scanned on its own and degrades on its own. `claude-code` reads `projects/` under `$CLAUDE_CONFIG_DIR` or `~/.claude`; `codex` reads `sessions/` under `$CODEX_HOME` or `~/.codex`. Override either with `dir`. `extraCwds` also counts sessions started in other directories (such as the repository's parent) toward this project. A Codex session belongs to a project only if it *started* there, and sub-agents are merged into their parent session. |

Docs, sessions and manual links refresh every 5 seconds; GitHub every `githubRefreshMinutes`. Pages update live over SSE.

## Read-only guarantees

- **Repositories**: YUIBoard runs only allow-listed read-only git commands (`rev-parse`, `merge-base --is-ancestor`, `for-each-ref`, `log`, `worktree list`) with `GIT_OPTIONAL_LOCKS=0`, ignoring any inherited `GIT_*` variables such as `GIT_DIR`. It never fetches or checks out, never writes `.git` or the index, never competes with you or your AI for git locks, and never changes any file in the repository.
- **GitHub**: YUIBoard only reads, through `gh`. Your token stays with `gh` and never appears in the config, caches, logs or pages. If the token has more than read access, the page tells you.
- **AI session logs**: files are opened read-only and read up to the last complete line, and nothing is created in session directories. Caches and pages keep only metadata and short excerpts, with anything that looks like a key or token masked. Full conversations are never stored or uploaded.
- **Convention fixes** are the one exception, and they are not made by YUIBoard: when you run `devboard-fix-convention` (or onboard a project for the first time), the AI in your session edits document lines and PR titles, each change only after you confirm it.
- **The server itself** writes only to `cache/` and `data/` in its own directory. Pages accept only same-origin requests, and the write endpoints (manual links, refresh now) check `Origin` and `Content-Type`. There is no telemetry.
- `test/readonly.test.mjs` runs a full refresh against a temporary repository and session directory. It checks that `git status`, `.git` and the session files (including their mtimes) are unchanged afterwards.

## Platforms

- **Tested**: macOS 15 with Node 24. The full test suite also runs in CI on Ubuntu and macOS.
- **Linux**: the systemd user service is tested only against a stand-in, not yet on a real machine. Directories whose file names are NFD-normalized may fail to open from "View source".
- **Windows**: handled by design but untested. Known risks are the encoding of Claude Code session directory names, finding `gh.exe` (set `github.ghPath` if needed), shared reads of session files that are being written, and `rename` failing with `EPERM` while antivirus or indexing holds the cache file.
- Everywhere: paths are normalized to NFC and shown with `/`, CRLF and LF are both accepted, and git / gh are called through `execFile`, never a shell.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, tests and the hard constraints (zero dependencies, read-only).

## License

[Apache License 2.0](LICENSE). Copyright 2026 JimmyFu.
