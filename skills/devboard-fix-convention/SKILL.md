---
name: devboard-fix-convention
description: Fix the "Convention issues" that the local devboard (YUIBoard) board reports for the current repository — task lines, dependencies, Markdown in task bodies, and PR titles that YUIBoard cannot read — one item at a time, each change confirmed by the user. Use when the user says "fix the convention issues", "make the docs readable for YUIBoard", "rewrite the PR titles for devboard", or the same in Chinese or Japanese (e.g. 「修正不满足约定之处」「按 YUIBoard 约定改文档」「把 PR 标题改成看板认得的写法」「規約に合わない箇所を直して」). Also run by devboard-add-project right after a first onboarding.
---

# Fix convention issues, one confirmed change at a time

The board lists everything it cannot read as intended on its Diagnostics page under "Convention issues". This skill walks that list and fixes the items in the watched repository's documents and in the PR titles on GitHub.

Talk to the user in the language they write in. This skill is in English, but every question, listing and report follows the user's language.

## Rules

- **This skill is an approved exception to devboard's read-only rule** (owner 2026-10-12, NEXT N27.3): the AI in the user's session edits the watched repository's documents and PR titles, **and only after the user confirms each single change**. Never batch changes, never apply a change the user has not seen, never "fix the rest the same way" without asking item by item. The devboard service itself stays read-only.
- Edit documents only with the editing tools, one item at a time. Do not commit, push or run any other git write; tell the user the edits are uncommitted.
- Change PR titles only with `gh pr edit <number> --repo <owner/name> --title "…"` (labels with `--add-label`). Merged and closed PRs are fixed too (owner 2026-10-12): their titles are how the board links them to tasks.
- Do not invent rewrites. Each item's `detail` says what is wrong and, for most, the form to use; the full convention is `CONVENTION.md` in the YUIBoard checkout or plugin (`CONVENTION.zh-CN.md`, `CONVENTION.ja.md`). If you cannot tell what the author meant, ask the user instead of guessing.
- If YUIBoard's Claude Code plugin blocks one of your writes ("YUIBoard: …"), your rewrite is still off-convention: read the message, propose a corrected change, and confirm it with the user again.
- On "**Stop**": tell the user the reason and what to do next. Do not work around it some other way.

## 1. Find the project and the service

1. `<REPO>` = `git rev-parse --show-toplevel`. Fails → **Stop**: not in a git repository.
2. `<URL>` = the devboard service, `http://127.0.0.1:4317` unless the user or the YUIBoard plugin's `url` setting says otherwise. `curl -sf "<URL>/api/projects"` fails → **Stop**: the service is not running; tell the user to start it (`node <YUIBoard checkout>/ops/devboard-ctl.mjs up`).
3. Find the project whose workspace is `<REPO>`:

   ```sh
   curl -s "<URL>/api/projects" | node -e '
   const repo = process.argv[1]; const url = process.argv[2];
   const { projects } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
   (async () => { for (const p of projects) {
     const r = await fetch(`${url}/api/projects/${encodeURIComponent(p.id)}/summary`); if (!r.ok) continue;
     const s = await r.json();
     if ((s.workspaces ?? []).some((w) => !w.ref && (repo === w.path || repo.startsWith(w.path + "/")))) { console.log(p.id); return; }
   } })();' "<REPO>" "<URL>"
   ```

   No output → **Stop**: this repository is not on the board (the user can onboard it with devboard-add-project).

## 2. Read the list

```sh
curl -s "<URL>/api/projects/<id>/board" | node -e '
const b = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const ws = new Map(b.workspaces.map((w) => [w.id, w]));
const docs = new Map(b.docs.map((d) => [d.docId, d]));
const items = b.diagnostics.convention.map((x) => {
  if (x.pr != null) return { pr: x.pr, rule: x.rule, detail: x.detail };
  const d = docs.get(x.docId), w = d && ws.get(d.workspaceId);
  return { rule: x.rule, file: w && !d.ref ? `${w.path}/${d.path}` : null, ref: d?.ref ?? null, line: x.line, detail: x.detail };
});
console.log(JSON.stringify({ github: b.freshness.github.state === "off" ? null : true, prTitlesChecked: !b.degraded.noPrData, items }));'
```

