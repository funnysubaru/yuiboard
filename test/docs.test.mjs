import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTasksDoc, parseEstimate, compareTaskNumbers } from '../src/docs.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.tasks.md`, import.meta.url), 'utf8');
const parse = (name, opts) => parseTasksDoc(fixture(name), name, opts);
const byNum = (doc) => Object.fromEntries(doc.tasks.map((t) => [t.key.split('#')[1], t]));

// ---- 实物：collab-m0-space-run（虚构项目夹具） ----

test('实物 collab-m0-space-run：整份识别、无疑似行、代码围栏里的 Mermaid 不当任务', () => {
  const doc = parse('collab-m0-space-run');
  assert.equal(doc.parse.state, 'ok');
  assert.deepEqual(doc.parse.unrecognizedLines, []);
  assert.equal(doc.title, 'Implementation Plan — collab-m0-space-run');
  assert.equal(doc.tasks.length, 64);
  assert.ok(doc.tasks.every((t) => t.line < 658), '「## 任务依赖图」之后（Mermaid 围栏内）不出任务');
  assert.ok(doc.tasks.every((t) => !t.duplicate && !t.void));
});

test('实物：尾点编号、父子、2.5b、2.10', () => {
  const t = byNum(parse('collab-m0-space-run'));
  assert.equal(t['1'].label, '1.');
  assert.equal(t['1'].parentKey, null);
  assert.equal(t['1.1'].parentKey, 'collab-m0-space-run#1');
  assert.equal(t['2.5b'].parentKey, 'collab-m0-space-run#2');
  assert.equal(t['2.10'].parentKey, 'collab-m0-space-run#2');
  assert.equal(t['2.5b'].title.startsWith('Edge Function'), true);
});

test('实物：里程碑代号、无代号分组、复选框', () => {
  const doc = parse('collab-m0-space-run');
  assert.deepEqual(doc.groups.map((g) => g.code), ['M0-a', 'M0-b', 'M0-c', 'M0-d', null, 'M0-e', 'M0-f']);
  const extra = doc.groups[4];
  assert.match(extra.title, /^追加：2\.0\.6 UI 改进轮/);
  assert.equal(extra.alias, null);
  const t = byNum(doc);
  assert.equal(t['18.3'].groupId, extra.id);
  assert.equal(t['2.5b'].groupId, doc.groups[1].id);
  const open = doc.tasks.filter((x) => x.checkbox === 'open').map((x) => x.number);
  assert.deepEqual(open, ['13', '14', '15', '15.1', '16', '17']);
  assert.equal(t['15.2'].checkbox, 'done');
});

test('实物：局部删除线（1.2、2.5）不算作废', () => {
  const t = byNum(parse('collab-m0-space-run'));
  assert.match(t['1.2'].title, /~~\+ S1\(c\).*~~ 不再需要/);
  assert.equal(t['1.2'].void, false);
  assert.equal(t['2.5'].void, false);
});

test('实物：预计耗时与正文行号区间', () => {
  const doc = parse('collab-m0-space-run');
  const t = byNum(doc);
  assert.equal(t['1.1'].estimateHours, 8, '「1 天（design §12）」去括号附注');
  assert.equal(t['1.2'].estimateHours, 4);
  assert.equal(t['1.4'].estimateHours, 4);
  assert.equal(t['1.5'].estimateHours, 2);
  assert.equal(t['1.7'].estimateHours, 3);
  assert.equal(t['1.8'].estimateHours, 1.58, '「1 小时人工 + 35 分钟等待」');
  assert.deepEqual(t['1.8'].estimateSource, { file: 'collab-m0-space-run', line: 124, text: '- **预计耗时**：1 小时人工 + 35 分钟等待' });
  assert.equal(t['2.1'].estimateHours, null, '没写就是 null，由甘特用默认工期');
  assert.deepEqual(doc.parse.unknownEstimates, []);
  assert.deepEqual(t['1'].bodyRange, [36, 36], '没有正文的父任务只含任务行本身');
  assert.deepEqual(t['1.1'].bodyRange, [37, 45], '尾部空行不算');
  assert.deepEqual(t['12.2'].bodyRange[1], 525, '到下一个分组标题前为止');
  assert.deepEqual(t['15.2'].bodyRange, [632, 643], '任务后的引用块进度备注算正文');
  assert.deepEqual(t['17'].bodyRange, [650, 654], '分隔线与「## 任务依赖图」不算正文');
});

// ---- 合成夹具：行内任务的各种写法 ----

test('合成：编号形式（0.1、T 前缀、Task 前缀、加粗、尾点、4a.1）', () => {
  const t = byNum(parse('synthetic-inline'));
  assert.equal(t['0.1'].title, '初始化仓库');
  assert.equal(t['20'].label, 'T20');
  assert.equal(t['1.3'].label, 'Task 1.3');
  assert.equal(t['1.3'].title, '带 Task 前缀');
  assert.equal(t['1.1'].title, '加粗编号的子任务（依赖 0.1, T20）', '加粗的闭合标记被去掉');
  assert.equal(t['1'].label, '1.');
  assert.equal(t['4a.1'].parentKey, 'synthetic-inline#4a');
  assert.equal(t['4a'].parentKey, null, '4a 只有一段，是顶层');
  assert.equal(t['2.5b'].parentKey, 'synthetic-inline#2');
});

test('编号排序：分段先比数值再比字母，段少在前；任务数组保持文档顺序', () => {
  const nums = ['2.10', '2.5b', '2', '2.9', '2.5', '2.6', '10', '1', '4a.1', '4a', '4', '0.1'];
  assert.deepEqual([...nums].sort(compareTaskNumbers), ['0.1', '1', '2', '2.5', '2.5b', '2.6', '2.9', '2.10', '4', '4a', '4a.1', '10']);
  const inDoc = parse('synthetic-inline').tasks.map((x) => x.number);
  assert.deepEqual(inDoc.slice(7, 10), ['2.10', '2.5b', '2.5'], '文档里怎么写就怎么排');
});

test('复选框三态与异常字符', () => {
  const doc = parse('synthetic-inline');
  const t = byNum(doc);
  assert.equal(t['1'].checkbox, 'open');
  assert.equal(t['1.1'].checkbox, 'done');
  assert.equal(t['1.2'].checkbox, 'doing');
  assert.equal(t['6'].checkbox, 'open', '[-] 按未勾处理');
  assert.equal(doc.parse.diagnostics.length, 1);
  assert.equal(doc.parse.diagnostics[0].source.line, t['6'].line);
  assert.match(doc.parse.diagnostics[0].message, /\[-\]/);
});

