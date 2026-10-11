// 只读自检（design §7 readonly）：本地同步检查只读 git，不改工作树、不写 .git（需求 16.1）；
// 整轮刷新（文档、会话、GitHub、本地同步）不改仓库与会话目录（需求 16.1、16.6，任务 5.4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocalSync } from '../src/docs.mjs';
import { startServer } from '../src/server.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
async function commit(dir, file) {
  await writeFile(path.join(dir, file), file);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * 临时仓库：main = A → M（M 当作已合并 PR 的合并提交）；feature = A → F（当前检出，不含 M）；side = A → S（哪都没合入）。
 * 另留一个未提交改动，确认检查照常且不碰工作树。
 */
async function makeRepo() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-sync-')));
  git(dir, 'init', '-q', '-b', 'main');
  await commit(dir, 'a.md');
  const M = await commit(dir, 'm.md');
  git(dir, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  const S = await commit(dir, 's.md');
  git(dir, 'checkout', '-q', '-b', 'feature', 'main~1');
  const F = await commit(dir, 'f.md');
  await writeFile(path.join(dir, 'dirty.md'), '未提交');
  return { dir, M, F, S };
}

// .git 下所有文件的路径与 mtime，外加 git status --porcelain。
function snapshot(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(`${path.relative(dir, p)} ${statSync(p).mtimeMs}`);
    }
  };
  walk(path.join(dir, '.git'));
  // 自检用的 status 也关可选锁，否则它自己会刷新 .git/index，冤枉被测代码。
  const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { status, files: files.sort() };
}

const ABSENT = 'deadbeef'.repeat(5);

test('checkLocalSync：synced / pending / unknown 各分支，且 .git 与工作树不变', async () => {
  const { dir, M, F, S } = await makeRepo();
  const before = snapshot(dir);
  const state = async (oid, base) => (await checkLocalSync(dir, oid, base)).state;

  assert.equal(await state(M, 'main'), 'synced', '已在本地 base 分支');
  assert.equal(await state(F, 'main'), 'synced', '已在当前检出 HEAD');
  assert.equal(await state(F, 'no-such-base'), 'synced', '无本地 base 但 HEAD 含');
  assert.equal(await state(ABSENT, 'main'), 'pending', '对象不在本地');
  assert.equal(await state(ABSENT, 'no-such-base'), 'unknown', '对象不在本地且无本地 base（P3：不卡在待同步）');
  assert.equal(await state(S, 'main'), 'pending', '在另一分支、未合入 base 也不在 HEAD');

  const noBase = await checkLocalSync(dir, M, 'no-such-base');
  assert.equal(noBase.state, 'unknown', '无本地 base 且 HEAD 不含');
  assert.match(noBase.reason, /本地没有 no-such-base 分支/);
  assert.deepEqual(await checkLocalSync(dir, null, 'main'), { state: 'unknown', reason: 'PR 没有合并提交' });
  assert.equal(await state('--output=/tmp/x', 'main'), 'unknown', '非提交号不交给 git');
  // 再查一遍走缓存，结果一致。
  assert.equal(await state(S, 'main'), 'pending');

  assert.deepEqual(snapshot(dir), before);
});

test('checkLocalSync：ref 前进后缓存失效重查；git 出错为 unknown 且带原因', async () => {
  const { dir, S } = await makeRepo();
  assert.equal((await checkLocalSync(dir, S, 'main')).state, 'pending');
  git(dir, 'update-ref', 'refs/heads/main', S); // 模拟本地 pull 后 main 前进到含 S
  assert.equal((await checkLocalSync(dir, S, 'main')).state, 'synced');

  const gone = await checkLocalSync(path.join(dir, '不存在'), S, 'main');
  assert.equal(gone.state, 'unknown');
  assert.match(gone.reason, /^git 出错：/);
});

// ---------------- 只读全链路（任务 5.4）：文档 + 会话 + fake gh + 本地同步，整轮刷新前后仓库与会话目录不变 ----------------

const NOW = Date.parse('2026-09-26T08:00:00Z');
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const iso = (ms) => new Date(ms).toISOString();
// 仿实物的人发消息记录（正文虚构）
const userLine = (cwd, at, text) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text },
  uuid: 'u', timestamp: iso(at), userType: 'external', cwd, sessionId: 's', version: '2.0.0', gitBranch: 'main' });
