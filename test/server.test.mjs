import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { loadProjectDocs } from '../src/docs.mjs';
import { readCache, writeCache, readManual, changeManual } from '../src/store.mjs';

const NOW = new Date('2026-09-26T08:00:00Z');
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
// 服务启动后会在后台拉 GitHub：一律指向 gh 替身（默认回放 fixtures/prs.json），测试绝不访问真 GitHub
process.env.FAKE_GH = '{}';

// realpath：避免 macOS /var → /private/var 让路径比较失真。
const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-server-')));
async function put(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return root;
}
const project = (id, repoPath) => ({
  id, repo: { path: repoPath, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }],
  docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }], github: { ghPath: FAKE_GH },
});

// 一个好项目（有 spec 的临时 git 仓库）+ 一个仓库路径不存在的坏项目 + 一个带 index.html 的临时 web 目录。
async function fixtureSpace() {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), { '.claude/specs/demo/tasks.md': '# 计划\n\n- [x] 1 第一件\n- [ ] 2 第二件\n' });
  execFileSync('git', ['init', '-q', repo]);
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [project('good', repo), project('bad', path.join(dir, 'nope'))] }));
  const webDir = await put(path.join(dir, 'web'), { 'index.html': '<!doctype html><title>devboard</title>', 'app.mjs': 'export {};' });
  return { configPath, webDir };
}

// 缓存与手动关联目录默认放进一次性临时目录，不碰仓库里的 cache/、data/
async function start(opts) {
  const logs = [];
  const tmp = await tmpDir();
  const s = await startServer({ port: 0, now: () => NOW, log: (l) => logs.push(l), cacheDir: path.join(tmp, 'cache'), dataDir: path.join(tmp, 'data'), ...opts });
  return { ...s, logs };
}

// 等所有项目排队中的刷新（文档、GitHub）跑完，之后看板内容稳定、断言不受后台刷新干扰
async function idle(s) {
  for (const rt of s.runtimes.values()) {
    await rt.ready; // ready 之后启动时的两步刷新都已排上队
    while (rt.busy) await rt.lock;
  }
}

function request(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));

test('安全：错误 Host 403；回环 Host 与 devboard.localhost 放行；每个响应带 CSP / nosniff / no-referrer 且无 CORS 头', async (t) => {
  const s = await start(await fixtureSpace());
  t.after(() => s.close());

  for (const host of ['evil.example:' + s.port, `127.0.0.1:${s.port + 1}`, 'localhost', `devboard.localhost:${s.port + 1}`, `devboard.localhost.evil.example:${s.port}`, `other.localhost:${s.port}`]) {
    assert.equal((await request(s.port, '/api/projects', { host })).status, 403, host);
  }
  for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `devboard.localhost:${s.port}`, `[::1]:${s.port}`]) {
    assert.equal((await request(s.port, '/api/projects', { host })).status, 200, host);
  }
  for (const p of ['/', '/api/projects', '/nope', '/api/projects/good/board']) {
    const r = await request(s.port, p);
    assert.equal(r.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'", p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.equal(r.headers['access-control-allow-origin'], undefined, p);
  }
  assert.equal((await request(s.port, '/api/projects', { method: 'POST' })).status, 405);
});

test('静态文件：固定白名单，其它路径（含穿越写法）一律 404', async (t) => {
  const s = await start(await fixtureSpace());
  t.after(() => s.close());

  const index = await request(s.port, '/?x=1');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(index.body.toString(), /devboard/);
  assert.equal((await request(s.port, '/app.mjs')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await request(s.port, '/style.css')).status, 404, '白名单内但文件不存在 → 404');

  for (const p of ['/index.html', '/web/app.mjs', '/../package.json', '/%2e%2e/package.json', '/src/server.mjs', '/package.json', '/devboard.config.json', '//app.mjs']) {
    assert.equal((await request(s.port, p)).status, 404, p);
  }
});