test('分组：阶段 / Phase / PR 别名，里程碑代号优先，更深的小标题不是分组', () => {
  const doc = parse('synthetic-inline');
  assert.deepEqual(doc.groups.map((g) => [g.code, g.alias]), [
    [null, '阶段 0'], [null, 'Phase 1'], ['M9', null], [null, null], [null, 'PR 2'],
  ]);
  const t = byNum(doc);
  assert.equal(t['2.5'].groupId, doc.groups[2].id);
  assert.equal(t['2.6'].groupId, doc.groups[3].id, '#### 标题也是分组');
  const body = fixture('synthetic-inline').split('\n').slice(t['2.5'].bodyRange[0] - 1, t['2.5'].bodyRange[1]);
  assert.ok(body.some((l) => l.startsWith('##### 实现细节')), '##### 小标题留在 2.5 的正文里');
});

test('作废：整体删除线 + 【作废】、（作废）；局部删除线、删除线后还有说明都不算', () => {
  const t = byNum(parse('synthetic-inline'));
  assert.equal(t['2.6'].void, true);
  assert.equal(t['2.6'].title, '整体删除线的作废任务 **【作废 2026-06-24】** 需求取消');
  assert.equal(t['2.7'].void, true);
  assert.equal(t['2.8'].void, false);
  assert.equal(t['2.9'].void, false);
});

test('重复编号：两条都保留，第二条键加 ~2，都标 duplicate', () => {
  const doc = parse('synthetic-inline');
  const threes = doc.tasks.filter((x) => x.number === '3');
  assert.deepEqual(threes.map((x) => x.key), ['synthetic-inline#3', 'synthetic-inline#3~2']);
  assert.ok(threes.every((x) => x.duplicate));
  assert.equal(doc.tasks.filter((x) => x.duplicate).length, 2);
});

test('疑似任务行 → partial 并列行号；无编号复选框只计数；围栏内不认任务', () => {
  const doc = parse('synthetic-inline');
  const lines = fixture('synthetic-inline').split('\n');
  assert.equal(doc.parse.state, 'partial');
  assert.equal(doc.parse.unrecognizedLines.length, 1);
  assert.equal(lines[doc.parse.unrecognizedLines[0] - 1], '- [ ] 5.写法有误的疑似任务行');
  assert.match(doc.parse.reason, new RegExp(`第 ${doc.parse.unrecognizedLines[0]} 行`));
  assert.equal(doc.parse.uncheckedBoxes, 2, '「验收：…」「**Step 1**」');
  assert.ok(!doc.tasks.some((x) => x.number === '99'));
  assert.equal(byNum(doc)['8'].title.startsWith('围栏之后的任务'), true, '围栏正确闭合');
});

test('预计耗时：各种写法换算，识别不出记诊断', () => {
  const doc = parse('synthetic-inline');
  const t = byNum(doc);
  assert.equal(t['0.1'].estimateHours, 2);
  assert.equal(t['20'].estimateHours, 0.5);
  assert.equal(t['1.2'].estimateHours, 4);
  assert.equal(t['1.3'].estimateHours, 24, '「2–3 天（含评审）」取上限；没加粗也认');
  assert.equal(t['2'].estimateHours, 16, '「两天」');
  assert.equal(t['2.5'].estimateHours, null);
  assert.equal(t['2.5'].estimateSource.line, doc.parse.unknownEstimates[0].line);
  assert.deepEqual(doc.parse.unknownEstimates.map((r) => r.text), ['- **预计耗时**：看情况再说']);
  assert.equal(parse('synthetic-inline', { hoursPerDay: 6 }).tasks.find((x) => x.number === '2').estimateHours, 12);
});

test('parseEstimate：需求 15.5 的四种写法与边界', () => {
  assert.equal(parseEstimate('1 天'), 8);
  assert.equal(parseEstimate('半天'), 4);
  assert.equal(parseEstimate('2 小时'), 2);
  assert.equal(parseEstimate('1 小时人工 + 35 分钟等待'), 1.58);
  assert.equal(parseEstimate('1 天（design §12）'), 8);
  assert.equal(parseEstimate('2-3 工作日'), 24);
  assert.equal(parseEstimate('90 min'), 1.5);
  assert.equal(parseEstimate('3h'), 3);
  assert.equal(parseEstimate('1 天', 6), 6);
  assert.equal(parseEstimate('看情况'), null);
  assert.equal(parseEstimate('（约 2 小时）'), null, '只写在括号附注里的不算');
});

// ---- 合成夹具：标题式任务兜底 ----

test('parseEstimate：英文 / 日文单位（day / d / working days / hours / hr / h / minutes / min，日 / 営業日 / 時間 / 分）', () => {
  assert.equal(parseEstimate('1 day'), 8);
  assert.equal(parseEstimate('2-3 days'), 24);
  assert.equal(parseEstimate('2 working days'), 16);
  assert.equal(parseEstimate('1.5d'), 12);
  assert.equal(parseEstimate('2 hours'), 2);
  assert.equal(parseEstimate('1 hr + 30 minutes'), 1.5);
  assert.equal(parseEstimate('45 mins'), 0.75);
  assert.equal(parseEstimate('1 日'), 8);
  assert.equal(parseEstimate('2〜3 営業日'), 24);
  assert.equal(parseEstimate('半日'), 4);
  assert.equal(parseEstimate('1 時間 30 分'), 1.5);
  assert.equal(parseEstimate('1 dev'), null, '单位后面紧跟字母不算');
  assert.equal(parseEstimate('it depends'), null);
});

test('英文 / 日文：Estimate / 見積もり 行、[void] / (obsolete) / 【廃止】、Milestone / マイルストーン 代号、Phase / Stage / フェーズ 别名、タスク 前缀', () => {
  const doc = parseTasksDoc('# Plan\n## Milestone M1: base\n- [ ] 1 one\n  - **Estimate**: 2 days\n- [ ] 2 two\n  - Estimated time: 3h\n'
    + '- [ ] 3 three [void] replaced by 4\n- [ ] 4 four (obsolete 2026-09-01)\n- [ ] 5 five, 3 days later we review\n  - Re-estimate: soon\n'
    + '## マイルストーン M2：機能\n- [ ] タスク 6 ろく\n  - 見積もり：1 日\n- [ ] 7 なな【廃止 2026-09-01】\n  - **所要時間**：2 時間\n'
    + '## Stage 3\n- [ ] 8 eight\n## フェーズ 4\n- [ ] 9 きゅう\n', 'd');
  const t = byNum(doc);
  assert.deepEqual([1, 2, 5, 6, 7].map((n) => t[n].estimateHours), [16, 3, null, 8, 2], '叙述里的「3 days later」与 Re-estimate 都不是耗时行');
  assert.deepEqual(doc.parse.unknownEstimates, []);
  assert.deepEqual([3, 4, 5, 7].map((n) => t[n].void), [true, true, false, true]);
  assert.deepEqual(doc.groups.map((g) => [g.code, g.alias]), [['M1', null], ['M2', null], [null, 'Stage 3'], [null, 'フェーズ 4']]);
  assert.equal(t['6'].label, 'タスク 6');
});

