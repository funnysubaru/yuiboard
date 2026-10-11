#!/usr/bin/env node
// npm run demo（N26 任务 26.3）：用虚构项目「Acme Notes」起一份演示看板，新用户几秒内就能看到完整界面。
// 所有东西（git 仓库、文档、PR 回放文件、Claude Code 会话、配置、cache/、data/）都建在一次性的系统临时目录里，
// 每次运行从零开始：合并提交的 SHA 每次都不同，复用旧缓存会让已合并 PR 显示成「待同步到本地」。
// 服务在本进程内起（startServer），不写本目录的 cache/、data/、devboard.config.json；Ctrl+C 关服务并删掉临时目录。
// GitHub 由 test/fixtures/fake-gh.mjs 回放 prs.json，不联网、不需要凭据。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { gitEnv } from '../src/config.mjs';
import { pickPort, isFree } from './devboard-ctl.mjs';

const FAKE_GH = fileURLToPath(new URL('../test/fixtures/fake-gh.mjs', import.meta.url));
const DEMO_PORT = 4318; // 4317 留给常驻服务

const SYNC = (s) => `# Sync engine

## Prerequisites
| ID | Item | Blocks |
|---|---|---|
| P1 | Staging database (done) | none |
| P2 | Load-test budget approval | 6 |

### Milestone M1: Local-first storage
- [${s[1]}] 1 Storage schema and migrations
  - **Estimate**: 1 day
- [${s[2]}] 2 Operation log
- [${s[21]}] 2.1 Append-only log (depends on 1)
  - **Estimate**: 1 day
- [${s[22]}] 2.2 Log compaction (depends on 2.1)
  - **Estimate**: 1 day
- [${s[23]}] 2.3 Snapshot export (depends on 2.1)
  - **Estimate**: 2 days
- [ ] 3 Conflict resolution with CRDTs (depends on 2.2 and 2.3)
  - **Estimate**: 3 days

### Milestone M2: Sync protocol
> Depends on M1.

- [ ] 4 WebSocket transport
  - **Estimate**: 2 days
- [ ] 5 Offline queue and retry (parallel with 4)
  - **Estimate**: 2 days
- [ ] 6 Load test with 10k clients (depends on 4 and 5; needs P2)
  - **Estimate**: 1 day
`;

const EDITOR = (s) => `# Web editor

### Milestone E1: Editing
- [${s[1]}] 1 Rich-text editor shell
- [${s[11]}] 1.1 Markdown shortcuts
  - **Estimate**: 1 day
- [ ] 1.2 Formatting toolbar (depends on 1.1)
  - **Estimate**: 1 day
- [ ] 1.3 Paste images (parallel with 1.2)
  - **Estimate**: 2 days

### Milestone E2: Collaboration
- [ ] 2 Live cursors (depends on sync-engine#4)
  - **Estimate**: 2 days
- [ ] 3 Comment threads
  - **Estimate**: 3 days
`;

/**
 * 在 dir 下生成演示数据，时间都相对 now 往回推，看板才显得「正在进行」。
 * 生成后的状态：sync-engine#1 / 2.1 / 2.2 已合并完成；2.3 有 draft PR #22（等待 review）且 Claude 会话 1 分钟前还在动；
 * web-editor#1.1 PR 已合并但文档未勾选（进行中）；1.2 有 ready PR #23 且超出预计；sync-engine#6 卡在外部前置 P2；
 * PR #24 没关联任务；mobile-app 只有需求文档（规划中）。
 * @param {string} dir 已存在的空目录（应为 realpath，会话 cwd 要与仓库路径逐字相等）
 * @param {number} [now] 毫秒
 * @returns {{ configPath: string, prsPath: string, repo: string }}
 */
