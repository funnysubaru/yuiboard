// N25 任务 1：看板摘要（mod 用，design §3.1）。投影只留 mod 用到的字段；与完整看板跑口径函数结果相同；路由与 /board 同口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { extractRefs } from '../src/refs.mjs';
import { normalizePr } from '../src/github.mjs';
import { summarize } from '../src/summary.mjs';
import { startServer } from '../src/server.mjs';
import { overallStats, checkItems, statusWhy } from '../web/app.mjs';

process.env.DEVBOARD_LANG = 'zh';
process.env.FAKE_GH = '{}'; // 服务启动后后台拉 GitHub 一律走 gh 替身，不联网

// ---------- 夹具：真实解析器 + 真实 engine，覆盖会话关联、冲突（含 PR / 会话类）、PR（含「部分」、待同步） ----------

const NOW = '2025-09-27T00:30:00Z';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const doc = (name, over = {}) => ({ docId: name, archived: false, sourceType: 'spec-dir', sourceLabel: 'spec', path: `.claude/specs/${name}/tasks.md`,
  workspaceId: 'repo', kind: 'tasks', ...parseTasksDoc(fixture(`${name}.tasks.md`), name), ...over });
const WIDGET = { id: 'widget', repo: { path: '/ws/repo' }, branchLines: [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'], docFilter: '^collab-', workspace: '/ws/collab' },
] };

