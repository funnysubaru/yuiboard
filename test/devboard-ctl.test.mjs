// N11 ops/devboard-ctl.mjs：check / find / 工具函数（design §4）。不装 LaunchAgent、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { check, findProject, pickPort, isFree, isDevboard, renderPlist, findAgent } from '../ops/devboard-ctl.mjs';

const CTL = fileURLToPath(new URL('../ops/devboard-ctl.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../ops/devboard.plist.template', import.meta.url));
const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-ctl-')));
const runCtl = (args) => new Promise((resolve) => {
  execFile(process.execPath, [CTL, ...args], (e, stdout) => resolve({ code: e ? e.code : 0, out: JSON.parse(stdout.trim().split('\n').at(-1)) }));
});
async function gitRepo(dir) {
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

test('check：好配置退出 0、坏配置退出 1，输出一行 JSON', async () => {
  const dir = await tmpDir();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const good = path.join(dir, 'good.json');
  await writeFile(good, JSON.stringify({ projects: [{ id: 'p', repo: { path: repo, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main', docFilter: '^' }] }] }));
  const g = await runCtl(['check', good]);
  assert.deepEqual([g.code, g.out.ok, g.out.errors], [0, true, []]);

  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{ "projects": [ x ] }');
  const b = await runCtl(['check', bad]);
  assert.equal(b.code, 1);
  assert.equal(b.out.ok, false);
  assert.equal(b.out.errors[0].projectId, null);
  assert.deepEqual(await check(bad), b.out, 'CLI 与函数结果一致');
});

test('用法错误：退出 1 并给出用法', async () => {
  const r = await runCtl(['nope']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /用法：devboard-ctl/);
});

test('findProject：~/、相对路径、尾斜杠、软链、NFD 都认作同一仓库；其它仓库为 null', async () => {
  const dir = await tmpDir();
  const nfc = 'café'.normalize('NFC');
  const repo = await gitRepo(path.join(dir, 'My Projects', `${nfc} repo`));
  const link = path.join(dir, 'link');
  execFileSync('ln', ['-s', repo, link]);
  const config = { projects: [
    { id: 'other', repo: { path: path.join(dir, 'elsewhere') } },
    { id: 'kept-id', name: '原名', repo: { path: path.relative(dir, repo) }, archived: ['x'] },
  ] };
  for (const q of [repo, `${repo}/`, link, repo.normalize('NFD')]) {
    const hit = findProject(config, q, dir);
    assert.equal(hit?.project?.id, 'kept-id', q);
    assert.equal(hit?.matchedBy, 'repo', q);
  }
  assert.equal(findProject(config, path.join(dir, 'nope'), dir), null);
  const home = { projects: [{ id: 'h', repo: { path: `~/${path.relative(os.homedir(), repo)}` } }] };
  if (repo.startsWith(os.homedir())) assert.equal(findProject(home, repo, dir)?.project?.id, 'h');
});

test('findProject：分支线 workspace 也算接入；repo 匹配优先于别的项目的 workspace 匹配', async () => {
  const dir = await tmpDir();
  const repoA = await gitRepo(path.join(dir, 'repo-a'));
  const repoB = await gitRepo(path.join(dir, 'acme', 'repo-b'));
  const config = { projects: [
    { id: 'proj-a', repo: { path: repoA }, branchLines: [
      { id: 'main', name: '主线', base: 'main', docFilter: '^' },
      { id: 'collab', name: '协作版', base: 'v2', docFilter: '^', workspace: `~/${path.relative(os.homedir(), repoB)}` },
    ] },
  ] };
  // B 以 ~/ 形式给出：命中 proj-a，matchedBy 标出是哪条分支线
  if (repoB.startsWith(os.homedir())) {
    const hitTilde = findProject(config, repoB, dir);
    assert.equal(hitTilde?.project?.id, 'proj-a');
    assert.equal(hitTilde?.matchedBy, 'workspace:collab');
  }
  // B 以相对路径给出，结果一样
  const hitRel = findProject(config, path.relative(dir, repoB), dir);
  assert.equal(hitRel?.project?.id, 'proj-a');
  assert.equal(hitRel?.matchedBy, 'workspace:collab');
  // A 命中走 repo
  const hitA = findProject(config, repoA, dir);
  assert.equal(hitA?.project?.id, 'proj-a');
  assert.equal(hitA?.matchedBy, 'repo');
  // 另一个项目的 repo.path 恰好等于 B：repo 匹配优先于 workspace 匹配
  const config2 = { projects: [
    ...config.projects,
    { id: 'proj-b', repo: { path: repoB } },
  ] };
  const hitB = findProject(config2, repoB, dir);
  assert.equal(hitB?.project?.id, 'proj-b');
  assert.equal(hitB?.matchedBy, 'repo');
});

test('pickPort：跳过占用的端口；全占时报错', async () => {
  assert.equal(await pickPort(5000, async (p) => p >= 5003), 5003);
  await assert.rejects(pickPort(5000, async () => false), /100 个端口/);
});

test('isFree / isDevboard：被普通程序占用 → 不空闲也不是 devboard；返回 projects 数组 → 是 devboard', async (t) => {
  const plain = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => plain.once('listening', r));
  t.after(() => plain.close());
  const port = plain.address().port;
  assert.equal(await isFree(port), false);
  assert.equal(await isDevboard(port), false);

  const http = await import('node:http');
  const fake = http.createServer((req, res) => res.end(JSON.stringify({ projects: [] }))).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  t.after(() => fake.close());
  assert.equal(await isDevboard(fake.address().port), true);

  const freePort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  assert.equal(await isFree(freePort), true);
});

test('renderPlist：占位符全部替换、值做 XML 转义、带空格与中文的路径原样保留；缺值报错', async () => {
  const template = await readFile(TEMPLATE, 'utf8');
  const values = { LABEL: 'com.devboard.agent', NODE: '/opt/node 24/bin/node', SERVER: '/Users/x/My Projects/dev&board/src/server.mjs', DIR: '/Users/x/My Projects/dev&board', PATH: '/usr/bin:/bin', LOG: '/Users/x/Library/Logs/devboard.log', ERRLOG: '/Users/x/Library/Logs/devboard.error.log' };
  const xml = renderPlist(template, values);
  assert.doesNotMatch(xml, /\{\{\w+\}\}/);
  assert.match(xml, /<string>\/Users\/x\/My Projects\/dev&amp;board\/src\/server\.mjs<\/string>/);
  assert.match(xml, /<string>\/opt\/node 24\/bin\/node<\/string>/);
  assert.throws(() => renderPlist(template, { ...values, ERRLOG: undefined, LOG: undefined }), /缺少值/);
});

test('findAgent：按 ProgramArguments 里的 server 路径找 plist，带出 label 与错误日志路径', async () => {
  const template = await readFile(TEMPLATE, 'utf8');
  const mk = (label, server) => renderPlist(template, { LABEL: label, NODE: '/n', SERVER: server, DIR: path.dirname(path.dirname(server)), PATH: '/usr/bin', LOG: '/l', ERRLOG: `/e-${label}` });
  const plists = [
    { file: '/LA/a.plist', text: mk('com.other', '/elsewhere/src/server.mjs') },
    { file: '/LA/b.plist', text: mk('com.example.devboard', '/Users/x/dev & board/src/server.mjs') },
  ];
  assert.deepEqual(findAgent(plists, '/Users/x/dev & board/src/server.mjs'), { file: '/LA/b.plist', label: 'com.example.devboard', errLog: '/e-com.example.devboard' });
  assert.equal(findAgent(plists, '/nope/src/server.mjs'), null);
});

// ---- up（后台进程模式）：在临时目录里放一份 src/ web/ ops/ 副本，真实启动服务 ----
import { cp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { up, sh, context, whoManages, ensureConfig } from '../ops/devboard-ctl.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// gh 一律当未登录，测试不碰真 gh；其它命令照常执行
const quietSh = (cmd, args) => (cmd === 'gh' ? Promise.resolve({ code: 1, stdout: '', stderr: '' }) : sh(cmd, args));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 副本目录 → 本测试经 upIn 实际起过的后台进程 PID。清理只杀这些，绝不按 pidfile 盲杀（pidfile 可能被伪造成测试进程自己）。
const spawned = new Map();
const pidOf = (dir) => Number(readFileSync(path.join(dir, 'cache', 'devboard.pid'), 'utf8'));

// 一份可运行的 devboard 副本；config = null 时不写配置文件
async function ctlSpace(t, config) {
  const dir = await tmpDir();
  spawned.set(dir, new Set());
  // 先注册清理：测试失败也杀掉本测试起的后台进程
  t.after(() => {
    for (const pid of spawned.get(dir)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  });
  for (const sub of ['src', 'web', 'ops']) await cp(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
  if (config) await writeFile(path.join(dir, 'devboard.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}
// up 返回后 pidfile 里若是新起的进程，记进 spawned；测试进程自己的 PID 永不记录
async function upIn(dir, extra = {}) {
  const r = await up({ dir, noLaunchd: true, sh: quietSh, timeoutMs: 15_000, ...extra });
  if (existsSync(path.join(dir, 'cache', 'devboard.pid'))) {
    const pid = pidOf(dir);
    if (pid !== process.pid) spawned.get(dir).add(pid);
  }
  return r;
}

test('up：Node 版本不对 → ok:false 且不写任何文件', async (t) => {
  const dir = await ctlSpace(t, null);
  const r = await upIn(dir, { nodeVersion: '22.11.0' });
  assert.deepEqual([r.ok, r.reason], [false, 'node-version']);
  assert.match(r.error, /需要 Node 24/);
  assert.equal(existsSync(path.join(dir, 'devboard.config.json')), false);
  assert.equal(existsSync(path.join(dir, 'cache')), false);
});

test('up：坏配置 → ok:false 带错误，不启动、不改文件', async (t) => {
  const port = await freePort();
  const text = `{ "server": { "port": ${port} }, "projects": [ x ] }`;
  const dir = await ctlSpace(t, text);
  const r = await upIn(dir);
  assert.deepEqual([r.ok, r.reason], [false, 'config-invalid']);
  assert.equal(r.errors[0].projectId, null);
  assert.equal(readFileSync(path.join(dir, 'devboard.config.json'), 'utf8'), text);
  assert.equal(await isDevboard(port), false);
  assert.equal(existsSync(path.join(dir, 'cache', 'devboard.pid')), false);
});

test('up：首次安装序列——空项目配置 up 启动 → 写入项目 → 再 up 重启并加载新项目', async (t) => {
  // 真正的「无配置」会用 4317，真实启动测试一律用随机端口；无配置时生成的内容由 ensureConfig 用例单独验证
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  const first = await upIn(dir);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual([first.port, first.portChanged, first.url], [port, false, `http://devboard.localhost:${port}`]);
  assert.match(first.managedBy, /^background:\d+$/);
  const pid1 = pidOf(dir);

  const repo = await gitRepo(path.join(await tmpDir(), 'repo'));
  await mkdir(path.join(repo, 'docs', 'plans'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'plans', 'p.md'), '- [ ] 1 第一件\n');
  const cfg = JSON.parse(readFileSync(path.join(dir, 'devboard.config.json'), 'utf8'));
  cfg.projects.push({ id: 'demo', repo: { path: repo }, branchLines: [{ id: 'main', name: '主线', base: 'main', docFilter: '^' }], docSources: [{ type: 'md-dir', label: '计划', path: 'docs/plans' }] });
  await writeFile(path.join(dir, 'devboard.config.json'), JSON.stringify(cfg));

  const second = await upIn(dir);
  assert.equal(second.ok, true, JSON.stringify(second));
  const pid2 = pidOf(dir);
  assert.notEqual(pid2, pid1, '第二次 up 重启了后台进程');
  assert.equal(alive(pid1), false);
  const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
  assert.deepEqual(list.projects.map((p) => p.id), ['demo']);
});

test('ensureConfig：配置文件不存在 → 生成最小配置（端口 4317）；已存在 → 原样不动（不探测、不绑定任何端口）', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'devboard.config.json');
  assert.equal(await ensureConfig(file), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { server: { host: '127.0.0.1', port: 4317 }, projects: [] });
  await writeFile(file, '{ "手写": true }');
  assert.equal(await ensureConfig(file), false);
  assert.equal(readFileSync(file, 'utf8'), '{ "手写": true }');
});

test('up：端口被普通程序占用 → 换到下一个空闲端口并写回，保留 BOM 之外的全部内容', async (t) => {
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const original = { server: { host: '127.0.0.1', port }, defaults: { hoursPerDay: 6 }, projects: [], custom: { keep: true } };
  const dir = await ctlSpace(t, `﻿${JSON.stringify(original)}`);
  const r = await upIn(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.portChanged, true);
  assert.ok(r.port > port);
  const saved = JSON.parse(readFileSync(path.join(dir, 'devboard.config.json'), 'utf8'));
  assert.deepEqual(saved, { ...original, server: { host: '127.0.0.1', port: r.port } });
  assert.equal(await isDevboard(r.port), true);
});

test('up：端口上的 devboard 不是本目录 devboard-ctl 起的（pidfile 失效）→ ok:false 报 PID，不杀它', async (t) => {
  const port = await freePort();
  const http = await import('node:http');
  const other = http.createServer((req, res) => res.end(JSON.stringify({ projects: [] }))).listen(port, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  t.after(() => other.close());
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  await mkdir(path.join(dir, 'cache'), { recursive: true });
  const fakePid = path.join(dir, 'cache', 'devboard.pid');
  await writeFile(fakePid, `${process.pid}\n`); // 活着但命令行不含本目录 server.mjs
  try {
    assert.equal((await whoManages(context({ dir, noLaunchd: true, sh: quietSh }))).kind, 'unmanaged');
    const r = await upIn(dir);
    assert.deepEqual([r.ok, r.reason], [false, 'unmanaged']);
    assert.match(r.error, /不是 devboard-ctl 或本目录的 LaunchAgent 启动的/);
    assert.equal(await isDevboard(port), true, '原进程照常运行');
  } finally {
    await rm(fakePid, { force: true }); // 伪造的 pidfile 指向测试进程自己，无论断言成败都删掉
  }
});

test('up：服务起不来 → 清理本次起的进程与 pidfile，带日志末尾', async (t) => {
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  await writeFile(path.join(dir, 'src', 'server.mjs'), "console.error('启动失败：故意的'); process.exit(1);\n");
  const r = await upIn(dir, { timeoutMs: 1500 });
  assert.deepEqual([r.ok, r.reason], [false, 'not-ready']);
  assert.match(r.error, /没有就绪/);
  assert.match(r.log, /启动失败：故意的/);
  assert.equal(existsSync(path.join(dir, 'cache', 'devboard.pid')), false);
});

test('up：上一个后台进程不理 SIGTERM → 改用 SIGKILL，健康检查只认新进程', async (t) => {
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  // 假服务：回 projects 数组和自己的 pid，忽略 SIGTERM
  await writeFile(path.join(dir, 'src', 'server.mjs'), `import http from 'node:http';
import { readFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const { server } = JSON.parse(readFileSync(new URL('../devboard.config.json', import.meta.url), 'utf8'));
http.createServer((req, res) => res.end(JSON.stringify({ projects: [], pid: process.pid }))).listen(server.port, '127.0.0.1');
`);
  assert.equal((await upIn(dir)).ok, true);
  const pid1 = pidOf(dir);
  const r = await upIn(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const pid2 = pidOf(dir);
  assert.notEqual(pid2, pid1);
  assert.equal(alive(pid1), false, '旧进程被 SIGKILL');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).pid, pid2, '应答的是新进程');
});

test('up：host 0.0.0.0 时上一个后台进程不理 SIGTERM → 仍按 PID 退出判断（不按端口空判断），改用 SIGKILL', async (t) => {
  // host 0.0.0.0：旧进程还在监听时，macOS 上另绑 127.0.0.1 同端口不一定报错，isFree() 可能提前误判为「空了」；
  // 必须按 PID 还在不在判断，才会在 TERM 无效后真正发 SIGKILL。
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '0.0.0.0', port }, projects: [] });
  await writeFile(path.join(dir, 'src', 'server.mjs'), `import http from 'node:http';
import { readFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const { server } = JSON.parse(readFileSync(new URL('../devboard.config.json', import.meta.url), 'utf8'));
http.createServer((req, res) => res.end(JSON.stringify({ projects: [], pid: process.pid }))).listen(server.port, server.host);
`);
  assert.equal((await upIn(dir)).ok, true);
  const pid1 = pidOf(dir);
  const r = await upIn(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const pid2 = pidOf(dir);
  assert.notEqual(pid2, pid1);
  assert.equal(alive(pid1), false, '旧进程被 SIGKILL');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).pid, pid2, '应答的是新进程');
});

test('up：配置端口改到另一个空闲端口后再 up → 按 pidfile 认回旧进程并停掉，不留孤儿、不重复起', async (t) => {
  const portA = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port: portA }, projects: [] });
  const first = await upIn(dir);
  assert.equal(first.ok, true, JSON.stringify(first));
  const pid1 = pidOf(dir);
  assert.equal(await isDevboard(portA), true);

  const portB = await freePort();
  const cfg = JSON.parse(readFileSync(path.join(dir, 'devboard.config.json'), 'utf8'));
  cfg.server.port = portB;
  await writeFile(path.join(dir, 'devboard.config.json'), JSON.stringify(cfg));

  const second = await upIn(dir);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.port, portB);
  const pid2 = pidOf(dir);
  assert.notEqual(pid2, pid1);
  assert.equal(alive(pid1), false, '旧进程被按 pidfile 识别并停掉');
  assert.equal(await isDevboard(portA), false, '旧端口没有残留实例');
  assert.equal(await isDevboard(portB), true, '新端口只有一个实例在跑');
});

test('whoManages（Windows）：用 PowerShell 取命令行认 pidfile 进程，不调用 ps；命令行不符为 unmanaged', async () => {
  const dir = await tmpDir();
  await mkdir(path.join(dir, 'cache'), { recursive: true });
  await writeFile(path.join(dir, 'cache', 'devboard.pid'), '4242\n');
  const serverEntry = path.join(dir, 'src', 'server.mjs');
  for (const [cmdLine, kind] of [[`"C:\\node\\node.exe" ${serverEntry}`, 'pidfile'], ['"C:\\node\\node.exe" C:\\other\\server.mjs', 'unmanaged']]) {
    const calls = [];
    const winSh = async (cmd, args) => { calls.push(cmd); return cmd === 'powershell' ? { code: 0, stdout: `${cmdLine}\r\n`, stderr: '' } : { code: 127, stdout: '', stderr: '' }; };
    const ctx = context({ dir, platform: 'win32', sh: winSh });
    const who = await whoManages(ctx);
    assert.equal(who.kind, kind, cmdLine);
    if (kind === 'pidfile') assert.equal(who.pid, 4242);
    assert.ok(calls.includes('powershell') && !calls.includes('ps'), '不用 ps');
    assert.equal(ctx.useLaunchd, false);
  }
});

// ---- LaunchAgent 模式：替身 sh 记录调用，plist 写在临时目录 ----
import { launchdStart, launchdCleanup } from '../ops/devboard-ctl.mjs';

// codes：命令前缀 → 退出码，如 { 'launchctl print': 113 }；未列出的返回 0
function fakeSh(codes = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const hit = Object.keys(codes).find((k) => line.startsWith(k));
    return { code: hit ? codes[hit] : 0, stdout: '', stderr: hit ? `失败：${hit}` : '' };
  };
  fn.calls = calls;
  return fn;
}
async function launchdCtx(codes) {
  const dir = await tmpDir();
  await cp(path.join(ROOT, 'ops'), path.join(dir, 'ops'), { recursive: true });
  const fake = fakeSh(codes);
  const ctx = context({ dir, platform: 'darwin', uid: 501, agentsDir: path.join(dir, 'LaunchAgents'), logsDir: path.join(dir, 'Logs'), sh: fake });
  return { ctx, fake };
}
async function putAgent(ctx, label, serverEntry = ctx.serverEntry) {
  await mkdir(ctx.agentsDir, { recursive: true });
  const text = renderPlist(await readFile(TEMPLATE, 'utf8'), { LABEL: label, NODE: '/n', SERVER: serverEntry, DIR: ctx.dir, PATH: '/usr/bin', LOG: '/l', ERRLOG: '/e' });
  await writeFile(path.join(ctx.agentsDir, `${label}.plist`), text);
}

test('launchd：本目录的 plist 已加载 → kickstart -k，不新建', async () => {
  const { ctx, fake } = await launchdCtx();
  await putAgent(ctx, 'com.example.devboard');
  const r = await launchdStart(ctx);
  assert.deepEqual([r.agent.label, r.created], ['com.example.devboard', false]);
  assert.ok(fake.calls.includes('launchctl kickstart -k gui/501/com.example.devboard'));
  assert.deepEqual(readdirSync(ctx.agentsDir), ['com.example.devboard.plist']);
  assert.equal((await whoManages(ctx)).kind, 'launchd');
});

test('launchd：plist 在但已 bootout（未加载）→ bootstrap 恢复', async () => {
  const { ctx, fake } = await launchdCtx({ 'launchctl print': 113 });
  await putAgent(ctx, 'com.example.devboard');
  const r = await launchdStart(ctx);
  assert.equal(r.created, false);
  assert.ok(fake.calls.includes(`launchctl bootstrap gui/501 ${path.join(ctx.agentsDir, 'com.example.devboard.plist')}`));
  assert.ok(!fake.calls.some((c) => c.startsWith('launchctl kickstart')));
  assert.equal((await whoManages(ctx)).kind, 'unmanaged', '未加载、也没有 pidfile');
});

test('launchd：没有本目录的 plist → 按模板新建 com.devboard.agent 并 bootstrap；别的目录的同名 plist 不覆盖', async () => {
  const { ctx, fake } = await launchdCtx({ 'launchctl print': 113 });
  await putAgent(ctx, 'com.devboard.agent', '/another/devboard/src/server.mjs');
  const before = readFileSync(path.join(ctx.agentsDir, 'com.devboard.agent.plist'), 'utf8');
  const r = await launchdStart(ctx);
  assert.equal(r.created, true);
  assert.match(r.agent.label, /^com\.devboard\.agent\.[0-9a-f]{6}$/);
  const text = readFileSync(r.agent.file, 'utf8');
  assert.ok(text.includes(`<string>${ctx.serverEntry}</string>`));
  assert.ok(text.includes(`<string>${process.execPath}</string>`));
  assert.equal(r.agent.errLog, path.join(ctx.logsDir, 'devboard.error.log'));
  assert.equal(readFileSync(path.join(ctx.agentsDir, 'com.devboard.agent.plist'), 'utf8'), before, '别的目录的 plist 原样保留');
  assert.ok(fake.calls.includes(`launchctl bootstrap gui/501 ${r.agent.file}`));

  await launchdCleanup(ctx, r);
  assert.ok(fake.calls.includes(`launchctl bootout gui/501/${r.agent.label}`));
  assert.equal(existsSync(r.agent.file), false, '本次新建的 plist 失败清理时删除');
});

test('launchd：新建后 bootstrap 失败 → 抛错并删掉本次新建的 plist；已有 plist 的 cleanup 什么都不删', async () => {
  const { ctx } = await launchdCtx({ 'launchctl print': 113, 'launchctl bootstrap': 5 });
  await assert.rejects(launchdStart(ctx), /launchctl bootstrap 失败/);
  assert.deepEqual(readdirSync(ctx.agentsDir), []);

  const { ctx: ctx2, fake } = await launchdCtx();
  await putAgent(ctx2, 'com.example.devboard');
  const r = await launchdStart(ctx2);
  await launchdCleanup(ctx2, r);
  assert.ok(!fake.calls.some((c) => c.startsWith('launchctl bootout')));
  assert.deepEqual(readdirSync(ctx2.agentsDir), ['com.example.devboard.plist']);
});

// fix round 1 · Finding 1：入口路径里有符号链接时，main() 的「是否被直接运行」判断不能悄悄判假
test('CLI：入口路径经符号链接也能识别为直接运行（不会 exit 0 零输出地啥都不做）', async () => {
  const dir = await tmpDir();
  const link = path.join(dir, 'repo-link');
  execFileSync('ln', ['-s', ROOT, link]);
  const linkedCtl = path.join(link, 'ops', 'devboard-ctl.mjs');
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [linkedCtl, 'bogus'], (e, stdout) => resolve({ code: e ? e.code : 0, out: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  });
  assert.equal(r.code, 1);
  assert.match(r.out.error, /用法：devboard-ctl/);
});

// fix round 1 · Finding 2：launchd 已加载时也要查端口，被别的程序占用要换端口、写回配置，再 kickstart
test('up：launchd 已加载但端口被别的程序占用 → 同样换端口写回配置、再 kickstart；现有 plist 不删、不 bootout', async (t) => {
  const { ctx, fake } = await launchdCtx({ gh: 1 });
  await putAgent(ctx, 'com.example.devboard');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  await writeFile(ctx.configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, projects: [] }));

  const r = await up({ dir: ctx.dir, platform: 'darwin', uid: 501, agentsDir: ctx.agentsDir, logsDir: ctx.logsDir, sh: fake, timeoutMs: 1500 });
  assert.deepEqual([r.ok, r.reason], [false, 'not-ready']);
  assert.match(r.error, /没有就绪/);

  const saved = JSON.parse(readFileSync(ctx.configPath, 'utf8'));
  assert.ok(saved.server.port > port, `端口应换到比 ${port} 更高的空闲端口，实际 ${saved.server.port}`);
  assert.ok(fake.calls.includes('launchctl kickstart -k gui/501/com.example.devboard'));
  assert.equal(existsSync(path.join(ctx.agentsDir, 'com.example.devboard.plist')), true, '已有 plist 不删');
  assert.ok(!fake.calls.some((c) => c.startsWith('launchctl bootout')), '已有 plist 的失败路径不该 bootout');
});