export function buildDemo(dir, now = Date.now()) {
  const repo = path.join(dir, 'acme-notes');
  const sessDir = path.join(dir, 'claude-projects');
  mkdirSync(repo, { recursive: true });

  const ago = (d, h = 0) => new Date(now - d * 86400e3 - h * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  // 固定作者、关掉签名与钩子：不受本机全局 git 配置影响（CI 上也没有 user.name）。
  // gitEnv 去掉继承的 GIT_*：否则 GIT_DIR 等会让 add / commit 写到外部仓库（PR #33 review）
  const git = (args, date) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo,
    env: gitEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com',
      GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' }),
  }).toString().trim();
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
  const commit = (message, date) => { git(['add', '-A'], date); git(['commit', '-q', '-m', message], date); return git(['rev-parse', 'HEAD'], date); };

  const sync = { 1: ' ', 2: ' ', 21: ' ', 22: ' ', 23: ' ' };
  const editor = { 1: ' ', 11: ' ' };
  const docs = () => { put('.claude/specs/sync-engine/tasks.md', SYNC(sync)); put('.claude/specs/web-editor/tasks.md', EDITOR(editor)); };

  git(['init', '-q', '-b', 'main'], ago(15));
  put('README.md', '# Acme Notes\n');
  put('.claude/specs/mobile-app/requirements.md', '# Mobile app\n\nRequirements draft; no tasks yet.\n');
  put('docs/adr/0001-use-crdts.md', '# ADR-0001 Use CRDTs for conflict resolution\n\nStatus: Accepted\n\n## Decision\n\nMerge concurrent edits with a CRDT instead of last-write-wins.\n');
  put('docs/adr/0002-websocket-transport.md', '# ADR-0002 WebSocket as the sync transport\n\nStatus: Proposed\n\n## Tasks\n\n- [ ] 1 Benchmark WebSocket vs. SSE\n- [ ] 2 Write the transport decision (depends on 1)\n');
  docs();
  commit('docs: plan sync engine and web editor', ago(14));

  // 这些提交充当 PR 的合并提交：PR 的 mergeCommit.oid 指向它们，本地 main 已含 → 「已同步」
  const merged = {};
  put('src/schema.sql', 'create table notes (id text primary key);\n');
  merged[12] = commit('Merge pull request #12: sync-engine#1 storage schema', ago(12));
  sync[1] = 'x'; docs(); commit('docs: tick sync-engine#1', ago(12, -1));
  put('src/oplog.js', 'export const log = [];\n');
  merged[15] = commit('Merge pull request #15: Task 2.1 append-only log', ago(9));
  sync[21] = 'x'; editor[1] = 'x'; docs(); commit('docs: tick 2.1', ago(9, -1));
  put('src/compact.js', 'export const compact = (l) => l;\n');
  merged[18] = commit('Merge pull request #18: Task 2.2 log compaction', ago(6));
  sync[22] = 'x'; docs(); commit('docs: tick 2.2', ago(6, -1));
  put('web/shortcuts.js', 'export const shortcuts = {};\n');
  merged[19] = commit('Merge pull request #19: web-editor#1.1 markdown shortcuts', ago(4));
  sync[23] = '~'; docs(); commit('docs: start 2.3', ago(1));

  // fake-gh 回放的 GraphQL 节点
  const pr = (number, title, state, extra) => ({
    number, title, body: '', url: `https://github.com/acme/notes/pull/${number}`, state, isDraft: false, baseRefName: 'main',
    headRefName: `feat/pr-${number}`, labels: { nodes: [] }, mergedAt: null, closedAt: null, mergeCommit: null, timelineItems: { nodes: [] }, ...extra,
  });
  const mergedPr = (n, title, created, mergedDays) => pr(n, title, 'MERGED', {
    createdAt: ago(created), updatedAt: ago(mergedDays), mergedAt: ago(mergedDays), closedAt: ago(mergedDays), mergeCommit: { oid: merged[n] },
    timelineItems: { nodes: [{ createdAt: ago(created) }] },
  });
  const prs = [
    pr(24, 'chore: bump dev dependencies', 'OPEN', { createdAt: ago(0, 5), updatedAt: ago(0, 5) }),
    pr(23, 'feat: web-editor#1.2 formatting toolbar', 'OPEN', { createdAt: ago(2), updatedAt: ago(0, 3), timelineItems: { nodes: [{ createdAt: ago(1) }] } }),
    pr(22, 'feat: Task 2.3 snapshot export', 'OPEN', { isDraft: true, createdAt: ago(1), updatedAt: ago(0, 1) }),
    mergedPr(19, 'feat: web-editor#1.1 markdown shortcuts', 5, 4),
    mergedPr(18, 'feat: Task 2.2 log compaction', 8, 6),
    mergedPr(15, 'feat: Task 2.1 append-only log', 11, 9),
    mergedPr(12, 'feat: sync-engine#1 storage schema', 13, 12),
  ];
  const prsPath = path.join(dir, 'prs.json');
  writeFileSync(prsPath, JSON.stringify(prs, null, 1));

  // Claude Code 会话：cwd = 演示仓库，最后一条 1 分钟前 → sync-engine#2.3 显示「Claude 运行中」。
  // ponytail: 时间戳是生成时写死的，演示开着超过 sessionRunningMinutes（10 分钟）后会变成「最近活跃」；要一直显示运行中得定时追加记录
  const at = (min) => new Date(now - min * 60e3).toISOString();
  const base = { cwd: repo, sessionId: 'demo-session', version: '2.0.0' };
  const human = (ts, content) => JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content },
    uuid: 'u', timestamp: ts, permissionMode: 'default', origin: { kind: 'human' }, userType: 'external', ...base });
  const ai = (ts, text) => JSON.stringify({ parentUuid: 'u', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] },
    type: 'assistant', uuid: 'a', timestamp: ts, ...base });
  const projDir = path.join(sessDir, repo.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(path.join(projDir, 'demo-session.jsonl'), [
    human(at(40), 'Continue sync-engine task 2.3: snapshot export. Write the tests first.'),
    ai(at(38), 'Starting with a failing test for the snapshot writer.'),
    ai(at(1), 'Snapshot export passes; adding the streaming variant next.'),
  ].join('\n') + '\n');

  const configPath = path.join(dir, 'devboard.config.json');
  writeFileSync(configPath, JSON.stringify({
    server: { host: '127.0.0.1', port: DEMO_PORT },
    projects: [{
      id: 'demo', name: 'Acme Notes (demo)',
      repo: { path: repo, github: 'acme/notes' },
      branchLines: [{ id: 'main', name: 'main', base: 'main' }],
      docSources: [{ type: 'spec-dir', label: 'Claude Code spec', path: '.claude/specs' }, { type: 'adr-dir', label: 'ADR', path: 'docs/adr' }],
      github: { ghPath: FAKE_GH, historySince: ago(30) },
      sessions: [{ source: 'claude-code', dir: sessDir }],
    }],
  }, null, 2));
  return { configPath, prsPath, repo };
}