test('品牌资源：页面声明 YUIBoard 标签图标，Logo 和图标按 PNG 原样返回', async (t) => {
  const { configPath } = await fixtureSpace();
  // 故意不传夹具的 webDir，读取仓库真实 web/，校验实际页面声明和 PNG 资源。
  const s = await start({ configPath });
  t.after(() => s.close());
  const html = (await request(s.port, '/')).body.toString();
  assert.match(html, /<title>YUIBoard<\/title>/);
  assert.match(html, /rel="icon"[^>]+href="\/yuiboard-icon.png"/);
  for (const file of ['yuiboard-logo.png', 'yuiboard-icon.png']) {
    const response = await request(s.port, `/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(response.body, readFileSync(new URL(`../web/${file}`, import.meta.url)));
    assert.equal(response.body.subarray(1, 4).toString(), 'PNG');
  }
});

test('项目列表与看板：坏项目返回明确错误而不是空看板，好项目照常', async (t) => {
  const s = await start(await fixtureSpace());
  t.after(() => s.close());
  await idle(s);

  const list = json(await request(s.port, '/api/projects'));
  assert.deepEqual(list.errors, []);
  assert.deepEqual(list.projects.map((p) => p.id), ['good', 'bad']);
  assert.deepEqual(list.projects[0].branchLines, [{ id: 'main', name: '主线', docFilter: null }], '顶栏分支线按钮用');
  const [good, bad] = list.projects;
  assert.deepEqual(good.errors, []);
  assert.equal(bad.errors[0].field, 'repo.path');
  assert.match(bad.errors[0].message, /项目 bad 的 repo\.path 项/);

  const badBoard = await request(s.port, '/api/projects/bad/board');
  assert.equal(badBoard.status, 409);
  assert.equal(json(badBoard).error, 'config');
  assert.match(json(badBoard).messages[0], /项目 bad 的 repo\.path 项/);
  assert.ok(s.logs.some((l) => /配置错误：项目 bad 的 repo\.path 项/.test(l)), '启动日志也指出问题');

  const r = await request(s.port, '/api/projects/good/board');
  assert.equal(r.status, 200);
  const board = json(r);
  assert.equal(board.projectId, 'good');
  assert.equal(board.version, 2, '文档一版 + GitHub 拉完一版');
  assert.equal(board.computedAt, NOW.toISOString());
  assert.equal(board.freshness.docsReadAt, NOW.toISOString());
  assert.deepEqual(board.tasks.map((v) => [v.key, v.status]), [['demo#1', 'done'], ['demo#2', 'not_started']]);
  assert.equal(board.workspaces[0].id, 'repo');
  assert.deepEqual(board.diagnostics.sources, []);

  assert.equal((await request(s.port, '/api/projects/none/board')).status, 404);
  assert.equal((await request(s.port, '/api/projects/%E0%A4/board')).status, 404, '坏的百分号编码不抛异常');
  const listAfter = json(await request(s.port, '/api/projects'));
  assert.equal(listAfter.projects[0].freshness.docsReadAt, NOW.toISOString());
});

test('看板：ETag / 304 与 gzip', async (t) => {
  const s = await start(await fixtureSpace());
  t.after(() => s.close());
  await idle(s);

  const plain = await request(s.port, '/api/projects/good/board');
  const etag = plain.headers.etag;
  assert.match(etag, /^".+"$/);
  assert.equal(plain.headers['content-encoding'], undefined);

  const again = await request(s.port, '/api/projects/good/board', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const gz = await request(s.port, '/api/projects/good/board', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.etag, etag);
  assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString('utf8')), json(plain));
});

test('全局配置错误（JSON 语法错）：服务照常起，项目列表带全局错误', async (t) => {
  const dir = await tmpDir();
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, '{ "projects": [ x ] }');
  const s = await start({ configPath, webDir: dir });
  t.after(() => s.close());

  const list = json(await request(s.port, '/api/projects'));
  assert.deepEqual(list.projects, []);
  assert.equal(list.errors.length, 1);
  assert.match(list.errors[0].message, /不是合法 JSON/);
});

test('端口占用：startServer 明确报错；命令行启动退出码 1', async (t) => {
  const space = await fixtureSpace();
  const s = await start(space);
  t.after(() => s.close());

  await assert.rejects(start({ ...space, port: s.port }), { code: 'EADDRINUSE', message: `端口 ${s.port} 已被占用，改 server.port` });

  const cfg = JSON.parse(readFileSync(space.configPath, 'utf8'));
  await writeFile(space.configPath, JSON.stringify({ ...cfg, server: { host: '127.0.0.1', port: s.port } }));
  const cli = promisify(execFile)(process.execPath, [path.join(SRC, 'server.mjs'), '--config', space.configPath], { timeout: 10_000 });
  await assert.rejects(cli, (e) => {
    assert.equal(e.code, 1);
    assert.match(e.stderr, new RegExp(`端口 ${s.port} 已被占用，改 server\\.port`));
    return true;
  });
});

test('只读静态检查：src/ 中写文件类调用只允许出现在 store.mjs（当前应为零处）', () => {
  const WRITE_CALL = /\b(?:writeFile|appendFile|rename|unlink|rmdir|rm|mkdir|mkdtemp|copyFile|cp|symlink|link|truncate|chmod|chown|utimes|createWriteStream)(?:Sync)?\s*\(/;
  const offenders = [];
  for (const rel of readdirSync(SRC, { recursive: true })) {
    if (!rel.endsWith('.mjs') || path.basename(rel) === 'store.mjs') continue;
    readFileSync(path.join(SRC, rel), 'utf8').split('\n').forEach((line, i) => {
      if (WRITE_CALL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('原文接口（任务 2.5）：按已发现的 docId 取整份或 from–to 片段；未知 docId / 路径形态参数一律 404，不碰文件系统', async (t) => {
  const s = await start(await fixtureSpace());
  t.after(() => s.close());

  const whole = await request(s.port, '/api/projects/good/docs/demo');
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'");
  assert.deepEqual(json(whole), {
    docId: 'demo', path: '.claude/specs/demo/tasks.md', from: 1, to: 4, total: 4,
    lines: ['# 计划', '', '- [x] 1 第一件', '- [ ] 2 第二件'],
  });
  const part = json(await request(s.port, '/api/projects/good/docs/demo?from=3&to=9'));
  assert.deepEqual([part.from, part.to, part.lines], [3, 4, ['- [x] 1 第一件', '- [ ] 2 第二件']], 'to 超出按文末截断');

  for (const q of ['from=0', 'from=abc', 'from=3&to=2', 'to=-1', 'from=1.5']) {
    const r = await request(s.port, `/api/projects/good/docs/demo?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(json(r).error, 'bad-request', q);
  }

  const denied = ['nope', 'tasks', '..%2F..%2Fpackage.json', '%2Fetc%2Fpasswd', '.claude%2Fspecs%2Fdemo%2Ftasks.md',
    'demo%2F..%2F..%2Fdevboard.config.json', '%2E%2E', 'demo%00', '%E0%A4'];
  for (const id of denied) {
    const r = await request(s.port, `/api/projects/good/docs/${id}`);
    assert.equal(r.status, 404, id);
    assert.equal(json(r).error, 'not-found', id);
  }
  for (const p of ['/api/projects/good/docs/../../package.json', '/api/projects/good/docs/demo/tasks.md', '/api/projects/good/docs/']) {
    assert.equal((await request(s.port, p)).status, 404, p);
  }
  assert.equal((await request(s.port, '/api/projects/bad/docs/demo')).status, 409, '配置有错的项目');
  assert.equal((await request(s.port, '/api/projects/none/docs/demo')).status, 404);
});

test('N17 原文接口：docRef 分支线的文档从 git ref 读（不检出），行与分支上的文件一致', async (t) => {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), { '.claude/specs/demo/tasks.md': '- [ ] 1 甲\n' });
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a]);
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  g('switch', '-q', '-c', 'next/x');
  await put(repo, { 'adr/ADR-0042-x.md': '\n# ADR-0042 新版\n\n- [ ] 94 丙\n' });
  g('add', '-A'); g('commit', '-q', '-m', 'next'); g('switch', '-q', 'main');
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ ...project('good', repo),
    docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }, { type: 'adr-dir', label: 'ADR', path: 'adr' }],
    branchLines: [{ id: 'main', name: '主线', base: 'main', docFilter: '^(?!next:)' },
      { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'next/x', docFiles: ['adr/ADR-0042-x.md'], docFilter: '^next:' }] }] }));
  const s = await start({ configPath, webDir: dir });
  t.after(() => s.close());
  await idle(s);

  const b = await board(s);
  assert.deepEqual(b.docs.map((d) => d.docId).sort(), ['demo', 'next:ADR-0042-x']);
  assert.equal(b.workspaces.find((w) => w.id === 'next').branch, 'next/x');
  const r = await request(s.port, `/api/projects/good/docs/${encodeURIComponent('next:ADR-0042-x')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).lines, ['', '# ADR-0042 新版', '', '- [ ] 94 丙']);
  assert.equal(json(r).path, 'adr/ADR-0042-x.md');
});

// ---------------- 任务 3.5：刷新调度、缓存与推送 ----------------

const COLLAB_FIXTURE = fileURLToPath(new URL('./fixtures/collab-m0-space-run.tasks.md', import.meta.url));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

// 轮询条件直到成立（最多 10 秒，需求 13.3 的上限）；返回条件的值
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const board = async (s, id = 'good') => json(await request(s.port, `/api/projects/${id}/board`));
const post = (s, pathname, origin = `http://127.0.0.1:${s.port}`) =>
  request(s.port, pathname, { method: 'POST', headers: origin ? { Origin: origin } : {} });
const FAST = { pollMs: 30, boardWriteMs: 0 };

// SSE 客户端：收集推送的 {version}
function subscribe(s, id = 'good') {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: s.port, path: `/api/projects/${id}/events`, headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
    events.headers = res.headers;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      for (const m of chunk.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
    });
  });
  req.on('error', () => {});
  events.close = () => req.destroy();
  return events;
}

