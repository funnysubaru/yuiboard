import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { fetchPrs, normalizePr, classifyBranchLine, historyFloor, checkScopes, GITHUB_ERROR_TEXT } from '../src/github.mjs';
import { mask, MASKED } from '../src/mask.mjs';

const NOW = '2025-09-27T08:00:00.000Z';
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const PRS = JSON.parse(readFileSync(new URL('./fixtures/prs.json', import.meta.url), 'utf8'));
const BRANCH_LINES = [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'], docFilter: '^collab-' },
];

const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-github-')));
const project = (extra = {}) => ({
  id: 'demo', repo: { path: os.tmpdir(), github: 'acme/widget' }, docSources: [],
  branchLines: BRANCH_LINES, ...extra, github: { ghPath: FAKE_GH, ...extra.github },
});

// 每个用例一个调用日志；gh 替身按 FAKE_GH 环境变量回放（execFile 继承调用时的 process.env）
async function fakeGh() {
  const dir = await tmpDir();
  const log = path.join(dir, 'calls.log');
  const setup = (cfg = {}) => { process.env.FAKE_GH = JSON.stringify({ log, ...cfg }); };
  const calls = async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)) : []);
  const writePrs = async (list) => { const f = path.join(dir, `prs-${Math.random()}.json`); await writeFile(f, JSON.stringify(list)); return f; };
  return { setup, calls, writePrs };
}
const nums = (r) => r.prs.map((p) => p.number);

// ---- 拉取与增量 ----

test('首次拉取：按更新时间倒序翻页到底，字段归一；squash 合并按 state=MERGED 认作已合并', async () => {
  const gh = await fakeGh();
  gh.setup({ page: 3 });
  const r = await fetchPrs(project(), null, { now: NOW });
  assert.equal(r.requests, 4, '10 个 PR、每页 3 → 4 页');
  assert.deepEqual(nums(r), [373, 372, 371, 369, 365, 361, 360, 352, 346, 344]);
  assert.equal(r.maxUpdatedAt, '2025-09-27T01:52:43Z');
  assert.deepEqual(r.status, { lastSuccessAt: NOW, error: null, message: null, detail: null,
    rate: { remaining: 4990, limit: 5000, resetAt: '2026-09-26T09:00:00Z' }, pausedUntil: null, scopeHint: null });

  const pr = Object.fromEntries(r.prs.map((p) => [p.number, p]));
  assert.deepEqual(pr[360], {
    number: 360, title: '[V2] feat(collab): M0-c 推送服务 + 部署脚本 + 网页端 + 场景 A 在模拟环境通过 (collab 2.0.4)',
    body: '（虚构描述）做了什么（spec 任务 3–10）。', url: 'https://github.com/acme/widget/pull/360',
    state: 'MERGED', isDraft: false, baseRefName: 'v2/collab', headRefName: 'feature/m0c-push-service',
    labels: ['collab-v2'], createdAt: '2025-09-25T03:50:22Z', updatedAt: '2025-09-25T07:00:31Z',
    readyAt: '2025-09-25T06:48:49Z', mergedAt: '2025-09-25T07:00:31Z', closedAt: '2025-09-25T07:00:31Z',
    mergeCommit: '3cada25d96a75bb71b7b8497a9c712ee73ba086d',
  });
  assert.deepEqual([pr[372].state, pr[372].isDraft, pr[372].readyAt], ['OPEN', true, null], 'draft：从未转 ready');
  assert.deepEqual([pr[373].isDraft, pr[373].readyAt], [false, '2025-09-27T01:40:00Z']);
  assert.deepEqual([pr[352].state, pr[352].mergedAt, pr[352].mergeCommit], ['CLOSED', null, null], '关闭未合并');

  const calls = await gh.calls();
  assert.deepEqual(calls[0], ['api', 'graphql', '-f', 'query=…', '-f', 'owner=acme', '-f', 'name=widget'], '首页不带游标');
  assert.deepEqual(calls[1].slice(-2), ['-f', 'after=3'], '后续页带上一页的 endCursor');
});

