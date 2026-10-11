import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { extractRefs } from '../src/refs.mjs';
import { normalizePr } from '../src/github.mjs';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const isoPair = (p) => p && p.map(iso);
const inline = (text, docId = 't') => ({ docId, archived: false, ...parseTasksDoc(text, docId) });
const byNum = (b) => Object.fromEntries(b.tasks.map((t) => [t.key.split('#')[1], t]));
const pr = (number, over = {}) => ({ number, title: `任务 ${number}`, body: '', url: '', state: 'OPEN', isDraft: false,
  baseRefName: 'main', headRefName: `b${number}`, labels: [], createdAt: '2025-09-21T00:00:00Z', updatedAt: '2025-09-21T00:00:00Z',
  readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null, ...over });

// ---- design §3.10.3 实物推演：collab-m0-space-run 快照 + 实物 PR + 会话样例，now 固定 ----

const NOW = '2025-09-27T00:30:00Z';
const DOC = 'collab-m0-space-run';
const WIDGET = { id: 'widget', repo: { path: '/ws/repo' }, branchLines: [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'],
    docFilter: '^collab-', workspace: '/ws/collab' },
] };
// 会话样例（虚构正文）：s-m0c 在 #360 创建前就开工 M0-c → 3–10 的事实开始取会话；
// s-m0a 只做过 1.4、无 PR → 仅文档确认的 1.4 结束取会话最后活动（§11 已决 5）
const say = (docs, text, at, until, line) => ({ kind: 'prompt', at, until, file: 'r/s.jsonl', line, snippet: text,
  refs: extractRefs(text, { knownDocIds: docs.map((d) => d.docId), knownCodes: docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)) }) });
const session = (id, signals) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/collab'], branches: [], title: id,
  firstAt: signals[0].at, lastAt: signals.at(-1).until, lastSummary: null, signals, aiOnlyMentions: 0, brokenLines: 0 });

function realBoard() {
  const doc = inline(readFileSync(new URL(`./fixtures/${DOC}.tasks.md`, import.meta.url), 'utf8'), DOC);
  const prs = JSON.parse(readFileSync(new URL('./fixtures/prs.json', import.meta.url), 'utf8')).map(normalizePr);
  const sessions = [
    session('s-m0c', [say([doc], `${DOC} 的 M0-c 开工`, '2025-09-25T01:00:00.000Z', '2025-09-25T02:30:00.000Z', 1)]),
    session('s-m0a', [say([doc], `${DOC} 任务 1.4`, '2025-09-21T02:00:00.000Z', '2025-09-21T06:00:00.000Z', 1)]),
  ];
  const sync = { 360: { state: 'synced', reason: null }, 365: { state: 'pending', reason: null } };
  return computeBoard([doc], prs, sessions, [], sync, WIDGET, NOW, { hoursPerDay: 8, defaultDurationDays: 1 });
}

// 期望表：一行一个任务（文档顺序），时间写 ISO 便于人工核对
function expectedShape(b) {
  const rows = b.tasks.map((v) => {
    const g = v.gantt;
    return { n: v.key.split('#')[1], status: v.status, syncPending: v.syncPending, fact: isoPair(g.fact), factFrom: g.factFrom,
      endFromSession: g.endFromSession, est: isoPair(g.est), defaultDuration: g.defaultDuration, overdue: g.overdue,
      noTime: g.noTime, unschedulable: g.unschedulable, span: isoPair(g.span) };
  });
  const s = (x) => ({ done: x.done, total: x.total, estEnd: iso(x.estEnd), unschedulable: x.unschedulable, noTime: x.noTime });
  const d = b.gantt.docs[0];
  const code = new Map(b.docs[0].groups.map((g) => [g.id, g.code ?? g.title.slice(0, 12)]));
  return { now: NOW, rows, groups: d.groups.map((g) => ({ group: code.get(g.groupId), ...s(g) })), doc: s(d), all: s(b.gantt.all) };
}
const lines = (x) => `{\n"now": ${JSON.stringify(x.now)},\n"rows": [\n${x.rows.map((r) => JSON.stringify(r)).join(',\n')}\n],\n`
  + `"groups": [\n${x.groups.map((r) => JSON.stringify(r)).join(',\n')}\n],\n"doc": ${JSON.stringify(x.doc)},\n"all": ${JSON.stringify(x.all)}\n}\n`;