// ---- save / remove：skill 写配置只走这几个子命令，不再自己拼 node -e（final review Important 1） ----
import { saveNew, saveUpdate, removeProject, writeJson } from '../ops/devboard-ctl.mjs';

const fmt = (v) => `${JSON.stringify(v, null, 2)}\n`;
const noTmp = (dir) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));
// owner 式项目：分支线带 workspace / docRef / docFiles，外加 archived、excluded、正则、extraCwds、github 与未知字段
const ownerProject = (repo, ws) => ({
  id: 'widget', name: 'Widget',
  repo: { path: repo, github: 'acme/widget' },
  docSources: [{ type: 'spec-dir', label: 'Claude Code spec', path: '.claude/specs' }],
  branchLines: [
    { id: 'main', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'collab', name: '协作版', base: 'v2/collab', docFilter: '^(?!next:)', workspace: ws },
    { id: 'next', name: '新引擎', base: 'next/engine-2026.9', docFilter: '^next:', docRef: 'origin/next/engine-2026.9', docFiles: ['docs/adr/ADR-0042.md'] },
  ],
  archived: ['T1'], excluded: ['T9'], milestoneCodePattern: '^M\\d+',
  sessions: [{ source: 'claude-code', extraCwds: ['~/Projects/widget'] }, { source: 'codex' }],
  github: { labels: ['collab-v2'] },
  futureField: { keep: [1, 'x'] },
});
async function saveSpace() {
  const dir = await tmpDir();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const ws = await gitRepo(path.join(dir, 'collab-ws'));
  const other = await gitRepo(path.join(dir, 'other'));
  const file = path.join(dir, 'devboard.config.json');
  return { dir, repo, ws, other, file };
}
const newProj = (id, repoPath) => ({ id, name: id, repo: { path: repoPath }, branchLines: [{ id: 'main', name: '主线', base: 'main', docFilter: '^' }], sessions: [{ source: 'claude-code' }] });