test('增量：遇到比缓存最新还旧的 PR 即停；已关闭且之后没更新的 PR 不重拉', async () => {
  const gh = await fakeGh();
  gh.setup({ page: 3 });
  const first = await fetchPrs(project(), null, { now: NOW });

  // #371 有新动静；#352 在远端改了标题但 updatedAt 没变（模拟「已关闭、之后没更新」）
  const changed = PRS.map((p) => (p.number === 371 ? { ...p, title: '新标题', updatedAt: '2025-09-27T07:00:00Z' }
    : p.number === 352 ? { ...p, title: '不该被拉到' } : p));
  gh.setup({ page: 3, prs: await gh.writePrs(changed) });
  const { requests, ...cacheOnly } = first;
  const second = await fetchPrs(project(), cacheOnly, { now: '2025-09-27T08:05:00.000Z' });
  assert.equal(second.requests, 1, '第一页就碰到已知的旧 PR，停止翻页');
  const pr = Object.fromEntries(second.prs.map((p) => [p.number, p]));
  assert.equal(pr[371].title, '新标题');
  assert.equal(pr[352].title, first.prs.find((p) => p.number === 352).title);
  assert.equal(second.prs.length, 10);
  assert.equal(second.maxUpdatedAt, '2025-09-27T07:00:00Z');

  const third = await fetchPrs(project(), second, { now: '2025-09-27T08:10:00.000Z' });
  assert.equal(third.requests, 1, '没有新变化：只看一页');
  assert.deepEqual(third.prs, second.prs);
});

test('首次回溯下限：配置 historySince 优先；早于下限的 PR 不拉', async () => {
  const gh = await fakeGh();
  gh.setup({ page: 3 });
  const r = await fetchPrs(project({ github: { historySince: '2025-09-25T05:00:00Z' } }), null, { now: NOW });
  assert.deepEqual(nums(r), [373, 372, 371, 369, 365, 360]);
  assert.equal(r.requests, 3, '第 3 页碰到 #361（09-24 04:44）即停，不再翻第 4 页');
  assert.equal(r.since, '2025-09-25T05:00:00Z');
});

// 临时仓库：每个提交用指定的提交时间
const git = (dir, env, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });
async function commitAt(dir, file, date) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), 'x\n');
  git(dir, {}, 'add', '-A');
  git(dir, { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, 'commit', '-q', '-m', file);
}

test('默认回溯下限：未归档 spec 目录最早入库时间（git log --diff-filter=A），可按 spec 过滤', async () => {
  const repo = await tmpDir();
  git(repo, {}, 'init', '-q', '-b', 'main');
  await commitAt(repo, '.claude/specs/README.md', '2025-07-02T00:00:00Z');      // spec 根下的文件不算某个 spec
  await commitAt(repo, '.claude/specs/老规格/tasks.md', '2025-08-02T00:00:00Z'); // 中文目录名
  await commitAt(repo, '.claude/specs/b/requirements.md', '2025-09-25T05:00:00Z');
  await commitAt(repo, '.claude/specs/老规格/design.md', '2025-09-26T00:00:00Z');
  await commitAt(repo, 'other/x.md', '2025-06-02T00:00:00Z');
  const before = git(repo, {}, 'status', '--porcelain');
  const p = project({ repo: { path: repo, github: 'acme/widget' }, docSources: [{ type: 'spec-dir', label: 's', path: '.claude/specs' }] });

  assert.equal(await historyFloor(p), '2025-08-02T00:00:00.000Z');
  assert.equal(await historyFloor(p, ['b']), '2025-09-25T05:00:00.000Z', '老规格已归档时不计');
  assert.equal(await historyFloor({ ...p, docSources: [] }), null, '没有 spec 目录：不设下限');
  assert.equal(await historyFloor({ ...p, repo: { path: os.tmpdir() } }), null, 'git 失败：不设下限');

  const gh = await fakeGh();
  gh.setup({ page: 3 });
  const r = await fetchPrs(p, null, { now: NOW, specDocIds: ['b'] });
  assert.equal(r.since, '2025-09-25T05:00:00.000Z');
  assert.deepEqual(nums(r), [373, 372, 371, 369, 365, 360]);
  assert.equal(git(repo, {}, 'status', '--porcelain'), before, '只读');
});

// ---- 失败与限流 ----

async function successCache(gh) {
  gh.setup();
  const { requests, ...cache } = await fetchPrs(project(), null, { now: NOW });
  return cache;
}

