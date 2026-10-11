import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rename, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

// 每个用例一个临时空间；realpath 避免 macOS /var → /private/var 让路径比较失真。
async function tmpSpace() {
  return realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-config-')));
}
async function gitRepo(dir) {
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function project(id, repoPath, extra = {}) {
  return { id, repo: { path: repoPath, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }], ...extra };
}
async function writeConfig(dir, config) {
  const file = path.join(dir, 'devboard.config.json');
  await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}

test('JSON 语法错：只返回全局错误并带行列，不抛异常', async () => {
  const dir = await tmpSpace();
  const cfg = await loadConfig(await writeConfig(dir, '{\n  "projects": [\n  x\n]}'));
  assert.equal(cfg.projects.length, 0);
  assert.equal(cfg.errors.length, 1);
  assert.equal(cfg.errors[0].projectId, null);
  assert.match(cfg.errors[0].message, /第 3 行/);
  assert.deepEqual(cfg.server, { host: '127.0.0.1', port: 4317 }, '语法错时仍给出默认监听，服务照常起');
});

test('配置文件不存在：全局错误', async () => {
  const dir = await tmpSpace();
  const cfg = await loadConfig(path.join(dir, 'nope.json'));
  assert.equal(cfg.errors[0].projectId, null);
  assert.match(cfg.errors[0].message, /找不到配置文件/);
});

test('缺必填字段：逐项指出是哪个项目的哪一项', async () => {
  const dir = await tmpSpace();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const cfg = await loadConfig(await writeConfig(dir, {
    projects: [{ id: 'p1', repo: { path: repo } }, { repo: { path: repo, github: 'a/b' }, branchLines: [{ id: 'x', base: 'main' }] }],
  }));
  const fields = cfg.errors.map((e) => `${e.projectId}:${e.field}`);
  assert.deepEqual(fields.sort(), ['p1:branchLines', 'projects[1]:id'].sort());
  assert.match(cfg.errors.find((e) => e.field === 'branchLines').message, /项目 p1 的 branchLines 项/);
  assert.equal(cfg.projects.length, 2, '出错的项目保留在列表里，由上层停用而不是悄悄消失');
});

test('路径不存在 / 非 git 目录：只记该项目错误', async () => {
  const dir = await tmpSpace();
  await mkdir(path.join(dir, 'plain'));
  const cfg = await loadConfig(await writeConfig(dir, {
    projects: [project('gone', 'missing'), project('plain', 'plain')],
  }));
  const byId = Object.fromEntries(cfg.errors.map((e) => [e.projectId, e]));
  assert.equal(byId.gone.field, 'repo.path');
  assert.match(byId.gone.message, /路径不存在/);
  assert.equal(byId.plain.field, 'repo.path');
  assert.match(byId.plain.message, /不是 git 仓库/);
});

test('两个项目一坏一好互不影响', async () => {
  const dir = await tmpSpace();
  await gitRepo(path.join(dir, 'good'));
  const cfg = await loadConfig(await writeConfig(dir, { projects: [project('bad', 'missing'), project('good', 'good')] }));
  assert.deepEqual(cfg.errors.map((e) => e.projectId), ['bad']);
  const good = cfg.projects.find((p) => p.id === 'good');
  assert.equal(good.repo.path, path.join(dir, 'good'));
  assert.equal(good.name, 'good', '未写 name 时用 id 显示');
});

