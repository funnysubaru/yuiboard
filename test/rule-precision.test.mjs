// 第一批：分清「提到」和「在做、交付了」。全部是虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard, linkPrs, linkSessions } from '../src/engine.mjs';
import { extractRefs, extractBranchRefs, humanRefText, isRecordTitle, taskLines, withoutCode } from '../src/refs.mjs';
import { titleIssues } from '../src/guard.mjs';
import { duplicateDocs } from '../web/app.mjs';

const NOW = '2026-09-20T08:00:00.000Z';
const doc = (text, docId = 'plan') => ({ docId, archived: false, ...parseTasksDoc(text, docId) });
const PLAN = doc('### 里程碑 M1：一组\n\n- [ ] 1 第一件\n- [ ] 2 第二件\n- [ ] 3 第三件\n\n### 里程碑 M2：二组\n\n- [ ] 4 第四件\n');
const PLAN_DONE = doc('- [x] 1 第一件\n- [x] 2 第二件\n');
const OTHER = doc('### 里程碑 M9：别的\n\n- [ ] 7 别的第七件\n', 'other');
const opts = { knownDocIds: ['plan', 'other'], knownCodes: ['M1', 'M2', 'M9'] };
const pr = (number, over = {}) => ({ number, title: `PR ${number}`, body: '', url: '', state: 'OPEN', isDraft: true, baseRefName: 'main',
  headRefName: `b${number}`, labels: [], createdAt: NOW, updatedAt: NOW, mergedAt: null, closedAt: null, readyAt: null, ...over });
const tasksOf = (prs, docs = [PLAN]) => linkPrs(docs, prs, { id: 'demo' }).prs.get(prs[0].number).tasks;

// ---- 36.1 PR 标题的代号 ----

test('36.1 标题同时有代号和任务号：代号不展开，只算写明的任务', () => {
  assert.deepEqual(tasksOf([pr(1, { title: 'feat: M1 任务 2 收尾' })]), ['plan#2']);
  assert.deepEqual(tasksOf([pr(1, { title: 'feat: M1 plan#3 收尾' })]), ['plan#3']);
  const { links } = linkPrs([PLAN], [pr(1, { title: 'feat: M1 任务 2 收尾' })], { id: 'demo' });
  assert.equal(links[0].evidence, '任务 2', '依据不再列没采信的代号');
});

test('36.1 只有代号仍算整组；带部分标记的代号照旧算', () => {
  assert.deepEqual(tasksOf([pr(1, { title: 'feat: M1 收尾' })]), ['plan#1', 'plan#2', 'plan#3']);
  const { links } = linkPrs([PLAN], [pr(1, { title: 'feat: M1（部分） 任务 4' })], { id: 'demo' });
  assert.deepEqual(links.map((l) => [l.taskKey, Boolean(l.partial)]), [['plan#4', false], ['plan#1', true], ['plan#2', true], ['plan#3', true]]);
});

test('36.1 约定守卫同口径：有任务号时，代号展开不出任务也不报', () => {
  const empty = doc('### 里程碑 M3：全作废\n\n- [x] ~~5 旧~~ **【作废 2026-09-01】** 不做了\n\n### 里程碑 M4：x\n\n- [ ] 6 新\n');
  assert.match(titleIssues('feat: M3', [empty])[0], /不存在的任务：M3/, '只有代号时照旧报');
  assert.deepEqual(titleIssues('feat: M3 任务 6', [empty]), []);
  assert.match(titleIssues('feat: M3（部分） 任务 6', [empty])[0], /不存在的任务：M3/, '带部分标记的代号照旧算');
});

// ---- 36.2 会话的代号 ----

const at = (m) => `2026-09-20T07:${String(m).padStart(2, '0')}:00.000Z`;
const sig = (kind, m, refs, extra = {}) => ({ kind, at: at(m), until: at(m), file: 'r/s.jsonl', line: m + 1, snippet: '（虚构）片段',
  refs: { keys: [], nums: [], codes: [], docIds: [], scopes: [], partial: [], unknown: [], spans: [], ...refs }, ...extra });
const session = (id, signals, over = {}) => ({ source: 'claude-code', id, files: [], cwds: ['/ws/repo'], branches: [], title: id,
  firstAt: signals[0].at, lastAt: signals.at(-1).until, lastSummary: null, signals, aiOnlyMentions: 0, brokenLines: 0, ...over });
const sess = (docs, sessions) => linkSessions(docs, sessions, [], new Map(), { id: 'demo' });
const keysOf = (r, id) => r.links.filter((l) => l.sessionId === id).map((l) => l.taskKey);

test('36.2 prompt、dispatch、command 里的代号不解析成任务', () => {
  for (const kind of ['prompt', 'dispatch', 'command']) {
    const r = sess([PLAN, OTHER], [session('s', [sig(kind, 0, { codes: ['M1'] })])]);
    assert.deepEqual(r.links, [], kind);
    assert.deepEqual(r.conflicts, [], kind);
  }
});