test('save new：追加项目；两格缩进、无 BOM、结尾换行，未知顶层字段保留，.bak 是写之前的原文，不留临时文件', async () => {
  const s = await saveSpace();
  const original = `﻿${JSON.stringify({ server: { port: 4999 }, projects: [], custom: { keep: true } })}`;
  await writeFile(s.file, original);
  const r = await saveNew(s.file, newProj('demo', s.other));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.id, 'demo');
  assert.equal(readFileSync(s.file, 'utf8'), fmt({ server: { port: 4999 }, projects: [newProj('demo', s.other)], custom: { keep: true } }));
  assert.equal(readFileSync(`${s.file}.bak`, 'utf8'), original);
  assert.deepEqual(noTmp(s.dir), []);
});

test('save new：配置不存在时先生成最小配置再追加', async () => {
  const s = await saveSpace();
  const r = await saveNew(s.file, newProj('demo', s.other));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf8')), { server: { host: '127.0.0.1', port: 4317 }, projects: [newProj('demo', s.other)] });
});

test('save new：id 已存在 → id-exists；仓库已接入（repo 或分支线 workspace）→ already-onboarded 带 id/matchedBy；文件不动', async () => {
  const s = await saveSpace();
  const text = fmt({ projects: [ownerProject(s.repo, s.ws)] });
  await writeFile(s.file, text);
  const dup = await saveNew(s.file, newProj('widget', s.other));
  assert.deepEqual([dup.ok, dup.reason], [false, 'id-exists']);
  const byRepo = await saveNew(s.file, newProj('again', `${s.repo}/`));
  assert.deepEqual([byRepo.ok, byRepo.reason, byRepo.id, byRepo.matchedBy], [false, 'already-onboarded', 'widget', 'repo']);
  const byWs = await saveNew(s.file, newProj('collab', s.ws));
  assert.deepEqual([byWs.ok, byWs.reason, byWs.id, byWs.matchedBy], [false, 'already-onboarded', 'widget', 'workspace:collab']);
  assert.equal(readFileSync(s.file, 'utf8'), text);
  assert.equal(existsSync(`${s.file}.bak`), false, '被拒时不备份、不写');
});