/**
 * 在 dir 里生成演示数据并在本进程起服务；cache/、data/ 也放在 dir 里。
 * 会设置 process.env.FAKE_GH（fake-gh 继承本进程环境）：只给只读权限范围，不出令牌权限横幅。
 * @param {{ dir: string, port: number, now?: () => Date, log?: (line: string) => void }} opts
 * @returns {ReturnType<typeof startServer>}
 */
export async function startDemo({ dir, port, now, log }) {
  const { configPath, prsPath } = buildDemo(dir, (now?.() ?? new Date()).getTime());
  process.env.FAKE_GH = JSON.stringify({ prs: prsPath, scopes: 'read:org' });
  return startServer({ configPath, port, now, log, cacheDir: path.join(dir, 'cache'), dataDir: path.join(dir, 'data') });
}

async function main() {
  // realpath：macOS 的 /var → /private/var，会话 cwd 与仓库路径要逐字一致
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'yuiboard-demo-')));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let server;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await server?.close(); } finally { cleanup(); process.exit(0); }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    server = await startDemo({ dir, port: await pickPort(DEMO_PORT, isFree) });
  } catch (e) {
    cleanup();
    console.error(`YUIBoard demo failed to start: ${e.message}`);
    process.exit(1);
  }
  console.log(`\nYUIBoard demo is running: ${server.url}\n`
    + 'It shows a fictional project ("Acme Notes") with made-up docs, pull requests and an AI session.\n'
    + `Demo files live in ${dir} and are deleted when you stop. Press Ctrl+C to stop.\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