test('四类失败：保留上一版缓存与最后成功时间、给出对应文案；stderr 先遮蔽再记', async () => {
  const gh = await fakeGh();
  const cache = await successCache(gh);
  const later = { now: '2025-09-27T08:05:00.000Z' };

  for (const [mode, kind] of [['auth', 'auth'], ['notfound', 'no-access'], ['network', 'unreachable']]) {
    gh.setup({ mode });
    const r = await fetchPrs(project(), cache, later);
    assert.equal(r.status.error, kind, mode);
    assert.equal(r.status.message, GITHUB_ERROR_TEXT[kind]);
    assert.deepEqual(r.prs, cache.prs, `${mode}：PR 用缓存`);
    assert.equal(r.status.lastSuccessAt, NOW, `${mode}：页面据此显示「来自 <时间> 的缓存」`);
    assert.equal(r.maxUpdatedAt, cache.maxUpdatedAt);
    assert.ok(r.status.detail, `${mode}：有诊断用的首行`);
  }

  gh.setup({ mode: 'auth' });
  const auth = await fetchPrs(project(), cache, later);
  assert.ok(auth.status.detail.includes(MASKED) && !/gh[p]_[A-Za-z0-9]{20}/.test(auth.status.detail), '令牌形态串被遮蔽');
  assert.ok(!JSON.stringify(auth).includes('ghp_'), '返回的缓存里没有令牌');

  const missing = await fetchPrs(project({ github: { ghPath: path.join(os.tmpdir(), 'no-such-gh-binary') } }), cache, later);
  assert.equal(missing.status.error, 'gh-missing');
  assert.equal(missing.status.message, '未安装 GitHub CLI（安装 gh 并运行 gh auth login 后自动恢复）');
  assert.deepEqual(missing.prs, cache.prs);

  gh.setup({ mode: 'network' });
  const never = await fetchPrs(project(), null, later);
  assert.deepEqual([never.prs, never.status.lastSuccessAt, never.status.error], [[], null, 'unreachable'], '从未成功 → 页面显示「未包含 PR 信息」');

  gh.setup();
  const recovered = await fetchPrs(project(), auth, { now: '2025-09-27T08:10:00.000Z' });
  assert.deepEqual([recovered.status.error, recovered.status.lastSuccessAt], [null, '2025-09-27T08:10:00.000Z'], '下一轮自动恢复');
});

test('翻页中途失败：整轮作废，已拉到的页不并入，maxUpdatedAt 不前进', async () => {
  const gh = await fakeGh();
  gh.setup({ page: 3 });
  // 第 2 页起断网：只有带游标的调用失败
  const flaky = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
  const dir = await tmpDir();
  const wrapper = path.join(dir, 'flaky-gh.mjs');
  await writeFile(wrapper, `#!/usr/bin/env node\nif (process.argv.some((a) => a.startsWith('after='))) { process.stderr.write('error connecting to api.github.com\\n'); process.exit(1); }\nawait import(${JSON.stringify(flaky)});\n`, { mode: 0o755 });
  const r = await fetchPrs(project({ github: { ghPath: wrapper } }), null, { now: NOW });
  assert.equal(r.status.error, 'unreachable');
  assert.deepEqual([r.prs, r.maxUpdatedAt, r.requests], [[], null, 2]);
});

test('限流：RATE_LIMITED → 暂停到 resetAt，期间不发请求、用缓存；到点自动恢复', async () => {
  const gh = await fakeGh();
  const cache = await successCache(gh);

  gh.setup({ mode: 'ratelimited', resetAt: '2025-09-27T09:00:00Z' });
  const limited = await fetchPrs(project(), cache, { now: NOW });
  assert.equal(limited.status.error, 'rate-limited');
  assert.equal(limited.status.pausedUntil, '2025-09-27T09:00:00Z');
  assert.equal(limited.status.rate.remaining, 0);
  assert.deepEqual(limited.prs, cache.prs);

  gh.setup();
  const callsBefore = (await gh.calls()).length;
  const paused = await fetchPrs(project(), limited, { now: '2025-09-27T08:30:00.000Z' });
  assert.equal(paused.requests, 0);
  assert.equal((await gh.calls()).length, callsBefore, '暂停期内没有调用 gh');
  assert.equal(paused.status.error, 'rate-limited');

  const resumed = await fetchPrs(project(), paused, { now: '2025-09-27T09:00:01.000Z' });
  assert.deepEqual([resumed.status.error, resumed.status.pausedUntil], [null, null]);
  assert.ok(resumed.requests >= 1);
});

test('额度将尽（剩余 < 10%）：本轮结果照用，之后暂停到 resetAt', async () => {
  const gh = await fakeGh();
  gh.setup({ remaining: 499, limit: 5000, resetAt: '2025-09-27T09:00:00Z' });
  const r = await fetchPrs(project(), null, { now: NOW });
  assert.deepEqual([r.prs.length, r.status.error, r.status.pausedUntil], [10, null, '2025-09-27T09:00:00Z']);
  const next = await fetchPrs(project(), r, { now: '2025-09-27T08:05:00.000Z' });
  assert.equal(next.requests, 0);

  gh.setup({ remaining: 500, limit: 5000 });
  const ok = await fetchPrs(project(), null, { now: NOW });
  assert.equal(ok.status.pausedUntil, null, '恰好 10% 不暂停');
});