// gh 替身的调用日志：数 graphql 请求次数，或数全部调用（rate_limit 权限检查也算）
async function ghLog(extra = {}) {
  const log = path.join(await tmpDir(), 'gh.log');
  process.env.FAKE_GH = JSON.stringify({ log, ...extra });
  const lines = () => (readdirSync(path.dirname(log)).includes('gh.log') ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    set: (cfg) => { process.env.FAKE_GH = JSON.stringify({ log, ...cfg }); },
    graphql: () => lines().filter((l) => l.includes('"graphql"')).length,
    calls: () => lines().length,
  };
}

test('文档变化：改临时 tasks.md 后 10 秒内 version 递增、只重解析该文档，SSE 推新版本；没变化不升版本', async (t) => {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), {
    '.claude/specs/demo/tasks.md': '# 计划\n\n- [x] 1 第一件\n- [ ] 2 第二件\n',
    '.claude/specs/other/tasks.md': '# 另一份\n\n- [ ] 1 甲\n',
  });
  execFileSync('git', ['init', '-q', repo]);
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [project('good', repo)] }));
  const s = await start({ configPath, webDir: dir, timing: FAST });
  t.after(() => s.close());
  await idle(s);

  const events = subscribe(s);
  t.after(() => events.close());
  const v0 = (await board(s)).version;
  await until(() => events.length);
  assert.equal(events.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.deepEqual(events[0], { version: v0 }, '连上先收到当前版本');

  await new Promise((r) => setTimeout(r, 200)); // 空转若干轮轮询
  assert.equal((await board(s)).version, v0, '没有变化时不重算、不升版本');

  await writeFile(path.join(repo, '.claude/specs/demo/tasks.md'), '# 计划\n\n- [x] 1 第一件\n- [x] 2 第二件（改完了）\n');
  const b = await until(async () => { const x = await board(s); return x.version > v0 && x; });
  assert.equal(b.tasks.find((v) => v.key === 'demo#2').status, 'done');
  assert.ok(s.logs.some((l) => / good 文档 2（重解析 1）/.test(l)), '两份文档只重解析改动的那份');
  await until(() => events.some((e) => e.version === b.version));
});