test('标题式任务：「### タスク 1：…」与 Task 同样兜底', () => {
  const doc = parseTasksDoc('# 計画\n### タスク 1：準備\n- [x] 手順一\n### タスク 2：実装\n- [ ] 手順一\n', 'd');
  assert.deepEqual(doc.tasks.map((x) => [x.number, x.title, x.checkbox]), [['1', '準備', 'done'], ['2', '実装', 'open']]);
});

test('标题式任务：只在没有任务行时启用；✅ 或步骤全勾即已勾', () => {
  const doc = parse('synthetic-headings');
  assert.equal(doc.parse.state, 'ok');
  assert.deepEqual(doc.tasks.map((x) => [x.number, x.label, x.checkbox]), [
    ['1.1', 'Task 1.1', 'done'], ['2', 'T2', 'done'], ['2.1', 'Task 2.1', 'open'], ['3', 'Task 3', 'open'],
  ]);
  const t = byNum(doc);
  assert.equal(t['1.1'].title, '建表');
  assert.equal(t['2.1'].parentKey, 'synthetic-headings#2');
  assert.equal(t['2.1'].estimateHours, 3, '#### 小标题下的内容仍属 2.1');
  assert.equal(t['1.1'].estimateHours, 8);
  assert.deepEqual(doc.groups.map((g) => g.alias), ['Phase 1', 'Phase 2'], '「## 0. 需要 owner…」不是任务也不是空分组');
  assert.equal(t['2.1'].groupId, doc.groups[0].id);
});

test('有任务行时标题式写法不启用', () => {
  const doc = parseTasksDoc('## 阶段 1\n### Task 9：标题式\n- [ ] 1 行内任务\n', 'mix');
  assert.deepEqual(doc.tasks.map((x) => x.number), ['1']);
});

// ---- 文本层面的边界 ----

test('去 BOM、CRLF 切行', () => {
  const doc = parseTasksDoc('﻿# 标题\r\n\r\n## 里程碑 M1：一\r\n- [x] 1 第一\r\n  - **预计耗时**：半天\r\n', 'crlf');
  assert.equal(doc.title, '标题');
  assert.equal(doc.groups[0].code, 'M1');
  assert.deepEqual(doc.tasks.map((x) => [x.number, x.title, x.checkbox, x.estimateHours]), [['1', '第一', 'done', 4]]);
});

test('no-tasks：给原因而不是「0 个任务」', () => {
  const doc = parseTasksDoc('# 清单\n\n- [ ] 写代码\n- [x] 写测试\n- [ ] 3)括号编号\n', 'empty');
  assert.equal(doc.parse.state, 'no-tasks');
  assert.equal(doc.tasks.length, 0);
  assert.match(doc.parse.reason, /共 2 个无编号复选框/);
  assert.match(doc.parse.reason, /第 5 行像任务行但格式不对/);
});

test('里程碑代号正则可配置', () => {
  const doc = parseTasksDoc('## Sprint S3 收尾\n- [ ] 1 任务\n', 'cfg', { milestoneCodePattern: 'Sprint\\s*([A-Z]\\d+)' });
  assert.equal(doc.groups[0].code, 'S3');
});

test('固定输入结果可重复', () => {
  assert.deepEqual(parse('collab-m0-space-run'), parse('collab-m0-space-run'));
});

// ---- 任务 1.3：文档发现与工作区只读 git ----
// import 放在本段开头（ES 模块里会被提升），与并行开发的其它任务改文件头时互不冲突。
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadProjectDocs, readWorkspaceHead, gitRead } from '../src/docs.mjs';

const TASKS = '# 计划\n\n## 里程碑 M1：起步\n\n- [x] 1 第一件\n- [ ] 2 第二件\n';
// realpath：避免 macOS /var → /private/var 让路径比较失真。
const tmpDir = async (name = 'devboard-docs-') => realpathSync(await mkdtemp(path.join(os.tmpdir(), name)));
async function put(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    if (content === null) await mkdir(abs, { recursive: true }); // null = 建成目录
    else await writeFile(abs, content);
  }
  return root;
}
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
async function commitAll(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const specProject = (repoPath, extra = {}) => ({
  id: 'p', repo: { path: repoPath, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }],
  docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }], ...extra,
});
const docMap = (r) => Object.fromEntries(r.docs.map((d) => [d.docId, d]));

test('spec-dir 发现：有 tasks.md 解析，只有其它 .md 记规划中，无 .md 的目录与散文件不算', async () => {
  const repo = await put(await tmpDir(), {
    '.claude/specs/beta/tasks.md': TASKS,
    '.claude/specs/beta/design.md': '# d',
    '.claude/specs/alpha/requirements.md': '# r',
    '.claude/specs/empty/notes.txt': 'x',
    '.claude/specs/README.md': '# 不是 spec',
  });
  const r = await loadProjectDocs(specProject(repo));
  assert.deepEqual(r.docs.map((d) => d.docId), ['alpha', 'beta'], '按 docId 排序，结果稳定');
  const { alpha, beta } = docMap(r);
  assert.equal(beta.kind, 'tasks');
  assert.equal(beta.parse.state, 'ok');
  assert.equal(beta.tasks.length, 2);
  assert.equal(beta.tasks[0].key, 'beta#1');
  assert.equal(beta.path, '.claude/specs/beta/tasks.md');
  assert.equal(beta.sourceType, 'spec-dir');
  assert.equal(beta.sourceLabel, 'spec');
  assert.equal(beta.workspaceId, 'repo');
  assert.equal(beta.archived, false);
  assert.equal(alpha.kind, 'planning');
  assert.equal(alpha.parse.state, 'planning');
  assert.match(alpha.parse.reason, /规划中（暂无任务）/);
  assert.deepEqual(alpha.tasks, []);
});

test('task-list 来源：docId 为相对路径去扩展名；文件不存在只把该文档标 error', async () => {
  const repo = await put(await tmpDir(), { 'plans/roadmap.md': TASKS });
  const r = await loadProjectDocs(specProject(repo, {
    docSources: [{ type: 'task-list', label: '任务清单', files: ['plans/roadmap.md', 'plans/missing.md'] }],
  }));
  const d = docMap(r);
  assert.equal(d['plans/roadmap'].tasks.length, 2);
  assert.equal(d['plans/roadmap'].tasks[1].key, 'plans/roadmap#2');
  assert.equal(d['plans/missing'].parse.state, 'error');
  assert.match(d['plans/missing'].parse.reason, /读取或解析失败/);
});

test('单文档抛错（tasks.md 是目录）不影响其它文档；来源目录不存在记诊断', async () => {
  const repo = await put(await tmpDir(), {
    '.claude/specs/bad/tasks.md': null,
    '.claude/specs/good/tasks.md': TASKS,
  });
  const r = await loadProjectDocs(specProject(repo, {
    docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' }, { type: 'spec-dir', label: '另一处', path: 'nope' }],
  }));
  const { bad, good } = docMap(r);
  assert.equal(bad.parse.state, 'error');
  assert.deepEqual(bad.tasks, []);
  assert.equal(good.parse.state, 'ok');
  assert.equal(good.tasks.length, 2);
  assert.equal(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0].message, /另一处.*目录不存在 nope/);
});