// 仿实物的 Codex 记录：首行 session_meta + 一条人发 UserMessage（正文虚构）
const codexUid = (n) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const codexRollout = (cwd, n, at, text) => [
  { timestamp: iso(at), ordinal: 0, type: 'session_meta', payload: { session_id: codexUid(n), id: codexUid(n), timestamp: iso(at), cwd, originator: 'test', cli_version: '0.0.0', source: 'cli' } },
  { timestamp: iso(at), ordinal: 1, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } },
].map((o) => `${JSON.stringify(o)}\n`).join('');

// 目录下全部文件与目录的相对路径、大小、mtime（含 .git）
function tree(dir) {
  const out = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    const st = statSync(p);
    out.push(`${path.relative(dir, p)} ${e.isDirectory() ? 'd' : st.size} ${st.mtimeMs}`);
  }
  return out.sort();
}
const gitStatus = (dir) => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

/**
 * 空间：repo（main：tasks.md → 合并提交 M，另有未提交改动）；demo 的任务 1 由已合并 PR #7（合并提交 M）完成，
 * 任务 2 标 [~]；会话 s-run 两分钟前在做任务 3，会话 s-old 五天前做过任务 4（→ 停滞）。
 */
// codex：不传 = 不配 Codex 来源；'missing' = 配了但记录根不存在；数组 = 各写一份 Codex 会话 {n, at, text}。
async function makeSpace({ withRecords = true, codex } = {}) {
  const t = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-e2e-')));
  const repo = path.join(t, 'repo');
  await mkdir(path.join(repo, '.claude/specs/demo'), { recursive: true });
  git(t, 'init', '-q', '-b', 'main', repo);
  await writeFile(path.join(repo, '.claude/specs/demo/tasks.md'), '# 计划\n\n- [ ] 1 第一件\n- [~] 2 第二件\n- [ ] 3 第三件\n- [ ] 4 第四件\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'tasks');
  const M = await commit(repo, 'm.md');
  await writeFile(path.join(repo, 'dirty.md'), '未提交');

  const prsFile = path.join(t, 'prs.json');
  await writeFile(prsFile, JSON.stringify([{
    number: 7, title: 'feat(demo): 任务 1 第一件', body: '（虚构）', url: 'https://github.com/acme/demo/pull/7', state: 'MERGED', isDraft: false,
    baseRefName: 'main', headRefName: 'feat/one', createdAt: '2026-09-25T01:00:00Z', updatedAt: '2026-09-25T02:00:00Z',
    mergedAt: '2026-09-25T02:00:00Z', closedAt: '2026-09-25T02:00:00Z', mergeCommit: { oid: M }, labels: { nodes: [] }, timelineItems: { nodes: [] },
  }]));
  process.env.FAKE_GH = JSON.stringify({ prs: prsFile });

  const records = path.join(t, 'records');
  if (withRecords) {
    const dir = path.join(records, enc(repo));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 's-run.jsonl'), `${userLine(repo, NOW - 2 * 60_000, '（虚构）请继续 demo 任务 3')}\n`);
    await writeFile(path.join(dir, 's-old.jsonl'), `${userLine(repo, NOW - 5 * 86_400_000, '（虚构）demo 任务 4 先做一半')}\n`);
  }
  const codexRecords = path.join(t, 'codex');
  for (const c of Array.isArray(codex) ? codex : []) {
    const day = iso(c.at).slice(0, 10).replaceAll('-', '/');
    await mkdir(path.join(codexRecords, day), { recursive: true });
    await writeFile(path.join(codexRecords, day, `rollout-${iso(c.at).slice(0, 10)}T00-00-00-${codexUid(c.n)}.jsonl`), codexRollout(repo, c.n, c.at, c.text));
  }
  const configPath = path.join(t, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [{
    id: 'p', repo: { path: repo, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }],
    // historySince：临时仓库的提交时间是真实时钟，不让 PR 回溯下限把夹具 PR 挡掉
    docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }], github: { ghPath: FAKE_GH, historySince: '2025-01-01T00:00:00Z' },
    sessions: [{ source: 'claude-code', dir: records }, ...(codex ? [{ source: 'codex', dir: codexRecords }] : [])],
  }] }));
  return { t, repo, records, codexRecords, configPath };
}