test('本地同步随分支变化：已关联的已合并 PR 先按「未核对」算，本地建出 base 分支后转「待同步」', async (t) => {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), { '.claude/specs/collab-m0-space-run/tasks.md': readFileSync(COLLAB_FIXTURE) });
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const configPath = path.join(dir, 'devboard.config.json');
  const branchLines = [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
    { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'], docFilter: '^collab-' },
  ];
  // historySince：临时仓库的首次提交是「现在」，按默认回溯下限会把夹具里的旧 PR 全截掉
  await writeFile(configPath, JSON.stringify({ projects: [{ ...project('good', repo), branchLines, github: { ghPath: FAKE_GH, historySince: '2025-01-01T00:00:00Z' } }] }));
  const s = await start({ configPath, webDir: dir, timing: FAST });
  t.after(() => s.close());
  await idle(s);

  let b = await board(s);
  const task = (x, n) => x.tasks.find((v) => v.key === `collab-m0-space-run#${n}`);
  assert.deepEqual([task(b, '3').status, task(b, '3').syncUnchecked, task(b, '3').prs.map((l) => l.pr)], ['done', true, [360]],
    '本地没有 base 分支、合并提交也不在本地 → 未核对（P3）');
  assert.equal(task(b, '15.2').status, 'in_review');
  const pr360 = b.prs.find((p) => p.number === 360);
  assert.equal(pr360.localSync, 'unknown');
  assert.equal(b.degraded.noPrData, false);

  // 本地建出 base 分支（不含 #360 的合并提交）→ 5 秒轮询发现 ref 变化 → 重查 → 待同步
  git(repo, 'branch', 'v2/collab');
  b = await until(async () => { const x = await board(s); return task(x, '3').status === 'awaiting_merge' && x; });
  assert.deepEqual(task(b, '3').syncPending, [360]);
  assert.equal(b.prs.find((p) => p.number === 360).localSync, 'pending');
  assert.ok(b.waiting.some((w) => w.kind === 'sync' && w.pr === 360));
});

test('手动刷新：连点合并为一次 GitHub 拉取；30 秒内再点也合并；要求同源 Origin', async (t) => {
  const gh = await ghLog();
  const s = await start({ ...(await fixtureSpace()), timing: FAST });
  t.after(() => s.close());
  await idle(s);
  assert.equal(gh.graphql(), 1, '启动时拉一次');

  const rs = await Promise.all([1, 2, 3].map(() => post(s, '/api/projects/good/refresh')));
  assert.deepEqual(rs.map((r) => [r.status, json(r).merged]), [[202, false], [202, true], [202, true]]);
  await idle(s);
  assert.equal(gh.graphql(), 2, '三次连点只多拉一次');
  assert.equal(json(await post(s, '/api/projects/good/refresh')).merged, true, '30 秒内再点合并');
  await idle(s);
  assert.equal(gh.graphql(), 2);
  assert.deepEqual((await board(s)).freshness.refreshing, { docs: false, sessions: false, github: false });

  assert.equal((await post(s, '/api/projects/good/refresh', null)).status, 403, '无 Origin');
  assert.equal((await post(s, '/api/projects/good/refresh', 'http://evil.example')).status, 403, '跨源');
  assert.equal((await post(s, '/api/projects/none/refresh')).status, 404);
  assert.equal((await post(s, '/api/projects/bad/refresh')).status, 409, '配置错的项目');
  assert.equal((await post(s, '/api/projects/good/board')).status, 405, '其它路径仍不接受 POST');
});

test('GitHub 降级：从未成功 → 未包含 PR 信息；成功后失败 → 用缓存并记最后成功时间；恢复后自动恢复', { timeout: 10_000 }, async (t) => {
  const gh = await ghLog({ mode: 'network', delayMs: 80 });
  let clock = NOW;
  const s = await start({ ...(await fixtureSpace()), now: () => clock, timing: { ...FAST, githubMs: 50 } });
  t.after(() => s.close());
  // 请求刻意慢于 50ms 轮询；等目标状态即可，等队列全空会被持续入队的刷新拖住。
  let b = await until(async () => { const x = await board(s); return x.freshness.github.error === 'unreachable' && x; });
  assert.deepEqual([b.degraded.noPrData, b.degraded.prFromCache, b.freshness.github.error, b.prs.length], [true, false, 'unreachable', 0]);
  assert.equal(b.freshness.github.message, 'GitHub 不可达');

  gh.set({});
  b = await until(async () => { const x = await board(s); return !x.degraded.noPrData && x; });
  assert.deepEqual([b.degraded.prFromCache, b.freshness.github.lastSuccessAt, b.prs.length], [false, NOW.toISOString(), 10]);

  clock = new Date('2026-09-26T09:00:00Z');
  gh.set({ mode: 'auth' });
  b = await until(async () => { const x = await board(s); return x.degraded.prFromCache && x; });
  assert.deepEqual([b.freshness.github.error, b.freshness.github.lastSuccessAt, b.prs.length], ['auth', NOW.toISOString(), 10],
    '沿用缓存的 PR，横幅用最后一次成功的时间');
  assert.ok(!JSON.stringify(b).includes('ABCDEFabcdef0123456789'), 'gh 输出里的令牌不进看板');

  gh.set({});
  b = await until(async () => { const x = await board(s); return !x.degraded.prFromCache && x; });
  assert.deepEqual([b.freshness.github.error, b.freshness.github.lastSuccessAt], [null, clock.toISOString()]);
  assert.ok(s.logs.some((l) => / good GitHub 请求 1（剩余 4990）/.test(l)), '日志记请求数与剩余额度');
  assert.ok(s.logs.every((l) => !l.includes('ABCDEFabcdef0123456789')), '日志不含令牌');
});