test('archived 照读并标记，excluded 不读；docId 通配', async () => {
  const repo = await put(await tmpDir(), {
    '.claude/specs/old-a/tasks.md': TASKS,
    '.claude/specs/old-b/tasks.md': TASKS,
    '.claude/specs/tmp-x/tasks.md': TASKS,
    '.claude/specs/live/tasks.md': TASKS,
  });
  const r = await loadProjectDocs(specProject(repo, { archived: ['old-*'], excluded: ['tmp-?'] }));
  const d = docMap(r);
  assert.deepEqual(Object.keys(d).sort(), ['live', 'old-a', 'old-b']);
  assert.equal(d['old-a'].archived, true);
  assert.equal(d['old-a'].tasks.length, 2, '归档文档照样解析，只是默认隐藏');
  assert.equal(d.live.archived, false);
});

test('中文路径：仓库、来源目录、spec 名都是中文，git 与文件读取正常，docId / path 为 NFC', async () => {
  const outer = await tmpDir('devboard-中文-');
  const repo = await put(path.join(outer, '仓库'), {
    '产品文档/规划/协作版-空间/tasks.md': TASKS,
    // 用 NFD 写目录名，模拟 macOS 上从别处拷来的文件名
    ['产品文档/规划/' + 'café'.normalize('NFD') + '/requirements.md']: '# r',
  });
  await commitAll(repo);
  const r = await loadProjectDocs(specProject(repo, { docSources: [{ type: 'spec-dir', label: '规划', path: '产品文档/规划' }] }));
  const d = docMap(r);
  assert.equal(d['协作版-空间'].path, '产品文档/规划/协作版-空间/tasks.md');
  assert.equal(d['协作版-空间'].tasks.length, 2);
  assert.equal(d['café'.normalize('NFC')].kind, 'planning');
  assert.equal(r.workspaces[0].branch, 'main');
  assert.match(r.workspaces[0].commit, /^[0-9a-f]{40}$/);
});

test('工作区：分支名与提交号；分离 HEAD 照常读，未提交改动如实读到', async () => {
  const repo = await put(await tmpDir(), { '.claude/specs/s/tasks.md': TASKS });
  await commitAll(repo);
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await readWorkspaceHead(repo), { branch: 'main', commit: head, detached: false, error: null });

  git(repo, 'checkout', '-q', '--detach');
  await writeFile(path.join(repo, '.claude/specs/s/tasks.md'), TASKS + '- [ ] 3 未提交的新任务\n');
  const before = git(repo, 'status', '--porcelain');
  const r = await loadProjectDocs(specProject(repo));
  assert.deepEqual(r.workspaces, [{ id: 'repo', path: repo, branch: null, commit: head, detached: true, error: null }]);
  assert.equal(r.docs[0].tasks.length, 3, '读当前工作树文件，不读提交里的版本');
  assert.equal(git(repo, 'status', '--porcelain'), before, '只读：工作树状态不变');
});

test('git 失败（非 git 目录）：分支与提交为 null 并带原因，文档照读', async () => {
  const dir = await put(await tmpDir(), { '.claude/specs/s/tasks.md': TASKS });
  const r = await loadProjectDocs(specProject(dir));
  const ws = r.workspaces[0];
  assert.equal(ws.branch, null);
  assert.equal(ws.commit, null);
  assert.equal(ws.detached, false);
  assert.ok(ws.error);
  assert.equal(r.docs[0].tasks.length, 2);
});