test('36.2 代号把文档加进上下文：同会话的裸编号因此对得上', () => {
  const r = sess([PLAN, OTHER], [session('s', [sig('prompt', 0, { codes: ['m9'] }), sig('prompt', 1, { nums: ['7'] })])]);
  assert.deepEqual(keysOf(r, 's'), ['other#7']);
  const cmd = sess([PLAN, OTHER], [session('c', [sig('command', 0, { codes: ['M1'] }), sig('prompt', 1, { nums: ['2'] })])]);
  assert.deepEqual(keysOf(cmd, 'c'), ['plan#2'], 'command 的代号同样进上下文');
});

test('36.2 只写代号的信号不清焦点：之后的活动还算原来的任务', () => {
  const r = sess([PLAN], [session('s', [sig('prompt', 0, { nums: ['2'] }), { ...sig('prompt', 5, { codes: ['M2'] }), until: at(9) }])]);
  assert.deepEqual(r.links.map((l) => [l.taskKey, l.lastAt]), [['plan#2', at(9)]]);
});

// ---- 36.3 PR 描述 ----

test('36.3 taskLines 只留行首的 Task 行，跳过代码块', () => {
  const body = ['说明', 'Task: plan#1', 'tasks：任务 2', '  任务：任务 3', 'タスク: 4', '- 任务 5 不是行首写法', '```', 'Task: plan#6', '```'].join('\n');
  assert.deepEqual(taskLines(body).split('\n'), ['Task: plan#1', 'tasks：任务 2', '  任务：任务 3', 'タスク: 4']);
  assert.equal(taskLines(null), '');
});

test('36.3 #195 式「本 PR 不含」的叙述不算交付', () => {
  assert.deepEqual(tasksOf([pr(195, { body: '本 PR 不含任务 1、任务 2，也不含 M2。' })]), []);
  assert.deepEqual(tasksOf([pr(196, { body: '背景。\n\nTask: plan#3\n' })]), ['plan#3']);
});

test('36.3 i 只比 Task 行：正文叙述指向别的任务不报', () => {
  const types = (body) => linkPrs([PLAN], [pr(1, { title: '任务 1', body })], { id: 'demo' }).conflicts.map((c) => c.type);
  assert.deepEqual(types('下一步做任务 2'), []);
  assert.deepEqual(types('Task: plan#2'), ['i']);
});

test('36.3 描述来源的 h 只留在 PR 详情，不进需要确认和诊断', () => {
  const b = computeBoard([PLAN], [pr(1, { body: 'Task: 任务 99' })], [], [], {}, { id: 'demo' }, NOW);
  assert.deepEqual(b.conflicts, []);
  assert.deepEqual(b.diagnostics.convention.filter((x) => x.pr), []);
  assert.match(b.prs[0].refIssues[0], /不存在的任务：99/);
  const t = computeBoard([PLAN], [pr(1, { title: '任务 99' })], [], [], {}, { id: 'demo' }, NOW);
  assert.deepEqual(t.conflicts.map((c) => c.type), ['h'], '标题来源照旧报');
});

test('36.3 Tasks: 72 successful 这类工具输出行不当引用', () => {
  assert.deepEqual(tasksOf([pr(1, { body: 'Tasks:    3 successful, 3 total' })]), []);
});

// ---- 36.4 工具输出和版本号 ----

test('36.4 编号后跟 successful、passed、failed、个、项 的不算', () => {
  for (const t of ['Tasks: 72 successful', 'Tasks:    72 successful, 72 total', 'Tasks 3 passed', 'Task 3 failed', '任务 3 个', '任务 12项', '任务 3、4 个']) {
    assert.deepEqual(extractRefs(t, opts).nums, [], t);
  }
  for (const t of ['任务 3 个人版修复', '任务 3 项目初始化', 'Task 3 successfully done']) assert.deepEqual(extractRefs(t, opts).nums, ['3'], t);
});

test('36.4 任务列表遇到三段版本号截止', () => {
  const r = extractRefs('任务 58，2.0.83', opts);
  assert.deepEqual(r.nums, ['58']);
  assert.equal(r.spans[0].text, '任务 58', '依据不带版本号');
  assert.deepEqual(extractRefs('任务 58、59，2.0.83、60', opts).nums, ['58', '59'], '截止后的都不算');
  assert.deepEqual(extractRefs('任务 4.1.1、4.1.2', opts).nums, ['4.1.1', '4.1.2'], '三段任务号的列表照旧');
});

test('36.4 release-1.15 这类分支名不认', () => {
  for (const b of ['release-1.15', 'release/1.15', 'hotfix/release-1.15', 'version-2.3']) assert.deepEqual(extractBranchRefs(b).nums, [], b);
  assert.deepEqual(extractBranchRefs('collab-15.2-docs').nums, ['15.2']);
});

test('36.4 withoutCode 去掉代码，refs.mjs 共用', () => {
  assert.equal(withoutCode('做 `N99` 吧').includes('N99'), false);
});

// ---- 36.5 [~] 不报 a ----

test('36.5 文档写着进行中的任务不报 a；未勾的照旧报', () => {
  const d = doc('- [~] 1 做着\n- [ ] 2 没勾\n');
  const b = computeBoard([d], [pr(1, { title: '任务 1、2', state: 'MERGED', isDraft: false, mergedAt: at(0) })], [], [], { 1: { state: 'synced' } }, { id: 'demo' }, NOW);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'a').map((c) => c.taskKey), ['plan#2']);
});