// 启动服务并等启动时排上的三步（文档 → 会话 → GitHub）跑完。now 可变，用来模拟时间流逝。
async function run(space, timing = {}) {
  const clock = { ms: NOW };
  const s = await startServer({ configPath: space.configPath, port: 0, now: () => new Date(clock.ms), log: () => {},
    cacheDir: path.join(space.t, 'cache'), webDir: path.join(space.t, 'web'), timing });
  const rt = s.runtimes.get('p');
  const idle = async () => { await rt.ready; while (rt.busy) await rt.lock; };
  await idle();
  return { s, rt, clock, idle, board: () => rt.payload.board };
}
const view = (board, key) => board.tasks.find((v) => v.key === key);
// 等轮询把看板推到期望状态（最多 5 秒），不靠固定睡眠，满载跑全套测试时也不抖
async function until(fn) {
  for (const end = Date.now() + 5000; !fn(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() > end) assert.fail('等待轮询结果超时');
  }
}

test('只读全链路：文档 + 会话 + GitHub + 本地同步整轮刷新，仓库（含 .git）与会话目录的文件、mtime、git status 都不变', async (t) => {
  const space = await makeSpace();
  const before = { repo: tree(space.repo), records: tree(space.records), status: gitStatus(space.repo) };
  assert.notEqual(before.status, '', '有未提交改动，确认检查照常');

  const { s, rt, clock, idle, board } = await run(space, { pollMs: 20 });
  t.after(() => s.close());
  let b = board();
  assert.equal(b.prs[0].localSync, 'synced', '已合并 PR 的合并提交在本地 main 上');
  assert.deepEqual([view(b, 'demo#1').status, view(b, 'demo#1').rule], ['in_progress', '8.2-4']);
  assert.deepEqual(view(b, 'demo#2').inProgressBy, ['marker']);
  assert.deepEqual([view(b, 'demo#3').status, view(b, 'demo#3').inProgressBy, view(b, 'demo#3').activity], ['in_progress', ['session'], 'running']);
  assert.equal(view(b, 'demo#4').activity, 'stale');
  assert.deepEqual(b.waiting.filter((w) => w.kind === 'stale').map((w) => w.taskKey), ['demo#4']);
  assert.equal(b.freshness.sessionsReadAt, iso(NOW));
  assert.deepEqual(b.freshness.refreshing, { docs: false, sessions: false, github: false });
  assert.equal(b.degraded.noSessionData, false);
  assert.deepEqual(b.diagnostics.sessions, { total: 2, linked: 2, unlinked: 0, aiOnlyMentions: 0 });
  assert.deepEqual(b.diagnostics.sessionSources.map((d) => [d.source, d.available, d.sessions]), [['claude-code', true, 2]]);
  assert.ok(existsSync(path.join(space.t, 'cache/p/sessions.json')), '会话增量缓存落在 cache/ 下');

  // 轮询空转若干轮：无变化不重算、不升版本
  const v = b.version;
  await new Promise((r) => setTimeout(r, 150));
  await idle();
  assert.equal(board().version, v, '空闲轮询不升版本');

  // 时间流逝 15 分钟、会话记录没变：到点重算，任务 3 由「运行中」变「最近活跃」
  clock.ms += 15 * 60_000;
  await until(() => view(board(), 'demo#3').activity === 'recent');

  // 会话追加一条新记录：5 秒轮询（此处 20ms）增量读到，任务 3 回到「运行中」
  await writeFile(path.join(space.records, enc(space.repo), 's-run.jsonl'),
    `${userLine(space.repo, NOW - 2 * 60_000, '（虚构）请继续 demo 任务 3')}\n${userLine(space.repo, clock.ms - 1000, '（虚构）demo 任务 3 接着来')}\n`);
  const recordsAfterAppend = tree(space.records);
  await until(() => view(board(), 'demo#3').activity === 'running');

  await s.close();
  assert.deepEqual(tree(space.repo), before.repo, '仓库与 .git 文件、mtime 不变');
  assert.equal(gitStatus(space.repo), before.status);
  assert.deepEqual(tree(space.records), recordsAfterAppend, '会话目录只有测试自己的追加，devboard 未改动');
});

test('只读全链路：会话目录不存在 → 标「未包含 AI 会话信息」，文档标记与已合并 PR 的进展依据照常', async (t) => {
  const space = await makeSpace({ withRecords: false });
  const { s, board } = await run(space);
  t.after(() => s.close());
  const b = board();
  assert.equal(b.degraded.noSessionData, true);
  assert.deepEqual(b.diagnostics.sessionSources.map((d) => [d.available, /会话目录不存在/.test(d.error)]), [[false, true]]);
  assert.equal(s.runtimes.get('p').refreshError, null, '来源不可用不算刷新失败');
  assert.deepEqual(b.tasks.map((x) => [x.key, x.status]),
    [['demo#1', 'in_progress'], ['demo#2', 'in_progress'], ['demo#3', 'not_started'], ['demo#4', 'not_started']]);
  assert.deepEqual(view(b, 'demo#2').inProgressBy, ['marker']);
  assert.equal(b.prs[0].localSync, 'synced', 'PR 与本地同步照常');
  assert.ok(!existsSync(space.records), '不替会话来源建目录');
});