test('分支线自带工作区：docFilter 命中的文档只从该工作区读，其余从主工作区读', async () => {
  const main = await put(await tmpDir(), {
    '.claude/specs/collab-x/tasks.md': '- [ ] 1 主工作区里的旧版\n',
    '.claude/specs/personal/tasks.md': TASKS,
  });
  const wt = await put(await tmpDir(), {
    '.claude/specs/collab-x/tasks.md': TASKS,
    '.claude/specs/collab-y/requirements.md': '# 只在协作工作区',
    '.claude/specs/personal/tasks.md': '- [ ] 9 另一工作区里的副本\n',
  });
  await commitAll(main);
  await commitAll(wt);
  git(wt, 'checkout', '-q', '-b', 'v2/collab');
  const r = await loadProjectDocs(specProject(main, {
    branchLines: [
      { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
      { id: 'collab', name: '协作版', base: 'v2/collab', docFilter: '^collab-', workspace: wt },
    ],
  }));
  assert.deepEqual(r.workspaces.map((w) => [w.id, w.path, w.branch]), [['repo', main, 'main'], ['collab', wt, 'v2/collab']]);
  const d = docMap(r);
  assert.deepEqual(Object.keys(d).sort(), ['collab-x', 'collab-y', 'personal'], '同一 docId 只出现一次');
  assert.equal(d['collab-x'].workspaceId, 'collab');
  assert.equal(d['collab-x'].tasks.length, 2);
  assert.equal(d['collab-x'].tasks[0].key, 'collab-x#1', '任务键不带工作区');
  assert.equal(d['collab-y'].workspaceId, 'collab');
  assert.equal(d.personal.workspaceId, 'repo');
  assert.equal(d.personal.tasks.length, 2);
});

test('只读 git 白名单：非白名单子命令直接拒绝、不执行', async () => {
  const repo = await commitAll(await put(await tmpDir(), { 'a.md': 'x' }));
  for (const args of [['checkout', 'main'], ['fetch'], ['-c', 'x=y', 'rev-parse'], []]) {
    await assert.rejects(gitRead(repo, args), /白名单外/);
  }
  assert.equal(await gitRead(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

// ---- 前置条件表 → 外部阻塞（任务 2.1）----

test('实物前置表：P1 → 1.2、1.7、13、14；已决 / 整格划掉即解除；P4「不阻塞」', () => {
  const doc = parse('collab-m0-space-run');
  const p = Object.fromEntries(doc.prerequisites.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(p), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.deepEqual([p.P1.resolved, p.P1.blocksNums], [false, ['1.2', '1.7', '13', '14']], '划掉的 ~~1.1~~（已完成）不算');
  assert.deepEqual([p.P4.resolved, p.P4.blocksNums], [false, []]);
  assert.deepEqual([p.P5.resolved, p.P5.blocksNums], [false, ['8.5', '13']]);
  assert.deepEqual(['P2', 'P3', 'P6'].map((id) => [p[id].resolved, p[id].blocksNums]), [[true, []], [true, []], [true, []]]);
  assert.equal(p.P1.source.line, 23);
  // 表里的阻塞同时作为关系输出，engine 只需看 relations 里 objects 为 prereq 的 dep。
  const fromTable = doc.relations.filter((r) => r.via === 'prereq-table');
  assert.deepEqual(fromTable.map((r) => [r.objects[0].id, r.subjects.flatMap((s) => s.keys).map((k) => k.split('#')[1])]),
    [['P1', ['1.2', '1.7', '13', '14']], ['P5', ['8.5', '13']]]);
});

test('前置表：首列划掉即解除；「阻塞」列按表头找；首列正则可配置；不含任务的章节照样读表', () => {
  const text = '## 前置\n\n| 编号 | 事项 | 默认 | 阻塞 |\n|---|---|---|---|\n| ~~P1~~ | 仓库 | 本地 | 1 |\n| P2 | 远端 | 无 | 不阻塞 |\n| P3 | 区域 | 无 | 无 |\n\n## 阶段 1\n- [ ] 1 一\n';
  const doc = parseTasksDoc(text, 'x');
  assert.deepEqual(doc.prerequisites.map((x) => [x.id, x.resolved, x.blocksNums]), [['P1', true, ['1']], ['P2', false, []], ['P3', false, []]]);
  const custom = parseTasksDoc('| Q1 | x | 1 |\n|---|---|---|\n| Q2 | y | 1 |\n- [ ] 1 一（需要 Q2）\n', 'y', { prerequisiteIdPattern: '^Q\\d+$' });
  assert.deepEqual(custom.prerequisites.map((x) => x.id), ['Q2'], '首行是表头，不当前置条件');
  assert.deepEqual(custom.relations.map((r) => [r.via, r.objects[0].id, r.objects[0].dangling]), [['title', 'Q2', false], ['prereq-table', 'Q2', false]]);
});

// ---- ADR 文档级条目（任务 2.3）----
// import 同样会被提升；path / readFileSync / loadProjectDocs 沿用上文已导入的。
import { fileURLToPath } from 'node:url';
import { parseAdrDoc } from '../src/adr.mjs';

const adrProject = (repoPath) => ({
  id: 'p', repo: { path: repoPath, github: 'acme/demo' }, branchLines: [{ id: 'main', name: '主线', base: 'main' }],
  docSources: [{ type: 'adr-dir', label: 'ADR', path: 'adr' }],
});
const loadAdrFixtures = () => loadProjectDocs(adrProject(fileURLToPath(new URL('./fixtures/', import.meta.url))));

test('ADR 发现：目录下每个 .md 一篇，docId = 文件名去扩展名，编号取文件名、标题取 H1（去掉编号前缀）', async () => {
  const r = await loadAdrFixtures();
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.docs.length, 7);
  assert.ok(r.docs.every((d) => d.kind === 'adr' && d.sourceType === 'adr-dir' && d.sourceLabel === 'ADR'));
  const d = docMap(r);
  const a1 = d['ADR-0001-行内加粗状态'];
  assert.equal(a1.path, 'adr/ADR-0001-行内加粗状态.md');
  assert.equal(a1.adr.number, '0001');
  assert.equal(a1.title, '行内加粗状态');
  assert.equal(d['ADR-0002-标题式状态'].title, '标题式状态', '全角冒号');
  assert.equal(d['ADR-0003-引用块半角冒号'].title, '引用块半角冒号', '长横');
  assert.equal(d.README.adr.number, null, '文件名没有编号');
  assert.equal(d.README.title, '写 ADR 的约定');
});

test('ADR 状态：行内（加粗 / 引用块半角冒号 / Status）与「## 状态」下一行两种写法，原文不归一化；只看前 30 行；超长截 80 字', async () => {
  const d = docMap(await loadAdrFixtures());
  const status = (id) => d[id].adr.status;
  assert.equal(status('ADR-0001-行内加粗状态'), '已实施（Phase 1 — v1.8.0）', '取首个状态行，正文里的「状态管理」不算');
  assert.equal(status('ADR-0002-标题式状态'), '已采纳（2026-03-26）');
  assert.equal(status('ADR-0003-引用块半角冒号'), '已接受(Accepted)—— owner 确认后按阶段推进');
  assert.equal(status('ADR-0003-编号重复'), 'Accepted');
  assert.equal(status('README'), null, '第 30 行之后的状态行不认');
  const long = status('ADR-0004-超长状态与检查清单');
  assert.equal([...long].length, 81);
  assert.ok(long.startsWith('Proposed（首版曾误标 Accepted；') && long.endsWith('…'));
  assert.ok(!long.includes('一定会被截掉'));
});

test('ADR 编号重复：两篇都保留（docId 用文件名区分），各记一条诊断；不重复的没有诊断', async () => {
  const d = docMap(await loadAdrFixtures());
  const a = d['ADR-0003-引用块半角冒号'], b = d['ADR-0003-编号重复'];
  assert.equal(a.adr.number, '0003');
  assert.equal(b.adr.number, '0003');
  assert.deepEqual(a.parse.diagnostics.map((x) => x.message), ['ADR 编号 0003 重复：另见 ADR-0003-编号重复；按文件名区分']);
  assert.deepEqual(b.parse.diagnostics.map((x) => x.message), ['ADR 编号 0003 重复：另见 ADR-0003-引用块半角冒号；按文件名区分']);
  assert.deepEqual(b.parse.diagnostics[0].source, { file: 'adr/ADR-0003-编号重复.md', line: 1, text: '# ADR-0003: 编号重复' });
  assert.equal(a.parse.state, 'ok', '编号重复不是解析失败');
  assert.deepEqual(d['ADR-0001-行内加粗状态'].parse.diagnostics, []);
});

test('ADR 任务：带编号的任务行照常解析（键、关系）；无编号检查清单静默忽略、不记 no-tasks', async () => {
  const d = docMap(await loadAdrFixtures());
  const withTasks = d['ADR-0005-含任务行'];
  assert.equal(withTasks.parse.state, 'ok');
  assert.deepEqual(withTasks.tasks.map((t) => [t.key, t.checkbox]), [['ADR-0005-含任务行#1', 'done'], ['ADR-0005-含任务行#2', 'open']]);
  assert.ok(withTasks.relations.some((r) => r.kind === 'dep'), '标题里的「依赖 1」照常识别');
  const checklist = d['ADR-0004-超长状态与检查清单'];
  assert.deepEqual(checklist.tasks, []);
  assert.equal(checklist.parse.state, 'ok');
  assert.equal(checklist.parse.reason, undefined);
  assert.equal(checklist.parse.uncheckedBoxes, 3);
});

test('parseAdrDoc 纯函数：去 BOM、CRLF；没有 H1 时标题为 null', () => {
  const doc = parseAdrDoc('﻿## 状态\r\n\r\nDraft\r\n', 'ADR-0042-x');
  assert.equal(doc.kind, 'adr');
  assert.deepEqual(doc.adr, { number: '0042', status: 'Draft' });
  assert.equal(doc.title, null);
});

test('parseAdrDoc：日文「ステータス：」「## 状態」也认作状态', () => {
  assert.equal(parseAdrDoc('# ADR-0001: x\n- **ステータス**：承認済み\n', 'ADR-0001-x').adr.status, '承認済み');
  assert.equal(parseAdrDoc('# ADR-0002: y\n## 状態\n\n草案\n', 'ADR-0002-y').adr.status, '草案');
});

// ADR 目录因仓库而异：DEVBOARD_REAL_ADR_DIR 指定（仓库内相对路径），缺省 docs/adr；spec 固定看 .claude/specs。
test('实物（可选）：设了 DEVBOARD_REAL_REPO 时，解析真实仓库的全部 spec 与 ADR，没有 error', {
  skip: !process.env.DEVBOARD_REAL_REPO && '未设置 DEVBOARD_REAL_REPO',
}, async () => {
  const docSources = [
    { type: 'spec-dir', label: 'Claude Code spec', path: '.claude/specs' },
    { type: 'adr-dir', label: 'ADR', path: process.env.DEVBOARD_REAL_ADR_DIR || 'docs/adr' },
  ];
  const repo = path.resolve(process.env.DEVBOARD_REAL_REPO).normalize('NFC');
  const r = await loadProjectDocs({ ...adrProject(repo), docSources });
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.docs.some((d) => d.kind === 'adr'), '读到了 ADR');
  assert.ok(r.docs.some((d) => d.kind === 'tasks'), '读到了 spec');
  assert.deepEqual(r.docs.filter((d) => d.parse.state === 'error').map((d) => `${d.docId}：${d.parse.reason}`), []);
});

test('ADR 内加粗数字开头的检查清单不当任务（主线程补：避免检查清单类误报）', async () => {
  const { parseAdrDoc } = await import('../src/adr.mjs');
  const text = '# ADR-0099: 样例\n\n状态：已接受\n\n- [ ] **461 个孤儿目录要清理**\n- [x] **2.0 是否推翻**\n- [ ] 1 真任务\n';
  const doc = parseAdrDoc(text, 'ADR-0099-样例');
  assert.deepEqual(doc.tasks.map((t) => t.number), ['1']);
  assert.equal(doc.parse.state, 'ok');
});

// ---- N11：md-dir 来源（requirements 需求 7） ----
import { chmod } from 'node:fs/promises';

const PLAN_SP = `# chat.abort 实现计划

### Task 0: 准备分支

- [x] **Step 1: 确认干净**
- [x] **Step 2: 切分支**

### Task 1: helper

- [x] **Step 1: 写失败测试**
- [ ] **Step 2: 实现**
`;
const mdDir = (p = 'docs/plans', label = '计划') => ({ type: 'md-dir', label, path: p });

test('N11 md-dir：只取这一层的 .md；superpowers plan 按 Task / Step 判完成；无任务的为「规划中」', async () => {
  const repo = await put(await tmpDir(), {
    'docs/plans/2026-06-03-abort.md': PLAN_SP,
    'docs/plans/方案说明.md': '# 只是方案\n\n没有复选框。\n',
    'docs/plans/notes.txt': 'x',
    'docs/plans/old/nested.md': '- [ ] 1 不该被读到\n',
  });
  const r = await loadProjectDocs(specProject(repo, { docSources: [mdDir()] }));
  assert.deepEqual(r.docs.map((d) => d.docId), ['2026-06-03-abort', '方案说明']);
  const d = docMap(r);
  const sp = d['2026-06-03-abort'];
  assert.deepEqual([sp.kind, sp.sourceType, sp.parse.state, sp.path], ['tasks', 'md-dir', 'ok', 'docs/plans/2026-06-03-abort.md']);
  assert.deepEqual(sp.tasks.map((t) => [t.number, t.checkbox]), [['0', 'done'], ['1', 'open']]);
  const plan = d['方案说明'];
  assert.deepEqual([plan.kind, plan.parse.state], ['tasks', 'planning']);
  assert.equal(plan.parse.reason, '规划中（暂无任务）：文档里没有任务行');
  assert.deepEqual(r.diagnostics, []);
});

test('N11 md-dir：有疑似任务行却一个都没认出时仍是 no-tasks（不藏问题）', async () => {
  const repo = await put(await tmpDir(), { 'docs/plans/bad.md': '# 计划\n\n- [ ] 1、格式不对的任务\n' });
  const r = await loadProjectDocs(specProject(repo, { docSources: [mdDir()] }));
  const bad = docMap(r).bad;
  assert.equal(bad.parse.state, 'no-tasks');
  assert.deepEqual(bad.parse.unrecognizedLines, [3]);
});

test('N11 md-dir：读取失败保留 error 与原因，不转成「规划中」', { skip: process.getuid?.() === 0 && 'root 读得了 000 权限的文件' }, async () => {
  const repo = await put(await tmpDir(), { 'docs/plans/locked.md': '# 锁住\n' });
  await chmod(path.join(repo, 'docs/plans/locked.md'), 0o000);
  try {
    const r = await loadProjectDocs(specProject(repo, { docSources: [mdDir()] }));
    const locked = docMap(r).locked;
    assert.equal(locked.parse.state, 'error');
    assert.match(locked.parse.reason, /读取或解析失败/);
  } finally {
    await chmod(path.join(repo, 'docs/plans/locked.md'), 0o644);
  }
});

test('N11 md-dir：与 spec-dir 同名时不论来源顺序都留 spec-dir 那份并记诊断；两个 md-dir 同名时靠前的优先', async () => {
  const repo = await put(await tmpDir(), {
    '.claude/specs/alpha/tasks.md': TASKS,
    'docs/plans/alpha.md': '- [ ] 1 plan 里的同名\n',
    'docs/plans/shared.md': '- [ ] 1 第一个 md-dir\n',
    'docs/todo/shared.md': '- [ ] 1 第二个 md-dir\n',
  });
  const spec = { type: 'spec-dir', label: 'spec', path: '.claude/specs' };
  for (const order of [[mdDir(), spec], [spec, mdDir()]]) {
    const r = await loadProjectDocs(specProject(repo, { docSources: [...order, mdDir('docs/todo', 'TODO')] }));
    const alphas = r.docs.filter((d) => d.docId === 'alpha');
    assert.deepEqual(alphas.map((d) => d.sourceType), ['spec-dir'], `顺序 ${order.map((s) => s.type)}`);
    const shared = r.docs.filter((d) => d.docId === 'shared');
    assert.deepEqual(shared.map((d) => d.path), ['docs/plans/shared.md']);
    assert.deepEqual(r.diagnostics.map((x) => x.message).sort(), [
      '来源「TODO」的 docs/todo/shared.md 与已有文档同名（shared），已跳过',
      '来源「计划」的 docs/plans/alpha.md 与已有文档同名（alpha），已跳过',
    ]);
  }
});

test('N11 md-dir：带空格与中文的路径、NFD 文件名 → docId 为 NFC', async () => {
  const root = await tmpDir();
  const nfd = 'café'.normalize('NFD');
  const repo = await put(path.join(root, 'My Repo'), { [`文档/开发文档/03.PLAN/${nfd}-实施计划.md`]: '- [ ] 1 做\n' });
  const r = await loadProjectDocs(specProject(repo, { docSources: [mdDir('文档/开发文档/03.PLAN', '实施计划')] }));
  assert.deepEqual(r.docs.map((d) => d.docId), ['café-实施计划'.normalize('NFC')]);
  assert.equal(r.docs[0].tasks[0].key, `${'café-实施计划'.normalize('NFC')}#1`);
});

// ---- N17：从 git ref 读文档的分支线（docRef） ----
import { checkLocalSync } from '../src/docs.mjs';

const ADR42 = 'docs/adr/ADR-0042-x.md';
const refProject = (repoPath, line = {}) => ({
  id: 'p', repo: { path: repoPath, github: 'acme/demo' },
  docSources: [{ type: 'adr-dir', label: 'ADR', path: 'docs/adr' }],
  branchLines: [{ id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'next/x', docFiles: [ADR42], docFilter: '^next:', ...line }],
});
async function refRepo() {
  const repo = await commitAll(await put(await tmpDir(), { [ADR42]: '# ADR-0042 旧版\n\n- [ ] 1 甲\n- [x] 2 乙\n' }));
  git(repo, 'switch', '-q', '-c', 'next/x');
  // 新引擎分支上的版本开头多一个空行：行号要与 git 里的文件一致（读内容不能去首尾空白）
  await writeFile(path.join(repo, ADR42), '\n# ADR-0042 新版\n\n- [ ] 1 甲\n- [x] 2 乙\n- [ ] 94 丙\n');
  git(repo, 'commit', '-q', '-am', 'next');
  git(repo, 'switch', '-q', 'main');
  return repo;
}

test('N17 docRef：不检出也能读另一分支的同名文档，docId 带分支线前缀、与主工作区那份各算各的', async () => {
  const repo = await refRepo();
  const r = await loadProjectDocs(refProject(repo));
  const d = docMap(r);
  assert.deepEqual(d['ADR-0042-x'].tasks.map((t) => t.number), ['1', '2'], '主工作区那份不受影响');
  const n = d['next:ADR-0042-x'];
  assert.deepEqual(n.tasks.map((t) => t.key), ['next:ADR-0042-x#1', 'next:ADR-0042-x#2', 'next:ADR-0042-x#94']);
  assert.equal(n.tasks[2].line, 6, '行号与分支上的文件一致');
  assert.equal(n.kind, 'adr');
  assert.equal(n.title, '新版');
  assert.deepEqual([n.alias, n.ref, n.workspaceId, n.path, n.sourceLabel], ['ADR-0042-x', 'next/x', 'next', ADR42, '新引擎线']);
  const ws = r.workspaces.find((w) => w.id === 'next');
  assert.deepEqual([ws.path, ws.branch, ws.commit, ws.error], [repo, 'next/x', git(repo, 'rev-parse', 'next/x'), null]);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '没有切分支');

  // 增量：ref 没动不重解析；分支有新提交才重解析
  const again = await loadProjectDocs(refProject(repo), { prev: r.parsedCache });
  assert.deepEqual(again.reparsed, []);
  git(repo, 'switch', '-q', 'next/x');
  await writeFile(path.join(repo, ADR42), '# ADR-0042\n\n- [x] 94 丙\n');
  git(repo, 'commit', '-q', '-am', 'next2');
  git(repo, 'switch', '-q', 'main');
  const moved = await loadProjectDocs(refProject(repo), { prev: again.parsedCache });
  assert.ok(moved.reparsed.includes('next:ADR-0042-x'), '分支有新提交就重解析（切分支会碰工作区文件，主工作区那份也可能重解析）');
  assert.deepEqual(docMap(moved)['next:ADR-0042-x'].tasks.map((t) => [t.number, t.checkbox]), [['94', 'done']]);
});

test('N17 docRef：ref 不存在或分支上没有该文件，只把该文档标 error，顶栏写明原因', async () => {
  const repo = await refRepo();
  const r = await loadProjectDocs(refProject(repo, { docRef: 'origin/next/x' }));
  const n = docMap(r)['next:ADR-0042-x'];
  assert.equal(n.parse.state, 'error');
  assert.match(n.parse.reason, /本地没有 origin\/next\/x（需要先 git fetch）/);
  assert.match(r.workspaces.find((w) => w.id === 'next').error, /本地没有 origin\/next\/x/);
  assert.equal(docMap(r)['ADR-0042-x'].parse.state, 'ok');

  const m = docMap(await loadProjectDocs(refProject(repo, { docFiles: ['docs/adr/ADR-0099-none.md'] })))['next:ADR-0099-none'];
  assert.match(m.parse.reason, /next\/x 上没有这个文件/);
});

test('N17 本地同步：docRef 分支线按 docRef 判断合并提交是否已在本地', async () => {
  const repo = await refRepo();
  const oid = git(repo, 'rev-parse', 'next/x');
  // 没有本地 next/engine 分支、HEAD 在 main：缺省口径无从判断
  assert.equal((await checkLocalSync(repo, oid, 'next/engine')).state, 'unknown');
  assert.equal((await checkLocalSync(repo, oid, 'next/engine', 'next/x')).state, 'synced');
});

test('N17 本地同步：docRef 只对照 docRef，HEAD 比它新也不算同步', async () => {
  const repo = await refRepo();
  git(repo, 'branch', 'stale', 'next/x');
  git(repo, 'switch', '-q', 'next/x');
  await writeFile(path.join(repo, 'extra.md'), 'x');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'ahead');
  const ahead = git(repo, 'rev-parse', 'HEAD');
  assert.equal((await checkLocalSync(repo, ahead, 'next/engine')).state, 'synced', '缺省口径：在 HEAD 上就算');
  assert.equal((await checkLocalSync(repo, ahead, 'next/engine', 'stale')).state, 'pending', 'docRef 还没有这个提交 → 待 fetch');
  const none = await checkLocalSync(repo, ahead, 'next/engine', 'origin/none');
  assert.deepEqual(none, { state: 'unknown', reason: '本地没有 origin/none' });
});

test('N17 docRef 缺文件：fetch 前后原因会更新（文件戳带上 ref 的提交 / 错误）', async () => {
  const repo = await refRepo();
  const proj = refProject(repo, { docRef: 'origin/next/x', docFiles: ['docs/adr/ADR-0099-none.md'] });
  const first = await loadProjectDocs(proj);
  assert.match(docMap(first)['next:ADR-0099-none'].parse.reason, /需要先 git fetch/);
  git(repo, 'update-ref', 'refs/remotes/origin/next/x', 'next/x'); // 相当于 fetch 之后有了这个 ref
  const second = await loadProjectDocs(proj, { prev: first.parsedCache });
  assert.match(docMap(second)['next:ADR-0099-none'].parse.reason, /origin\/next\/x 上没有这个文件/);
});

test('N30 读取失败不粘住：文件戳没变也重读，读成功即恢复；仍是同一错误不算重解析', async () => {
  const repo = await refRepo();
  await put(repo, { 'plans/roadmap.md': TASKS });
  const proj = { ...refProject(repo), docSources: [...refProject(repo).docSources, { type: 'task-list', label: '清单', files: ['plans/roadmap.md', 'plans/missing.md'] }] };
  const first = await loadProjectDocs(proj);
  // 模拟上一轮（或上次启动存进 docs.json 的）一时失败：git 子进程被超时杀掉，文件戳照旧
  const failed = { kind: 'adr', title: null, parse: { state: 'error', reason: '读取或解析失败：Command failed: git cat-file blob …' }, groups: [], tasks: [] };
  const prev = { ...first.parsedCache, 'next:ADR-0042-x': { ...first.parsedCache['next:ADR-0042-x'], parsed: failed }, 'plans/roadmap': { ...first.parsedCache['plans/roadmap'], parsed: failed } };
  const second = await loadProjectDocs(proj, { prev });
  const d = docMap(second);
  assert.deepEqual(d['next:ADR-0042-x'].tasks.map((t) => t.number), ['1', '2', '94'], 'docRef 文档重读恢复');
  assert.deepEqual(d['plans/roadmap'].tasks.map((t) => t.number), ['1', '2'], '本地文件同样重读恢复');
  assert.deepEqual(second.reparsed.sort(), ['next:ADR-0042-x', 'plans/roadmap']);
  // 一直读不了的文件（不存在）每轮重试，但结果没变就沿用，不触发重算
  const third = await loadProjectDocs(proj, { prev: second.parsedCache });
  assert.equal(docMap(third)['plans/missing'].parse.state, 'error');
  assert.deepEqual(third.reparsed, []);
});

test('N30 gitRead：进程冻结超过 10 秒（像机器睡眠）醒来时超时先到点，不论 git 被杀还是已写完，重试一次读出原文', { skip: process.platform === 'win32' && '靠 SIGSTOP 冻结进程' }, async () => {
  const repo = await refRepo();
  const blob = git(repo, 'rev-parse', `next/x:${ADR42}`);
  // 子进程自成进程组，发起读取后立刻冻结，11 秒后由这里 SIGCONT 整组。两种冻结法：
  // group = 连同刚派生的 git 一起冻结（git 醒来还没写完 → 被杀掉报错）；
  // self = 只冻结 node，git 照常写完退出（execFile 到点先销毁 stdout → 「成功」返回空输出，CI 的 Linux 上踩到过）
  const frozenRead = (target) => {
    const code = `const { gitRead } = await import(${JSON.stringify(new URL('../src/docs.mjs', import.meta.url).href)});
const p = gitRead(${JSON.stringify(repo)}, ['cat-file', 'blob', ${JSON.stringify(blob)}], { raw: true });
process.kill(${target === 'group' ? '-process.pid' : 'process.pid'}, 'SIGSTOP');
p.then((s) => console.log(JSON.stringify({ text: s })), (e) => console.log(JSON.stringify({ killed: e.killed, signal: e.signal })));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    const resume = setTimeout(() => process.kill(-child.pid, 'SIGCONT'), 11_000);
    return new Promise((resolve) => child.on('exit', resolve)).then(() => JSON.parse(out)).finally(() => {
      clearTimeout(resume);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    });
  };
  const text = '\n# ADR-0042 新版\n\n- [ ] 1 甲\n- [x] 2 乙\n- [ ] 94 丙\n';
  const [group, self] = await Promise.all([frozenRead('group'), frozenRead('self')]);
  assert.deepEqual(group, { text }, 'git 一起冻结');
  assert.deepEqual(self, { text }, '只冻结 node');
});

// ---- N9：写法不合约定时不静默误读 ----
test('N9 中文数字的阶段标题：「阶段一」「第二阶段」「第 12 阶段」与「阶段 N」同一别名，可被依赖引用', () => {
  const doc = parseTasksDoc('## 阶段一：起步\n- [ ] 1 甲\n## 第二阶段\n- [ ] 2 乙（依赖 阶段 1）\n## 第 12 阶段\n- [ ] 3 丙\n## 阶段二十三\n- [ ] 4 丁\n', 'n9');
  assert.deepEqual(doc.groups.map((g) => g.alias), ['阶段 1', '阶段 2', '阶段 12', '阶段 23']);
  assert.deepEqual(doc.relations.map((r) => r.objects[0].keys), [['n9#1']]);
  // 超出九十九的不当别名，也不截成别的阶段（PR #43 review：「阶段一百」曾被截成「阶段 1」，依赖 阶段 1 指到任务 100）
  const big = parseTasksDoc('## 阶段一百\n- [ ] 100 甲\n## 阶段一\n- [ ] 1 乙\n## 第两千阶段\n- [ ] 3 丙（依赖 阶段 1）\n', 'n9c');
  assert.deepEqual(big.groups.map((g) => g.alias), [null, '阶段 1', null]);
  assert.deepEqual(big.relations.map((r) => r.objects[0].keys), [['n9c#1']]);
});

test('N9 已有任务行时混用的标题式任务、小写 task / 全角数字的疑似任务行都报出来', () => {
  const doc = parseTasksDoc('## 分组\n- [ ] 1 甲\n### 任务 2：标题式\n- [ ] task 3 小写\n- [ ] ４ 全角\n- [ ] 验收清单\n', 'n9');
  assert.deepEqual(doc.tasks.map((t) => t.number), ['1']);
  assert.deepEqual(doc.parse.diagnostics.map((d) => [d.source.line, d.message]),
    [[3, '标题「任务 2：标题式」像标题式任务，但本文档已有任务行，它不会被当成任务；建议改成「- [ ] 2 标题式」']]);
  assert.deepEqual([doc.parse.state, doc.parse.unrecognizedLines, doc.parse.uncheckedBoxes], ['partial', [4, 5], 1]);
  // 没有任务行时标题式任务照旧兜底，不报
  assert.deepEqual(parseTasksDoc('## Task 1: 甲\n- [x] 步骤\n', 'n9b').parse.diagnostics, []);
});

test('N9 未知来源类型不再静默跳过：记诊断并列出可用类型', async () => {
  const repo = await put(await tmpDir(), { '.claude/specs/beta/tasks.md': TASKS });
  const r = await loadProjectDocs(specProject(repo, { docSources: [{ type: 'spec-dir', label: 'spec', path: '.claude/specs' },
    { type: 'md_dir', label: '计划', path: 'docs/plans' }] }));
  assert.deepEqual(r.docs.map((d) => d.docId), ['beta']);
  assert.deepEqual(r.diagnostics.map((d) => d.message.replaceAll('⁣', '')),
    ['来源「计划」的类型「md_dir」不认识，已跳过；可用的类型：spec-dir、task-list、md-dir、adr-dir']);
});