// ---- 36.6 引用和 fork ----

test('36.6 去掉 reply 引用块和 > 行，留下人自己写的', () => {
  const t = humanRefText('<!-- reply 1 -->\n> 上一条说的任务 3 还没做\n\n好，那做任务 4\n');
  assert.deepEqual(extractRefs(t, opts).nums, ['4']);
  assert.deepEqual(extractRefs(humanRefText('> 任务 3'), opts).nums, []);
});

test('36.6 人发消息的代码块不算，行内代码算', () => {
  assert.deepEqual(extractRefs(humanRefText('看日志\n```\n任务 3\n```\n做 `plan#4`'), opts).keys, ['plan#4']);
  assert.deepEqual(extractRefs(humanRefText('看日志\n```\n任务 3\n```\n'), opts).nums, []);
});

test('36.6 fork：相同信号只算给最早的会话，后面的会话仍用它更新焦点', () => {
  const shared = sig('prompt', 0, { nums: ['2'] });
  const later = { ...sig('command', 5, { nums: [] }), kind: 'turn' };
  const r = sess([PLAN], [session('b-fork', [shared, later], { firstAt: at(0) }), session('a-first', [shared], { firstAt: at(0) })]);
  assert.deepEqual(r.links.map((l) => [l.sessionId, l.firstAt, l.evidence.length]), [['b-fork', at(5), 0], ['a-first', at(0), 1]]);
});

test('36.6 fork：相同信号的引用问题不重复报，时间不同的不算相同', () => {
  const bad = sig('prompt', 0, { nums: ['99'] });
  assert.equal(sess([PLAN], [session('a', [bad]), session('b', [bad])]).conflicts.length, 1);
  const same = sig('prompt', 1, { nums: ['2'] });
  const r = sess([PLAN], [session('a', [same]), session('b', [{ ...same, at: at(2), until: at(2) }])]);
  assert.deepEqual(r.links.map((l) => l.sessionId), ['a', 'b']);
});

// ---- owner 2026-11-01 改：描述正文是弱关联、分支名的代号不展开、父任务不误报 c ----

const merged = (number, over = {}) => pr(number, { state: 'MERGED', isDraft: false, mergedAt: at(0), ...over });
const boardOf = (d, prs) => computeBoard([d], prs, [], [], Object.fromEntries(prs.map((p) => [p.number, { state: 'synced' }])), { id: 'demo' }, NOW);
const viewOf = (b, key) => b.tasks.find((v) => v.key === key);

test('36.3 正文的任务号是弱关联：显示在任务上、不报 c，不进状态', () => {
  const d = doc('- [x] 1 勾了\n- [ ] 2 没勾\n');
  const b = boardOf(d, [merged(5, { body: '这次做完了任务 1、任务 2。' })]);
  assert.deepEqual(viewOf(b, 'plan#1').mentionedPrs, [{ pr: 5, evidence: '任务 1、任务 2' }]);
  assert.equal(viewOf(b, 'plan#1').docOnly, false);
  assert.deepEqual(b.conflicts, [], '不报 a、c');
  assert.equal(viewOf(b, 'plan#2').status, 'not_started');
  assert.deepEqual(viewOf(b, 'plan#2').prs, []);
  assert.deepEqual(b.prs[0].tasks, [], 'PR 仍算未关联，会话也不跟着关联');
});

test('36.3 弱关联不进 l、m，也不进 i；open 的不改状态', () => {
  const d = doc('- [ ] 1 前置\n- [ ] 2 后面（依赖 1）\n- [x] ~~3 旧~~ **【作废 2026-09-01】** 不做了\n');
  const b = boardOf(d, [merged(5, { title: '任务 1', body: '顺带提一下任务 2 和任务 3。' })]);
  assert.deepEqual(b.conflicts.filter((c) => ['l', 'm', 'i'].includes(c.type)), []);
  assert.deepEqual(b.tasks.flatMap((v) => v.mentionedPrs), [], '标题生效时正文不记');
  const open = boardOf(d, [pr(6, { body: '在做任务 2。' })]);
  assert.equal(viewOf(open, 'plan#2').status, 'not_started');
});

test('36.3 标题写了任务时正文不记，标题的引用没生效时才记；Task 行照旧是强关联', () => {
  const d = doc('- [x] 1 一\n- [x] 2 二\n');
  const c = (prs) => boardOf(d, prs).conflicts.filter((x) => x.type === 'c').map((x) => x.taskKey);
  assert.deepEqual(c([merged(5, { title: '任务 1', body: '顺带做了任务 2。' })]), ['plan#2']);
  assert.deepEqual(viewOf(boardOf(d, [merged(5, { title: '任务 99', body: '做了任务 2。' })]), 'plan#2').mentionedPrs.map((m) => m.pr), [5], '标题的编号不存在，不算生效');
  assert.deepEqual(viewOf(boardOf(d, [merged(5, { title: '任务 1', body: 'Task: 任务 2' })]), 'plan#2').mentionedPrs, []);
  assert.deepEqual(viewOf(boardOf(d, [merged(5, { body: 'Task: 任务 1\n\n做了任务 2。' })]), 'plan#2').mentionedPrs.map((m) => m.pr), [5], '标题没写时正文照记');
});