test('缓存：写入 0600 且原子；重启先回放 board.json 当首屏；删掉 cache/ 后自动重建', async (t) => {
  const space = await fixtureSpace();
  const cacheDir = path.join(await tmpDir(), 'cache');
  const projDir = path.join(cacheDir, 'good');
  let release;
  let s = await start({ ...space, cacheDir, timing: FAST });
  // 断言失败也先释放回放测试的读取闸门，再等服务的刷新收尾。
  t.after(() => { release?.(); return s.close(); });
  await idle(s);
  await until(() => ['board.json', 'docs.json', 'github.json'].every((f) => readdirSync(projDir).includes(f)));
  for (const f of readdirSync(projDir)) {
    assert.ok(!f.endsWith('.tmp'), `不留临时文件：${f}`);
    assert.equal(statSync(path.join(projDir, f)).mode & 0o777, 0o600, f);
  }
  const before = await board(s);
  await s.close();

  // 重启时让文档读取卡住：此时拿到的只能是回放的上次结果，并标「正在刷新」
  const gate = new Promise((r) => { release = r; });
  s = await start({ ...space, cacheDir, timing: FAST, loadDocs: async (...a) => { await gate; return loadProjectDocs(...a); } });
  const replay = await board(s);
  assert.equal(replay.version, 1);
  assert.deepEqual(replay.freshness.refreshing, { docs: true, sessions: false, github: true });
  assert.deepEqual(replay.tasks, before.tasks);
  release();
  await idle(s);
  const after = await board(s);
  assert.deepEqual(after.freshness.refreshing, { docs: false, sessions: false, github: false });
  assert.ok(s.logs.some((l) => / good 文档 1（重解析 0）/.test(l)), '文件没变：沿用 docs.json 里的解析结果');
  assert.deepEqual([after.docs, after.tasks], [before.docs, before.tasks], '沿用的解析结果与重新解析的一致');

  // 运行中删掉整个 cache/：下一次刷新照常，并把缓存文件重建出来
  await rm(cacheDir, { recursive: true, maxRetries: 5 }); // 重试：board.json 的节流写入可能正落在删目录的同时
  assert.equal(json(await post(s, '/api/projects/good/refresh')).merged, false);
  await idle(s);
  await until(() => existsSync(path.join(projDir, 'github.json')) && existsSync(path.join(projDir, 'board.json')));
  assert.equal((await board(s)).tasks.length, 2);
});

test('store：版本不符或损坏的缓存当不存在；写入原子覆盖', async () => {
  const dir = path.join(await tmpDir(), 'cache', 'p');
  assert.equal(await readCache(dir, 'github'), null, '不存在');
  await writeCache(dir, 'github', { a: 1 });
  assert.deepEqual(await readCache(dir, 'github'), { a: 1 });
  await writeCache(dir, 'github', { a: 2 });
  assert.deepEqual(await readCache(dir, 'github'), { a: 2 });
  assert.deepEqual(readdirSync(dir), ['github.json']);
  await writeFile(path.join(dir, 'github.json'), '{"cacheVersion":');
  assert.equal(await readCache(dir, 'github'), null, '损坏');
  await writeFile(path.join(dir, 'github.json'), JSON.stringify({ cacheVersion: 'old', value: { a: 3 } }));
  assert.equal(await readCache(dir, 'github'), null, '版本不符');
});

test('两个项目：一个刷新抛错（保留上一版看板、记「最近一次刷新失败」、错误已遮蔽）另一个照常，恢复后自动清除', async (t) => {
  const dir = await tmpDir();
  const repos = {};
  for (const id of ['a', 'b']) {
    repos[id] = await put(path.join(dir, id), { '.claude/specs/demo/tasks.md': '# 计划\n\n- [ ] 1 第一件\n' });
    execFileSync('git', ['init', '-q', repos[id]]);
  }
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [project('a', repos.a), project('b', repos.b)] }));
  let broken = false;
  const token = ['gh', 'p_', 'ABCDEFabcdef0123456789', 'ABCDEFabcdef0123'].join('');
  const loadDocs = async (p, o) => {
    if (broken && p.id === 'b') throw new Error(`炸了 ${token}`);
    return loadProjectDocs(p, o);
  };
  const s = await start({ configPath, webDir: dir, timing: FAST, loadDocs });
  t.after(() => s.close());
  await idle(s);
  const [a0, b0] = [await board(s, 'a'), await board(s, 'b')];

  broken = true;
  for (const id of ['a', 'b']) await writeFile(path.join(repos[id], '.claude/specs/demo/tasks.md'), '# 计划\n\n- [x] 1 第一件\n');
  await until(async () => (await board(s, 'a')).version > a0.version);
  const err = await until(async () => json(await request(s.port, '/api/projects')).projects.find((p) => p.id === 'b').refreshError);
  assert.match(err, /^最近一次刷新失败：炸了 ‹已遮蔽›$/);
  assert.equal((await board(s, 'a')).tasks[0].status, 'done', 'a 照常更新');
  const b1 = await board(s, 'b');
  assert.deepEqual([b1.version, b1.tasks[0].status], [b0.version, 'not_started'], 'b 保留上一版看板');
  assert.equal(json(await request(s.port, '/api/projects')).projects.find((p) => p.id === 'a').refreshError, null);

  broken = false;
  await until(async () => (await board(s, 'b')).tasks[0].status === 'done');
  assert.equal(json(await request(s.port, '/api/projects')).projects.find((p) => p.id === 'b').refreshError, null);
});