test('save update：只改 name / docSources，其它字段（含未知字段、键顺序）逐字节保留，其它项目不动', async () => {
  const s = await saveSpace();
  const cfg = { server: { port: 4999 }, projects: [ownerProject(s.repo, s.ws), newProj('other', s.other)] };
  await writeFile(s.file, fmt(cfg));
  const docSources = [{ type: 'md-dir', label: '实施计划', path: 'docs/plans' }];
  const r = await saveUpdate(s.file, 'widget', { name: 'Widget 新名', docSources });
  assert.equal(r.ok, true, JSON.stringify(r));
  const expected = structuredClone(cfg);
  expected.projects[0].name = 'Widget 新名';
  expected.projects[0].docSources = docSources;
  assert.equal(readFileSync(s.file, 'utf8'), fmt(expected));
});

test('save update：只给 repo.github → 只改它，repo.path 等原样', async () => {
  const s = await saveSpace();
  const p = newProj('demo', s.other);
  p.repo.extra = 'keep';
  await writeFile(s.file, fmt({ projects: [p] }));
  const r = await saveUpdate(s.file, 'demo', { repo: { github: 'acme/demo' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(s.file, 'utf8'), fmt({ projects: [{ ...p, repo: { path: s.other, extra: 'keep', github: 'acme/demo' } }] }));
});

test('save update：补丁含不允许的字段 → patch-field-not-allowed 列出它们，文件不动；id 不存在 → not-found', async () => {
  const s = await saveSpace();
  const text = fmt({ projects: [ownerProject(s.repo, s.ws)] });
  await writeFile(s.file, text);
  const bad = await saveUpdate(s.file, 'widget', { name: 'x', branchLines: [], repo: { path: '/elsewhere', github: 'a/b' }, archived: [] });
  assert.deepEqual([bad.ok, bad.reason], [false, 'patch-field-not-allowed']);
  assert.deepEqual(bad.fields.sort(), ['archived', 'branchLines', 'repo.path']);
  const missing = await saveUpdate(s.file, 'nope', { name: 'x' });
  assert.deepEqual([missing.ok, missing.reason], [false, 'not-found']);
  assert.equal(readFileSync(s.file, 'utf8'), text);
});

test('save：目标项目 check 不过 → 恢复 .bak，文件逐字节还原；别的项目原有的错不挡保存，放在 otherErrors', async () => {
  const s = await saveSpace();
  // 原文刻意不是 writeJson 的格式（紧凑 + BOM），才能证明恢复的是原字节而不是重新序列化
  const text = `﻿${JSON.stringify({ projects: [newProj('demo', s.other), newProj('broken', path.join(s.dir, 'gone'))] })}`;
  await writeFile(s.file, text);
  const bad = await saveUpdate(s.file, 'demo', { repo: { github: 'not a repo' } });
  assert.deepEqual([bad.ok, bad.reason], [false, 'check-failed']);
  assert.ok(bad.errors.length > 0 && bad.errors.every((e) => e.projectId === 'demo'), JSON.stringify(bad.errors));
  assert.equal(readFileSync(s.file, 'utf8'), text);
  const badNew = await saveNew(s.file, newProj('ghost', path.join(s.dir, 'no-repo')));
  assert.deepEqual([badNew.ok, badNew.reason], [false, 'check-failed']);
  assert.equal(readFileSync(s.file, 'utf8'), text);
  assert.deepEqual(noTmp(s.dir), []);

  const ok = await saveUpdate(s.file, 'demo', { name: '演示' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.otherErrors.some((e) => e.projectId === 'broken'));
});

test('remove：删掉该项目、其它原样；id 不存在 → not-found 且文件不动', async () => {
  const s = await saveSpace();
  const cfg = { projects: [ownerProject(s.repo, s.ws), newProj('other', s.other)], custom: 1 };
  await writeFile(s.file, fmt(cfg));
  const r = await removeProject(s.file, 'other');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(s.file, 'utf8'), fmt({ projects: [cfg.projects[0]], custom: 1 }));
  assert.equal(readFileSync(`${s.file}.bak`, 'utf8'), fmt(cfg));
  const before = readFileSync(s.file, 'utf8');
  const missing = await removeProject(s.file, 'other');
  assert.deepEqual([missing.ok, missing.reason], [false, 'not-found']);
  assert.equal(readFileSync(s.file, 'utf8'), before);
});

test('writeJson：原子写（同目录临时文件 + rename），不留临时文件', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'x.json');
  await writeJson(file, { a: 1 });
  await writeJson(file, { a: 2 });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 2\n}\n');
  assert.deepEqual(readdirSync(dir), ['x.json']);
});

