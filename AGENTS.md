# YUIBoard — notes for AI agents (Claude Code / Codex)

YUIBoard is a local, read-only progress board for AI-assisted development. It reads planning docs (`tasks.md`, ADRs, plans, TODO lists), GitHub PRs and local Claude Code / Codex sessions, and derives a five-state status per task. It shows an overview, Gantt chart, dependency graph, next steps, needs-attention list and diagnostics. The repository path, local domain, config file and storage keys still use the old name `devboard`; the product name is YUIBoard.

## Read first

- [README.md](README.md): usage, configuration fields, read-only guarantees. Translations: `README.zh-CN.md`, `README.ja.md`.
- [CONTRIBUTING.md](CONTRIBUTING.md): dev setup, layout, tests, CI, hard constraints, and the **manual checklist**.
- [CONVENTION.md](CONVENTION.md): how watched repositories should write docs and PR titles. Translations: `CONVENTION.zh-CN.md`, `CONVENTION.ja.md`. `test/convention.test.mjs` compares the examples in all three, block by block.
- `test/fixtures/ui-mockup.html`: the static UI mockup the interface was built from (fictional data). `test/ui.test.mjs` checks colors, status icons, navigation and wording against it.

- The Claude Code plugin (mod): the repository root is the plugin (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/`). `hooks/model.mjs` is the pure pane logic, tested by `npm test`; `hooks/register.tsx` holds the hooks and the pane, tested by `claude plugin test .` (not in CI). On the server side it adds only `src/summary.mjs`.

The trilingual docs move together: if you change one README or CONVENTION, update the other two in the same PR.

## Hard constraints

- **Zero npm dependencies, no build step.** Use the Node 24 standard library and a native ES-module frontend. Charts are hand-drawn SVG.
- **Tests**: `npm test` (= `node --test --test-timeout=60000 "test/*.test.mjs"`; `node --test test/` doesn't work on Node 24) must stay fully green.
  - Tests use a fixed "now" and need `git`. Server tests listen on a random 127.0.0.1 port.
  - GitHub is faked by `test/fixtures/fake-gh.mjs`, so tests never touch the network.
  - Register cleanup as soon as you start a server or child process, and release any promise you blocked on purpose. A timeout is not cleanup.
  - Fixtures use fictional data only.
- **CI**: `.github/workflows/ci.yml` runs `test-linux` / `test-macos` on every PR once it is ready for review (drafts are skipped; marking a PR ready starts the run), and on pushes to `main`. The Node version comes from `package.json`.
- **Read-only.** YUIBoard never writes to watched repositories, `~/.claude`, `~/.codex` or GitHub.
  - git runs only the allow-listed read-only commands in `GIT_ALLOWED` (`src/docs.mjs`), with `GIT_OPTIONAL_LOCKS=0` and without inherited `GIT_*` variables (`gitEnv()` in `src/config.mjs`; otherwise `GIT_DIR` and friends override `-C`).
  - GitHub is read only through `gh api graphql`, and YUIBoard holds no token.
  - Only `src/store.mjs` writes to disk, and only to `cache/` and `data/`.
  - The Claude Code mod reads the local service only through `GET /api/projects/:id/summary` (the mod's `$.http.fetch` caps responses at 4 MiB, which the full board exceeds) and writes nothing.
  - The exception is `ops/devboard-ctl.mjs`, which also writes:
    - `devboard.config.json`: `up` rewrites `server.port`, and `save` / `remove` back the file up to `.bak` first;
    - `cache/devboard.pid` and `cache/devboard.log`;
    - the LaunchAgent plist or systemd user unit that it created itself.
- **Frontend.** Build nodes only with `h()`, `textContent` and `setAttribute`; never `innerHTML`. Session excerpts and error messages go through `src/mask.mjs` first.
  - Markdown in task text is rendered with `h()` too (`mdBlock` / `mdInline` in `web/app.mjs`; parsing lives in the DOM-free `web/md.mjs`). SVG, tooltips and picker buttons use the plain text from `mdText`. HTML in docs shows up as literal text.
  - Forms the renderer can't handle are shown as written with a "not rendered as Markdown here" marker, and the same check (`mdUnrendered`) feeds rule 8 of the Diagnostics page's convention issues. A single `*` (as in `*.mjs`) and a single `~` (as in `1.2~1.8`) are never italic or strikethrough.
  - Dropdowns and dates always use the custom `dropdown()` (APG select-only combobox) and `datePicker()` (calendar dialog) in `web/app.mjs`, never a native `<select>` or `<input type=date>`.
    - Open state and the highlighted item or focused day live in `state.dd` / `state.dp`, keyed by aria-label, so they survive a full SSE redraw and focus comes back by aria-label.
    - They close when the view changes, and the `pointerdown` handler in `main()` closes them on an outside click.
- **Three UI languages.** The Chinese source string is the translation key.
  - Frontend text uses `` t`…` `` (`web/i18n.mjs`).
  - Server sentences that reach the page use `` msg`…` `` (`src/msg.mjs`; still Chinese at runtime). The frontend translates them with `tx()`, which matches whole sentences against the server dictionary.
  - User content is never translated: task titles, paths, PR titles, session text. Interpolated values stay as they are, except sub-clauses and reference lists that the server itself builds. Those are translated only once registered in `SLOTS` in `web/i18n.mjs`.
  - Japanese and English translations live in `web/i18n-ja.mjs` and `web/i18n-en.mjs`. `test/i18n.test.mjs` statically checks for unwrapped text, missing or extra keys and placeholder mismatches.
  - Write each sentence as one template; don't glue sentences together from fragments.
  - Lists the server builds into a sentence use `joinList()` (`src/msg.mjs`). The separator is an invisible U+2063 followed by '、', shown as ', ' in English; a '、' inside an item stays as it is, and U+2063 inside an item is escaped.
  - Server log lines and `devboard-ctl` messages are `` msg`…` `` templates too, printed through `say()` (`src/say.mjs`). The language comes from `DEVBOARD_LANG`, then `LC_ALL` / `LC_MESSAGES` / `LANG`, defaulting to English. `devboard-ctl` translates only when it prints its JSON; function return values and machine fields such as `reason` stay as they are.
- **Comments.** Most existing comments are in Chinese. New comments may be in English or Chinese. Explain intent and non-obvious edge cases. References like `design §3.8`, `需求 3.1` or `任务 6.7` point to the original internal spec, which isn't published; treat them as historical anchors. Mark a deliberate shortcut with a `ponytail:` comment that names its limit and how to upgrade it.

## Product rules (don't break these)

- **Done requires the doc checkbox.** A linked or merged PR never replaces the check in the doc.
  - Draft PR = awaiting review; ready PR = awaiting merge.
  - Merged on GitHub but not pulled locally = awaiting merge, labelled "merged · not synced locally".
  - A checked task counts as done only when it has no open or not-yet-synced PR.
  - An unchecked task with a merged linked PR is in progress.
  - If sync can't be verified, a checked task still counts as done, flagged "local sync not verified".
  - A checked task with no valid PR is done, flagged "checked in doc only".
- **"In progress" activity comes from the focus of local AI sessions.** A merged PR alone doesn't mean a session is active.
- **Task rows come from `tasks.md`**; PRs are only tags at the end of the row.
  - PRs are linked to tasks mainly by their title. Bare numbers are never recognized.
  - "Task N (partial)" keeps the evidence and the tag. Like any other link, it can't replace the checkbox, and partial PRs also go through the open / not-synced checks.
  - A milestone code with a partial marker makes the whole group partial. If the same task is referenced both fully and partially, it counts as partial.
- **Off-convention writing is never silently misread.** Common variants are recognized directly (the partial-marker forms, ADR short names like `ADR-0033`, `阶段一`, `depends on 1.1 + 1.2`, `1~3`). Anything whose intent is visible but still can't be read goes to the Diagnostics page's convention issues with a suggested rewrite, and the onboarding skill lists it in its report.
- **Linking sessions to tasks is deliberately strict across documents.** A bare task number counts only for docs that already appear in the session's context, and a bare number in a hand-off message doesn't link anything. Don't loosen this; doing so marks same-numbered tasks in other specs as in progress.
- **Branch lines are assigned by a PR's base branch** (plus `titlePrefix` / `labels`). Users switch lines from the top bar. Don't add a config that hard-limits counting to one line; this was tried and reverted.
- **Claude Code subagents count separately.** When a subagent's log has an `agent-*.meta.json` with the `toolUseId` of the call that dispatched it, it runs as its own lane: the tasks dispatched to it keep their activity from its own records and don't change the main thread's focus. A dispatch that names no task freezes the main thread's focus at that moment for the lane. Branch signals are per lane too. Subagents without meta merge into the main thread as before.
- **Codex sessions** belong to a project only by the cwd they started in. Sub-agents merge into their parent session. Only root-session `UserMessage` entries count as human input; heartbeats and answers to Codex's own questions don't. Summaries may include masked public assistant output.
- **Token-scope banner**: users can dismiss it with "Got it", which hides that exact text in that browser until the text changes. Diagnostics always shows it. Never touch credentials or hide it on the server.
- The "Needs attention" nav count equals the total in that view, "checked in doc only" included, and matches "All types (N)". Parent tasks can fold their children and are expanded by default.
- "Waiting on me" lists every open PR, marking the unlinked ones "No linked task". The overview number cards count tasks, so the two use different units.
- **Projects are added by AI, not from the web UI.** `skills/devboard-add-project` detects the docs, confirms them with the user, and writes `devboard.config.json` only through `ops/devboard-ctl.mjs save` / `remove`, which validate and back up.
  - Re-onboarding the same repository (matched by normalized path) keeps its id and existing fields.
  - `md-dir` sources: docs without task lines show as "Planning", and they give way to other sources with the same name.
  - `repo.github` is optional. Without it no PR cache is read and no old board is replayed.
- **Claude Code mod.** The repository root is the plugin, because a mod can't import files outside its plugin directory or follow symlinks; that's why `skills/devboard-add-project` comes with the plugin. The pane opens by itself once per session when it can match the session to a project, and stays closed after the user closes it. Status hues match the web page. Task numbers are the links to the web page; nothing appears only on hover. The main task is the one with the latest activity; on a tie, prefer tasks the session named, then unchecked ones, then tasks without subtasks, then document order.
- In the overview task tree, doc, group and task text can be selected and copied but not edited. Clicking text or empty row space doesn't open the drawer; the "Details" button at the end of the row does. Docs, groups and parent tasks expand only via their fold triangle.

## Redraw behavior (when changing `main()` in `web/app.mjs`)

`test/main.test.mjs` drives the real `main()` on a fake DOM with a fixed clock. Layout, inertial scrolling and bounce still need manual checklist item 10 in CONTRIBUTING.

- A new board version arrives over SSE and **replaces the whole `body`**. Afterwards, restore focus and caret by aria-label, and restore scroll positions (`SCROLLERS`, only within the same view or drawer).
- **Don't redraw mid-scroll.** `paintWhenIdle` waits for 800 ms without wheel or touch events; otherwise trackpad inertia lands on the main panel.
- **Refresh feedback** only changes the `textContent` of the mounted `aria-live` node next to the button; it never redraws the page. A 202 `{merged:false}` only means the request was accepted, and `{merged:true}` shows "refresh request merged". A success message clears when the new board arrives; a failure message stays. Messages from an older project or request never overwrite newer ones.
- When the board updates, doc source text is only **marked stale**: it keeps showing while it is re-read in the background (`textLoader`'s `stale`). Don't clear it, or the drawer flashes "Loading source…" and shrinks.
- Drawer bounce: `.drawer` uses `overscroll-behavior: contain`, `body:has(.drawer.open)::after` puts a same-color backdrop behind it, and `.drawer .hd::before` covers the top. Don't change this to `none`, which feels stiff.

## Running

- `node src/server.mjs` reads `devboard.config.json` (copy it from `devboard.config.example.json`; it's git-ignored) and serves http://127.0.0.1:4317 by default. If the port is taken, an instance is probably already running.
- After changing `src/` or the config, restart. After changing only `web/`, a hard refresh is enough.
- Developing the mod: load the checkout with `claude --plugin-dir <this directory>` or `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, and point the plugin's `url` at a service running the same checkout. A running session does not reload the mod when plugin files change; change a value in `pluginConfigs["yuiboard@inline"].options` (for example add or remove a trailing `/` on `url`) and leave it changed, or start a new session.
- `npm run demo` (`ops/demo.mjs`) builds a fictional project (git repo, docs, PRs replayed by `fake-gh`, a Claude Code session) in a `yuiboard-demo-*` system temp directory and serves it in-process from port 4318 up; cache and data live there too. Ctrl+C stops it and deletes the directory. `test/demo.test.mjs` checks the demo states with a fixed "now".
- Docs, sessions and manual links refresh every 5 s; GitHub every `githubRefreshMinutes` (default 5, minimum 2). YUIBoard never calls an AI API.
- For checks that write data or simulate failures (manual links, going offline), copy the whole directory and run it on another port. Never touch the user's running instance or its `data/`.

## Workflow

- Use one branch and one PR per change, and describe what changed and how you verified it. Exception: changes that touch only docs (no code, tests or config) go straight to `main` without a PR.
- **Open every PR as a draft** (`gh pr create --draft`), then stop and hand it to the maintainer for review. Run `gh pr ready` only after the maintainer says it's ready; never open a draft and mark it ready in the same turn, and never merge right after marking it ready. CI doesn't run on drafts, so fixes made during review don't re-run it; it starts at `gh pr ready`. Run `npm test` (plus `claude plugin test .` when the plugin changes) yourself before asking for review, and put the results in the PR description.
- **Auto-merge is enabled for this repository.** After the maintainer approves, run `gh pr merge --auto --merge --delete-branch`: GitHub merges once `test-linux` and `test-macos` pass (immediately if they already have). Don't turn on auto-merge when opening a PR.
- When behavior or counting rules change, update README / CONVENTION (all three languages) and this file in the same PR.
- Ask the maintainer about product decisions instead of deciding them yourself.
