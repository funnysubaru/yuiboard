# Contributing to YUIBoard

Thanks for helping out! Issues and pull requests are welcome in English, 中文 or 日本語.

## Dev setup

You need Node 24.x and git. There is nothing to install: YUIBoard has no npm dependencies and no build step.

```sh
cp devboard.config.example.json devboard.config.json   # point it at a repository you want to watch
node src/server.mjs                                     # http://127.0.0.1:4317/
npm test
```

- After changing `src/` or the config, restart the server. After changing only `web/`, a hard refresh in the browser is enough.
- If you need to try something that writes data or simulates failures (manual links, going offline), copy the whole directory somewhere else and run it on another port. That way your everyday instance and its `data/` stay untouched.

## Layout

| Path | What lives there |
|---|---|
| `src/server.mjs` | HTTP server, SSE, refresh loop |
| `src/config.mjs` | Loading and validating `devboard.config.json` |
| `src/docs.mjs`, `src/relations.mjs`, `src/refs.mjs` | Parsing task docs, dependencies and task references (see [CONVENTION.md](CONVENTION.md)) |
| `src/github.mjs` | Read-only PR queries through `gh api graphql` |
| `src/sessions/` | Claude Code and Codex session scanners |
| `src/engine.mjs`, `src/gantt.mjs` | Status, conflicts, next steps and schedule |
| `src/store.mjs` | The only module that writes to disk (`cache/`, `data/`) |
| `src/mask.mjs`, `src/msg.mjs` | Secret masking; marking server messages for translation |
| `web/` | Native ES-module frontend: `app.mjs` (views), `svg.mjs` (hand-drawn charts), `i18n*.mjs` |
| `ops/devboard-ctl.mjs` | Service install / restart and config editing used by the skill |
| `skills/devboard-add-project/` | The AI skill that onboards a repository |
| `test/` | `node:test` suites and fixtures (all fictional data) |

## Tests

```sh
npm test    # = node --test --test-timeout=60000 "test/*.test.mjs"
```