test('36.3 「本 PR 不含」「还没做」这类小节和句子不算，下一节恢复', () => {
  const body = ['## 本 PR 不含', '- 任务 1', '', '## 改动', '- 任务 2', '', '**还没做**', '- 任务 3', '', '未完成：', '', '- 任务 4', '', '### Verification', '- 任务 5', '', '不含任务 6。'].join('\n');
  const d = doc('- [ ] 1 一\n- [ ] 2 二\n- [ ] 3 三\n- [ ] 4 四\n- [ ] 5 五\n- [ ] 6 六\n');
  const b = boardOf(d, [merged(5, { body })]);
  assert.deepEqual(b.tasks.filter((v) => v.mentionedPrs.length).map((v) => v.key), ['plan#2', 'plan#5']);
});

test('36.3 未交付小节按标题层级排除：子标题不结束，同级或更高才恢复', () => {
  const d = doc('- [x] 1 一\n- [x] 2 二\n- [x] 3 三\n');
  const b = boardOf(d, [merged(5, { body: ['## 本 PR 不含', '### 后端', '- plan#1', '**前端**', '- plan#2', '', '## 改动', '修复解析器，plan#3'].join('\n') })]);
  assert.deepEqual(['plan#1', 'plan#2', 'plan#3'].map((k) => viewOf(b, k).docOnly), [true, true, false]);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'c').map((c) => c.taskKey), ['plan#1', 'plan#2']);
  const up = boardOf(d, [merged(6, { body: '### 还没做\n- plan#1\n\n## 改动\n- plan#2\n\n### 不含\n- plan#3\n\n#### 细节\n- plan#3\n' })]);
  assert.deepEqual(up.tasks.filter((v) => v.mentionedPrs.length).map((v) => v.key), ['plan#2']);
});

test('36.3 正文的弱关联跳过代码块、工具输出、代号、Task 行，关闭未合并的不算记录', () => {
  const d = doc('### 里程碑 M1：一组\n\n- [x] 1 一\n- [x] 2 二\n');
  const none = (body) => assert.deepEqual(boardOf(d, [merged(5, { body })]).tasks.flatMap((v) => v.mentionedPrs), [], body);
  none('```\n任务 1\n```');
  none('Tasks: 2 successful');
  none('属于 M1 这个里程碑。');
  const strong = boardOf(d, [merged(5, { body: 'Task: 任务 1' })]);
  assert.deepEqual(viewOf(strong, 'plan#1').mentionedPrs, [], 'Task 行是强关联，不重复记');
  assert.equal(viewOf(strong, 'plan#1').prs.length, 1);
  const closed = boardOf(d, [pr(5, { state: 'CLOSED', isDraft: false, body: '做了任务 1。' })]);
  assert.equal(viewOf(closed, 'plan#1').docOnly, true);
});

test('36.3 同一 PR 对同一任务，标题的强关联优先，不再记弱关联', () => {
  const d = doc('- [ ] 1 一\n');
  assert.deepEqual(viewOf(boardOf(d, [merged(5, { title: '任务 1', body: '做了任务 1。' })]), 'plan#1').mentionedPrs, []);
});

test('分支名的代号不展开：只认 task-<编号> 和带点的编号', () => {
  assert.deepEqual(tasksOf([pr(1, { headRefName: 'feat/m1-reconnect' })]), []);
  assert.deepEqual(tasksOf([pr(1, { headRefName: 'feat/task-2' })]), ['plan#2']);
  assert.deepEqual(extractBranchRefs('feat/m1').codes, []);
});

test('已勾选的父任务：子任务都有 PR 记录时不报 c，缺一个照报；没有子任务的照报', () => {
  const d = doc('- [x] 1 父\n- [x] 1.1 子一\n- [x] 1.2 子二\n- [x] 2 父二\n- [x] 2.1 子\n- [x] 2.2 子\n- [x] 3 单独\n');
  const b = boardOf(d, [merged(5, { title: '任务 1.1、2.1' }), merged(6, { body: '做了任务 1.2。' })]);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'c').map((c) => c.taskKey), ['plan#2', 'plan#2.2', 'plan#3']);
  assert.equal(viewOf(b, 'plan#1').status, 'done');
  const deep = doc('- [x] 1 父\n- [x] 1.1 中\n- [x] 1.1.1 叶\n- [x] 1.2 作废的\n'.replace('- [x] 1.2 作废的', '- [x] ~~1.2 旧~~ **【作废 2026-09-01】** 不做了'));
  assert.deepEqual(boardOf(deep, [merged(5, { title: '任务 1.1.1' })]).conflicts.filter((c) => c.type === 'c'), [], '隔代、作废的子任务不算');
});

// ---- 第二批 ----

const SYNCED = (prs) => Object.fromEntries(prs.map((p) => [p.number, { state: 'synced' }]));
const withSessions = (d, sessions, prs = []) => computeBoard([d], prs, sessions, [], SYNCED(prs), { id: 'demo' }, NOW);