function fixtureBoard() {
  const collab = doc('collab-m0-space-run');
  // 改成未勾：已合并 PR 的任务走「进行中（merged）」，2.5b 由会话带成运行中
  for (const n of ['2.5b', '3', '4']) collab.tasks.find((x) => x.number === n).checkbox = 'open';
  const docs = [collab, doc('synthetic-inline'), doc('synthetic-headings', { archived: true })];
  const known = { knownDocIds: docs.map((d) => d.docId), knownCodes: docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)) };
  const say = (text, at, until, line) => ({ kind: 'prompt', at, until, file: 'r/s.jsonl', line, snippet: text, refs: extractRefs(text, known) });
  const session = (id, signals) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/collab'], branches: [], title: `标题 ${id}`,
    firstAt: signals[0].at, lastAt: signals.at(-1).until, lastSummary: '（虚构）最后一条', signals, aiOnlyMentions: 0, brokenLines: 0 });
  const sessions = [
    session('s-run', [say('继续做 collab-m0-space-run 的任务 2.5b', '2025-09-27T00:00:00.000Z', '2025-09-27T00:25:00.000Z', 1)]),
    session('s-m0c', [say('collab-m0-space-run 的 M0-c 开工', '2025-09-25T01:00:00.000Z', '2025-09-25T02:30:00.000Z', 2)]),
    session('s-x', [say('看看 synthetic-inline 任务 9.9 和 nope 的 1', '2025-09-26T00:00:00.000Z', '2025-09-26T00:10:00.000Z', 3)]),
    // 只登记了 PR、没点名任务：关联不带 named
    session('s-pr', [{ kind: 'pr-link', at: '2025-09-26T01:00:00.000Z', until: '2025-09-26T01:05:00.000Z', file: 'r/s.jsonl', line: 4, pr: 901 }]),
  ];
  const raw = JSON.parse(fixture('prs.json'));
  const prs = [...raw,
    { ...raw[0], number: 901, title: '[V2] feat: collab-m0-space-run 任务 2.5b（部分）', baseRefName: 'v2/collab', state: 'MERGED',
      mergedAt: '2025-09-26T00:00:00Z', mergeCommit: { oid: 'f'.repeat(40) } },
    { ...raw[0], number: 902, title: 'fix: 任务 99 与 collab-m0-space-run 任务 2', state: 'OPEN', mergedAt: null, mergeCommit: null },
  ].map(normalizePr);
  const board = computeBoard(docs, prs, sessions, [], { 360: { state: 'synced' }, 365: { state: 'pending' } }, WIDGET, NOW,
    { hoursPerDay: 8, defaultDurationDays: 1 });
  // 服务端 rebuild 补的字段（src/server.mjs），摘要要原样带上
  board.workspaces = [{ id: 'repo', path: '/ws/repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  board.defaults = { hoursPerDay: 8, defaultDurationDays: 1 };
  board.recentClosedPrDays = 7;
  return board;
}

// design §3.1 的字段表：键 = 保留的字段；值为对象的递归往下比，其余整块原样保留
const SPEC = {
  top: ['projectId', 'freshness', 'degraded', 'workspaces', 'diagnostics', 'defaults', 'stats', 'docs', 'tasks', 'conflicts', 'prs', 'sessions'],
  doc: ['docId', 'title', 'path', 'kind', 'archived', 'workspaceId', 'sourceType', 'sourceLabel', 'parse', 'groups', 'alias', 'adr', 'tasks'],
  docTask: ['key', 'number', 'title', 'checkbox', 'void', 'docId', 'groupId', 'parentKey', 'duplicate'],
  view: ['key', 'status', 'rule', 'docOnly', 'syncPending', 'syncUnchecked', 'inProgressBy', 'activity', 'childSummary', 'next', 'prs', 'sessions', 'deps'],
  prLink: ['pr', 'partial', 'removedManually'],
  sessionLink: ['sessionId', 'activity', 'firstAt', 'lastAt', 'evidenceAt'],
  deps: ['on', 'unmet', 'external'],
  conflict: ['type', 'taskKey', 'pr', 'sessionId', 'detail', 'source'],
  pr: ['number', 'title', 'branchLine', 'tasks'],
  session: ['id', 'source', 'title'],
};
const NESTED = { docs: ['doc', { tasks: 'docTask' }], tasks: ['view', { prs: 'prLink', sessions: 'sessionLink', deps: 'deps' }],
  conflicts: ['conflict'], prs: ['pr'], sessions: ['session'] };

// 摘要的键 = 字段表 ∩ 原对象实有的键；未列出子结构的字段与原值逐字节相同
function assertPick(src, out, keys, sub = {}, where = '') {
  // 会话关联多一个派生的 named（点到过具体任务）：有 prompt / dispatch / edit 依据才有，且只能是 true
  if (keys === SPEC.sessionLink) {
    const named = src.evidence?.some((e) => ['prompt', 'dispatch', 'edit'].includes(e.kind));
    assert.equal(out.named, named ? true : undefined, `${where}.named`);
    out = { ...out };
    delete out.named;
  }
  assert.deepEqual(Object.keys(out).sort(), keys.filter((k) => Object.hasOwn(src, k)).sort(), where);
  for (const k of Object.keys(out)) {
    const s = sub[k];
    if (!s) assert.deepEqual(out[k], src[k], `${where}.${k}`);
    else if (Array.isArray(src[k])) {
      assert.equal(out[k].length, src[k].length, `${where}.${k}`);
      src[k].forEach((x, i) => assertPick(x, out[k][i], SPEC[s], {}, `${where}.${k}[${i}]`));
    } else assertPick(src[k], out[k], SPEC[s], {}, `${where}.${k}`);
  }
}

test('摘要投影：只含 design §3.1 的字段，结构与值不变（Board 的同构子集）', () => {
  const board = fixtureBoard();
  const before = JSON.stringify(board);
  const sum = summarize(board);
  assert.equal(JSON.stringify(board), before, '不改动传入的看板');
  assert.deepEqual(Object.keys(sum).sort(), SPEC.top.filter((k) => Object.hasOwn(board, k)).sort());
  for (const k of Object.keys(sum)) {
    const n = NESTED[k];
    if (k === 'freshness') assert.deepEqual(sum.freshness, { github: board.freshness.github }, '只留 GitHub 状态');
    else if (!n) assert.deepEqual(sum[k], board[k], k);
    else {
      assert.equal(sum[k].length, board[k].length, k);
      board[k].forEach((x, i) => assertPick(x, sum[k][i], SPEC[n[0]], n[1], `${k}[${i}]`));
    }
  }
  // 夹具确实带了要删的东西，投影不是空操作
  for (const k of ['gantt', 'waiting', 'recent', 'recentClosedPrDays']) assert.ok(Object.hasOwn(board, k) && !Object.hasOwn(sum, k), k);
  assert.ok(board.tasks.some((v) => v.prs.some((l) => 'evidence' in l)) && board.tasks.some((v) => v.sessions.length));
  const links = sum.tasks.flatMap((v) => v.sessions);
  assert.ok(links.some((l) => l.named) && links.some((l) => !l.named), '夹具里既有点到任务的会话关联，也有只靠分支 / PR 连上的');
  assert.ok(JSON.stringify(sum).length < before.length / 2, '摘要明显小于完整看板');
  assert.deepEqual(summarize(board), sum, '纯函数：同一输入同一输出');
  // 只有版本号、推算时间、读取时间、刷新中标记变了：摘要不变（ETag 不变，mod 不白拉）
  const churn = { ...board, version: board.version + 1, computedAt: 'x',
    freshness: { ...board.freshness, docsReadAt: 'x', sessionsReadAt: 'x', refreshing: { docs: true } } };
  assert.deepEqual(summarize(churn), sum, '每轮都变的字段不进摘要');
});

test('摘要与完整看板跑 overallStats / checkItems / statusWhy 结果完全相同', () => {
  const board = fixtureBoard();
  const sum = JSON.parse(JSON.stringify(summarize(board))); // 走一遍序列化，同 mod 拿到的
  const full = JSON.parse(JSON.stringify(board));

  // 夹具覆盖：五态、四条规则（含「部分」与会话进行中）、待同步、PR 类与会话类冲突，否则等价性测不到东西
  const rules = new Set(full.tasks.map((v) => v.rule));
  for (const r of ['8.2-1', '8.2-2', '8.2-3', '8.2-4', '8.2-5']) assert.ok(rules.has(r), r);
  assert.ok(full.tasks.some((v) => v.inProgressBy.includes('session') && v.activity === 'running'));
  assert.ok(full.tasks.some((v) => v.inProgressBy.includes('partial')));
  assert.ok(full.tasks.some((v) => v.syncPending?.length) && full.tasks.some((v) => v.syncUnchecked));
  assert.ok(full.tasks.some((v) => v.status === null), '作废任务');
  assert.ok(full.conflicts.some((c) => c.pr != null) && full.conflicts.some((c) => c.sessionId));
  assert.ok(full.docs.some((d) => d.archived));

  assert.deepEqual(overallStats(sum), overallStats(full));
  for (const line of [null, 'collab', 'personal']) assert.deepEqual(checkItems(sum, { line }), checkItems(full, { line }), String(line));
  assert.ok(checkItems(full, { line: null }).length > 0);

  const docTasks = (b) => new Map(b.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  const [ds, df] = [docTasks(sum), docTasks(full)];
  const whys = new Set();
  sum.tasks.forEach((v, i) => {
    const why = statusWhy(full.tasks[i], df.get(v.key));
    assert.equal(statusWhy(v, ds.get(v.key)), why, v.key);
    whys.add(why);
  });
  assert.ok(whys.size >= 6, `状态原因种类够多（${whys.size}）`);
});

// ---------- 路由：与 /board 同口径 ----------

const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-summary-')));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const project = (id, repoPath) => ({
  id, repo: { path: repoPath, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }],
  docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }], github: { ghPath: FAKE_GH },
});
const TASKS = '.claude/specs/demo/tasks.md';