test('双来源：Claude Code 与 Codex 各自扫描并关联任务，最近活动来源决定会话标记；Codex 记录目录只读', async (t) => {
  // Codex 一分钟前接着做任务 4：Claude 那边五天前做过（停滞），合起来任务 4「运行中」，最近活动来自 Codex
  const space = await makeSpace({ codex: [{ n: 1, at: NOW - 60_000, text: '（虚构）接着做 demo 任务 4' }] });
  const before = tree(space.codexRecords);
  const { s, board } = await run(space);
  t.after(() => s.close());
  const b = board();
  assert.deepEqual(b.diagnostics.sessionSources.map((d) => [d.source, d.available, d.sessions]), [['claude-code', true, 2], ['codex', true, 1]]);
  assert.deepEqual(b.diagnostics.sessions, { total: 3, linked: 3, unlinked: 0, aiOnlyMentions: 0 });
  const four = view(b, 'demo#4');
  assert.equal(four.activity, 'running');
  const last = four.sessions.reduce((a, x) => (Date.parse(x.lastAt) > Date.parse(a.lastAt) ? x : a));
  assert.equal(last.sessionId, `codex:${codexUid(1)}`);
  assert.equal(b.sessions.find((x) => x.id === last.sessionId).source, 'codex');
  assert.equal(view(b, 'demo#3').activity, 'running', 'Claude 来源照常');
  await s.close();
  assert.deepEqual(tree(space.codexRecords), before, 'Codex 记录目录文件、mtime 不变');
});

test('双来源：Codex 记录根不存在只降级它自己，Claude 会话照常；不算「未包含 AI 会话信息」', async (t) => {
  const space = await makeSpace({ codex: 'missing' });
  const { s, board } = await run(space);
  t.after(() => s.close());
  const b = board();
  assert.deepEqual(b.diagnostics.sessionSources.map((d) => [d.source, d.available]), [['claude-code', true], ['codex', false]]);
  assert.equal(b.degraded.noSessionData, false);
  assert.equal(view(b, 'demo#3').activity, 'running');
  assert.equal(s.runtimes.get('p').refreshError, null);
  assert.ok(!existsSync(space.codexRecords), '不替会话来源建目录');
});

test('Codex 会话同样遵守多文档裸编号规则：只说「任务 3」不关联，点名文档才关联', async (t) => {
  const space = await makeSpace({ withRecords: false, codex: [
    { n: 1, at: NOW - 60_000, text: '（虚构）继续任务 3' },
    { n: 2, at: NOW - 120_000, text: '（虚构）继续 other 的任务 1' },
  ] });
  await mkdir(path.join(space.repo, '.claude/specs/other'), { recursive: true });
  await writeFile(path.join(space.repo, '.claude/specs/other/tasks.md'), '# 另一份\n\n- [ ] 1 甲\n- [ ] 3 乙\n');
  const { s, board } = await run(space);
  t.after(() => s.close());
  const b = board();
  assert.deepEqual(b.diagnostics.sessions, { total: 2, linked: 1, unlinked: 1, aiOnlyMentions: 0 });
  assert.deepEqual(['demo#3', 'other#3', 'other#1'].map((k) => view(b, k).sessions.map((x) => x.sessionId)), [[], [], [`codex:${codexUid(2)}`]]);
});

test('双来源：某个来源扫描时抛异常（如 extraCwds 误填成字符串）只记它自己的诊断，其它来源与刷新照常', async (t) => {
  const space = await makeSpace({ codex: [] });
  const cfg = JSON.parse(readFileSync(space.configPath, 'utf8'));
  cfg.projects[0].sessions[1].extraCwds = '/误填成字符串';
  await writeFile(space.configPath, JSON.stringify(cfg));
  const { s, board } = await run(space);
  t.after(() => s.close());
  const b = board();
  assert.deepEqual(b.diagnostics.sessionSources.map((d) => [d.source, d.available]), [['claude-code', true], ['codex', false]]);
  assert.match(b.diagnostics.sessionSources[1].error, /^会话来源出错：/);
  assert.equal(view(b, 'demo#3').activity, 'running');
  assert.equal(s.runtimes.get('p').refreshError, null, '单个来源出错不算刷新失败');
});