const EXPECTED = new URL('./fixtures/expected-gantt.json', import.meta.url);

test('design §3.10.3：collab-m0-space-run 甘特排布与 expected-gantt.json 逐行一致', () => {
  const actual = expectedShape(realBoard());
  // 规则有意改动时：UPDATE_GANTT=1 npm test 重新生成，再逐行人工核对 diff
  if (process.env.UPDATE_GANTT) writeFileSync(EXPECTED, lines(actual));
  assert.deepEqual(actual, JSON.parse(readFileSync(EXPECTED, 'utf8')));
});

test('design §3.10.3 期望表要点（基线之外再直接断言一遍）', () => {
  const b = realBoard();
  const t = byNum(b);
  const prs = JSON.parse(readFileSync(new URL('./fixtures/prs.json', import.meta.url), 'utf8')).map(normalizePr);
  const P = (n) => prs.find((p) => p.number === n);
  // 3–10：事实段 [min(会话 firstAt, #360 createdAt), #360 mergedAt]
  for (const n of ['3', '4.1', '10.2']) {
    assert.deepEqual(isoPair(t[n].gantt.fact), ['2025-09-25T01:00:00.000Z', iso(Date.parse(P(360).mergedAt))], n);
    assert.deepEqual(t[n].gantt.factFrom, ['会话 s-m0c', 'PR #360']);
  }
  // 11–12：待同步，事实段结束 = #365 mergedAt
  for (const n of ['11.1', '12.2']) {
    assert.deepEqual([t[n].status, t[n].syncPending], ['awaiting_merge', [365]]);
    assert.deepEqual(isoPair(t[n].gantt.fact), [iso(Date.parse(P(365).createdAt)), iso(Date.parse(P(365).mergedAt))]);
  }
  // 18.1–18.6：仅文档确认、无会话 → 无时间
  for (const n of ['18.1', '18.6']) assert.deepEqual([t[n].gantt.noTime, t[n].gantt.fact], [true, null]);
  // 1.4：仅文档确认、有会话 → 结束取自会话（无 PR）
  assert.deepEqual([isoPair(t['1.4'].gantt.fact), t['1.4'].gantt.endFromSession],
    [['2025-09-21T02:00:00.000Z', '2025-09-21T06:00:00.000Z'], true]);
  // 15.2：等待 review；事实 [#372 createdAt, now]；预估 [now, createdAt + 1 天]、默认工期
  const c372 = Date.parse(P(372).createdAt);
  assert.deepEqual(t['15.2'].gantt.fact, [c372, Date.parse(NOW)]);
  assert.deepEqual([t['15.2'].gantt.est, t['15.2'].gantt.defaultDuration], [[Date.parse(NOW), c372 + 864e5], true]);
  // 13、14 外部阻塞；15.1、16、17 前置无法排期
  assert.deepEqual(t['13'].gantt.unschedulable, ['外部前置 P1\u2063、P5']);
  assert.deepEqual(t['14'].gantt.unschedulable, ['外部前置 P1']);
  assert.deepEqual(t['15.1'].gantt.unschedulable, ['前置 13\u2063、14 无法排期']);
  assert.deepEqual(t['16'].gantt.unschedulable, ['前置 13\u2063、14\u2063、15.1 无法排期']);
  assert.deepEqual(t['17'].gantt.unschedulable, ['前置 16 无法排期']);
  // 分组 M0-e：完成 0/2，预估完成日「—（不含 2 个无法排期任务）」
  const e = b.gantt.docs[0].groups[b.docs[0].groups.findIndex((g) => g.code === 'M0-e')];
  assert.deepEqual([e.done, e.total, e.estEnd, e.unschedulable], [0, 2, null, 2]);
  // 父任务 15：汇总条 = 15.2 的事实 + 预估
  assert.deepEqual(t['15'].gantt.span, [c372, c372 + 864e5]);
  assert.deepEqual([t['15'].gantt.fact, t['15'].gantt.est], [null, null], '父任务不单独排');
});

// ---- 合成用例：环、悬空、外部阻塞传染、进行中被阻塞仍画事实段、排布与汇总 ----

