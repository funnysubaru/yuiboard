import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startDemo } from '../ops/demo.mjs';
import { gitEnv } from '../src/config.mjs';

const NOW = new Date('2026-09-26T08:00:00Z');

// 先注册清理再建临时根目录下的东西：先关服务再删整个根目录（启动失败时没有服务，只删目录）
function cleanup(t, root) {
  const own = {};
  t.after(async () => { await own.s?.close(); await rm(root, { recursive: true, force: true }); });
  return own;
}

// 起 demo 等刷新跑完，返回看板；服务挂到 own.s 上交给 cleanup 关
async function demoBoard(own, dir) {
  const s = own.s = await startDemo({ dir, port: 0, now: () => NOW, log: () => {} });
  // 等启动时排队的文档、会话、GitHub 刷新都跑完
  for (const rt of s.runtimes.values()) {
    await rt.ready;
    while (rt.busy) await rt.lock;
  }
  const res = await fetch(`${s.url}api/projects/demo/board`);
  assert.equal(res.status, 200);
  return res.json();
}

test('npm run demo：虚构项目起来后看板有已合并完成、等待 review、Claude 运行中、超出预计、外部前置、未关联 PR', async (t) => {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'yuiboard-demo-test-')));
  const b = await demoBoard(cleanup(t, dir), dir);
  assert.deepEqual(b.freshness.refreshing, { docs: false, sessions: false, github: false });
  assert.equal(b.freshness.github.error, null);
  assert.equal(b.freshness.github.scopeHint, null, '只读权限范围，不出令牌横幅');
  const task = (key) => b.tasks.find((v) => v.key === key);

  assert.equal(task('sync-engine#1').status, 'done');
  assert.equal(task('sync-engine#1').docOnly, false, '有已合并且已同步的 PR #12');
  assert.equal(task('sync-engine#2.3').status, 'in_review', 'draft PR #22');
  assert.deepEqual(task('sync-engine#2.3').sessions.map((l) => l.activity), ['running']);
  assert.equal(task('web-editor#1.1').status, 'in_progress', '已合并 PR 但文档未勾选');
  assert.equal(task('web-editor#1.2').status, 'awaiting_merge', 'ready PR #23');
  assert.equal(task('web-editor#1.2').gantt.overdue, true);
  assert.match(String(task('sync-engine#6').gantt.unschedulable), /P2/);
  assert.deepEqual(b.waiting.find((w) => w.pr === 24)?.tasks, [], 'PR #24 没关联任务，照样列在「等我处理」');
  assert.ok(b.docs.some((d) => d.docId === 'mobile-app' && d.kind === 'planning'));
});

test('demo：环境里已有 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 时，生成与服务读取都只碰 demo 仓库（PR #33 review）', async (t) => {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'yuiboard-demo-git-')));
  const own = cleanup(t, dir);
  const outside = path.join(dir, 'outside');
  // 准备与核对外部仓库一律用去掉 GIT_* 的环境，不受跑测试的终端影响
  const g = (...args) => execFileSync('git', ['-C', outside, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { env: gitEnv() }).toString();
  execFileSync('git', ['init', '-q', '-b', 'main', outside], { env: gitEnv() });
  writeFileSync(path.join(outside, 'seed.txt'), 'seed\n');
  g('add', '-A'); g('commit', '-q', '-m', 'seed');
  writeFileSync(path.join(outside, 'private-draft.txt'), 'draft\n');
  const state = () => [g('rev-parse', 'HEAD'), g('status', '--porcelain'), g('ls-files', '--stage')];
  const before = state();

  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const saved = keys.map((k) => process.env[k]);
  t.after(() => keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));
  Object.assign(process.env, { GIT_DIR: path.join(outside, '.git'), GIT_WORK_TREE: outside, GIT_INDEX_FILE: path.join(outside, '.git', 'index') });
  const b = await demoBoard(own, path.join(dir, 'demo'));

  const task = b.tasks.find((v) => v.key === 'sync-engine#1');
  assert.deepEqual([task.status, task.docOnly, task.syncPending, task.syncUnchecked], ['done', false, null, false], '读的是 demo 仓库：PR #12 的合并提交在本地');
  assert.equal(b.tasks.find((v) => v.key === 'sync-engine#2.3').status, 'in_review');
  assert.deepEqual(state(), before, '外部仓库 HEAD、工作区与索引不变');
});