// ---------------- 任务 4.1：手动关联存储与写接口 ----------------

// 带请求体的手动关联写请求；origin / type 传 null 表示不带该头
function manualReq(s, method, body, { id = 'good', origin = `http://127.0.0.1:${s.port}`, type = 'application/json' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // 显式 Content-Length：Node 客户端对 DELETE 默认不分块，不写长度请求体就发不出去（浏览器 fetch 会自动带）
  const headers = { Host: `127.0.0.1:${s.port}`, 'Content-Length': Buffer.byteLength(text),
    ...(origin && { Origin: origin }), ...(type && { 'Content-Type': type }) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: `/api/projects/${id}/manual-links`, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(text);
  });
}
const manualFile = (s, id = 'good') => path.join(s.runtimes.get(id).manualDir, 'manual-links.json');
const view = (b, key) => b.tasks.find((v) => v.key === key);

test('手动关联写接口：只收同源 + JSON；link / unlink / 撤销写进 data/<项目>/manual-links.json 并立即反映到看板；失效键报 j', async (t) => {
  const s = await start({ ...(await fixtureSpace()), timing: FAST });
  t.after(() => s.close());
  await idle(s);
  const file = manualFile(s);
  const link = { taskKey: 'demo#2', pr: 372, action: 'link' };

  // 跨站页面发不出来的请求一律拒绝，且不落盘、不回 CORS 头
  const rejected = [
    [await manualReq(s, 'POST', link, { origin: null }), 403],
    [await manualReq(s, 'POST', link, { origin: 'http://evil.example' }), 403],
    [await manualReq(s, 'POST', link, { type: 'text/plain' }), 415],
    [await manualReq(s, 'POST', 'taskKey=demo%232', { type: 'application/x-www-form-urlencoded' }), 415],
    [await manualReq(s, 'POST', link, { type: null }), 415],
    [await manualReq(s, 'POST', '{"taskKey":'), 400],
    [await manualReq(s, 'POST', { taskKey: 'demo#2', pr: 372 }), 400],
    [await manualReq(s, 'POST', { ...link, pr: '372' }), 400],
    [await manualReq(s, 'DELETE', { taskKey: '', pr: 372 }), 400],
    [await manualReq(s, 'POST', link, { id: 'none' }), 404],
    [await manualReq(s, 'POST', link, { id: 'bad' }), 409],
  ];
  assert.deepEqual(rejected.map(([r]) => r.status), rejected.map(([, want]) => want));
  for (const [r] of rejected) assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')));
  assert.equal(existsSync(file), false, '被拒的请求不落盘');

  // link：写文件（五个字段、人可读）→ 返回的版本已包含改动
  const r = await manualReq(s, 'POST', link);
  assert.equal(r.status, 200);
  let b = await board(s);
  assert.ok(b.version >= json(r).version);
  assert.deepEqual(view(b, 'demo#2').prs.map((l) => [l.pr, l.source]), [[372, 'manual']]);
  assert.deepEqual(b.prs.find((p) => p.number === 372).tasks, ['demo#2']);
  const at = NOW.toISOString();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ project: 'good', ...link, at }]);
  assert.match(readFileSync(file, 'utf8'), /^\[\n  \{\n    "project": "good",/, '带缩进，方便手改');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // 同一 (taskKey, pr) 只留一条：unlink 覆盖 link；再关联一个不存在的任务 → 记录照存、冲突 j
  assert.equal((await manualReq(s, 'POST', { ...link, action: 'unlink' })).status, 200);
  assert.equal((await manualReq(s, 'POST', { taskKey: 'demo#9', pr: 360, action: 'link' })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((x) => [x.taskKey, x.pr, x.action]), [['demo#2', 372, 'unlink'], ['demo#9', 360, 'link']]);
  b = await board(s);
  assert.deepEqual(view(b, 'demo#2').prs, []);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'j').map((c) => [c.taskKey, c.pr]), [['demo#9', 360]]);

  // 撤销 = 删掉那一条；不存在的撤销也回 200、不写盘
  assert.equal((await manualReq(s, 'DELETE', { taskKey: 'demo#9', pr: 360 })).status, 200);
  assert.equal((await manualReq(s, 'DELETE', { taskKey: 'demo#1', pr: 1 })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((x) => x.taskKey), ['demo#2']);
  assert.deepEqual((await board(s)).conflicts.filter((c) => c.type === 'j'), []);
});