const G_NOW = '2025-09-27T00:00:00.000Z';
const nowMs = Date.parse(G_NOW);
const D = 864e5;
const gBoard = (text, { prs = [], defaults } = {}) => byNum(computeBoard([inline(text)], prs, [], [], {}, { id: 'demo' }, G_NOW, defaults));

test('依赖成环：环上任务无法排期、不编造预估；下游被传染', () => {
  const t = gBoard(`## 分组

- [ ] 1 甲（依赖 2）
- [ ] 2 乙（依赖 1）
- [ ] 3 丙（依赖 2）
- [ ] 4 丁
`);
  assert.deepEqual([t['1'].gantt.unschedulable, t['2'].gantt.unschedulable], [['依赖成环'], ['依赖成环']]);
  assert.deepEqual([t['1'].gantt.est, t['1'].gantt.fact], [null, null]);
  assert.deepEqual(t['3'].gantt.unschedulable, ['前置 2 无法排期']);
  assert.deepEqual([t['4'].gantt.unschedulable, t['4'].gantt.est], [null, [nowMs, nowMs + D]], '不相干的任务照常排');
});

test('悬空依赖：无法排期并写出原文；下游被传染', () => {
  const t = gBoard(`## 分组

- [ ] 1 甲（依赖 9）
- [ ] 2 乙（依赖 1）
`);
  assert.deepEqual(t['1'].gantt.unschedulable, ['悬空依赖：9']);
  assert.deepEqual(t['2'].gantt.unschedulable, ['前置 1 无法排期']);
  assert.equal(t['2'].gantt.est, null);
});

test('外部阻塞沿依赖链传染到整条下游；划掉 P 后恢复排期', () => {
  const doc = (p) => `# 计划

| 编号 | 事项 | 阻塞 |
|---|---|---|
| ${p} | 沙箱访问 | 1 |

## 分组

- [ ] 1 要沙箱（需要 P1）
- [ ] 2 乙（依赖 1）
- [ ] 3 丙（依赖 2）
`;
  const t = gBoard(doc('P1'));
  assert.deepEqual(['1', '2', '3'].map((n) => t[n].gantt.unschedulable), [['外部前置 P1'], ['前置 1 无法排期'], ['前置 2 无法排期']]);
  assert.ok(['1', '2', '3'].every((n) => t[n].gantt.est === null));
  const ok = gBoard(doc('~~P1~~'));
  assert.deepEqual(['1', '2', '3'].map((n) => ok[n].gantt.est), [[nowMs, nowMs + D], [nowMs + D, nowMs + 2 * D], [nowMs + 2 * D, nowMs + 3 * D]]);
});

test('进行中被阻塞：照样画事实段到今天，但不给预估', () => {
  const text = `# 计划

| 编号 | 事项 | 阻塞 |
|---|---|---|
| P1 | 沙箱访问 | 1 |

## 分组

- [ ] 1 要沙箱（需要 P1）
`;
  const t = gBoard(text, { prs: [pr(1, { createdAt: '2025-09-25T00:00:00Z' })] });
  assert.equal(t['1'].status, 'awaiting_merge');
  assert.deepEqual(t['1'].gantt.fact, [nowMs - 2 * D, nowMs]);
  assert.deepEqual(t['1'].gantt.factFrom, ['PR #1']);
  assert.deepEqual([t['1'].gantt.est, t['1'].gantt.unschedulable], [null, ['外部前置 P1']]);
});