// ---- 36.7 进行中要有实际工作信号 ----

test('36.7 只点名、询问：列在任务的会话里，但任务不进进行中', () => {
  const b = withSessions(PLAN, [session('s', [sig('prompt', 0, { nums: ['2'] })])]);
  const v = viewOf(b, 'plan#2');
  assert.equal(v.status, 'not_started');
  assert.deepEqual(v.inProgressBy, []);
  assert.deepEqual(v.sessions.map((l) => l.sessionId), ['s']);
  assert.equal(v.next, 'ready', '只提到不挡可开工');
  assert.equal(v.gantt.fact, null);
});

test('36.7 只改任务行：只算提到', () => {
  const d = { ...PLAN, path: 'plan.md' };
  const b = withSessions(d, [session('s', [sig('edit', 0, { }, { docPath: 'plan.md', taskNums: ['2'] })])]);
  assert.equal(viewOf(b, 'plan#2').status, 'not_started');
  assert.equal(viewOf(b, 'plan#2').sessions.length, 1);
});

test('36.7 点名后改了代码才算在做，statusSince 是开始工作的时刻', () => {
  const b = withSessions(PLAN, [session('s', [sig('prompt', 0, { nums: ['2'] }), { ...sig('prompt', 5, { nums: ['3'] }), worked: true }])]);
  assert.equal(viewOf(b, 'plan#2').status, 'not_started', '焦点已换走，2 没有工作');
  assert.equal(viewOf(b, 'plan#3').status, 'in_progress');
  assert.equal(viewOf(b, 'plan#3').statusSince, at(5));
});

test('36.7 派活、非 docs 提交、PR 登记、PR 分支都是工作信号', () => {
  assert.equal(viewOf(withSessions(PLAN, [session('s', [sig('dispatch', 0, { nums: ['2'], docIds: ['plan'] })])]), 'plan#2').status, 'in_progress');
  assert.equal(viewOf(withSessions(PLAN, [session('s', [sig('command', 0, { nums: ['2'] })])]), 'plan#2').status, 'in_progress');
  const prs = [merged(5, { title: '任务 2', headRefName: 'b5' })];
  const reg = withSessions({ ...PLAN }, [session('s', [sig('pr-link', 0, {}, { pr: 5 })])], prs);
  assert.ok(viewOf(reg, 'plan#2').sessions[0].workAt);
  const open = [pr(6, { title: '任务 2', headRefName: 'b6' })];
  const br = withSessions({ ...PLAN }, [session('s', [sig('branch', 0, {}, { branch: 'b6' })])], open);
  assert.ok(viewOf(br, 'plan#2').sessions[0].workAt);
});

test('36.7 docs 提交只算提到，也不抢焦点', () => {
  const b = withSessions(PLAN, [session('s', [sig('prompt', 0, { nums: ['2'] }), sig('command', 1, { nums: ['3'] }, { docs: true }), { ...sig('prompt', 2, { docIds: ['plan'] }), worked: true }])]);
  assert.equal(viewOf(b, 'plan#3').status, 'not_started');
  assert.equal(viewOf(b, 'plan#3').sessions.length, 1);
  assert.equal(viewOf(b, 'plan#2').status, 'in_progress', '之后的改动仍算原焦点');
});

test('36.7 只提到的任务不报 l，也不算甘特图的实际时间', () => {
  const d = doc('- [ ] 1 前置\n- [ ] 2 后面（依赖 1）\n');
  const mention = withSessions(d, [session('s', [sig('prompt', 0, { nums: ['2'] })])]);
  assert.deepEqual(mention.conflicts.filter((c) => c.type === 'l'), []);
  const working = withSessions(d, [session('s', [{ ...sig('prompt', 0, { nums: ['2'] }), worked: true }])]);
  assert.deepEqual(working.conflicts.filter((c) => c.type === 'l').map((c) => c.taskKey), ['plan#2']);
});

test('36.7 子 agent：lane 里改代码算在派给它的任务上，不算主线焦点', () => {
  const agent = { ...sig('agent', 2, {}), lane: 'tool-1', worked: true };
  const b = withSessions(PLAN, [session('s', [sig('prompt', 0, { nums: ['2'] }), sig('dispatch', 1, {}, { toolUseId: 'tool-1' }), agent, sig('prompt', 3, { nums: ['3'] })])]);
  assert.equal(viewOf(b, 'plan#2').status, 'in_progress', '没写任务的派活冻结主线焦点');
  assert.equal(viewOf(b, 'plan#3').status, 'not_started');
});

// ---- 36.10 docs 类 PR 只作记录 ----

test('36.10 isRecordTitle：docs、docs(...)、chore(version)，chore(vendor) 等不算', () => {
  for (const t of ['docs: 回写', 'docs(spec): 回写', 'DOCS: x', '[V2] docs: 回写', 'chore(version): 2.0.1', 'docs!: x', 'docs：全角']) assert.equal(isRecordTitle(t), true, t);
  for (const t of ['chore(vendor): 升级', 'chore: 清理', 'fix: docs: 不是', 'docs+fix(collab): 混合', 'documentation: x', null]) assert.equal(isRecordTitle(t), false, String(t));
});