test('手动关联文件损坏：只用自动关联并标 manualBroken；写接口 409 且文件字节不变；owner 手工修好后下一轮轮询恢复', async (t) => {
  const space = await fixtureSpace();
  const dataDir = path.join(await tmpDir(), 'data');
  const broken = '[{"project":"good","taskKey":"demo#2",'; // 写了一半的 JSON
  await put(dataDir, { 'good/manual-links.json': broken });
  const s = await start({ ...space, dataDir, timing: FAST });
  t.after(() => s.close());
  await idle(s);
  const file = manualFile(s);

  let b = await board(s);
  assert.match(b.degraded.manualBroken, /^JSON 格式错误/);
  assert.ok(b.tasks.length === 2, '看板照常出');
  assert.ok(s.logs.some((l) => /good 手动关联文件读不了：JSON 格式错误/.test(l)));
  for (const [method, body] of [['POST', { taskKey: 'demo#2', pr: 372, action: 'link' }], ['DELETE', { taskKey: 'demo#2', pr: 372 }]]) {
    const r = await manualReq(s, method, body);
    assert.equal(r.status, 409, method);
    assert.match(json(r).messages[0], /^手动关联文件读不了：JSON 格式错误/);
  }
  assert.equal(readFileSync(file, 'utf8'), broken, '绝不覆盖');

  // JSON 合法但结构不对也当损坏；轮询发现文件变了会换上新原因
  const shape = '[{"taskKey":"demo#2","pr":"372"}]';
  await writeFile(file, shape);
  await until(async () => /第 1 条记录格式不对/.test((await board(s)).degraded.manualBroken));
  const r = await manualReq(s, 'POST', { taskKey: 'demo#1', pr: 372, action: 'link' });
  assert.equal(r.status, 409);
  assert.match(json(r).messages[0], /第 1 条记录格式不对/);
  assert.equal(readFileSync(file, 'utf8'), shape);

  // owner 手工改成合法内容：mtime 变了 → 重读 → 横幅消失、手动记录生效
  await writeFile(file, JSON.stringify([{ project: 'good', taskKey: 'demo#2', pr: 372, action: 'link', at: '2026-09-25T00:00:00Z' }]));
  b = await until(async () => { const x = await board(s); return x.degraded.manualBroken === null && view(x, 'demo#2').prs.length && x; });
  assert.deepEqual(view(b, 'demo#2').prs.map((l) => [l.pr, l.source]), [[372, 'manual']]);
});

test('删 cache/ 后手动记录仍在：重启后照样生效（需求 7.3）', async (t) => {
  const space = await fixtureSpace();
  const root = await tmpDir();
  const dirs = { cacheDir: path.join(root, 'cache'), dataDir: path.join(root, 'data') };
  let s = await start({ ...space, ...dirs, timing: FAST });
  t.after(() => s.close());
  await idle(s);
  assert.equal((await manualReq(s, 'POST', { taskKey: 'demo#1', pr: 360, action: 'unlink' })).status, 200);
  assert.equal((await manualReq(s, 'POST', { taskKey: 'demo#2', pr: 372, action: 'link' })).status, 200);
  await s.close();

  await rm(dirs.cacheDir, { recursive: true, maxRetries: 5 }); // 重试：关闭前排队的 board.json 写入可能还在收尾
  s = await start({ ...space, ...dirs, timing: FAST });
  await idle(s);
  const b = await board(s);
  assert.deepEqual(view(b, 'demo#2').prs.map((l) => [l.pr, l.source]), [[372, 'manual']]);
  assert.equal(JSON.parse(readFileSync(path.join(dirs.dataDir, 'good', 'manual-links.json'), 'utf8')).length, 2);
  assert.ok(existsSync(path.join(dirs.cacheDir, 'good')), '缓存照常重建');
});

test('store：手动关联并发写串行不丢；结构不对当损坏；写入目标只能是 cache/<项目> 或 data/<项目>', async () => {
  const dir = path.join(await tmpDir(), 'data', 'p');
  assert.deepEqual(await readManual(dir), { records: [], error: null, stamp: null }, '文件不存在 = 没有记录');
  await Promise.all([1, 2, 3, 4, 5].map((n) => changeManual(dir, 'p', { taskKey: `d#${n}`, pr: n, action: 'link' }, 'T')));
  assert.deepEqual((await readManual(dir)).records.map((r) => r.pr).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(readdirSync(dir), ['manual-links.json'], '不留临时文件');

  await writeFile(path.join(dir, 'manual-links.json'), '{"a":1}');
  assert.equal((await readManual(dir)).error, '内容应是记录数组');
  await assert.rejects(changeManual(dir, 'p', { taskKey: 'd#1', pr: 1 }, 'T'), { code: 'EMANUAL_BROKEN' });
  assert.equal(readFileSync(path.join(dir, 'manual-links.json'), 'utf8'), '{"a":1}');

  const elsewhere = path.join(await tmpDir(), 'repo', 'p');
  await assert.rejects(writeCache(elsewhere, 'github', {}), /只允许 cache\/<项目> 或 data\/<项目>/);
  await assert.rejects(writeCache(path.join(await tmpDir(), 'cache', '..', 'x'), 'github', {}), /只允许/);
  assert.equal(existsSync(elsewhere), false);
});

test('只读静态检查：store.mjs 的写盘调用全在 atomicWrite 里（它限定目标为 cache/ / data/）', () => {
  const WRITE_CALL = /\b(?:writeFile|appendFile|rename|unlink|rmdir|rm|mkdir|mkdtemp|copyFile|cp|symlink|link|truncate|chmod|chown|utimes|createWriteStream)(?:Sync)?\s*\(/;
  const src = readFileSync(path.join(SRC, 'store.mjs'), 'utf8');
  const start = src.indexOf('async function atomicWrite(');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const outside = (src.slice(0, start) + src.slice(end)).split('\n').filter((l) => WRITE_CALL.test(l));
  assert.deepEqual(outside, []);
  assert.match(src.slice(start, end), /root !== 'cache' && root !== 'data'/);
});

test('诊断（任务 6.5）：Board.diagnostics 带配置加载结果与 GitHub 最近一轮请求', async (t) => {
  const space = await fixtureSpace();
  const s = await start(space);
  t.after(() => s.close());
  await idle(s);
  const board = json(await request(s.port, '/api/projects/good/board'));
  assert.deepEqual(board.diagnostics.config, { path: space.configPath, projects: 2, warnings: [] });
  assert.deepEqual([typeof board.defaults.hoursPerDay, typeof board.defaults.defaultDurationDays], ['number', 'number'], '任务 6.6：甘特说明条用');
  assert.deepEqual(board.diagnostics.github, { at: NOW.toISOString(), requests: 1 });
  assert.equal(board.freshness.github.error, null);
  // 文档守约定；PR 侧的约定问题 = PR 级冲突 h / i / n，一条不少
  assert.ok(board.diagnostics.convention.length > 0);
  assert.deepEqual(board.diagnostics.convention,
    board.conflicts.filter((c) => c.pr != null).map((c) => ({ rule: 7, pr: c.pr, detail: c.detail })));
  assert.ok(board.prs.length > 0 && board.prs.every((p) => p.tasks.length === 0), '夹具 PR 都指向别的文档 → 全是未关联');
});

test('N11 md-dir：「规划中」的计划文件原文接口照常可读', async (t) => {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), { 'docs/plans/idea.md': '# 想法\n\n还没拆任务。\n' });
  execFileSync('git', ['init', '-q', repo]);
  const p = { ...project('good', repo), docSources: [{ type: 'md-dir', label: '计划', path: 'docs/plans' }] };
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [p] }));
  const s = await start({ configPath });
  t.after(() => s.close());
  await idle(s);
  const doc = (await board(s)).docs.find((d) => d.docId === 'idea');
  assert.equal(doc.parse.state, 'planning');
  const r = await request(s.port, '/api/projects/good/docs/idea');
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).lines, ['# 想法', '', '还没拆任务。']);
});