// 一个好项目（临时 git 仓库）+ 一个仓库路径不存在的坏项目（配置错误 → 409）
async function space() {
  const dir = await tmpDir();
  const repo = path.join(dir, 'repo');
  await mkdir(path.dirname(path.join(repo, TASKS)), { recursive: true });
  await writeFile(path.join(repo, TASKS), '# 计划\n\n- [x] 1 第一件\n- [ ] 2 第二件\n');
  execFileSync('git', ['init', '-q', repo]);
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [project('good', repo), project('bad', path.join(dir, 'nope'))] }));
  return { dir, repo, configPath };
}

async function start(t, opts) {
  const tmp = await tmpDir();
  const s = await startServer({ port: 0, now: () => new Date(NOW), log: () => {}, cacheDir: path.join(tmp, 'cache'), dataDir: path.join(tmp, 'data'), ...opts });
  t.after(() => s.close());
  for (const rt of s.runtimes.values()) { await rt.ready; while (rt.busy) await rt.lock; }
  return s;
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));
const both = (s, id, headers) => Promise.all(['board', 'summary'].map((k) => request(s.port, `/api/projects/${id}/${k}`, headers)));

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('GET /summary：200 是同一版看板的摘要；409 / 404 与 /board 一致；304 / gzip 同 /board', async (t) => {
  const { configPath, dir } = await space();
  const s = await start(t, { configPath, webDir: dir });

  const [b, sm] = await both(s, 'good');
  assert.equal(sm.status, 200);
  assert.equal(sm.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(json(sm), summarize(json(b)), '与 /board 同一次推算');
  assert.notEqual(sm.headers.etag, b.headers.etag, '各有各的 ETag');

  const [b304, s304] = await both(s, 'good', { 'If-None-Match': sm.headers.etag });
  assert.equal(s304.status, 304);
  assert.equal(s304.body.length, 0);
  assert.equal(b304.status, 200, '摘要的 ETag 不能让 /board 回 304');
  assert.equal((await request(s.port, '/api/projects/good/board', { 'If-None-Match': b.headers.etag })).status, 304);

  const gz = await request(s.port, '/api/projects/good/summary', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.etag, sm.headers.etag);
  assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString('utf8')), json(sm));

  for (const id of ['bad', 'none']) {
    const [bb, ss] = await both(s, id);
    assert.deepEqual([ss.status, json(ss)], [bb.status, json(bb)], id);
  }
  assert.equal((await both(s, 'bad'))[1].status, 409);
  assert.equal(json((await both(s, 'bad'))[1]).error, 'config');
});