test('36.10 docs PR 不进状态、a、l，任务上留记录、不报 c', () => {
  const d = doc('- [ ] 1 前置\n- [x] 2 勾了（依赖 1）\n- [ ] 3 没勾（依赖 1）\n');
  const b = boardOf(d, [merged(59, { title: 'docs: 任务 2、3 回写交付记录' })]);
  assert.deepEqual(viewOf(b, 'plan#2').prs, []);
  assert.deepEqual(viewOf(b, 'plan#2').mentionedPrs, [{ pr: 59, evidence: '任务 2、3' }]);
  assert.equal(viewOf(b, 'plan#2').docOnly, false);
  assert.equal(viewOf(b, 'plan#2').prRecorded, true);
  assert.equal(viewOf(b, 'plan#3').status, 'not_started');
  assert.deepEqual(b.conflicts.filter((c) => 'acl'.includes(c.type)), []);
  assert.equal(b.prs[0].record, true);
  assert.deepEqual(b.prs[0].tasks, []);
});

test('36.10 open 的 docs PR 不进等待 review；关闭的不算记录；chore(vendor) 照旧关联', () => {
  const d = doc('- [ ] 1 一\n- [x] 2 二\n');
  assert.equal(viewOf(boardOf(d, [pr(5, { title: 'docs: 任务 1' })]), 'plan#1').status, 'not_started');
  assert.equal(viewOf(boardOf(d, [pr(5, { state: 'CLOSED', isDraft: false, title: 'docs: 任务 2' })]), 'plan#2').docOnly, true);
  assert.equal(viewOf(boardOf(d, [pr(5, { title: 'chore(vendor): 任务 1' })]), 'plan#1').status, 'in_review');
});

test('36.10 手动关联仍能让 docs PR 算数', () => {
  const d = doc('- [ ] 1 一\n');
  const p = pr(5, { title: 'docs: 任务 1' });
  const b = computeBoard([d], [p], [], [{ taskKey: 'plan#1', pr: 5, action: 'link', at: NOW }], {}, { id: 'demo' }, NOW);
  assert.equal(viewOf(b, 'plan#1').status, 'in_review');
  assert.deepEqual(viewOf(b, 'plan#1').mentionedPrs, []);
});

test('36.10 手动解除后 docs PR 不再算记录', () => {
  const d = doc('- [x] 1 一\n');
  const p = merged(5, { title: 'docs: 任务 1' });
  const b = computeBoard([d], [p], [], [{ taskKey: 'plan#1', pr: 5, action: 'unlink', at: NOW }], SYNCED([p]), { id: 'demo' }, NOW);
  assert.deepEqual(viewOf(b, 'plan#1').mentionedPrs, []);
  assert.equal(viewOf(b, 'plan#1').docOnly, true);
});

// ---- 36.8 文档有 PR，未写到任务 ----