// N11：一个只有 spec 的临时仓库；withGithub = false 时项目不写 repo.github
async function n11Space({ withGithub }) {
  const dir = await tmpDir();
  const repo = await put(path.join(dir, 'repo'), { '.claude/specs/demo/tasks.md': '# 计划\n\n- [x] 1 第一件\n- [ ] 2 第二件\n' });
  execFileSync('git', ['init', '-q', repo]);
  const p = project('good', repo);
  if (!withGithub) delete p.repo.github;
  const configPath = path.join(dir, 'devboard.config.json');
  await writeFile(configPath, JSON.stringify({ projects: [p] }));
  return { dir, repo, p, configPath };
}

test('N11 未接 GitHub：不调用 gh，看板照常、freshness 为 off、无降级提示，手动刷新只刷文档', async (t) => {
  const gh = await ghLog();
  const { configPath } = await n11Space({ withGithub: false });
  const s = await start({ configPath, timing: FAST });
  t.after(() => s.close());
  await idle(s);
  const b = await board(s);
  assert.equal(b.tasks.length, 2);
  assert.deepEqual([b.freshness.github.state, b.freshness.github.message], ['off', '未接 GitHub']);
  assert.deepEqual([b.degraded.noPrData, b.degraded.prFromCache], [false, false]);
  assert.deepEqual(b.freshness.refreshing, { docs: false, sessions: false, github: false });
  const r = await post(s, '/api/projects/good/refresh');
  assert.equal(r.status, 202);
  await idle(s);
  assert.equal(gh.calls(), 0, '不拉 PR、不查令牌权限');
});

test('N11 关闭 GitHub：有 PR 缓存的项目去掉 repo.github 重启后，不用旧 PR、不回放旧看板，缓存文件保留', async (t) => {
  const { dir, p, configPath } = await n11Space({ withGithub: true });
  const node = JSON.parse(readFileSync(new URL('./fixtures/prs.json', import.meta.url), 'utf8'))[0];
  const prs = path.join(dir, 'prs.json');
  await writeFile(prs, JSON.stringify([{ ...node, number: 900, title: 'feat: 任务 2 第二件', body: '', isDraft: true, state: 'OPEN', mergedAt: null, closedAt: null, mergeCommit: null }]));
  await ghLog({ prs });
  const cacheDir = path.join(dir, 'cache');
  let s = await start({ configPath, cacheDir, timing: FAST });
  t.after(() => s.close());
  await idle(s);
  assert.equal((await board(s)).tasks.find((v) => v.key === 'demo#2').status, 'in_review', '前提：PR 让任务 2 处于等 review');
  await until(() => ['board.json', 'github.json'].every((f) => existsSync(path.join(cacheDir, 'good', f))));
  await s.close();

  delete p.repo.github;
  await writeFile(configPath, JSON.stringify({ projects: [p] }));
  s = await start({ configPath, cacheDir, timing: FAST });
  const b = await board(s);
  assert.equal(b.freshness.github.state, 'off');
  assert.equal(b.prs.length, 0);
  assert.equal(b.tasks.find((v) => v.key === 'demo#2').status, 'not_started');
  assert.ok(existsSync(path.join(cacheDir, 'good', 'github.json')), '缓存文件不删，重新接上 GitHub 后照常沿用');
});