test('~/ 展开到用户主目录，分支线工作区与会话目录同样解析', async () => {
  const home = await tmpSpace();
  await gitRepo(path.join(home, 'code', '仓库'));
  await gitRepo(path.join(home, 'wt'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home; // os.homedir() 读这两个变量
  try {
    const cfg = await loadConfig(await writeConfig(home, {
      projects: [project('p', '~/code/仓库', {
        branchLines: [{ id: 'b', name: 'b', base: 'main', workspace: '~/wt' }],
        sessions: [{ source: 'claude-code', dir: '~/.claude/projects', extraCwds: ['~/code'] }],
      })],
    }));
    assert.deepEqual(cfg.errors, []);
    const p = cfg.projects[0];
    assert.equal(p.repo.path, path.join(home, 'code', '仓库'));
    assert.equal(p.branchLines[0].workspace, path.join(home, 'wt'));
    assert.equal(p.sessions[0].dir, path.join(home, '.claude', 'projects'));
    assert.deepEqual(p.sessions[0].extraCwds, [path.join(home, 'code')]);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test('NFD 写法的中文路径规范化为 NFC', async () => {
  const dir = await tmpSpace();
  const name = 'プロジェクト'; // 含浊音，NFC / NFD 字节不同
  await gitRepo(path.join(dir, name));
  const cfg = await loadConfig(await writeConfig(dir, { projects: [project('p', name.normalize('NFD'))] }));
  assert.deepEqual(cfg.errors, []);
  assert.equal(cfg.projects[0].repo.path, path.join(dir, name).normalize('NFC'));
});

test('非回环 host 与过小的 GitHub 刷新间隔给出警告，间隔按 2 分钟执行', async () => {
  const dir = await tmpSpace();
  const cfg = await loadConfig(await writeConfig(dir, {
    server: { host: '0.0.0.0', port: 5000 }, defaults: { githubRefreshMinutes: 1 }, projects: [],
  }));
  assert.equal(cfg.warnings.length, 2);
  assert.match(cfg.warnings[0], /0\.0\.0\.0/);
  assert.equal(cfg.defaults.githubRefreshMinutes, 2);
  assert.equal(cfg.defaults.hoursPerDay, 8, '未写的默认值保留');
  assert.equal(cfg.server.port, 5000);

  const ok = await loadConfig(await writeConfig(dir, { server: { host: 'localhost' }, projects: [] }));
  assert.deepEqual(ok.warnings, []);
});

test('无效正则只记该项目错误', async () => {
  const dir = await tmpSpace();
  await gitRepo(path.join(dir, 'repo'));
  const cfg = await loadConfig(await writeConfig(dir, { projects: [project('p', 'repo', { milestoneCodePattern: '(' })] }));
  assert.deepEqual(cfg.errors.map((e) => e.field), ['milestoneCodePattern']);
});

test('整个空间移动到别处后，不改代码与配置仍能加载', async () => {
  const outer = await tmpSpace();
  const space = path.join(outer, 'devboard');
  // 复制真实的 config.mjs 进临时空间，验证空间根确实取自模块位置而不是 cwd 或写死路径。
  await mkdir(path.join(space, 'src'), { recursive: true });
  for (const f of ['config.mjs', 'msg.mjs']) await copyFile(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), path.join(space, 'src', f));
  await gitRepo(path.join(space, 'repo'));
  await writeConfig(space, { projects: [project('p', 'repo')] });

  const load = async (root) => (await import(pathToFileURL(path.join(root, 'src', 'config.mjs')).href)).loadConfig();
  const before = await load(space);
  assert.deepEqual(before.errors, []);
  assert.equal(before.projects[0].repo.path, path.join(space, 'repo'));

  const moved = path.join(outer, '搬走后', 'devboard');
  await mkdir(path.dirname(moved));
  await rename(space, moved);
  const after = await load(moved);
  assert.deepEqual(after.errors, []);
  assert.equal(after.projects[0].repo.path, path.join(moved, 'repo'));
  await rm(outer, { recursive: true, force: true });
});

test('项目 id 只允许安全字符（会拼进 cache/<id>、data/<id>），越界写法记为该项目错误', async () => {
  const dir = await tmpSpace();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const cfg = await loadConfig(await writeConfig(dir, { projects: [project('../evil', repo), project('ok_1-a', repo)] }));
  assert.deepEqual(cfg.errors.filter((e) => e.field === 'id').map((e) => e.projectId), ['../evil']);
});

test('N11 repo.github 可选：不写合法；写了但不是 owner/name 报错', async () => {
  const dir = await tmpSpace();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const noGithub = project('p1', repo, { repo: { path: repo } });
  let cfg = await loadConfig(await writeConfig(dir, { projects: [noGithub] }));
  assert.deepEqual(cfg.errors, []);
  for (const bad of ['foo', 'a/b/c', '', 'https://github.com/a/b']) {
    cfg = await loadConfig(await writeConfig(dir, { projects: [project('p1', repo, { repo: { path: repo, github: bad } })] }));
    assert.deepEqual(cfg.errors.map((e) => e.field), ['repo.github'], JSON.stringify(bad));
    assert.match(cfg.errors[0].message, /owner\/name/);
  }
});

test('N17 docRef 分支线：ref / docFiles / docFilter 校验，别的分支线 docFilter 认到本线前缀要报', async () => {
  const dir = await tmpSpace();
  const repo = await gitRepo(path.join(dir, 'repo'));
  const lines = (next, personal = '^(?!next:)') => [{ id: 'personal', name: '个人版', base: 'main', docFilter: personal },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'origin/next/x', docFiles: ['docs/adr/ADR-0042-x.md'], docFilter: '^next:', ...next }];
  const errs = async (next, personal) => (await loadConfig(await writeConfig(dir, { projects: [project('p', repo, { branchLines: lines(next, personal) })] })))
    .errors.map((e) => e.message);

  assert.deepEqual(await errs({}), [], '合法配置');
  assert.match((await errs({ docRef: '--upload-pack=x' }))[0], /branchLines\[1\]\.docRef 项：应为分支或 ref 名/);
  assert.match((await errs({ workspace: repo }))[0], /docRef 项：与 workspace 只能二选一/);
  assert.match((await errs({ docFiles: ['../etc/passwd'] }))[0], /docFiles 项/);
  assert.match((await errs({ docFiles: [] }))[0], /docFiles 项/);
  assert.match((await errs({ docFilter: '^collab-' }))[0], /docFilter 项：配了 docRef 时必须认到本线文档（以「next:」开头）/);
  assert.match((await errs({}, '^(?!collab-)'))[0], /branchLines\[0\]\.docFilter 项：也会认到分支线 next 的文档/);
  assert.match((await errs({}, 'ADR-0042'))[0], /branchLines\[0\]\.docFilter 项：也会认到分支线 next 的文档/, '只认到真实文档名、认不到 next:x 的也要拦');
  assert.match((await errs({ docRef: 'main..next/x' }))[0], /docRef 项/);
  assert.match((await errs({ docFiles: ['a:b.md'] }))[0], /docFiles 项/);
});