test('GET /summary：看板尚未生成（首次推算失败）→ 500，与 /board 一致', async (t) => {
  const { configPath, dir } = await space();
  const s = await start(t, { configPath, webDir: dir, loadDocs: async () => { throw new Error('炸了'); } });
  const [b, sm] = await both(s, 'good');
  assert.equal(sm.status, 500);
  assert.deepEqual(json(sm), json(b));
  assert.equal(json(sm).error, 'refresh');
});

test('摘要 ETag：内容不变不变，文档改了跟着变', async (t) => {
  const { configPath, dir, repo } = await space();
  const s = await start(t, { configPath, webDir: dir, timing: { pollMs: 30, boardWriteMs: 0 } });
  const summary = () => request(s.port, '/api/projects/good/summary');

  const a = await summary();
  await new Promise((r) => setTimeout(r, 200)); // 空转若干轮轮询
  assert.equal((await summary()).headers.etag, a.headers.etag);

  await writeFile(path.join(repo, TASKS), '# 计划\n\n- [x] 1 第一件\n- [x] 2 第二件（改完了）\n');
  const b = await until(async () => { const r = await summary(); return r.headers.etag !== a.headers.etag && r; });
  assert.equal(json(b).tasks.find((v) => v.key === 'demo#2').status, 'done');
  assert.equal((await request(s.port, '/api/projects/good/summary', { 'If-None-Match': a.headers.etag })).status, 200, '旧 ETag 不再 304');
});