test('CLI：save --new / save --update / remove 经 stdin 往返，一行 JSON，被拒退出 1', async (t) => {
  const s = await saveSpace();
  const dir = await ctlSpace(t, { projects: [] });
  const cli = path.join(dir, 'ops', 'devboard-ctl.mjs');
  const file = path.join(dir, 'devboard.config.json');
  const run = (args, input) => new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], (e, stdout) => resolve({ code: e ? e.code : 0, lines: stdout.trim().split('\n') }));
    child.stdin.end(input ?? '');
  });
  const a = await run(['save', '--new'], JSON.stringify(newProj('demo', s.other)));
  assert.deepEqual([a.code, a.lines.length, JSON.parse(a.lines[0]).ok], [0, 1, true]);
  const again = await run(['save', '--new'], JSON.stringify(newProj('demo', s.repo)));
  assert.deepEqual([again.code, JSON.parse(again.lines[0]).reason], [1, 'id-exists']);
  const u = await run(['save', '--update', 'demo'], JSON.stringify({ name: '演示' }));
  assert.equal(u.code, 0, u.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[0].name, '演示');
  const junk = await run(['save', '--update', 'demo'], 'not json');
  assert.deepEqual([junk.code, JSON.parse(junk.lines[0]).reason], [1, 'bad-input']);
  const rm1 = await run(['remove', 'demo']);
  assert.equal(rm1.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects, []);
});