test('排布：未开始排在前置结束之后且不早于今天；工期按预计耗时 ÷ 每日工时；已开工超期只标超出预计', () => {
  const text = `## 分组

- [x] 1 已做完没时间
- [ ] 2 开着 PR（依赖 1）
  - **预计耗时**：半天
- [ ] 3 等 2（依赖 2）
  - **预计耗时**：2 小时
- [ ] 4 超期
- [~] 5 只有标记（依赖 3）
- [ ] 6 父
- [ ] 6.1 子一（依赖 3）
- [ ] 6.2 子二（依赖 6.1）
`;
  const prs = [pr(2, { createdAt: '2025-09-26T20:00:00Z' }), pr(4, { title: '任务 4', createdAt: '2025-09-21T00:00:00Z' })];
  const t = gBoard(text, { prs, defaults: { hoursPerDay: 8, defaultDurationDays: 2 } });
  assert.deepEqual([t['1'].gantt.noTime, t['1'].gantt.fact], [true, null], '已完成无事实 → 无时间、不约束后继');
  // 2：半天 = 4 小时 → 轴上 12 小时，从开 PR 起算，剩余部分从今天画起
  const c2 = Date.parse('2025-09-26T20:00:00Z');
  assert.deepEqual([t['2'].gantt.fact, t['2'].gantt.est, t['2'].gantt.defaultDuration], [[c2, nowMs], [nowMs, c2 + D / 2], false]);
  // 3：2 小时 = 1/4 天，排在 2 的预估结束之后
  assert.deepEqual(t['3'].gantt.est, [c2 + D / 2, c2 + 0.75 * D]);
  // 4：默认 2 天，开始 6 天前 → 超出预计，不给预估
  assert.deepEqual([t['4'].gantt.overdue, t['4'].gantt.est, t['4'].gantt.fact], [true, null, [nowMs - 6 * D, nowMs]]);
  // 5：只有 [~]、无事实时间 → 按未开始排，默认工期
  assert.deepEqual([t['5'].status, t['5'].gantt.fact, t['5'].gantt.est, t['5'].gantt.defaultDuration],
    ['in_progress', null, [c2 + 0.75 * D, c2 + 2.75 * D], true]);
  // 父任务 6 不单独排，span = 子任务范围并集
  assert.deepEqual([t['6'].gantt.est, t['6'].gantt.span], [null, [c2 + 0.75 * D, c2 + 4.75 * D]]);
});

test('汇总：完成数 / 总数（不含作废）、预估完成日取预估段最晚结束、注明无法排期与无时间个数；全局不含归档', () => {
  const text = `# 计划

| 编号 | 事项 | 阻塞 |
|---|---|---|
| P1 | 沙箱访问 | 3 |

## 甲组

- [x] 1 完成无时间
- [ ] 2 乙
- [ ] 9 （作废）不要了

## 乙组

- [ ] 3 被卡（需要 P1）
`;
  const b = computeBoard([inline(text), inline(text, 'old'), { ...inline(text, 'arch'), archived: true }], [], [], [], {}, { id: 'demo' }, G_NOW);
  const [d] = b.gantt.docs;
  assert.deepEqual(d.groups.map((g) => [g.done, g.total, g.estEnd, g.unschedulable, g.noTime]),
    [[1, 2, nowMs + D, 0, 1], [0, 1, null, 1, 0]]);
  assert.deepEqual([d.done, d.total, d.estEnd, d.unschedulable, d.noTime], [1, 3, nowMs + D, 1, 1]);
  assert.deepEqual([b.gantt.all.done, b.gantt.all.total, b.gantt.all.unschedulable], [2, 6, 2], '归档文档不进全局');
});

test('同输入同 now 结果相同', () => {
  assert.deepEqual(expectedShape(realBoard()), expectedShape(realBoard()));
});


test('未勾选的待同步任务仍保留剩余工期；只有已勾选才能以合并时间结束', () => {
  for (const partial of ['', '（部分）']) for (const checked of [' ', 'x']) {
    const doc = inline(`## 分组\n\n- [${checked}] 1 验收\n  - **预计耗时**：10 天\n- [ ] 2 发布（依赖 1）\n`);
    const p = pr(1, { title: `任务 1${partial}`, state: 'MERGED', mergedAt: '2025-09-22T00:00:00Z' });
    const t = byNum(computeBoard([doc], [p], [], [], { 1: { state: 'pending' } }, { id: 'demo' }, G_NOW));
    assert.equal(t['1'].status, 'awaiting_merge');
    assert.equal(t['1'].gantt.fact[1], checked === 'x' ? Date.parse(p.mergedAt) : nowMs);
    assert.deepEqual(t['1'].gantt.est, checked === 'x' ? null : [nowMs, Date.parse('2025-10-01T00:00:00Z')]);
    assert.equal(t['2'].gantt.est[0], checked === 'x' ? nowMs : Date.parse('2025-10-01T00:00:00Z'));
    assert.deepEqual(t['2'].deps.unmet, ['t#1']);
  }
});