- `items` empty → tell the user there is nothing to fix and finish.
- `file: null` with a `ref` → the document is read from a git ref (another branch), not from a local file: list it as "edit it on branch `<ref>`" and skip it.
- `file` is in the checkout the board reads (the project's workspace). If `<REPO>` is a different checkout of the same repository (a git worktree), say so before the first document item and ask once: edit the workspace files the board reads (they may have uncommitted work of their own), or the same relative paths in `<REPO>` (the board sees them after the branch is merged and pulled). Use the answer for every document item.
- `prTitlesChecked: false` → PR titles have not been loaded yet; fix the documents now and say PR titles can be checked later.
- The GitHub repository for `gh`: `git -C "<REPO>" remote get-url origin` → `owner/name`.

Show the user the count by kind (task lines / dependencies / estimates / Markdown / PR titles) and say you will go through them one at a time, and that they can answer "skip" or "stop" at any item.

## 3. One item at a time

Go document by document; inside a document, **from the last line up**, so earlier line numbers stay valid. Before each item re-read the line (`sed -n '<line>p' "<file>"`); if it no longer matches what the item describes, find it again by its text or skip it.

For each item:

1. Show: where (`file:line` or `PR #n` with its current title from `gh pr view <n> --repo <owner/name> --json title,state -q '.title + " (" + .state + ")"'`), the original text, what is wrong (`detail`), and the exact replacement you propose.
2. Ask: apply / skip / stop. Only "apply" (or a clear yes) applies it; anything else is not a yes.
3. Apply exactly the confirmed change: the editing tool for a document line; `gh pr edit` for a PR title or label.

What the usual items look like (rule numbers as on the Diagnostics page):

| Item | Change to propose |
|---|---|
| 1 `### 任务 1：…` / `### Task 1: …` heading in a document that also has task lines | `- [ ] 1 …` (the item names the exact line) |
| 1 `- [ ] task 2 …`, full-width digits, `- [ ] 1、…` | `- [ ] 2 …` |
| 1 checkbox other than `[ ]` / `[x]` / `[~]` | ask which of the three is meant |
| 1 number used twice in a document | ask which one to renumber, and to what |
| 3 unknown dependency wording, or a dependency on something that does not exist | `（依赖 1、2.1）` / `(depends on 1, 2.1)` with the numbers that exist; ask when unclear |
| 5 estimate the board cannot read | `预计耗时：2 天` / `Estimate: 2d` |
| 8 heading, horizontal rule, image, footnote or HTML in a task body | what the item suggests: bold line, blank line, link, text in brackets, Markdown or inline code |
| 7 PR title reference that does not exist, is ambiguous, or has the wrong case | the exact `<document>#<number>`, milestone code or `任务 N` the item suggests; for a missing task ask which task the PR delivered |
| 7 title and description / branch point to different tasks | ask which is right; usually the title should name the delivered tasks |
| 7 missing branch-line title prefix or label | add the prefix to the title, or `gh pr edit <n> --add-label <label>` |

## 4. Check and report

After the last item, ask the board to re-read now (same as the Refresh button on the page): `curl -s -X POST "<URL>/api/projects/<id>/refresh"`, wait a few seconds, and run step 2 again. GitHub data may take until the next GitHub refresh (default 5 minutes) to show the new titles.

Report:

```
Convention issues for <project>: <fixed> fixed, <skipped> skipped, <left> left.
- Documents changed (uncommitted): <files>
- PR titles changed: #<n> "<old>" → "<new>", …
- Still listed: <the remaining items, or "none">; full list: Diagnostics page → Convention issues
```

## Codex and other tools

Without Claude Code's YUIBoard plugin nothing blocks off-convention writes; this skill (it only needs a shell and `gh`) and the snippet at the end of `CONVENTION.md` are the only help there.