// ---- final review minors：ownsPid 整参数匹配、端口校验、spawn 失败、reason ----
test('whoManages：命令行里 server.mjs 必须是完整参数——后缀路径、加后缀的文件名都不算本目录的进程', async () => {
  const dir = await tmpDir();
  await mkdir(path.join(dir, 'cache'), { recursive: true });
  await writeFile(path.join(dir, 'cache', 'devboard.pid'), '4242\n');
  const entry = path.join(dir, 'src', 'server.mjs');
  for (const [cmdLine, kind] of [
    [`/usr/bin/node ${entry}`, 'pidfile'],
    [`node ${entry} --inspect`, 'pidfile'],
    [`node /mnt/copy${entry}`, 'unmanaged'],
    [`node ${entry}.bak`, 'unmanaged'],
  ]) {
    const ctx = context({ dir, platform: 'linux', sh: async (cmd) => (cmd === 'ps' ? { code: 0, stdout: `${cmdLine}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }) });
    assert.equal((await whoManages(ctx)).kind, kind, cmdLine);
  }
});

test('up：server.port 不是 1–65535 的整数 → bad-port，不写任何文件、不启动', async (t) => {
  for (const port of ['abc', 0, 70000, 1.5]) {
    const text = JSON.stringify({ server: { host: '127.0.0.1', port }, projects: [] });
    const dir = await ctlSpace(t, text);
    const r = await upIn(dir);
    assert.deepEqual([r.ok, r.reason], [false, 'bad-port'], String(port));
    assert.equal(readFileSync(path.join(dir, 'devboard.config.json'), 'utf8'), text);
    assert.equal(existsSync(path.join(dir, 'cache')), false);
  }
});

test('up：server.port 写成数字字符串 → 按数字处理', async (t) => {
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port: String(port) }, projects: [] });
  const r = await upIn(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.port, r.portChanged], [port, false]);
});

test('up：后台进程 spawn 失败 → start-failed 一行结果、不崩，旧 pidfile 不留', async (t) => {
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  await mkdir(path.join(dir, 'cache'), { recursive: true });
  await writeFile(path.join(dir, 'cache', 'devboard.pid'), '999999\n'); // 早已不存在的进程
  const r = await upIn(dir, { execPath: path.join(dir, 'no-such-node') });
  assert.deepEqual([r.ok, r.reason], [false, 'start-failed'], JSON.stringify(r));
  assert.match(r.error, /ENOENT/);
  assert.equal(existsSync(path.join(dir, 'cache', 'devboard.pid')), false);
});

test('up：launchd 新建后 bootstrap 失败 → launchd-failed', async () => {
  const { ctx, fake } = await launchdCtx({ 'launchctl print': 113, 'launchctl bootstrap': 5, gh: 1 });
  await writeFile(ctx.configPath, JSON.stringify({ server: { host: '127.0.0.1', port: await freePort() }, projects: [] }));
  const r = await up({ dir: ctx.dir, platform: 'darwin', uid: 501, agentsDir: ctx.agentsDir, logsDir: ctx.logsDir, sh: fake, timeoutMs: 1500 });
  assert.deepEqual([r.ok, r.reason], [false, 'launchd-failed'], JSON.stringify(r));
  assert.deepEqual(readdirSync(ctx.agentsDir), []);
});

import { withConfigLock, revert } from '../ops/devboard-ctl.mjs';

test('save new：写入后校验抛异常（repo.path 为数字）→ check-failed，正式配置恢复原文，不留锁和临时文件', async () => {
  const s = await saveSpace();
  const text = fmt({ projects: [newProj('demo', s.other)] });
  await writeFile(s.file, text);
  const r = await saveNew(s.file, { ...newProj('bad', s.repo), repo: { path: 42 } });
  assert.deepEqual([r.ok, r.reason], [false, 'check-failed'], JSON.stringify(r));
  assert.match(r.errors[0].message, /写入后校验出错/);
  assert.equal(readFileSync(s.file, 'utf8'), text);
  assert.equal(existsSync(`${s.file}.lock`), false);
  assert.deepEqual(noTmp(s.dir), []);
});

test('save new：两个进程同时追加不同项目 → 都成功，两个项目都在，不留锁', async () => {
  const s = await saveSpace();
  await writeFile(s.file, fmt({ projects: [newProj('original', s.ws)] }));
  const script = `import { saveNew } from ${JSON.stringify(CTL)};
    const r = await saveNew(process.argv[1], JSON.parse(process.argv[2]));
    process.stdout.write(JSON.stringify(r));`;
  const run = (p) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script, s.file, JSON.stringify(p)],
    (e, stdout) => (e ? reject(e) : resolve(JSON.parse(stdout)))));
  const results = await Promise.all([run(newProj('a', s.repo)), run(newProj('b', s.other))]);
  assert.deepEqual(results.map((r) => r.ok), [true, true], JSON.stringify(results));
  assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf8')).projects.map((p) => p.id).sort(), ['a', 'b', 'original']);
  assert.equal(existsSync(`${s.file}.lock`), false);
});

test('withConfigLock：锁被活着的进程占用 → 超时报 config-busy、不执行；持有者已退出 → stale-lock、不删锁、不执行', async () => {
  const s = await saveSpace();
  await writeFile(`${s.file}.lock`, String(process.pid));
  let ran = false;
  const busy = await withConfigLock(s.file, async () => { ran = true; }, { waitMs: 300 });
  assert.deepEqual([busy.ok, busy.reason, ran], [false, 'config-busy', false]);
  const dead = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  await writeFile(`${s.file}.lock`, dead);
  const stale = await withConfigLock(s.file, async () => { ran = true; });
  assert.deepEqual([stale.ok, stale.reason, stale.pid, stale.lock, ran], [false, 'stale-lock', Number(dead), `${s.file}.lock`, false]);
  assert.equal(readFileSync(`${s.file}.lock`, 'utf8'), dead, '陈旧锁原样留着，等用户确认后再删');
});

test('save new：陈旧锁下六个进程同时追加 → 全部 stale-lock，配置一字不动（不会有人删掉别人的活锁后并发写）', async () => {
  const s = await saveSpace();
  const text = fmt({ projects: [newProj('original', s.ws)] });
  await writeFile(s.file, text);
  const dead = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  await writeFile(`${s.file}.lock`, dead);
  const repos = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => gitRepo(path.join(s.dir, `r${i}`))));
  const script = `import { saveNew } from ${JSON.stringify(CTL)};
    process.stdout.write(JSON.stringify(await saveNew(process.argv[1], JSON.parse(process.argv[2]))));`;
  const run = (p) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script, s.file, JSON.stringify(p)],
    (e, stdout) => (e ? reject(e) : resolve(JSON.parse(stdout)))));
  const results = await Promise.all(repos.map((r, i) => run(newProj(`p${i}`, r))));
  assert.deepEqual(results.map((r) => r.reason), Array(6).fill('stale-lock'), JSON.stringify(results));
  assert.equal(readFileSync(s.file, 'utf8'), text);
  assert.equal(readFileSync(`${s.file}.lock`, 'utf8'), dead);
});

test('revert：只撤销正式配置仍是那次写入结果的保存；之后别人又保存过 → config-changed，保留当前配置', async () => {
  const s = await saveSpace();
  await writeFile(s.file, fmt({ projects: [] }));
  const a = await saveNew(s.file, newProj('a', s.repo));
  const b = await saveNew(s.file, newProj('b', s.other));
  assert.match(a.revision, /^[0-9a-f]{16}$/);
  assert.notEqual(a.revision, b.revision);
  const ids = () => JSON.parse(readFileSync(s.file, 'utf8')).projects.map((p) => p.id);
  // A 之后的 up 失败：此时 .bak 是 B 写之前（只含 a）的原文，直接 mv 会丢 b
  const ra = await revert(s.file, a.revision);
  assert.deepEqual([ra.ok, ra.reason], [false, 'config-changed']);
  assert.deepEqual(ids(), ['a', 'b']);
  // B 是最后一次写入：可以撤销，回到 B 写之前
  assert.equal((await revert(s.file, b.revision)).ok, true);
  assert.deepEqual(ids(), ['a']);
  assert.equal(existsSync(`${s.file}.lock`), false);
});

test('revert：配置改回同一内容也不认旧凭据——添加再移除后撤销旧操作、无变化保存后撤销旧操作都拒绝', async () => {
  const s = await saveSpace();
  const ids = () => JSON.parse(readFileSync(s.file, 'utf8')).projects.map((p) => p.id);
  // 添加 a → 添加 b → 移除 b：正式配置回到 [a]、内容与 a 写入后相同，但 .bak 已是 [a,b]
  await writeFile(s.file, fmt({ projects: [] }));
  const a = await saveNew(s.file, newProj('a', s.repo));
  await saveNew(s.file, newProj('b', s.other));
  assert.equal((await removeProject(s.file, 'b')).ok, true);
  const r1 = await revert(s.file, a.revision);
  assert.deepEqual([r1.ok, r1.reason], [false, 'config-changed']);
  assert.deepEqual(ids(), ['a'], '不能把已移除的 b 恢复回来');
  // 无变化保存：内容不变，但 .bak 已被覆盖
  const s2 = await saveSpace();
  await writeFile(s2.file, fmt({ projects: [] }));
  const a2 = await saveNew(s2.file, newProj('a', s2.repo));
  assert.equal((await saveUpdate(s2.file, 'a', {})).ok, true);
  const r2 = await revert(s2.file, a2.revision);
  assert.deepEqual([r2.ok, r2.reason], [false, 'config-changed']);
  assert.deepEqual(JSON.parse(readFileSync(s2.file, 'utf8')).projects.map((p) => p.id), ['a']);
});

test('revert：凭据只能用一次；保存后配置被手改（如 up 换端口）→ config-changed', async () => {
  const s = await saveSpace();
  await writeFile(s.file, fmt({ projects: [] }));
  const a = await saveNew(s.file, newProj('a', s.repo));
  const edited = JSON.parse(readFileSync(s.file, 'utf8'));
  edited.server = { port: 4400 };
  await writeFile(s.file, fmt(edited));
  assert.equal((await revert(s.file, a.revision)).reason, 'config-changed');
  await writeFile(s.file, fmt({ projects: [] }));
  const b = await saveNew(s.file, newProj('b', s.other));
  assert.equal((await revert(s.file, b.revision)).ok, true);
  assert.equal((await revert(s.file, b.revision)).reason, 'config-changed', '用过的凭据作废');
});

// ---- N22 任务 22.4：Linux systemd 用户服务（替身 sh，不碰真 systemctl） ----
import { renderUnit, findUnit, systemdStart, systemdCleanup } from '../ops/devboard-ctl.mjs';

const UNIT_TEMPLATE = fileURLToPath(new URL('../ops/devboard.service.template', import.meta.url));
async function systemdCtx(codes) {
  const dir = await tmpDir();
  await cp(path.join(ROOT, 'ops'), path.join(dir, 'ops'), { recursive: true });
  const fake = fakeSh(codes);
  const ctx = context({ dir, platform: 'linux', unitsDir: path.join(dir, 'systemd-user'), sh: fake });
  return { ctx, fake };
}
async function putUnit(ctx, name, serverEntry = ctx.serverEntry) {
  await mkdir(ctx.unitsDir, { recursive: true });
  const text = renderUnit(await readFile(UNIT_TEMPLATE, 'utf8'), { NODE: '/n', SERVER: serverEntry, DIR: ctx.dir, PATH: '/usr/bin', LOG: '/l' });
  await writeFile(path.join(ctx.unitsDir, name), text);
}

test('renderUnit / findUnit：按字段转义——ExecStart 转义引号 / 反斜杠，入口参数的 $ 写 $$、可执行文件路径的 $ 不动；路径字段只把 % 写 %%、不落在行尾；能原样认回；缺值、换行报错', async () => {
  const tpl = await readFile(UNIT_TEMPLATE, 'utf8');
  // 同一个带引号、反斜杠、%、${UNSET} 的真实目录同时出现在 SERVER、DIR、LOG 里
  const dir = '/home/x/My 100% "dev"\\board ${UNSET}/看板';
  const server = `${dir}/src/server.mjs`;
  const log = `${dir}/cache/devboard.log`;
  const text = renderUnit(tpl, { NODE: '/opt/node$24/bin/node', SERVER: server, DIR: dir, PATH: '/usr/bin:/a "b"', LOG: log });
  // 可执行文件路径在变量展开前就被查找：$ 原样保留；入口参数会展开变量：$ 写成 $$
  assert.match(text, /^ExecStart="\/opt\/node\$24\/bin\/node" "\/home\/x\/My 100%% \\"dev\\"\\\\board \$\$\{UNSET\}\/看板\/src\/server\.mjs"$/m);
  assert.ok(text.includes('\nWorkingDirectory=/home/x/My 100%% "dev"\\board ${UNSET}/看板/.\n'), 'WorkingDirectory 不去转义，只写 %%');
  assert.ok(text.includes('\nStandardError=append:/home/x/My 100%% "dev"\\board ${UNSET}/看板/cache/devboard.log\n'));
  assert.ok(text.includes('\nEnvironment="PATH=/usr/bin:/a \\"b\\""\n'));
  assert.deepEqual(findUnit([{ file: '/u/devboard.service', text }], server), { file: '/u/devboard.service', label: 'devboard.service', errLog: log });
  assert.equal(findUnit([{ file: '/u/devboard.service', text }], '/home/x/My'), null, '只认完整参数');
  // 目录以反斜杠结尾：WorkingDirectory 行不能以反斜杠结尾（否则续行吞掉下一行 Environment）
  const tail = renderUnit(tpl, { NODE: '/n', SERVER: '/home/x/board\\/src/server.mjs', DIR: '/home/x/board\\', PATH: '/usr/bin', LOG: '/l' });
  assert.ok(tail.includes('\nWorkingDirectory=/home/x/board\\/.\nEnvironment="PATH=/usr/bin"\n'));
  assert.ok(!/\\$/m.test(tail), '没有以反斜杠结尾的行');
  assert.throws(() => renderUnit(tpl, { NODE: '/n' }), /缺少值/);
  assert.throws(() => renderUnit(tpl, { NODE: '/n\nExecStartPre=/bin/rm', SERVER: '/s', DIR: '/d', PATH: '/p', LOG: '/l' }), /换行/);
});

test('systemd：本目录的 unit 已 active → restart，不新建；whoManages 认作 systemd', async () => {
  const { ctx, fake } = await systemdCtx();
  await putUnit(ctx, 'my-board.service');
  const r = await systemdStart(ctx);
  assert.deepEqual([r.agent.label, r.created], ['my-board.service', false]);
  assert.ok(fake.calls.includes('systemctl --user restart my-board.service'));
  assert.deepEqual(readdirSync(ctx.unitsDir), ['my-board.service']);
  assert.equal((await whoManages(ctx)).kind, 'systemd');
});

test('systemd：unit 在但没在跑 → enable --now 恢复；whoManages 为 unmanaged', async () => {
  const { ctx, fake } = await systemdCtx({ 'systemctl --user is-active': 3 });
  await putUnit(ctx, 'devboard.service');
  const r = await systemdStart(ctx);
  assert.equal(r.created, false);
  assert.ok(fake.calls.includes('systemctl --user enable --now devboard.service'));
  assert.ok(!fake.calls.some((c) => c.startsWith('systemctl --user restart')));
  assert.equal((await whoManages(ctx)).kind, 'unmanaged');
});

test('systemd：没有本目录的 unit → 按模板新建（别的目录占了 devboard.service 就加哈希后缀）、daemon-reload、enable --now；失败清理只删本次新建的', async () => {
  const { ctx, fake } = await systemdCtx({ 'systemctl --user is-active': 3 });
  await putUnit(ctx, 'devboard.service', '/another/devboard/src/server.mjs');
  const before = readFileSync(path.join(ctx.unitsDir, 'devboard.service'), 'utf8');
  const r = await systemdStart(ctx);
  assert.equal(r.created, true);
  assert.match(r.agent.label, /^devboard-[0-9a-f]{6}\.service$/);
  const text = readFileSync(r.agent.file, 'utf8');
  assert.ok(text.includes(`"${ctx.serverEntry}"`));
  assert.ok(text.includes(`WorkingDirectory=${ctx.dir}`));
  assert.equal(r.agent.errLog, ctx.logFile);
  assert.equal(readFileSync(path.join(ctx.unitsDir, 'devboard.service'), 'utf8'), before, '别的目录的 unit 原样保留');
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('systemctl')).slice(-2), ['systemctl --user daemon-reload', `systemctl --user enable --now ${r.agent.label}`]);

  await systemdCleanup(ctx, r);
  assert.ok(fake.calls.includes(`systemctl --user disable --now ${r.agent.label}`));
  assert.equal(existsSync(r.agent.file), false);
  assert.deepEqual(readdirSync(ctx.unitsDir), ['devboard.service']);
});

test('systemd：新建后 enable 失败（含已建自启链接、启动失败）→ disable --now 并删掉新建的 unit 后抛错；已有 unit 的 cleanup 什么都不删', async () => {
  const { ctx, fake: f1 } = await systemdCtx({ 'systemctl --user is-active': 3, 'systemctl --user enable': 1 });
  await assert.rejects(systemdStart(ctx), /systemctl enable 失败/);
  assert.deepEqual(readdirSync(ctx.unitsDir), []);
  // enable --now 可能已建好自启链接、只是启动失败：删文件前先 disable --now，再 reload
  assert.deepEqual(f1.calls.filter((c) => c.startsWith('systemctl')).slice(-3),
    ['systemctl --user enable --now devboard.service', 'systemctl --user disable --now devboard.service', 'systemctl --user daemon-reload']);

  const { ctx: ctx2, fake } = await systemdCtx();
  await putUnit(ctx2, 'devboard.service');
  const r = await systemdStart(ctx2);
  await systemdCleanup(ctx2, r);
  assert.ok(!fake.calls.some((c) => c.includes('disable')));
  assert.deepEqual(readdirSync(ctx2.unitsDir), ['devboard.service']);
});

test('up（Linux）：systemd 用户实例不可用 → 退回后台进程并在 warnings 说明，不写 unit', async (t) => {
  const port = await freePort();
  const dir = await ctlSpace(t, { server: { host: '127.0.0.1', port }, projects: [] });
  const unitsDir = path.join(dir, 'systemd-user');
  const calls = [];
  const linuxSh = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'systemctl' ? Promise.resolve({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }) : quietSh(cmd, args);
  };
  const r = await upIn(dir, { noLaunchd: false, platform: 'linux', unitsDir, sh: linuxSh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.managedBy, /^background:\d+$/);
  assert.ok(r.warnings.includes('systemd 用户服务不可用，改为后台进程运行'));
  assert.deepEqual(calls.filter((c) => c.startsWith('systemctl')), ['systemctl --user show-environment']);
  assert.equal(existsSync(unitsDir), false);
});