(`node --test test/` doesn't work on Node 24.) The suite must stay fully green.

- Tests use a fixed "now". They need `git` on the machine. Server tests start the server on a random port on 127.0.0.1.
- GitHub is faked by `test/fixtures/fake-gh.mjs`, so the tests never touch the network or need credentials.
- Register cleanup as soon as a test starts a server or child process, and release any promise you blocked on purpose. A test timeout is not a substitute for cleanup.
- `test/main.test.mjs` drives the real frontend `main()` on a fake DOM. `test/ui.test.mjs` renders each view.
- `test/i18n.test.mjs` fails if UI text isn't wrapped for translation or a translation is missing (see below).
- To also parse every spec and ADR of a real repository, set `DEVBOARD_REAL_REPO=<path>`.

**CI**: GitHub Actions runs `test-linux` and `test-macos` (Node version from `package.json`, full `npm test`, 10-minute limit) on every PR, drafts included, and on pushes to `main`.

## Hard constraints

Please keep these intact. A PR that breaks one of them can't be merged as it is.

- **Zero npm dependencies, no build step.** Use the Node standard library and the native ES-module frontend. Charts are hand-drawn SVG.
- **Read-only.** YUIBoard never writes to the watched repository, `~/.claude`, `~/.codex` or GitHub.
  - git runs only the read-only commands in `GIT_ALLOWED` (`src/docs.mjs`), with `GIT_OPTIONAL_LOCKS=0`.
  - GitHub is read only through `gh api graphql`, and YUIBoard never holds a token.
  - Only `src/store.mjs` writes to disk, and only to `cache/` and `data/`.
  - The one exception is `ops/devboard-ctl.mjs`, which also writes `devboard.config.json` (plus its `.bak`), `cache/devboard.pid` / `.log`, and the LaunchAgent plist or systemd unit that it created itself.
- **Frontend safety.** Build DOM nodes only with `h()`, `textContent` and `setAttribute`; never `innerHTML`. Session excerpts and error messages go through `src/mask.mjs` first. Markdown in task text is rendered with `h()` too (`mdBlock` / `mdInline`), so HTML in docs shows up as literal text.
- **Three UI languages.** The Chinese source string is the translation key.
  - Wrap frontend text in `` t`…` `` (`web/i18n.mjs`).
  - Wrap server sentences that reach the page in `` msg`…` `` (`src/msg.mjs`). The frontend translates them with `tx()`.
  - Put the Japanese and English translations in `web/i18n-ja.mjs` and `web/i18n-en.mjs`.
  - Never translate user content: task titles, paths, PR titles and session text stay as written.
  - Write each sentence as one template; don't glue sentences together from fragments.
- **Redraw behavior.** A new board version replaces the whole page over SSE. Focus, cursor position and scroll positions are restored, and redraws wait until scrolling stops. If you change `main()` in `web/app.mjs`, keep `test/main.test.mjs` green and run checklist item 10 below.

Code comments are mostly in Chinese for historical reasons. Some cite sections of the original internal design spec (`design §…`, `需求 …`, `任务 …`), which isn't published; treat them as historical anchors. `test/fixtures/ui-mockup.html` is the static UI mockup the UI was built from (with fictional data), and `test/ui.test.mjs` checks the real views against it. Write new comments in English or Chinese. A comment should explain intent and non-obvious edge cases, not repeat what the code says. Mark a deliberate shortcut with a `ponytail:` comment that names its limit and the way to upgrade it.

## Pull requests

- Use one branch and one PR per change, and describe what changed and how you verified it.
- If you change how something behaves or is counted, update the docs ([README](README.md), [CONVENTION](CONVENTION.md), and their translations) in the same PR.
- For UI changes, attach a screenshot, and check both light and dark themes.

## Manual checklist

Run these against a real repository before a release or after a large change. They cover what unit tests can't. Use a read-only config that points at a repository in active use, with plenty of docs and PRs, and at your local session directories.

1. **First paint**: with a warm cache, a restart shows the full board, PRs and sessions included, within 2 s. After deleting `cache/` (cold start), the docs board appears within 5 s, and PRs and sessions show "Refreshing…" rather than a blank.
2. **Gantt layout**: pick a `tasks.md` with many tasks, dependencies and estimates. Check the actual segments, the estimated segments, the reasons tasks can't be scheduled, and each group's estimated finish date.
3. **PR linking**: a PR whose title names a milestone code expands to the whole group. A PR titled "Task N" links to that task. The "PR" box in the task drawer quotes the source text.
4. **Sessions**: time the first scan of about 120 MB of session logs and the incremental reads after it (the startup log prints each round's time). An active session shows as "running".
5. **Live doc updates**: change one line of `tasks.md` in the watched repository (for example, tick a checkbox). The page updates within 10 s, and "Docs N s ago" in the top bar resets to zero.
6. **Offline**: after you disconnect, GitHub reads fail and a "GitHub data is from a cache taken at …" banner appears, while the board keeps the last PR states. When you reconnect, the banner goes away.
7. **Idle CPU**: leave the page alone for a few minutes. The node process's CPU in Activity Monitor stays close to 0.
8. **Themes**: toggle ◐, and also let the page follow the system appearance. In both themes, dropdowns, date pickers, tags, the Gantt chart and the graph are all readable.
9. **URL sync**: pick a branch line on the overview, tick a few filters, type a search, change the "Recent activity" start date, pick a type under "Needs attention", and open a task drawer. The address bar follows each change. Open the copied URL in a new tab: the filters, search and drawer all come back. Back and Forward move between views and drawers.
10. **No focus loss on SSE redraw**: stop halfway through typing in the search box and wait for a push. With active sessions a push arrives about every 5 s, or click "↻ Refresh". After the full redraw, the search box still has focus, the cursor hasn't moved, and nothing you typed is lost. An open "＋ Link a task manually" picker in the drawer keeps its search text too. Scroll the drawer, the Gantt chart and the side lists, then wait for a push: the scroll positions stay put. Keep scrolling inside the drawer, past the end as well: the main panel doesn't scroll along.
11. **Manual links**: under "PRs without a linked task", click "Link", pick a task, then undo it. Close the drawer and reopen the same PR from its tag: the picker is collapsed. It opens automatically only when you come from "Link".
12. **Refresh feedback**:
    - Focus "↻ Refresh" with the keyboard and press Enter. The request state shows right away, and the button keeps focus after the response. Use a screen reader to check that the same live region announces the response.
    - Once the server accepts the request, the page says it is waiting for the board to update. Clicking again within 30 s shows "Refresh request merged with one already pending". The message clears when the new board arrives.
    - If you switch projects before the response arrives, the old project's message doesn't carry over to the new one.
    - When offline or on a server error, only a generic failure message appears.
13. **Codex sessions** (with a `codex` source configured): Diagnostics → "AI sessions" lists the Codex source and its session count. Start Codex in the watched repository naming "<doc> task N". Within 10 s:
    - the task shows "Codex running";
    - the drawer's session area says "Codex · started …";
    - the graph node says Codex as well.

    If the same task also has a Claude session, the one with the most recent activity wins.
14. **No GitHub** (onboard a repository without a GitHub remote, or remove `repo.github` in an isolated copy and restart):
    - The top bar says "GitHub not connected" in a neutral style, not a warning color, with no token banner.
    - The "Waiting on me" column says the project has no GitHub, so it contains no PRs.
    - The Diagnostics GitHub section says it is not configured.
    - "↻ Refresh" refreshes only docs and sessions, and tasks are only ever not started, in progress or done.