test('令牌权限提示：gh api -i /rate_limit 的 X-OAuth-Scopes', async () => {
  const gh = await fakeGh();
  gh.setup();
  assert.match(await checkScopes(project()), /^令牌带写权限（gist, read:org, repo, workflow），devboard 只读使用/);
  gh.setup({ scopes: 'read:org' });
  assert.equal(await checkScopes(project()), null);
  gh.setup({ scopes: 'read:org, write:packages' });
  assert.match(await checkScopes(project()), /写权限/);
  gh.setup({ scopes: null });
  assert.match(await checkScopes(project()), /^无法判断令牌权限范围/);
  assert.equal(await checkScopes(project({ github: { ghPath: path.join(os.tmpdir(), 'no-such-gh-binary') } })), null);
});

test('描述超过 64 KB 按字节截断，不留半个字符', () => {
  const node = { ...PRS[0], body: '汉'.repeat(30000) }; // 90000 字节
  const body = normalizePr(node).body;
  const [kept] = body.split('\n…');
  assert.ok(Buffer.byteLength(kept) <= 64 * 1024);
  assert.ok(!kept.includes('�'));
  assert.match(body, /已截断/);
  assert.equal(normalizePr(PRS[0]).body, PRS[0].body, '短描述原样');
});

// ---- 分支线归类 ----

test('归分支线：只看 base；前缀 / 标签不符或带别的分支线前缀 → 约定不一致，仍以 base 为准', () => {
  const pr = (number) => normalizePr(PRS.find((p) => p.number === number));
  assert.deepEqual(classifyBranchLine(pr(360), BRANCH_LINES), { branchLine: 'collab', issues: [] });
  assert.deepEqual(classifyBranchLine(pr(346), BRANCH_LINES), { branchLine: 'personal', issues: [] });

  const bare = { title: 'feat(collab): 忘了前缀', baseRefName: 'v2/collab', labels: [] };
  assert.deepEqual(classifyBranchLine(bare, BRANCH_LINES), { branchLine: 'collab', issues: [
    '标题缺少分支线「协作版」的前缀 [V2]', '缺少分支线「协作版」的标签（collab-v2 任一）'] });
  assert.equal(classifyBranchLine({ ...bare, title: '[V2] x' }, BRANCH_LINES).issues.length, 1, '只缺标签');
  assert.equal(classifyBranchLine({ ...bare, title: '[V2] x', labels: ['collab-v2'] }, BRANCH_LINES).issues.length, 0);

  const wrongBase = { title: '[V2] feat: 投错了 base', baseRefName: 'main', labels: [] };
  assert.deepEqual(classifyBranchLine(wrongBase, BRANCH_LINES), { branchLine: 'personal', issues: [
    'base 是 main，标题却带分支线「协作版」的前缀 [V2]'] });

  assert.deepEqual(classifyBranchLine({ title: 'x', baseRefName: 'release/1.0', labels: [] }, BRANCH_LINES),
    { branchLine: null, issues: [] }, '未归类，不丢弃');
});

// ---- 遮蔽 ----

test('mask：各类凭据形态遮蔽，普通文本、路径、分支名不误遮', () => {
  const token = (prefix, n = 36) => prefix + 'aB3'.repeat(Math.ceil(n / 3)).slice(0, n);
  const cases = [
    token('sk-ant-api03-', 40), token('sk-', 40), token('ghp_'), token('gho_'), token('github_pat_', 60),
    'AKIAIOSFODNN7EXAMPLE', 'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'a'.repeat(8) + '0123456789abcdef0123456789abcdef', // ≥32 位十六进制
    'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdI', // ≥32 位 base64
  ];
  for (const secret of cases) {
    const out = mask(`前文 ${secret} 后文`);
    assert.equal(out, `前文 ${MASKED} 后文`, secret);
  }
  assert.equal(mask('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n尾'), `${MASKED}\n尾`);
  assert.equal(mask('开头 -----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn（被截断）'), `开头 ${MASKED}`);
  assert.equal(mask('password: hunter2 与 API_KEY=abc 以及 token = xyz'), `password: ${MASKED} 与 API_KEY=${MASKED} 以及 token = ${MASKED}`);

  const plain = [
    '继续做 collab-m0-space-run 的任务 2.5b',
    '/Users/alice/Projects/widget/.claude/specs/collab-m0-space-run/tasks.md',
    'feature/chat-15.2-docs', 'fix/config-json-strict-write', 'https://github.com/acme/widget/pull/372',
  ];
  for (const s of plain) assert.equal(mask(s), s);
  assert.equal(mask(undefined), undefined);
});