test('36.8 PR 点了 docId 没写任务号：c 换成 p，状态不变', () => {
  const b = boardOf(PLAN_DONE, [merged(7, { title: 'feat: plan 上线' })]);
  assert.deepEqual(b.conflicts.map((c) => [c.type, c.taskKey]), [['p', 'plan#1'], ['p', 'plan#2']]);
  assert.match(b.conflicts[0].detail, /#7/);
  assert.equal(viewOf(b, 'plan#1').status, 'done');
  assert.equal(viewOf(b, 'plan#1').rule, '8.2-3');
  assert.deepEqual(viewOf(b, 'plan#1').docPrs, [7]);
});

test('36.8 写了任务号的 PR、别的文档的 PR、关闭的 PR、没写 docId 的 PR 都不算', () => {
  const type = (prs) => boardOf(PLAN_DONE, prs).conflicts.map((c) => `${c.type}:${c.taskKey}`);
  assert.deepEqual(type([merged(7, { title: 'feat: plan#1' })]), ['c:plan#2']);
  assert.deepEqual(type([merged(7, { title: 'feat: 随便' })]), ['c:plan#1', 'c:plan#2']);
  assert.deepEqual(type([pr(7, { state: 'CLOSED', isDraft: false, title: 'feat: plan 上线' })]), ['c:plan#1', 'c:plan#2']);
  const two = computeBoard([PLAN_DONE, OTHER], [merged(7, { title: 'feat: other 上线' })], [], [], { 7: { state: 'synced' } }, { id: 'demo' }, NOW);
  assert.deepEqual(two.conflicts.filter((c) => c.taskKey?.startsWith('plan#')).map((c) => c.type), ['c', 'c']);
});

test('36.8 p 只看标题和 Task 行：正文点 docId 仍是 c（owner 2026-11-01）', () => {
  const types = (body) => boardOf(PLAN_DONE, [merged(7, { body })]).conflicts.map((c) => c.type);
  assert.deepEqual(types('Task: plan'), ['p', 'p']);
  assert.deepEqual(types('这次交付 plan 的主体。'), ['c', 'c']);
  assert.deepEqual(types('```\nTask: plan\n```'), ['c', 'c']);
});

// ---- 36.9 规划文档可能没回写 ----

test('36.9 文档一个任务都没完成、有已合并 PR 点名：每份文档报一条 q', () => {
  const b = boardOf(PLAN, [merged(7, { title: 'feat: plan 上线' }), merged(8, { title: 'fix: plan#1' })]);
  const q = b.conflicts.filter((c) => c.type === 'q');
  assert.deepEqual(q.map((c) => c.docId), ['plan']);
  assert.match(q[0].detail, /#7/);
  assert.match(q[0].detail, /#8/);
  assert.equal(q[0].taskKey, undefined);
});

test('36.9 q 继续看正文：只在正文点名也报，「不含」小节不算', () => {
  const q = (body) => boardOf(PLAN, [merged(7, { body })]).conflicts.filter((c) => c.type === 'q').map((c) => c.docId);
  assert.deepEqual(q('这次交付 plan 的主体。'), ['plan']);
  assert.deepEqual(q('## 本 PR 不含\n- plan'), []);
});

test('36.9 有任务完成、PR 没合并、PR 没点名、文档已归档或没有任务都不报', () => {
  const q = (d, prs) => boardOf(d, prs).conflicts.filter((c) => c.type === 'q');
  assert.deepEqual(q(doc('- [x] 1 一\n- [ ] 2 二\n'), [merged(7, { title: 'feat: plan' })]), []);
  assert.deepEqual(q(PLAN, [pr(7, { title: 'feat: plan' })]), []);
  assert.deepEqual(q(PLAN, [merged(7, { title: 'feat: 别的' })]), []);
  assert.deepEqual(q({ ...PLAN, archived: true }, [merged(7, { title: 'feat: plan' })]), []);
  assert.deepEqual(q(doc('没有任务行\n'), [merged(7, { title: 'feat: plan' })]), []);
});

// ---- 36.11 等 owner ----

test('36.11 标题含 需 owner、等 owner、owner 确认 的可开工任务归到等 owner', () => {
  const d = doc('- [ ] 1 需 owner 手测\n- [ ] 2 等owner定方案\n- [ ] 3 部署，Owner 确认后再做\n- [ ] 4 普通\n- [ ] 5 ownership 调整\n- [ ] 6 需 owner 看（依赖 4）\n');
  const b = boardOf(d, []);
  assert.deepEqual(b.tasks.map((v) => v.next), ['owner', 'owner', 'owner', 'ready', 'ready', 'blocked']);
  assert.equal(viewOf(b, 'plan#1').batch, null);
  assert.equal(b.stats.all.ready, 2);
  assert.equal(viewOf(b, 'plan#1').status, 'not_started');
});

// ---- 36.12 ADR 两条线 ----

test('36.12 duplicateDocs：同一份 ADR 两条线各算一次，只在「全部」时算', () => {
  const main = doc('- [ ] 1 一\n- [x] ~~2 旧~~ **【作废 2026-09-01】** 不做了\n- [ ] 3 三\n', 'ADR-0033-x');
  const next = { ...doc('- [ ] 1 一\n- [ ] 2 二\n', 'next:ADR-0033-x'), alias: 'ADR-0033-x', ref: 'origin/next' };
  assert.deepEqual(duplicateDocs({ docs: [main, next] }), { docs: 1, tasks: 2 });
  assert.equal(duplicateDocs({ docs: [next] }), null, '另一份不在就没有重复');
  assert.equal(duplicateDocs({ docs: [main] }), null);
  assert.equal(duplicateDocs({ docs: [main, { ...next, archived: true }] }), null);
});

// ---- #63 review ----

test('36.7 fork：父会话只点名、fork 接着改代码，工作证据归 fork，点名依据不重复', () => {
  const shared = sig('prompt', 0, { nums: ['2'] });
  const r = sess([PLAN], [session('a-parent', [shared], { firstAt: at(0) }), session('b-fork', [{ ...shared, worked: true, until: at(9) }], { firstAt: at(0) })]);
  const of = (id) => r.links.find((l) => l.sessionId === id);
  assert.equal(of('a-parent').workAt, undefined);
  assert.equal(of('a-parent').evidence.length, 1);
  assert.equal(of('b-fork').workAt, at(0));
  assert.equal(of('b-fork').lastAt, at(9));
  assert.deepEqual(of('b-fork').evidence, []);
  const b = withSessions(PLAN, [session('a-parent', [shared], { firstAt: at(0) }), session('b-fork', [{ ...shared, worked: true }], { firstAt: at(0) })]);
  assert.equal(viewOf(b, 'plan#2').status, 'in_progress');
});

test('36.7 fork：共享历史里父会话已经工作过，fork 不重复记', () => {
  const shared = { ...sig('prompt', 0, { nums: ['2'] }), worked: true };
  const r = sess([PLAN], [session('a-parent', [shared], { firstAt: at(0) }), session('b-fork', [shared], { firstAt: at(0) })]);
  assert.deepEqual(r.links.map((l) => l.sessionId), ['a-parent']);
});

test('36.7 fork：共享的 PR 登记、派活本身不算 fork 的工作；fork 改了代码也不重复留依据', () => {
  const prs = [merged(5, { title: '任务 2' })];
  const info = linkPrs([PLAN], prs, { id: 'demo' }).prs;
  const reg = sig('pr-link', 0, {}, { pr: 5 });
  const two = (x, y) => linkSessions([PLAN], [session('a-parent', [x], { firstAt: at(0) }), session('b-fork', [y], { firstAt: at(0) })], prs, info, { id: 'demo' });
  assert.deepEqual(two(reg, reg).links.map((l) => l.sessionId), ['a-parent']);
  const out = sig('dispatch', 0, { nums: ['2'], docIds: ['plan'] });
  assert.deepEqual(two(out, out).links.map((l) => l.sessionId), ['a-parent']);
  const worked = two(out, { ...out, worked: true }).links.find((l) => l.sessionId === 'b-fork');
  assert.ok(worked.workAt);
  assert.deepEqual(worked.evidence, []);
});

test('36.7 同会话的前置要有实际工作才免 l：只问过前置要报，也做了才免', () => {
  const d = doc('- [ ] 1 前置\n- [ ] 2 后面（依赖 1）\n');
  const l = (first) => withSessions(d, [session('s', [first, { ...sig('prompt', 1, { nums: ['2'] }), worked: true }])]).conflicts.filter((c) => c.type === 'l').map((c) => c.taskKey);
  assert.deepEqual(l(sig('prompt', 0, { nums: ['1'] })), ['plan#2'], '只问过 1，再做 2');
  assert.deepEqual(l({ ...sig('prompt', 0, { nums: ['1'] }), worked: true }), [], '1 也做了');
});

test('36.7 fork 链：工作证据只算给最早带它的会话，只复制的不算，真有新增工作的保留', () => {
  const said = sig('prompt', 0, { nums: ['2'] });
  const chain = (c) => sess([PLAN], [session('a', [said], { firstAt: at(0) }), session('b', [{ ...said, worked: at(5) }], { firstAt: at(0) }),
    session('c', [{ ...said, worked: c }], { firstAt: at(0) })]);
  const working = (r) => r.links.filter((l) => l.workAt).map((l) => l.sessionId);
  assert.deepEqual(working(chain(at(5))), ['b'], 'C 只复制了 B 的历史');
  assert.deepEqual(working(chain(at(8))), ['b', 'c'], 'C 复制之后又改了代码');
  assert.deepEqual(working(chain(at(3))), ['b'], 'C 从 B 的中途 fork，只带着更早的工作');
});

// 三种组合：工作证据只走焦点 / lane 的续活动，共享信号自己点到的任务只归最早的会话
const forked = (shared, last, prs = [], info = new Map()) => {
  const mine = (g) => (g === last ? { ...g, worked: at(9) } : g);
  const r = linkSessions([PLAN], [session('a', shared, { firstAt: at(0) }), session('b', shared.map(mine), { firstAt: at(0) })], prs, info, { id: 'demo' });
  return r.links.filter((l) => l.sessionId === 'b').map((l) => [l.taskKey, Boolean(l.workAt)]);
};

test('36.7 fork + lane：已识别子 agent 派任务 2，fork 只在主线改代码，只算主线焦点任务 1', () => {
  const out = sig('dispatch', 1, { nums: ['2'], docIds: ['plan'] }, { toolUseId: 'u' });
  const shared = [sig('prompt', 0, { nums: ['1'] }), out, { ...sig('agent', 2, {}), lane: 'u' }];
  assert.deepEqual(forked(shared, out), [['plan#1', true]]);
});

test('36.7 fork + lane：工作标在子 agent 那一路，算派给它的任务，不算主线', () => {
  const agent = { ...sig('agent', 2, {}), lane: 'u' };
  const shared = [sig('prompt', 0, { nums: ['1'] }), sig('dispatch', 1, { nums: ['2'], docIds: ['plan'] }, { toolUseId: 'u' }), agent];
  assert.deepEqual(forked(shared, agent), [['plan#2', true]]);
});

test('36.7 fork + 分支：共享分支信号的 PR 任务，只有 fork 在这条分支上改了代码才算', () => {
  const prs = [pr(6, { title: '任务 2', headRefName: 'b6' })];
  const info = linkPrs([PLAN], prs, { id: 'demo' }).prs;
  const branch = sig('branch', 0, {}, { branch: 'b6' });
  assert.deepEqual(forked([branch], branch, prs, info), [['plan#2', true]]);
  assert.deepEqual(forked([branch, sig('prompt', 1, { docIds: ['plan'] })], null, prs, info).filter(([, w]) => w), []);
});

test('36.7 fork + PR 登记：共享登记点到的任务不算 fork 的工作，只算当时的焦点', () => {
  const prs = [merged(5, { title: '任务 2' })];
  const info = linkPrs([PLAN], prs, { id: 'demo' }).prs;
  const reg = sig('pr-link', 1, {}, { pr: 5 });
  assert.deepEqual(forked([sig('prompt', 0, { nums: ['1'] }), reg], reg, prs, info), [['plan#1', true]]);
  assert.deepEqual(forked([reg], reg, prs, info), []);
});
