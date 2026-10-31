import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard, classifyNext, linkPrs } from '../src/engine.mjs';
import { extractRefs } from '../src/refs.mjs';
import { normalizePr } from '../src/github.mjs';
import { parseAdrDoc } from '../src/adr.mjs';

const NOW = '2025-09-27T08:00:00.000Z';
// PlanDoc 由 1.3 拼装；这里直接用 parseTasksDoc 的结果补上 docId / archived
const planDoc = (name, extra = {}) => ({
  docId: name, archived: false,
  ...parseTasksDoc(readFileSync(new URL(`./fixtures/${name}.tasks.md`, import.meta.url), 'utf8'), name),
  ...extra,
});
// collab 实物里 15.1 的前置（13、14）只写在文末 Mermaid 图里，由任务 2.2 解析成 via:'mermaid' 的 dep。
// 本分支没有 2.2 时按同形状补这一条；2.2 合入后解析结果已含 Mermaid 关系，就不再补。
const collab = () => {
  const d = planDoc('collab-m0-space-run');
  if (d.relations.some((r) => r.via === 'mermaid')) return d;
  const ref = (n) => ({ raw: n, type: 'task', keys: [`collab-m0-space-run#${n}`], dangling: false });
  const source = { file: 'collab-m0-space-run', line: 744, text: 'T5 --> D1' };
  d.relations.push({ kind: 'dep', subjects: [ref('15.1')], objects: [ref('13'), ref('14')], via: 'mermaid', source });
  return d;
};
// 行内小文档：直接从字符串解析，docId 默认 t
const inline = (text, docId = 't') => ({ docId, archived: false, ...parseTasksDoc(text, docId) });
const board = (docs) => computeBoard(docs, [], [], [], {}, { id: 'demo' }, NOW);
const byNum = (b) => Object.fromEntries(b.tasks.map((t) => [t.key.split('#')[1], t]));

test('文档信号可达的三态：已勾 → 仅文档确认；[~] → 进行中（标记）；未勾 → 未开始', () => {
  const t = byNum(board([planDoc('synthetic-inline')]));
  assert.deepEqual([t['1.1'].status, t['1.1'].rule, t['1.1'].docOnly], ['done', '8.2-3', true]);
  assert.deepEqual([t['1.2'].status, t['1.2'].rule, t['1.2'].inProgressBy], ['in_progress', '8.2-4', ['marker']]);
  assert.deepEqual([t['1.3'].status, t['1.3'].rule, t['1.3'].docOnly], ['not_started', '8.2-5', false]);
  assert.equal(t['6'].status, 'not_started', '奇怪的复选框字符按未勾');
  assert.ok(Object.values(t).every((v) => v.statusSince === null && v.prs.length === 0));
});

test('N28 未接 GitHub：已勾选照旧完成，但不标仅文档确认、不报冲突 c；接了 GitHub 照旧标', () => {
  const run = (repo) => byNum(computeBoard([planDoc('synthetic-inline')], [], [], [], {}, { id: 'demo', repo }, NOW));
  const off = run({ path: '/ws/repo' });
  assert.deepEqual([off['1.1'].status, off['1.1'].rule, off['1.1'].docOnly], ['done', '8.2-3', false]);
  assert.ok(Object.values(off).every((v) => !v.conflicts.includes('c')));
  const on = run({ path: '/ws/repo', github: 'acme/demo' });
  assert.deepEqual([on['1.1'].docOnly, on['1.1'].conflicts.includes('c')], [true, true]);
});

test('作废任务不给状态、不计入分母', () => {
  const b = board([planDoc('synthetic-inline')]);
  const t = byNum(b);
  assert.equal(t['2.6'].status, null); // 整体删除线 + 【作废】
  assert.equal(t['2.7'].status, null); // 标题写（作废）
  assert.equal(t['2.8'].status, 'done', '局部删除线不算作废');
  // 21 条任务里 2.6、2.7 作废
  assert.equal(b.tasks.length, 21);
  assert.equal(b.stats.all.total, 19);
  assert.deepEqual(b.stats.all.counts, { not_started: 13, in_progress: 1, in_review: 0, awaiting_merge: 0, done: 5 });
  const doc = b.docs[0];
  const voidGroupId = doc.tasks.find((x) => x.number === '2.6').groupId;
  const g = b.stats.docs[0].groups.find((x) => x.groupId === voidGroupId);
  assert.deepEqual([g.total, g.ratio], [2, 1], '「作废与删除线」分组 4 条里只算 2.8、2.9 两条');
});

test('父任务：自身状态 + 直接子任务汇总「已完成 x / 未作废子任务 y」', () => {
  const t = byNum(board([planDoc('synthetic-inline')]));
  assert.deepEqual(t['1'].childSummary, { done: 1, total: 3 });
  assert.equal(t['1'].status, 'not_started', '汇总不覆盖父任务自身状态');
  assert.deepEqual(t['2'].childSummary, { done: 2, total: 5 }, '2.6、2.7 作废不进分母');
  assert.deepEqual(t['4a'].childSummary, { done: 0, total: 1 });
  assert.equal(t['1.1'].childSummary, null, '叶子没有汇总');

  const c = byNum(board([planDoc('collab-m0-space-run')]));
  assert.deepEqual(c['2'].childSummary, { done: 11, total: 11 });
  assert.deepEqual([c['15'].status, c['15'].childSummary], ['not_started', { done: 1, total: 2 }]);
});

test('统计：按文档 → 分组与全局；已归档文档不进全局；无任务文档比例为 null', () => {
  const real = collab();
  const b = board([real, planDoc('synthetic-inline', { archived: true }), { docId: 'plan-only', archived: false, groups: [], tasks: [] }]);
  assert.deepEqual(b.stats.all.counts, { not_started: 6, in_progress: 0, in_review: 0, awaiting_merge: 0, done: 58 });
  assert.equal(b.stats.all.total, 64);
  assert.equal(b.stats.all.ratio, 58 / 64);
  assert.deepEqual([b.stats.all.ready, b.stats.all.inProgressStale, b.stats.all.syncPending], [0, 0, 0]);

  const [d0, d1, d2] = b.stats.docs;
  assert.deepEqual(d0.groups.map((g) => g.groupId), real.groups.map((g) => g.id));
  assert.deepEqual(d0.groups.map((g) => g.total), [10, 12, 22, 6, 7, 2, 5]);
  assert.equal(d0.groups.at(-1).ratio, 1 / 5);
  assert.equal(d1.total, 19, '已归档文档自身统计照算');
  assert.deepEqual([d2.total, d2.ratio, d2.groups], [0, null, []]);
});

test('Board 结构齐全；docs 去掉 relations；固定 now 结果可重复', () => {
  const docs = [{ ...planDoc('synthetic-inline'), relations: [] }];
  const b = board(docs);
  assert.equal(b.computedAt, NOW);
  assert.equal(b.projectId, 'demo');
  assert.equal('relations' in b.docs[0], false);
  for (const k of ['version', 'freshness', 'degraded', 'workspaces', 'prs', 'sessions', 'conflicts', 'diagnostics']) {
    assert.ok(k in b, k);
  }
  assert.deepEqual(board(docs), b);
  assert.equal(computeBoard(docs, [], [], [], {}, { id: 'demo' }, new Date(NOW)).computedAt, NOW);
});

// ---- 任务 2.4：依赖展开、成环、下一步、文档侧冲突 ----

test('依赖展开：引用到叶子、子任务继承父依赖（标继承来源）、排除自身 / 祖先 / 后代、作废前置算已满足', () => {
  const t = byNum(board([inline(`## 分组

- [ ] 3 父任务三
- [ ] 3.1 子一
- [x] 3.2 子二
- [x] ~~3.3 作废的子任务~~ 【作废】
- [ ] 4 父任务四（依赖 3）
- [ ] 4.1 子（依赖 3.1）
- [ ] 5 父任务五（依赖 5.2）
- [ ] 5.1 子
- [ ] 5.2 子
`)]));
  assert.deepEqual(t['4'].deps.on, ['t#3.1', 't#3.2'], '父任务号展开为未作废叶子');
  assert.deepEqual(t['4.1'].deps.on, ['t#3.1', 't#3.2'], '4.1 继承 4 的依赖');
  const e31 = t['4.1'].deps.edges.find((e) => e.on === 't#3.1');
  assert.deepEqual(e31.sources.map((s) => s.inheritedFrom), [null, 't#4'], '同一对叶→叶只留一条边，直接与继承两处来源合并');
  assert.equal(t['4.1'].deps.edges.find((e) => e.on === 't#3.2').sources[0].inheritedFrom, 't#4');
  assert.deepEqual(t['4.1'].deps.unmet, ['t#3.1']);
  assert.deepEqual(t['5'].deps.on, [], '父任务依赖自己的子任务 → 排除');
  assert.deepEqual([t['5.1'].deps.on, t['5.2'].deps.on], [[], []], '继承时同样排除，5.1 不会去等 5.2');

  const s = byNum(board([planDoc('synthetic-inline')]));
  const b = s['2.5b'].deps; // 「依赖 2.x」：含自己与作废的 2.6、2.7
  assert.ok(!b.on.includes('synthetic-inline#2.5b'), '排除依赖方自己');
  assert.ok(b.on.includes('synthetic-inline#2.6'), '作废前置保留在 on 里供页面注明「前置已作废」');
  assert.deepEqual(b.unmet, ['synthetic-inline#2.10', 'synthetic-inline#2.5'], '作废与已完成的前置不算未满足');
  assert.deepEqual([s['8'].deps.on, s['8'].deps.inCycle], [['synthetic-inline#7'], false], '「依赖 8」自依赖被排除，不成环');
  assert.deepEqual(s['1.3'].deps.on, ['synthetic-inline#0.1', 'synthetic-inline#20'], '分组说明段「本组依赖 阶段 0」');
});

test('并行两端可见且不继承；Mermaid 与文字重复的依赖只算一条边', () => {
  const d = inline(`## 分组

- [ ] 1 甲（可与 2 并行）
- [ ] 1.1 甲的子任务
- [ ] 2 乙
- [ ] 3 丙（依赖 2）
`);
  const src = { file: 't', line: 99, text: 'B --> C' };
  const ref = (n) => ({ raw: n, type: 'task', keys: [`t#${n}`], dangling: false });
  d.relations.push({ kind: 'dep', subjects: [ref('3')], objects: [ref('2')], via: 'mermaid', source: src });
  const t = byNum(board([d]));
  assert.deepEqual([t['1'].parallelWith, t['2'].parallelWith], [['t#2'], ['t#1']]);
  assert.deepEqual(t['1.1'].parallelWith, [], '并行不继承');
  assert.deepEqual(t['3'].deps.edges, [{ on: 't#2', sources: [
    { via: 'title', source: d.relations[1].source, inheritedFrom: null },
    { via: 'mermaid', source: src, inheritedFrom: null },
  ] }]);
});

test('环：Tarjan 标出环上全部任务、不死循环；在环与悬空的任务进需要确认', () => {
  const b = board([inline(`## 分组

- [ ] 1 甲（依赖 2）
- [ ] 2 乙（依赖 3）
- [ ] 3 丙（依赖 1）
- [ ] 4 丁（依赖 3）
`)]);
  const t = byNum(b);
  assert.deepEqual(['1', '2', '3', '4'].map((n) => t[n].deps.inCycle), [true, true, true, false]);
  assert.deepEqual(t['1'].deps.cycleWith, ['t#3', 't#2']);
  assert.deepEqual(['1', '2', '3', '4'].map((n) => t[n].next), ['confirm', 'confirm', 'confirm', 'blocked']);

  const s = byNum(board([planDoc('synthetic-inline')]));
  assert.equal(s['4a.1'].next, 'confirm', '依赖 9.9 悬空');
  assert.deepEqual(s['4a.1'].deps.dangling.map((x) => [x.line, x.raw]), [[47, '9.9']]);
});

test('跨文档任务键：目标存在按其状态判定，不存在记悬空', () => {
  const b = inline('## 分组\n\n- [ ] 1 用到 A（依赖 a#2）\n', 'b');
  const a = inline('## 分组\n\n- [ ] 1 一\n- [x] 2 二\n', 'a');
  const tb = board([a, b]).tasks.find((v) => v.key === 'b#1');
  assert.deepEqual([tb.deps.on, tb.deps.dangling, tb.next], [['a#2'], [], 'ready']);
  const alone = board([b]).tasks[0];
  assert.deepEqual([alone.deps.on, alone.deps.dangling.map((x) => x.raw), alone.next], [[], ['a#2'], 'confirm']);
});

test('外部阻塞：前置表 P 编号未解除 → 被阻塞；划掉后 → 可开工；子任务继承外部阻塞', () => {
  const doc = (p) => inline(`# 计划

| 编号 | 事项 | 阻塞 |
|---|---|---|
| ${p} | 沙箱访问 | 1 |

## 分组

- [ ] 1 要沙箱
- [ ] 2 父任务（需要 P1）
- [ ] 2.1 子任务
`);
  const before = byNum(board([doc('P1')]));
  assert.deepEqual(before['1'].deps.external, [{ id: 'P1', resolved: false }]);
  assert.deepEqual([before['1'].next, before['2.1'].next], ['blocked', 'blocked']);
  assert.deepEqual(before['2.1'].deps.external, [{ id: 'P1', resolved: false }], '继承父任务的外部阻塞');
  const after = byNum(board([doc('~~P1~~')]));
  assert.deepEqual(after['1'].deps.external, [{ id: 'P1', resolved: true }]);
  assert.deepEqual([after['1'].next, after['2.1'].next], ['ready', 'ready']);
});

test('下一步：只对未开始的叶子分类，父任务不笼统出现；可开工按并行边分批', () => {
  const b = board([inline(`## 分组

- [ ] 1 甲（可与 2 并行）
- [ ] 2 乙
- [ ] 3 丙（与 4 并行）
- [ ] 4 丁
- [ ] 5 戊
- [ ] 6 父任务
- [ ] 6.1 子任务（可与 5 并行）
- [~] 7 进行中（可与 5 并行）
- [ ] 8 等 7（依赖 7；可与 1 并行）
`)]);
  const t = byNum(b);
  assert.deepEqual(['1', '2', '3', '4', '5', '6.1'].map((n) => t[n].batch), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual([t['6'].next, t['6'].batch], [null, null], '父任务不出现在可开工');
  assert.deepEqual([t['7'].next, t['7'].batch], [null, null], '进行中的任务不分类');
  assert.deepEqual([t['8'].next, t['8'].batch], ['soon', null], '前置还在进行中 → 即将可开工（UI 稿口径），不并入 1 的那一批');
  assert.equal(b.stats.all.ready, 6);
});

test('即将可开工：未满足的前置全处于进行中 / 等待 review / 等待合并；混有未开始则被阻塞', () => {
  const v = (key, status, on = []) => ({ key, status, childSummary: null, parallelWith: [], next: null, batch: null,
    deps: { on, unmet: [], dangling: [], external: [], inCycle: false } });
  const views = [v('a', 'in_review'), v('b', 'awaiting_merge'), v('c', 'in_progress'), v('d', 'done'), v('e', 'not_started'),
    v('x', 'not_started', ['a', 'b', 'd']), v('y', 'not_started', ['a', 'c']), v('z', 'not_started', ['d']), v('w', 'not_started', ['c', 'e'])];
  classifyNext(views);
  const t = Object.fromEntries(views.map((x) => [x.key, x]));
  assert.deepEqual([t.x.next, t.x.deps.unmet], ['soon', ['a', 'b']]);
  // UI 稿口径：前置进行中也算即将可开工；混有未开始的前置才算被阻塞。
  assert.deepEqual([t.y.next, t.w.next, t.z.next, t.z.batch], ['soon', 'blocked', 'ready', 2], 'e 无前置、按文档顺序先占第 1 批');
});

test('文档侧冲突 c、e、f、g、k 各一正一反', () => {
  const s = board([planDoc('synthetic-inline')]);
  const t = byNum(s);
  assert.ok(t['1.1'].conflicts.includes('c') && !t['1.3'].conflicts.includes('c'), 'c 仅文档确认');
  const dup = s.tasks.filter((v) => v.conflicts.includes('e')).map((v) => v.key);
  assert.deepEqual(dup, ['synthetic-inline#3', 'synthetic-inline#3~2'], 'e 重复编号两条都标，其余不标');
  assert.ok(t['4a.1'].conflicts.includes('f') && !t['4a'].conflicts.includes('f'), 'f 悬空依赖');
  const f = s.conflicts.find((c) => c.type === 'f');
  assert.deepEqual([f.taskKey, f.source.line, f.detail], ['synthetic-inline#4a.1', 47, '依赖了找不到的对象：9.9']);
  assert.equal(t['2.6'].conflicts.length, 0, '作废任务不查 c');

  const g = byNum(board([inline('## 分组\n\n- [ ] 1 甲（依赖 2）\n- [ ] 2 乙（依赖 1）\n- [ ] 3 丙（依赖 2）\n')]));
  assert.deepEqual(['1', '2', '3'].map((n) => g[n].conflicts), [['g'], ['g'], []]);

  const k = board([inline(`## 分组

- [x] 1 父已完成
- [ ] 1.1 子未完成
- [ ] 2 父未开始
- [x] 2.1 子已完成
- [ ] 3 父未开始
- [ ] 3.1 子未完成
- [x] 3.2 子已完成
`)]);
  const kk = byNum(k);
  assert.deepEqual(['1', '2', '3'].map((n) => kk[n].conflicts.includes('k')), [true, true, false]);
  assert.deepEqual(k.conflicts.filter((c) => c.type === 'k').map((c) => c.detail),
    ['父任务已完成，但子任务只完成 0 / 1', '子任务已全部完成（1 个），父任务还是未开始']);
});

test('collab-m0-space-run 实物推演：13、14、15.1、16、17 全部被阻塞，可开工为空', () => {
  const b = board([collab()]);
  const t = byNum(b);
  const open = b.tasks.filter((v) => v.next).map((v) => [v.key.split('#')[1], v.next]);
  assert.deepEqual(open, [['13', 'blocked'], ['14', 'blocked'], ['15.1', 'blocked'], ['16', 'blocked'], ['17', 'blocked']]);
  assert.equal(b.stats.all.ready, 0);
  assert.equal(t['15'].next, null, '父任务 15 不笼统出现');
  assert.deepEqual(t['13'].deps.external, [{ id: 'P1', resolved: false }, { id: 'P2', resolved: true }, { id: 'P5', resolved: false }]);
  assert.deepEqual([t['13'].deps.unmet, t['14'].deps.external], [[], [{ id: 'P1', resolved: false }]]);
  assert.deepEqual(t['15.1'].deps.unmet, ['collab-m0-space-run#13', 'collab-m0-space-run#14']);
  assert.ok(['13', '14', '15.1'].every((n) => t['16'].deps.unmet.includes(`collab-m0-space-run#${n}`)), '16 依赖 1–15 展开到叶子');
  assert.deepEqual(t['17'].deps.unmet, ['collab-m0-space-run#16']);
  assert.ok(b.tasks.every((v) => !v.deps.inCycle && !v.deps.dangling.length));
});

// ---- 任务 3.4：PR 关联与五态判定 ----

const PRS = JSON.parse(readFileSync(new URL('./fixtures/prs.json', import.meta.url), 'utf8')).map(normalizePr);
const fixturePr = (n) => PRS.find((p) => p.number === n);
// 实物配置：个人版 base main；协作版 base v2 分支、[V2] 前缀、collab-v2 标签、独立工作区
const WIDGET = { id: 'widget', repo: { path: '/ws/repo' }, branchLines: [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'],
    docFilter: '^collab-', workspace: '/ws/collab' },
] };
const prBoard = (docs, prs, sync = {}, config = { id: 'demo' }) => computeBoard(docs, prs, [], [], sync, config, NOW);
// 合成 PR：默认 open、ready、base main
const pr = (number, over = {}) => ({ number, title: `任务 ${number}`, body: '', url: '', state: 'OPEN', isDraft: false,
  baseRefName: 'main', headRefName: `b${number}`, labels: [], createdAt: '2025-09-21T00:00:00Z', updatedAt: '2025-09-21T00:00:00Z',
  readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null, ...over });
const merged = (number, over = {}) => pr(number, { state: 'MERGED', mergedAt: '2025-09-23T00:00:00Z', mergeCommit: 'a'.repeat(40), ...over });
const SIMPLE = `## 分组

- [ ] 1 甲
- [ ] 2 乙（依赖 1）
- [x] 3 丙
- [ ] 4 丁
`;

test('N1：PR 关联只证明进展，未勾选不能完成或放行下游（标题、否定正文、里程碑、部分与手动）', () => {
  const d = inline('### 里程碑 M0-a\n\n- [ ] 1 验收\n\n### 发布\n\n- [ ] 2 发布（依赖 1）\n');
  for (const [title, body, manual] of [
    ['任务 1', '', []],
    ['修补', '任务 1 未完成', []],
    ['修补', '不替代任务1全量审计', []],
    ['修补', '背景 M0-a', []],
    ['任务 1（部分）', '', []],
    ['任务 1（部分）', '', [{ taskKey: 't#1', pr: 10, action: 'link', at: NOW }]],
  ]) {
    const b = computeBoard([d], [merged(10, { title, body })], [], manual, { 10: { state: 'synced' } }, { id: 'demo' }, NOW);
    const t = byNum(b);
    assert.equal(t['1'].status, 'in_progress', title + body);
    assert.equal(t['1'].prs.length, 1, '保留关联证据');
    assert.deepEqual(t['2'].deps.unmet, ['t#1']);
    assert.equal(t['2'].next, 'soon', '关联 PR 合并不能让下游变为可开工');
    assert.equal(b.stats.all.ratio, 0);
    assert.deepEqual(b.recent.events.find(e => e.action === 'merged').done, []);
    assert.equal(t['1'].gantt.fact?.[1], Date.parse(NOW), '未完成的事实条延伸到今天');
  }
});

test('N1：勾选是完成必要条件，完整和部分 PR 都必须经过未合并与待同步检查', () => {
  for (const title of ['任务 1', '任务 1（部分）']) {
    for (const [box, state, want] of [
      [' ', 'synced', 'in_progress'], ['~', 'synced', 'in_progress'],
      [' ', 'unknown', 'in_progress'], ['x', 'synced', 'done'], ['x', 'unknown', 'done'],
      [' ', 'pending', 'awaiting_merge'], ['x', 'pending', 'awaiting_merge'],
    ]) {
      const d = inline(`- [${box}] 1 验收\n- [ ] 2 发布（依赖 1）\n`);
      const t = byNum(prBoard([d], [merged(10, { title })], { 10: { state } }));
      assert.equal(t['1'].status, want, `${title} [${box}] ${state}`);
      assert.equal(t['2'].next === 'ready', want === 'done');
      assert.equal(t['1'].docOnly, false, '有已合并 PR 时不能误称仅文档确认');
    }
    const d = inline('- [x] 1 验收\n');
    for (const isDraft of [true, false]) {
      const t = byNum(prBoard([d], [merged(10, { title }), pr(11, { title, isDraft })], { 10: { state: 'synced' } }));
      assert.equal(t['1'].status, isDraft ? 'in_review' : 'awaiting_merge');
    }
  }
});

test('实物：#360 → 3–10 已合并完成；#365 待同步 → 11–12 等待合并；#372 → 15.2 等待 review + 冲突 b', () => {
  const b = prBoard([collab()], PRS, { 360: { state: 'synced', reason: null }, 365: { state: 'pending', reason: null } }, WIDGET);
  const t = byNum(b);
  const m0c = ['3', '4', '4.1', '4.2', '4.3', '5', '5.1', '5.2', '6', '7', '7.1', '7.2', '8', '8.1', '8.2', '8.3', '8.4', '8.5', '9', '10', '10.1', '10.2'];
  for (const n of m0c) {
    assert.deepEqual([t[n].status, t[n].rule, t[n].docOnly, t[n].syncPending, t[n].syncUnchecked], ['done', '8.2-2', false, null, false], n);
    assert.deepEqual(t[n].prs, [{ pr: 360, taskKey: `collab-m0-space-run#${n}`, source: 'title', evidence: 'M0-c' }]);
    assert.ok(!t[n].conflicts.includes('c'), '有 PR 就不是仅文档确认');
  }
  assert.equal(t['3'].statusSince, fixturePr(360).mergedAt);
  for (const n of ['11', '11.1', '11.2', '12', '12.1', '12.2']) {
    assert.deepEqual([t[n].status, t[n].rule, t[n].syncPending], ['awaiting_merge', '8.2-2', [365]], n);
    assert.deepEqual(t[n].conflicts, [], '同一 PR 内的前置、只差本地 pull 的前置都不算抢跑（l）');
  }
  assert.deepEqual([t['15.2'].status, t['15.2'].rule, t['15.2'].statusSince], ['in_review', '8.2-1', fixturePr(372).createdAt]);
  assert.ok(t['15.2'].conflicts.includes('b'));
  assert.equal(b.stats.all.syncPending, 6);

  const p = Object.fromEntries(b.prs.map((x) => [x.number, x]));
  assert.deepEqual([p[365].branchLine, p[365].localSync, p[372].localSync, p[373].branchLine], ['collab', 'pending', null, 'personal']);
  assert.deepEqual(p[372].tasks, ['collab-m0-space-run#15.2']);
  assert.deepEqual(p[372].refIssues, [], '描述「M0-f 任务 15.2」与标题有重叠，不算指向不同（i）');
  // 版本号 / ADR / 章节号不认：个人版 PR 与 #352 均未关联，也不报 h
  for (const n of [373, 371, 361, 346, 352]) assert.deepEqual([p[n].tasks, p[n].refIssues], [[], []], n);
  assert.deepEqual(b.conflicts.filter((c) => c.pr).map((c) => c.type), [], '实物 PR 都守约定：无 h / i / n');
});

test('#369：标题无引用 → 看描述；描述也无引用 → 未关联（design §3.5 验收推演）', () => {
  const doc = collab();
  // 夹具描述是虚构的「tasks 任务 18」→ 走描述关联到 18
  const viaBody = linkPrs([doc], [fixturePr(369)], WIDGET);
  assert.deepEqual(viaBody.links.map((l) => [l.taskKey, l.source, l.evidence]), [['collab-m0-space-run#18', 'body', '任务 18']]);
  // 实物描述不写任务号：未关联，且不报 h（没有引用就谈不上歧义 / 不存在）
  const plain = linkPrs([doc], [{ ...fixturePr(369), body: '协作版 2.0.6 UI 改进轮。' }], WIDGET);
  assert.deepEqual([plain.links, plain.prs.get(369).tasks, plain.conflicts], [[], [], []]);
});

test('分支名只在标题与描述都无引用时启用；#344 M0-b 与 T1 测试、版本号互不干扰', () => {
  const doc = collab();
  const byBranch = linkPrs([doc], [{ ...fixturePr(372), title: '[V2] docs(collab): 文档回写', body: '' }], WIDGET);
  assert.deepEqual(byBranch.links.map((l) => [l.taskKey, l.source]), [['collab-m0-space-run#15.2', 'branch']]);
  const r = linkPrs([doc], [fixturePr(344)], WIDGET);
  assert.deepEqual([...new Set(r.links.map((l) => l.taskKey.split('#')[1].split('.')[0]))], ['2']);
});

test('本地同步：文档已勾选时，多个已合并 PR 有一个 pending 即待同步；unknown 保留 P3 降级与提示', () => {
  const d = inline(SIMPLE.replace('[ ] 1', '[x] 1'));
  const prs = [merged(10, { title: '任务 1' }), merged(11, { title: '任务 1', mergedAt: '2025-09-24T00:00:00Z' })];
  const mixed = byNum(prBoard([d], prs, { 10: { state: 'synced' }, 11: { state: 'pending' } }));
  assert.deepEqual([mixed['1'].status, mixed['1'].syncPending, mixed['1'].syncUnchecked], ['awaiting_merge', [11], false]);
  assert.equal(mixed['1'].statusSince, '2025-09-24T00:00:00Z', '8.2-2 取最晚合并时间');

  const unknown = prBoard([d], prs, { 10: { state: 'synced' }, 11: { state: 'unknown', reason: '本地没有 main 分支，当前检出也不含合并提交' } });
  const u = byNum(unknown)['1'];
  assert.deepEqual([u.status, u.rule, u.syncPending, u.syncUnchecked], ['done', '8.2-2', null, true]);
  assert.deepEqual(unknown.prs.map((p) => [p.localSync, p.localSyncReason]), [['synced', null], ['unknown', '本地没有 main 分支，当前检出也不含合并提交']]);
  const synced = byNum(prBoard([d], prs, { 10: { state: 'synced' }, 11: { state: 'synced' } }))['1'];
  assert.deepEqual([synced.status, synced.syncUnchecked], ['done', false]);
  const unchecked = prBoard([d], prs);
  assert.deepEqual([byNum(unchecked)['1'].status, byNum(unchecked)['1'].syncUnchecked, unchecked.prs[0].localSync], ['done', true, null]);
});

test('待同步的前置 → 下游进即将可开工，并列出在等的 PR / 本地同步', () => {
  const d = inline(SIMPLE);
  const pending = byNum(prBoard([d], [merged(10, { title: '任务 1' })], { 10: { state: 'pending' } }));
  assert.deepEqual([pending['2'].next, pending['2'].deps.waitingFor],
    ['soon', [{ on: 't#1', status: 'awaiting_merge', prs: [], syncPending: [10] }]]);
  const open = byNum(prBoard([d], [pr(10, { title: '任务 1', isDraft: true })]));
  assert.deepEqual([open['2'].next, open['2'].deps.waitingFor], ['soon', [{ on: 't#1', status: 'in_review', prs: [10], syncPending: null }]]);
  const done = byNum(prBoard([inline(SIMPLE.replace('[ ] 1', '[x] 1'))], [merged(10, { title: '任务 1' })], { 10: { state: 'synced' } }));
  assert.deepEqual([done['2'].next, done['2'].deps.waitingFor], ['ready', []]);
});

test('多个 open PR 取最落后；全部关闭回退到文档规则；一个 PR 多任务逐任务独立判定', () => {
  const d = inline(SIMPLE);
  const both = byNum(prBoard([d], [pr(10, { title: '任务 1', readyAt: '2025-09-22T00:00:00Z' }),
    pr(11, { title: '任务 1', isDraft: true, createdAt: '2025-09-25T00:00:00Z' }), merged(12, { title: '任务 1' })]));
  assert.deepEqual([both['1'].status, both['1'].rule, both['1'].statusSince], ['in_review', '8.2-1', '2025-09-25T00:00:00Z'],
    'draft 比 ready 落后；open 优先于已合并；since 取 draft 的 createdAt');
  const ready = byNum(prBoard([d], [pr(10, { title: '任务 1', readyAt: '2025-09-22T00:00:00Z' })]))['1'];
  assert.deepEqual([ready.status, ready.statusSince], ['awaiting_merge', '2025-09-22T00:00:00Z']);

  const closed = byNum(prBoard([d], [pr(10, { title: '任务 1、3', state: 'CLOSED', closedAt: '2025-09-23T00:00:00Z' })]));
  assert.deepEqual([closed['1'].status, closed['1'].rule, closed['3'].status, closed['3'].rule],
    ['not_started', '8.2-5', 'done', '8.2-3'], '关闭未合并的 PR 不参与判定');
  assert.deepEqual([closed['1'].prs.map((l) => l.pr), closed['1'].excludedPrs], [[10], [{ pr: 10, reason: 'closed' }]]);

  const multi = prBoard([d], [merged(10, { title: '任务 1、3、4' })], { 10: { state: 'synced' } });
  const m = byNum(multi);
  assert.deepEqual(['1', '3', '4'].map((n) => m[n].status), ['in_progress', 'done', 'in_progress']);
  assert.deepEqual(['1', '3', '4'].map((n) => m[n].conflicts), [['a'], [], ['a']], '只有复选框未勾的两条报 a');
  assert.deepEqual(multi.prs[0].tasks, ['t#1', 't#3', 't#4']);
});

test('PR 侧冲突 a、b、d、l、m 各一正一反', () => {
  const conf = (text, prs, sync = {}) => byNum(prBoard([inline(text)], prs, sync));
  // a：已合并但复选框未勾 / 已勾
  const a = conf(SIMPLE, [merged(10, { title: '任务 1、3' })], { 10: { state: 'synced' } });
  assert.deepEqual([a['1'].conflicts.includes('a'), a['3'].conflicts.includes('a')], [true, false]);
  // b：已勾但 PR 还 open / 未勾
  const b = conf(SIMPLE, [pr(10, { title: '任务 1、3' })]);
  assert.deepEqual([b['3'].conflicts.includes('b'), b['1'].conflicts.includes('b')], [true, false]);
  // d：关联 PR 全部关闭 / 一关一开
  const d = conf(SIMPLE, [pr(10, { title: '任务 1、4', state: 'CLOSED' }), pr(11, { title: '任务 4' })]);
  assert.deepEqual([d['1'].conflicts.includes('d'), d['4'].conflicts.includes('d')], [true, false]);
  // l：2 依赖 1，1 还没开始，2 已有 PR；1 与 2 在同一个 PR 里则不算
  const l = conf(SIMPLE, [pr(10, { title: '任务 2' })]);
  assert.ok(l['2'].conflicts.includes('l'));
  const same = conf(SIMPLE, [pr(10, { title: '任务 1、2' })]);
  assert.ok(!same['2'].conflicts.includes('l'));
  // m：作废任务仍有关联 PR / 作废任务无 PR
  const v = '## 分组\n\n- [ ] ~~1 甲~~ 【作废】\n- [ ] ~~2 乙~~ 【作废】\n';
  const m = conf(v, [pr(10, { title: '任务 1' })]);
  assert.deepEqual([m['1'].conflicts, m['2'].conflicts, m['1'].status], [['m'], [], null]);
});

test('PR 级冲突 h、i、n 各一正一反；只命中重复编号不说「不存在」', () => {
  const a = inline('## 分组\n\n- [ ] 3 甲\n- [ ] 5 乙\n', 'a');
  const b = inline('## 分组\n\n- [ ] 3 丙\n- [ ] 7 丁\n- [ ] 7 重复的丁\n', 'b');
  const types = (prs, cfg) => linkPrs([a, b], prs, cfg).conflicts.map((c) => [c.pr, c.type, c.detail]);
  // h：歧义、不存在、只命中重复编号；反例：唯一命中
  assert.deepEqual(types([pr(1, { title: '任务 3' }), pr(2, { title: '任务 9' }), pr(3, { title: '任务 7' }), pr(4, { title: '任务 5' }), pr(5, { title: 'a 任务 7' })]), [
    [1, 'h', 'PR 标题里的「3」有歧义，可能是 a#3\u2063、b#3'],
    [2, 'h', 'PR 标题引用了不存在的任务：9'],
    [3, 'h', 'PR 标题里的「7」对应的编号在文档里重复出现，无法确定是哪一条'],
    [5, 'h', 'PR 标题引用了不存在的任务：7'], // 写明了 a，b 里的重复编号不算
  ]);
  const ambiguous = linkPrs([a, b], [pr(1, { title: '任务 3' })]);
  assert.deepEqual([ambiguous.links, ambiguous.prs.get(1).tasks, ambiguous.prs.get(1).refIssues.length], [[], [], 1], '歧义 → 未关联');
  // i：标题与描述 / 分支名完全不重叠；反例：有重叠
  assert.deepEqual(types([pr(1, { title: '任务 5', body: 'a#3', headRefName: 'task-5' })]),
    [[1, 'i', '标题指向 a#5，描述却指向 a#3']]);
  assert.deepEqual(types([pr(1, { title: '任务 5', body: 'a#5 与 a#3' })]), []);
  // n：base 属协作版但缺前缀与标签；反例：守约定
  const cfg = { branchLines: WIDGET.branchLines.map((l) => ({ ...l, docFilter: undefined })) };
  const v2 = { baseRefName: 'v2/collab', title: '任务 5' };
  assert.deepEqual(types([pr(1, v2)], cfg).map((x) => x[1]), ['n', 'n']);
  assert.deepEqual(types([pr(1, { ...v2, title: '[V2] 任务 5', labels: ['collab-v2'] })], cfg), []);
});

test('N21 已关闭未合并的 PR 不报 h / i / n，问题（含 n 的分支线约定）仍留在 refIssues；同样写法的 open / 已合并 PR 照报', () => {
  const a = inline('## 分组\n\n- [ ] 3 甲\n- [ ] 5 乙\n', 'a');
  const b = inline('## 分组\n\n- [ ] 3 丙\n- [ ] 7 丁\n', 'b');
  const cfg = { branchLines: WIDGET.branchLines.map((l) => ({ ...l, docFilter: undefined })) };
  // h：歧义 / 不存在；i：标题与分支名不重叠（#20 的情形）；n：协作版 base 缺前缀与标签
  const bad = [
    { title: '任务 3' }, { title: '任务 9' },
    { title: '任务 5', headRefName: 'task-7' },
    { baseRefName: 'v2/collab', title: 'a#5' },
  ];
  const run = (state) => linkPrs([a, b], bad.map((o, i) => pr(i + 1, { ...o, state })), cfg);
  const closed = run('CLOSED');
  assert.deepEqual(closed.conflicts, []);
  assert.deepEqual([1, 2, 3, 4].map((n) => closed.prs.get(n).refIssues.length > 0), [true, true, true, true], 'PR 详情仍能看到写法问题');
  const open4 = linkPrs([a, b], [pr(4, bad[3])], cfg);
  assert.deepEqual(closed.prs.get(4).refIssues, open4.conflicts.filter((c) => c.type === 'n').map((c) => c.detail), 'n 的详情原样保留');
  assert.equal(open4.prs.get(4).refIssues.length, 0, 'open PR 的 n 仍只进「需要确认」，不重复进详情');
  for (const state of ['OPEN', 'MERGED']) {
    assert.deepEqual([...new Set(run(state).conflicts.map((c) => c.type))].sort(), ['h', 'i', 'n'], state);
  }
});

test('候选文档按分支线 docFilter 过滤：个人版 PR 引不到协作版文档', () => {
  const personal = inline('## 分组\n\n- [ ] 3 个人版三\n', 'personal-a');
  const r = linkPrs([collab(), personal], [pr(1, { title: '任务 3' }), pr(2, { title: '[V2] 任务 3', baseRefName: 'v2/collab', labels: ['collab-v2'] })], WIDGET);
  assert.deepEqual(r.links.map((l) => [l.pr, l.taskKey]), [[1, 'personal-a#3'], [2, 'collab-m0-space-run#3']]);
});

test('在等我处理：全部 open PR（draft / ready 已等时长）+ 待同步 PR（哪个工作区 pull 哪条分支），按分支线再按已等时长', () => {
  const b = prBoard([collab()], PRS, { 365: { state: 'pending' } }, WIDGET);
  const day = 864e5;
  assert.deepEqual(b.waiting.map((w) => [w.pr, w.kind, w.branchLine]), [[373, 'merge', 'personal'], [365, 'sync', 'collab'], [372, 'review', 'collab']]);
  const [w373, w365, w372] = b.waiting;
  const p373 = fixturePr(373);
  assert.equal(w373.waitedMs, Date.parse(NOW) - Date.parse(p373.readyAt ?? p373.createdAt), 'ready：从转 ready 算，从没当过 draft 从创建算');
  assert.deepEqual(w365.workspace, { id: 'collab', path: '/ws/collab', branch: 'v2/collab' });
  assert.equal(w365.since, fixturePr(365).mergedAt);
  assert.ok(w365.waitedMs > day && w365.waitedMs < 2 * day);
  assert.deepEqual(w372.tasks, ['collab-m0-space-run#15.2']);
  // 分支线没配独立工作区 → 主工作区
  const cfg = { ...WIDGET, branchLines: WIDGET.branchLines.map((l) => ({ ...l, workspace: undefined })) };
  assert.deepEqual(prBoard([collab()], PRS, { 365: { state: 'pending' } }, cfg).waiting[1].workspace,
    { id: 'repo', path: '/ws/repo', branch: 'v2/collab' });
});

// ---- 任务 5.3：会话关联与「进行中」 ----
// SessionRecord 直接手搭（扫描与信号提取在 sessions.test.mjs 测过）；refs 与 5.2 一样经 extractRefs 得出。
const at = (min) => new Date(Date.parse(NOW) - min * 6e4).toISOString(); // 距 now 多少分钟前
let lineNo = 0;
const say = (docs, text, from, until = from, kind = 'prompt') => ({ kind, at: from, until, file: 'r/s.jsonl', line: ++lineNo,
  refs: extractRefs(text, { knownDocIds: docs.map((d) => d.docId), knownCodes: docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)) }),
  snippet: text });
const sig = (kind, from, until, extra) => ({ kind, at: from, until, file: 'r/s.jsonl', line: ++lineNo, ...extra });
const session = (id, signals, over = {}) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/repo'], branches: [],
  title: `标题 ${id}`, firstAt: signals[0]?.at ?? at(600), lastAt: signals.map((s) => s.until).sort().at(-1) ?? at(600),
  lastSummary: '（虚构）最后一条', signals, aiOnlyMentions: 0, brokenLines: 0, ...over });
const sBoard = (docs, sessions, { prs = [], config = { id: 'demo' }, defaults } = {}) =>
  computeBoard(docs, prs, sessions, [], {}, config, NOW, defaults);
const withPath = (d) => ({ ...d, path: `${d.docId}/tasks.md` });

test('① 人发消息点名 collab-m0-space-run 与 2.5b → 关联并进行中（命中 a）；statusSince = firstAt；Board.sessions 不含信号', () => {
  const doc = collab();
  doc.tasks.find((t) => t.number === '2.5b').checkbox = 'open'; // 夹具里 2.5b 已勾，改成未勾才走得到 8.2-4
  const docs = [doc, planDoc('synthetic-inline')];
  // 之后的 git commit 等记录不产生信号，只把 until 推到 5 分钟前
  const s = session('s1', [say(docs, '继续做 collab-m0-space-run 的任务 2.5b', at(30), at(5))]);
  const b = sBoard(docs, [s]);
  const v = b.tasks.find((t) => t.key === 'collab-m0-space-run#2.5b');
  assert.deepEqual([v.status, v.rule, v.inProgressBy, v.activity, v.statusSince], ['in_progress', '8.2-4', ['session'], 'running', at(30)]);
  assert.deepEqual(v.sessions.map((l) => [l.sessionId, l.taskKey, l.firstAt, l.lastAt, l.activity]),
    [['s1', 'collab-m0-space-run#2.5b', at(30), at(5), 'running']]);
  assert.deepEqual(v.sessions[0].evidence, [{ kind: 'prompt', pos: { at: at(30), file: 'r/s.jsonl', line: s.signals[0].line },
    note: '人发消息：「继续做 collab-m0-space-run 的任务 2.5b」' }]);
  assert.equal(b.tasks.filter((t) => t.sessions.length).length, 1, '只关联点名的任务');
  assert.deepEqual(b.sessions.map((x) => [x.id, 'signals' in x, x.lastSummary]), [['s1', false, '（虚构）最后一条']]);
  assert.deepEqual(b.diagnostics.sessions, { total: 1, linked: 1, unlinked: 0, aiOnlyMentions: 0 });
});

test('命中 a 与 b 都列出；复选框已勾 / 有 PR 时会话不改状态，但照样挂在任务上', () => {
  const syn = planDoc('synthetic-inline');
  const docs = [syn];
  const s = session('s1', [say(docs, 'synthetic-inline 的任务 1.2、1.1', at(60), at(50))]);
  const t = byNum(sBoard(docs, [s]));
  assert.deepEqual([t['1.2'].status, t['1.2'].inProgressBy, t['1.2'].activity], ['in_progress', ['session', 'marker'], 'recent']);
  assert.deepEqual([t['1.1'].status, t['1.1'].rule, t['1.1'].activity, t['1.1'].sessions.length], ['done', '8.2-3', null, 1]);
});

test('② 只说「任务 3 先做」、无上下文 → 歧义不关联 + 会话侧冲突 h；touch 过某份文档后在其内唯一 → 关联', () => {
  const a = withPath(inline(SIMPLE, 'a'));
  const b2 = withPath(inline('## 分组\n\n- [ ] 3 别的三\n', 'b'));
  const docs = [a, b2];
  const amb = sBoard(docs, [session('s2', [say(docs, '任务 3 先做', at(20), at(15))])]);
  assert.ok(amb.tasks.every((t) => !t.sessions.length));
  assert.deepEqual(amb.conflicts.filter((c) => c.sessionId).map((c) => [c.type, c.sessionId, c.detail, c.source.text]),
    [['h', 's2', '会话「标题 s2」里的「3」有歧义，可能是 a#3\u2063、b#3', '任务 3 先做']]);
  assert.deepEqual(amb.diagnostics.sessions, { total: 1, linked: 0, unlinked: 1, aiOnlyMentions: 0 });
  assert.deepEqual(amb.sessions, [], '未关联的会话不进 Board.sessions');
  // 上下文取全会话：先说编号、后读 spec 也能定位
  const ctx = sBoard(docs, [session('s2', [say(docs, '任务 3 先做', at(20), at(15)), sig('touch', at(14), at(12), { docPath: 'b/tasks.md' })])]);
  assert.deepEqual(ctx.tasks.filter((t) => t.sessions.length).map((t) => t.key), ['b#3']);
  assert.deepEqual(ctx.conflicts.filter((c) => c.sessionId), []);
  // 引用了不存在的任务也记 h
  const miss = sBoard(docs, [session('s2', [say(docs, 'a#9 先做', at(20))])]);
  assert.deepEqual(miss.conflicts.filter((c) => c.sessionId).map((c) => c.detail), ['会话「标题 s2」引用了不存在的任务：a#9']);
});

test('多份文档、无上下文时，裸编号即使只在一份文档里唯一也不关联（主线程收紧，防编排会话误报）', () => {
  const a = withPath(inline(SIMPLE, 'a'));
  const b2 = withPath(inline('## 分组\n\n- [ ] 7.5 只有 b 有\n', 'b'));
  const docs = [a, b2];
  const bare = sBoard(docs, [session('s3', [say(docs, '任务 7.5 先做', at(20), at(15))])]);
  assert.ok(bare.tasks.every((t) => !t.sessions.length), '裸编号 + 无上下文 → 不关联');
  const named = sBoard(docs, [session('s3', [say(docs, 'b 的任务 7.5 先做', at(20), at(15))])]);
  assert.deepEqual(named.tasks.filter((t) => t.sessions.length).map((t) => t.key), ['b#7.5'], '写了 docId 照常关联');
  // 多文档下只有裸编号的子 agent 派活不采信，即使上下文里有该文档（派活说明应写明 spec 名）
  const disp = sBoard(docs, [session('s3', [say(docs, 'b 的任务 7.5 看一下', at(40), at(35)), say(docs, '实现任务 7.5', at(20), at(15), 'dispatch')])]);
  assert.deepEqual(disp.tasks.find((t) => t.key === 'b#7.5').sessions[0].evidence.map((e) => e.kind), ['prompt'], '裸编号派活不计入');
  // 上下文是 a，但 7.5 只在 b：不回退到全局求唯一
  const ctxA = sBoard(docs, [session('s3', [say(docs, 'a 的任务 1 先看看', at(30), at(25)), say(docs, '任务 7.5 先做', at(20), at(15))])]);
  assert.ok(!ctxA.tasks.find((t) => t.key === 'b#7.5').sessions.length, '上下文里对不上的裸编号不回退到全局');
});

test('③ 只在 AI 回复里提到任务号：不关联、只在诊断计数；⑧ 识别不出任务的会话不上任务、只计数', () => {
  const docs = [inline(SIMPLE)];
  // 5.2 对 AI 回复只计 aiOnlyMentions、不产生信号；只写 docId 的人发消息产生 prompt 信号但不设焦点
  const b = sBoard(docs, [session('s3', [], { aiOnlyMentions: 2 }), session('s8', [say(docs, '看看 t 这份文档', at(30))])]);
  assert.ok(b.tasks.every((t) => !t.sessions.length && t.status !== 'in_progress'));
  assert.deepEqual(b.diagnostics.sessions, { total: 2, linked: 0, unlinked: 2, aiOnlyMentions: 2 });
  assert.deepEqual(b.conflicts.filter((c) => c.sessionId), []);
});

test('④ 长会话多焦点：lastAt 按焦点段，只有当前焦点「运行中」；不带引用的消息不改焦点；对不上的引用清空焦点', () => {
  const docs = [inline(SIMPLE)];
  const s = session('s4', [
    say(docs, '先做任务 1', at(120), at(90)),
    say(docs, '转去做任务 4', at(60), at(50)),
    say(docs, '看一下 t 的文档', at(40), at(8)), // 只写 docId：焦点仍是 4，活动算给 4
    say(docs, '任务 99 呢', at(7), at(1)), // 不存在 → h，焦点清空，之后的活动不算给 4
  ]);
  const t = byNum(sBoard(docs, [s]));
  assert.deepEqual([t['1'].sessions[0].lastAt, t['1'].activity], [at(90), 'recent']);
  assert.deepEqual([t['4'].sessions[0].firstAt, t['4'].sessions[0].lastAt, t['4'].activity], [at(60), at(8), 'running']);
  assert.deepEqual(t['4'].sessions[0].evidence.map((e) => e.note), ['人发消息：「转去做任务 4」']);
  // 后来又回到任务 1：取最近一段
  const back = byNum(sBoard(docs, [session('s4', [...s.signals, say(docs, '回到任务 1', at(1), at(0))])]));
  assert.deepEqual([back['1'].sessions[0].firstAt, back['1'].sessions[0].lastAt, back['1'].activity], [at(120), at(0), 'running']);
});

test('⑤ 子 agent 派活即进行中；edit 直接关联被改的任务行', () => {
  const docs = [withPath(inline(SIMPLE))];
  const s = session('s5', [
    say(docs, '实现任务 2', at(20), at(10), 'dispatch'),
    sig('edit', at(9), at(9), { docPath: 't/tasks.md', taskNums: ['4'] }),
  ]);
  const t = byNum(sBoard(docs, [s]));
  assert.deepEqual([t['2'].status, t['2'].inProgressBy, t['2'].activity], ['in_progress', ['session'], 'running']);
  assert.deepEqual(t['2'].sessions[0].evidence.map((e) => [e.kind, e.note]), [['dispatch', '子 agent 派活：「实现任务 2」']]);
  assert.equal(t['2'].sessions[0].lastAt, at(9), 'edit 时焦点仍是 2，活动计入');
  assert.deepEqual([t['4'].status, t['4'].sessions[0].evidence.map((e) => e.note)], ['in_progress', ['改了 t 的任务行 4']]);
});

test('子 agent 各算各的：派给认得出的子 agent 的任务不改主线焦点，由它自己的记录续活动；没点到任务的子 agent 续主线焦点', () => {
  const docs = [withPath(inline(SIMPLE))];
  const s = session('s5', [
    say(docs, '做任务 4', at(60), at(59)),
    { ...say(docs, '实现任务 1', at(50), at(50), 'dispatch'), toolUseId: 'ta' },
    { ...say(docs, '实现任务 2', at(50), at(49), 'dispatch'), toolUseId: 'tb' },
    sig('agent', at(49), at(2), { lane: 'ta' }), // 还在干
    sig('agent', at(49), at(30), { lane: 'tb' }), // 30 分钟前做完
    sig('agent', at(20), at(1), { lane: 'tc' }), // 派活没写任务（如找代码）：算主线焦点 4 的活动
  ]);
  const t = byNum(sBoard(docs, [s]));
  const l = (n) => [t[n].sessions[0].lastAt, t[n].sessions[0].activity];
  assert.deepEqual(l('1'), [at(2), 'running']);
  assert.deepEqual(l('2'), [at(30), 'recent'], '各自的子 agent 停了就不再算运行中，不被别的子 agent 带着');
  assert.deepEqual(l('4'), [at(1), 'running'], '派活不改主线焦点');
  assert.deepEqual(t['1'].sessions[0].evidence.map((e) => e.kind), ['dispatch']);
  // 认不出的子 agent（没有 agent 信号）：照旧，派活改主线焦点
  const old = byNum(sBoard(docs, [session('s5', [say(docs, '做任务 4', at(60), at(59)), { ...say(docs, '实现任务 1', at(50), at(2), 'dispatch'), toolUseId: 'tz' }])]));
  assert.deepEqual([old['1'].sessions[0].lastAt, old['4'].sessions[0].lastAt], [at(2), at(59)]);
});

test('子 agent 各算各的：没写任务的派活冻结派活那一刻的主线焦点（空焦点也冻结），主线之后换任务不跟着变', () => {
  const docs = [withPath(inline(SIMPLE))];
  const t = byNum(sBoard(docs, [session('s5', [
    { ...say(docs, '（虚构）先派个找代码的', at(70), at(70), 'dispatch'), toolUseId: 'te' }, // 此时主线还没焦点
    sig('agent', at(69), at(1), { lane: 'te' }),
    say(docs, '做任务 1', at(60), at(59)),
    { ...say(docs, '（虚构）找一下相关代码', at(58), at(58), 'dispatch'), toolUseId: 'td' },
    sig('agent', at(57), at(45), { lane: 'td' }),
    say(docs, '转去做任务 2', at(50), at(40)),
    sig('touch', at(30), at(2), { docPath: 't/tasks.md', lane: 'td' }), // 主线换任务之后，子 agent 还在读文档、干活
  ])]));
  const l = (n) => [t[n].sessions[0]?.lastAt, t[n].sessions[0]?.activity];
  assert.deepEqual(l('1'), [at(2), 'running'], '找代码的子 agent 一直算在派它时的任务 1 上');
  assert.deepEqual(l('2'), [at(40), 'recent'], '主线换到任务 2 后，旧子 agent 的活动不续到 2');
  assert.equal(t['1'].sessions[0].firstAt, at(60), '空焦点时派出的 te 不给任何任务续活动');
});

test('N32 command：主线的命令接管主线焦点；子 agent 的命令只换它那一路；对不上任务的命令不清焦点、不报冲突', () => {
  const docs = [withPath(inline(SIMPLE))];
  const b = sBoard(docs, [session('s6', [
    say(docs, '做任务 1', at(60), at(55)),
    { ...say(docs, '（虚构）找一下相关代码', at(54), at(54), 'dispatch'), toolUseId: 'tf' },
    sig('agent', at(53), at(50), { lane: 'tf' }),
    { ...say(docs, 'fix: 任务 3', at(49), at(1), 'command'), lane: 'tf' }, // 子 agent 提交了任务 3
    say(docs, 'feat: 任务 2', at(40), at(30), 'command'), // 主线提交了任务 2
    say(docs, 'fix: 任务 99', at(29), at(2), 'command'), // 对不上
  ])]);
  const t = byNum(b);
  const l = (n) => [t[n].sessions[0]?.lastAt, t[n].sessions[0]?.evidenceAt];
  assert.deepEqual(l('1'), [at(50), at(60)], '主线换到任务 2 之前，任务 1 续到子 agent 开工');
  assert.deepEqual(l('2'), [at(2), at(40)], '对不上的命令不清主线焦点');
  assert.deepEqual(l('3'), [at(1), at(49)], '子 agent 那一路换成它提交的任务 3');
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'h'), []);
});

test('N32 command：没认出任务的命令不打断上一条 PR 登记的活动', () => {
  const docs = [withPath(inline(SIMPLE))];
  const prs = [{ number: 7, title: '任务 4', body: '', headRefName: 'feat-4', baseRefName: 'main', state: 'OPEN', isDraft: true, url: 'u', updatedAt: at(100) }];
  const t = byNum(sBoard(docs, [session('s7', [
    say(docs, '做任务 1', at(60), at(55)),
    sig('pr-link', at(50), at(40), { pr: 7 }),
    say(docs, 'docs: ADR-0099 任务 99', at(39), at(1), 'command'), // 认不出：PR #7 的任务 4 照样续到最后
  ])], { prs }));
  assert.deepEqual([t['4'].sessions[0].lastAt, t['4'].sessions[0].evidenceAt], [at(1), at(50)]);
  assert.equal(t['1'].sessions[0].lastAt, at(1), '主线焦点照常续');
});

test('子 agent 各算各的：子 agent 的分支信号只管它自己这一路，不续、不改主线焦点与主线分支', () => {
  const docs = [withPath(inline(SIMPLE))];
  const prs = [pr(11, { title: '任务 4', headRefName: 'feat-4' })];
  const t = byNum(sBoard(docs, [session('s6', [
    say(docs, '做任务 1', at(60), at(55)),
    { ...say(docs, '实现任务 2', at(54), at(54), 'dispatch'), toolUseId: 'tb' },
    sig('agent', at(53), at(1), { lane: 'tb' }),
    sig('branch', at(30), at(1), { branch: 'child-wt', lane: 'tb' }), // 子 agent 在独立 worktree：不是任何 PR 的 head
    sig('branch', at(20), at(1), { branch: 'feat-4', lane: 'tb' }), // 子 agent 切到 PR #11 的分支：只关联到它这一路
  ])], { prs }));
  assert.deepEqual([t['1'].sessions[0].lastAt, t['1'].sessions[0].activity], [at(54), 'recent'], '主线任务 1 停在主线最后一条记录');
  assert.deepEqual([t['2'].sessions[0].lastAt, t['2'].sessions[0].activity], [at(1), 'running']);
  assert.deepEqual([t['4'].sessions[0].lastAt, t['4'].sessions[0].evidence.map((e) => e.note)], [at(1), ['会话分支 feat-4 = PR #11 的 head']]);
  // 反过来：主线在 PR 分支上，子 agent 切去独立 worktree，不清掉主线的分支任务
  const m = byNum(sBoard(docs, [session('s6', [
    sig('branch', at(60), at(60), { branch: 'feat-4' }),
    say(docs, '做任务 1', at(59), at(55)),
    { ...say(docs, '实现任务 2', at(54), at(54), 'dispatch'), toolUseId: 'tb' },
    sig('agent', at(53), at(1), { lane: 'tb' }),
    sig('branch', at(30), at(1), { branch: 'child-wt', lane: 'tb' }),
    say(docs, '看一下 t 的文档', at(10), at(5)), // 主线继续干活（只写 docId，不改焦点）
  ])], { prs }));
  assert.deepEqual([m['4'].sessions[0].lastAt, m['1'].sessions[0].lastAt], [at(5), at(5)], '主线的分支任务照常随主线活动');
});

test('N29 切到能对上 PR 任务的分支：分支任务接管焦点，消息设的旧焦点停在切分支前；对不上 PR 的分支不改焦点', () => {
  const docs = [withPath(inline(SIMPLE))];
  const prs = [pr(11, { title: '任务 4', headRefName: 'feat-4' })];
  const run = (signals) => byNum(sBoard(docs, [session('s7', signals)], { prs }));
  const t = run([
    say(docs, '做任务 1', at(60), at(40)),
    sig('branch', at(39), at(20), { branch: 'scratch' }), // 没有 PR 的分支：任务 1 照旧
    sig('branch', at(19), at(5), { branch: 'feat-4' }), // PR #11 的分支：接管
    sig('touch', at(4), at(0), { docPath: 't/tasks.md' }),
  ]);
  assert.deepEqual([t['1'].sessions[0].lastAt, t['1'].sessions[0].activity], [at(20), 'recent'], '任务 1 停在切到 PR 分支前');
  assert.deepEqual([t['4'].sessions[0].lastAt, t['4'].sessions[0].activity], [at(0), 'running']);
  // 切分支之后再点名别的任务：照常设焦点，与分支任务并行
  const u = run([
    say(docs, '做任务 1', at(60), at(40)),
    sig('branch', at(39), at(20), { branch: 'feat-4' }),
    say(docs, '再看任务 2', at(19), at(0)),
  ]);
  assert.deepEqual([u['1'].sessions[0].lastAt, u['2'].sessions[0].lastAt, u['4'].sessions[0].lastAt], [at(40), at(0), at(0)]);
});

test('N29 只管主线：子 agent 那一路切到 PR 分支不清它的焦点，派给它的任务照旧续活动；主线焦点也不变', () => {
  const docs = [withPath(inline(SIMPLE))];
  const prs = [pr(11, { title: '任务 4', headRefName: 'feat-4' })];
  const t = byNum(sBoard(docs, [session('s8', [
    say(docs, '做任务 1', at(60), at(55)),
    { ...say(docs, '实现任务 2', at(54), at(54), 'dispatch'), toolUseId: 'tb' },
    sig('agent', at(53), at(30), { lane: 'tb' }),
    sig('branch', at(29), at(10), { branch: 'feat-4', lane: 'tb' }), // 回放实测：子 agent 开工时检出切到一条 PR 不对应派活的分支
    sig('touch', at(9), at(0), { docPath: 't/tasks.md', lane: 'tb' }),
    say(docs, '看一下 t 的文档', at(8), at(1)), // 主线继续（只写 docId，不改焦点）
  ])], { prs }));
  assert.equal(t['2'].sessions[0].lastAt, at(0), '子 agent 的任务 2 不因切分支停掉');
  assert.equal(t['4'].sessions[0].lastAt, at(0));
  assert.equal(t['1'].sessions[0].lastAt, at(1), '主线焦点任务 1 不受子 agent 切分支影响');
});

test('⑥ pr-link → 该 PR 的任务；分支 = PR head → 该 PR 的任务且切分支前一直计活动；PR 状态优先于会话', () => {
  const docs = [withPath(inline(SIMPLE))];
  const prs = [pr(10, { title: '任务 1' }), pr(11, { title: '任务 4', state: 'CLOSED', headRefName: 'task-4' })];
  const s = session('s6', [
    sig('branch', at(100), at(95), { branch: 'task-4' }),
    sig('touch', at(90), at(30), { docPath: 't/tasks.md' }), // 不带焦点的后续记录：仍在 task-4 分支上
    sig('pr-link', at(25), at(20), { pr: 10 }),
    sig('branch', at(19), at(0), { branch: 'other' }), // 切走后不再算给 4
  ]);
  const t = byNum(sBoard(docs, [s], { prs }));
  assert.deepEqual([t['4'].status, t['4'].inProgressBy, t['4'].statusSince], ['in_progress', ['session'], at(100)], 'PR 全关闭 → 回退到会话判定');
  assert.equal(t['4'].sessions[0].lastAt, at(20));
  assert.deepEqual(t['4'].sessions[0].evidence.map((e) => e.note), ['会话分支 task-4 = PR #11 的 head']);
  assert.deepEqual([t['1'].status, t['1'].inProgressBy, t['1'].activity], ['awaiting_merge', [], null], 'open PR 先命中 8.2-1');
  assert.deepEqual(t['1'].sessions.map((l) => [l.lastAt, l.activity, l.evidence[0].note]), [[at(20), 'recent', '会话登记了 PR #10']]);
});

test('活动阈值边界（含可配）；停滞只是标记、不改状态；有 open PR 的任务不标停滞', () => {
  const docs = [inline(SIMPLE)];
  const idle = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
  const act = (ms, defaults, prs) => byNum(sBoard(docs, [session('s', [say(docs, '任务 4', idle(ms + 1), idle(ms))])], { defaults, prs }))['4'];
  const min = 6e4;
  const day = 864e5;
  assert.equal(act(10 * min).activity, 'running');
  assert.equal(act(10 * min + 1).activity, 'recent');
  assert.equal(act(3 * day).activity, 'recent');
  const stale = act(3 * day + 1);
  assert.deepEqual([stale.status, stale.activity, stale.sessions[0].activity], ['in_progress', 'stale', 'stale']);
  assert.equal(act(29 * min, { sessionRunningMinutes: 30, sessionStaleDays: 1 }).activity, 'running');
  assert.equal(act(day + 1, { sessionRunningMinutes: 30, sessionStaleDays: 1 }).activity, 'stale');
  const withPr = act(5 * day, undefined, [pr(10, { title: '任务 4' })]);
  assert.deepEqual([withPr.status, withPr.activity, withPr.sessions[0].activity], ['awaiting_merge', null, 'recent']);
});

test('冲突 o 一正一反；停滞任务进「在等我处理」并计入统计', () => {
  const docs = [inline(SIMPLE)];
  const b = sBoard(docs, [session('old', [say(docs, '任务 4', at(5 * 1440 + 10), at(5 * 1440))]), session('new', [say(docs, '任务 1', at(60), at(30))])],
    { prs: [pr(20, { title: '任务 3', isDraft: true, createdAt: '2025-09-26T08:00:00Z' })] });
  const t = byNum(b);
  assert.deepEqual([t['4'].conflicts, t['1'].conflicts], [['o'], []]);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'o').map((c) => [c.taskKey, c.detail]), [['t#4', '任务仍在进行中，关联 AI 会话已 5 天没有动静']]);
  assert.equal(b.stats.all.inProgressStale, 1);
  assert.deepEqual(b.waiting.map((w) => [w.kind, w.pr, w.tasks, w.waitedMs]), [
    ['stale', null, ['t#4'], 5 * 864e5],
    ['review', 20, ['t#3'], 864e5],
  ], '按已等时长倒序与 PR 混排');
  assert.deepEqual([b.waiting[0].sessions, b.waiting[0].since, b.waiting[0].branchLine], [['old'], at(5 * 1440), null]);
});

test('冲突 l（会话侧）：依赖未满足却已有会话在做；同一会话一起做的前置不算', () => {
  const docs = [inline(SIMPLE)];
  const one = byNum(sBoard(docs, [session('s', [say(docs, '任务 2', at(20))])]));
  assert.ok(one['2'].conflicts.includes('l'));
  const both = byNum(sBoard(docs, [session('s', [say(docs, '任务 1、2', at(20))])]));
  assert.ok(!both['2'].conflicts.includes('l'));
  const l = sBoard(docs, [session('s', [say(docs, '任务 2', at(20))])]).conflicts.find((c) => c.type === 'l');
  assert.equal(l.detail, '依赖 t#1 还没完成，却已有 AI 会话在做');
});

test('候选文档：会话 cwd 落在分支线工作区 → 只认该分支线的文档；主工作区 → 全部文档', () => {
  const personal = inline('## 分组\n\n- [ ] 3 个人版三\n', 'personal-a');
  const docs = [collab(), personal];
  const linkedKeys = (cwds) => sBoard(docs, [session('s', [say(docs, '任务 3', at(20))], { cwds })], { config: WIDGET })
    .tasks.filter((t) => t.sessions.length).map((t) => t.key);
  assert.deepEqual(linkedKeys(['/ws/collab/db']), ['collab-m0-space-run#3']);
  assert.deepEqual(linkedKeys(['/ws/collabx']), [], '前缀相同的兄弟目录不算');
  assert.deepEqual(linkedKeys(['/ws/repo']), [], '全部文档里 3 不唯一 → 歧义');
});

// ---------------- 任务 4.1：手动关联叠加（design §3.8.2、需求 7） ----------------

const rec = (taskKey, pr, action, at = '2025-09-26T00:00:00Z') => ({ project: 'demo', taskKey, pr, action, at });
const mBoard = (manual, prs = [pr(10, { title: '任务 1、3' }), pr(11, { title: '文档整理' })]) =>
  computeBoard([inline(SIMPLE)], prs, [], manual, {}, { id: 'demo' }, NOW);

test('手动 link / unlink / 撤销：手动 > 标题；解除的自动关联留作「已手动解除」且不参与推算；撤销 = 删记录后回到自动', () => {
  const auto = byNum(mBoard([]));
  assert.deepEqual([auto['1'].status, auto['1'].prs.map((l) => l.source), auto['4'].prs], ['awaiting_merge', ['title'], []]);

  const b = mBoard([rec('t#1', 10, 'unlink'), rec('t#4', 11, 'link'), rec('t#3', 10, 'link')]);
  const t = byNum(b);
  // unlink：#10 从任务 1 上摘掉，状态回到文档规则；「已手动解除」带原来源，页面可撤销
  assert.deepEqual([t['1'].status, t['1'].prs], ['not_started', []]);
  assert.deepEqual(t['1'].excludedPrs, [{ pr: 10, reason: 'unlinked', source: 'title', evidence: '任务 1、3' }]);
  // link：未关联的 #11 挂到任务 4；已被标题关联的一对改记手动（优先级），不重复
  assert.deepEqual(t['4'].prs, [{ pr: 11, taskKey: 't#4', source: 'manual', evidence: '', at: '2025-09-26T00:00:00Z' }]);
  assert.equal(t['4'].status, 'awaiting_merge');
  assert.deepEqual(t['3'].prs.map((l) => [l.pr, l.source]), [[10, 'manual']]);
  const p = Object.fromEntries(b.prs.map((x) => [x.number, x]));
  assert.deepEqual([p[10].tasks, p[10].unlinked, p[11].tasks, p[11].unlinked], [['t#3'], ['t#1'], ['t#4'], []], 'PR 侧同步：未关联列表里 #11 不再出现');

  // 撤销 = 记录删掉：回到纯自动结果
  assert.deepEqual(byNum(mBoard([rec('t#4', 11, 'link')]))['1'].prs.map((l) => l.source), ['title'], '撤销 unlink 后标题关联回来');
  // null（文件读不了）= 只用自动关联
  assert.deepEqual(computeBoard([inline(SIMPLE)], [pr(10, { title: '任务 1、3' })], [], null, {}, { id: 'demo' }, NOW).tasks[0].prs.map((l) => l.source), ['title']);
});

test('手动记录：同一对以最后一条为准；unlink 对不上自动关联、PR 不在列表时不生效也不报错', () => {
  const t = byNum(mBoard([rec('t#4', 11, 'link'), rec('t#4', 11, 'unlink')]));
  assert.deepEqual([t['4'].prs, t['4'].excludedPrs], [[], []], '手改文件出现重复：后一条覆盖前一条');
  const u = byNum(mBoard([rec('t#2', 10, 'unlink'), rec('t#2', 999, 'link')]));
  assert.deepEqual([u['2'].prs, u['2'].excludedPrs], [[], []]);
});

test('失效关联 j：任务键不存在 → 冲突 j（带任务键与 PR）、记录不参与关联；键存在 → 无 j', () => {
  const b = mBoard([rec('t#9', 11, 'link'), rec('old#1', 10, 'unlink'), rec('t#4', 11, 'link')]);
  const j = b.conflicts.filter((c) => c.type === 'j');
  assert.deepEqual(j.map((c) => [c.taskKey, c.pr]), [['t#9', 11], ['old#1', 10]]);
  assert.match(j[0].detail, /手动关联记录指向不存在的任务 t#9（PR #11）/);
  assert.match(j[1].detail, /手动解除记录/);
  assert.deepEqual(b.prs.find((x) => x.number === 11).tasks, ['t#4']);
  assert.deepEqual(byNum(b)['1'].prs.map((l) => l.pr), [10], '失效的 unlink 不影响现有关联');
});

test('诊断 · 不满足约定之处（任务 6.5）：文档按行号列出任务行 / 依赖 / 耗时问题，PR 侧取 h、i、n', () => {
  const docs = [planDoc('synthetic-inline'), collab(), planDoc('synthetic-headings')];
  const cfg = { id: 'demo', branchLines: WIDGET.branchLines.map((l) => ({ ...l, docFilter: undefined })) };
  const prs = [pr(1, { title: '任务 99' }), pr(2, { baseRefName: 'v2/collab', title: 'collab-m0-space-run#1.1' })];
  const b = computeBoard(docs, prs, [], [], {}, cfg, NOW);
  assert.deepEqual(b.diagnostics.convention.map((x) => [x.rule, x.docId ?? `#${x.pr}`, x.line ?? null]), [
    [5, 'synthetic-inline', 31], [8, 'synthetic-inline', 33], // N12：正文里的小标题照原文显示并报出
    [3, 'synthetic-inline', 47], // 悬空依赖 9.9
    [1, 'synthetic-inline', 48], [1, 'synthetic-inline', 49], // 编号 3 重复
    [1, 'synthetic-inline', 50], // N9：parse.diagnostics（复选框「[-]」）也进不满足约定
    [1, 'synthetic-inline', 51],
    [3, 'collab-m0-space-run', 119], [3, 'collab-m0-space-run', 531], // design §3.4 表里的两条实物
    [8, 'synthetic-headings', 21],
    [7, '#1', null], [7, '#2', null], [7, '#2', null],
  ]);
  const item = (rule, line) => b.diagnostics.convention.find((x) => x.rule === rule && x.line === line).detail;
  assert.equal(item(5, 31), '无法识别的耗时写法：- **预计耗时**：看情况再说');
  assert.equal(item(3, 47), '依赖了找不到的对象：9.9');
  assert.equal(item(3, 119), '未识别的依赖说法：最迟在任务 12.2 之前做完');
  assert.equal(item(1, 50), '复选框「[-]」不是 [ ] / [x] / [~]，按未勾处理');
  assert.equal(item(8, 33), '正文里的标题不按 Markdown 渲染，照原文显示；建议改成加粗行');
  assert.equal(b.diagnostics.convention.find((x) => x.pr === 1).detail, 'PR 标题引用了不存在的任务：99');
  assert.equal(b.diagnostics.convention.filter((x) => x.pr === 2).length, b.conflicts.filter((c) => c.pr === 2 && c.type === 'n').length);
});

// ---------------- 任务 6.3：最近变化（design §3.9、需求 10.3） ----------------
import { recentChanges } from '../src/engine.mjs';

test('最近变化 · 窗口边界：闭区间，from / to 各差 1 毫秒即出窗；Board.recent 不设下限、上限 = now，days 取配置', () => {
  const b = computeBoard([inline(SIMPLE)], [pr(10, { title: '任务 1', createdAt: '2025-09-25T00:00:00.000Z' })], [], [], {}, { id: 'demo' }, NOW);
  const t = Date.parse('2025-09-25T00:00:00.000Z');
  const hit = (from, to) => recentChanges(b, { from, to }).length;
  assert.deepEqual([hit(t, t), hit(t + 1, null), hit(null, t - 1), hit(t - 1, t + 1)], [1, 0, 0, 1]);
  assert.deepEqual([b.recent.days, b.recent.events.length], [7, 1]);
  const future = computeBoard([inline(SIMPLE)], [pr(10, { createdAt: '2025-09-28T00:00:00Z' }), pr(11, { createdAt: '2020-01-01T00:00:00Z' })],
    [], [], {}, { id: 'demo' }, NOW, { recentChangesDays: 14 });
  assert.deepEqual([future.recent.days, future.recent.events.map((e) => e.pr)], [14, [11]], '晚于 now 的不收；再早也收（页面起始日可任选）');
});

test('最近变化 · PR 事件：开（draft）/ 转 ready / 合并（完成的任务、待同步）/ 关闭未合并；未关联 PR 的 tasks 为空', () => {
  const prs = [
    pr(10, { title: '任务 1', isDraft: true, createdAt: '2025-09-26T00:00:00Z' }),
    pr(11, { title: '任务 2', createdAt: '2025-09-22T00:00:00Z', readyAt: '2025-09-24T00:00:00Z' }),
    merged(12, { title: '任务 3', createdAt: '2025-09-11T00:00:00Z', mergedAt: '2025-09-25T00:00:00Z', closedAt: '2025-09-25T00:00:00Z' }),
    merged(13, { title: '任务 4', createdAt: '2025-09-11T00:00:00Z', mergedAt: '2025-09-23T00:00:00Z' }),
    pr(14, { title: '改 README', state: 'CLOSED', createdAt: '2025-09-11T00:00:00Z', closedAt: '2025-09-22T00:00:00Z' }),
  ];
  const b = computeBoard([inline(SIMPLE)], prs, [], [], { 13: { state: 'pending', reason: null } }, { id: 'demo' }, NOW);
  const ev = recentChanges(b, { from: Date.parse('2025-09-21T00:00:00Z') });
  assert.deepEqual(ev.map((e) => [e.kind, e.pr, e.action, e.at.slice(0, 10), e.tasks]), [
    ['pr', 10, 'opened', '2025-09-26', ['t#1']],
    ['pr', 12, 'merged', '2025-09-25', ['t#3']],
    ['pr', 11, 'ready', '2025-09-24', ['t#2']],
    ['pr', 13, 'merged', '2025-09-23', ['t#4']],
    ['pr', 11, 'opened', '2025-09-22', ['t#2']],
    ['pr', 14, 'closed', '2025-09-22', []],
  ], '合并的 PR 不再算一次关闭；窗口外的开 PR 不收；PR 引起的任务状态变化不单列');
  assert.equal(ev[0].draft, true);
  assert.equal(ev[4].draft, true, '后来转 ready 的，开的时候是 draft');
  assert.deepEqual([ev[1].done, ev[1].localSync], [['t#3'], null]);
  assert.deepEqual([ev[3].done, ev[3].localSync], [[], 'pending'], '待同步的不算完成');
});

test('最近变化 · 会话与任务事件：会话按同一段活动合并任务，带活动标记；会话带来的「进行中」以 firstAt 单列', () => {
  const docs = [inline(SIMPLE)];
  const b = sBoard(docs, [
    session('run', [say(docs, '任务 1、4', at(3 * 1440), at(5))]),
    session('old', [say(docs, '任务 2', at(10 * 1440), at(4 * 1440))]),
  ]);
  const ev = recentChanges(b, { from: Date.parse(NOW) - 7 * 864e5, to: Date.parse(NOW) });
  assert.deepEqual(ev.map((e) => [e.kind, e.at, e.tasks ?? e.taskKey, e.activity ?? e.status, e.sessionId ?? null, e.source ?? null]), [
    ['session', at(5), ['t#1', 't#4'], 'running', 'run', 'claude-code'],
    ['status', at(3 * 1440), 't#1', 'in_progress', null, null],
    ['status', at(3 * 1440), 't#4', 'in_progress', null, null],
    ['session', at(4 * 1440), ['t#2'], 'stale', 'old', 'claude-code'],
  ], '「old」开始于窗口外，只收它最后一段活动');
});

test('「任务 N（部分）」：保留部分依据、不报 a；另有普通 PR 合并仍需文档勾选确认', () => {
  const d = inline(SIMPLE);
  const part = byNum(prBoard([d], [merged(10, { title: 'fix: 修一部分', body: '任务 1（部分）、任务 4' })], { 10: { state: 'synced' } }));
  assert.deepEqual([part['1'].status, part['1'].rule, part['1'].inProgressBy], ['in_progress', '8.2-4', ['partial']]);
  assert.deepEqual(part['1'].prs.map((l) => [l.pr, l.partial, l.evidence]), [[10, true, '任务 1（部分）、任务 4']]);
  assert.ok(!part['1'].conflicts.includes('a'), '部分 PR 合并了但复选框没勾是预期的，不报 a');
  assert.deepEqual([part['4'].status, part['4'].prs[0].partial], ['in_progress', undefined], '没有部分标记也不能替代文档确认');

  const open = byNum(prBoard([d], [pr(10, { title: '任务 1(部分)', isDraft: true })]))['1'];
  assert.deepEqual([open.status, open.rule], ['in_review', '8.2-1'], '没合并的部分 PR 照常算等 review');

  const plusFull = byNum(prBoard([d], [merged(10, { title: '任务 1（部分）' }), merged(11, { title: '任务 1' })],
    { 10: { state: 'synced' }, 11: { state: 'synced' } }))['1'];
  assert.deepEqual([plusFull.status, plusFull.rule], ['in_progress', '8.2-4'], '再有普通 PR 合并仍未确认完整交付');

  const ticked = byNum(prBoard([d], [merged(10, { title: '任务 3（部分）' })], { 10: { state: 'synced' } }))['3'];
  assert.deepEqual([ticked.status, ticked.rule], ['done', '8.2-2'], '文档已勾且关联 PR 已合并同步才完成');
});

// ---- N9：写法不合约定时不静默误读 ----
const N9_PLAN = '### 里程碑 M1：一\n- [ ] 1 甲\n- [ ] 2 乙\n### 里程碑 M2：二\n- [ ] 3 丙\n- [ ] 4 丁\n### 任务 9：混在任务行里的标题式任务\n';

test('N9 部分标记：任务键、里程碑代号（整组）、不带括号、描述兜底都认；同段既有完整又有部分时按部分算', () => {
  const d = inline(N9_PLAN, 'plan-a');
  const r = linkPrs([d], [
    pr(10, { title: 'fix: plan-a#1（部分）' }),
    pr(11, { title: 'feat: M2（部分）' }),
    pr(12, { title: 'feat: M1、任务 1（部分）' }),
    pr(13, { title: 'fix: 修文案', body: '任务 3 部分' }),
    pr(14, { title: 'fix: 任务 2，部分' }),
    pr(15, { title: 'feat: Task 4 (part)' }),
  ], { id: 'demo' });
  const of = (n) => r.links.filter((l) => l.pr === n).map((l) => [l.taskKey.split('#')[1], !!l.partial]);
  assert.deepEqual(of(10), [['1', true]]);
  assert.deepEqual(of(11), [['3', true], ['4', true]], '代号带标记 = 整组都是部分交付');
  assert.deepEqual(of(12), [['1', true], ['2', false]], '同一任务既有完整又有部分引用时按部分（保守）');
  assert.deepEqual(of(13), [['3', true]], '描述兜底同样认');
  assert.deepEqual(of(14), [['2', true]]);
  assert.deepEqual(of(15), [['4', true]]);
});

test('N9 ADR 简称：ADR-0007#64 按分支线认到唯一那篇且标题优先；两篇同号时报歧义不猜', () => {
  const adr = (docId, text, extra = {}) => ({ docId, archived: false, ...parseAdrDoc(text, docId), ...extra });
  const docs = [adr('ADR-0007-sample', '# ADR-0007\n- [ ] 1 甲\n- [ ] 64 乙\n'),
    adr('next:ADR-0007-sample', '# ADR-0007\n- [ ] 1 甲\n- [ ] 64 乙\n', { alias: 'ADR-0007-sample', workspaceId: 'next' })];
  const cfg = { id: 'demo', repo: { path: '/ws/repo' }, branchLines: [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'next/x', docFiles: ['adr/ADR-0007-sample.md'], docFilter: '^next:' }] };
  const r = linkPrs(docs, [
    pr(20, { title: 'feat: ADR-0007#64（部分）', body: '背景：任务 1、任务 64 都还没做完' }),
    pr(21, { title: 'feat: ADR-0007#1', baseRefName: 'next/x' }),
    pr(22, { title: 'feat: ADR-0007#1', baseRefName: 'other' }),
  ], cfg);
  const of = (n) => r.links.filter((l) => l.pr === n).map((l) => [l.taskKey, l.source, !!l.partial]);
  assert.deepEqual(of(20), [['ADR-0007-sample#64', 'title', true]], '标题里的简称生效，不再退到描述把 1、64 当完整交付');
  assert.deepEqual(of(21), [['next:ADR-0007-sample#1', 'title', false]]);
  assert.deepEqual(of(22), []);
  assert.match(r.conflicts.find((c) => c.pr === 22).detail, /「ADR-0007#1」有歧义，可能是 ADR-0007-sample#1.*next:ADR-0007-sample#1/);
});

test('N9 像引用却对不上：报进「不满足约定」并给建议写法，不退到描述误读；PR#12、owner/repo#3 不算', () => {
  const d = { ...inline(N9_PLAN, 'plan-a'), path: 'plan-a/tasks.md' };
  const prs = [pr(30, { title: 'fix: Plan-A#1 修复', body: '任务 2' }), pr(31, { title: 'feat: M9 收尾' }),
    pr(32, { title: '合并 PR#12 与 owner/repo-x#3 的修复', body: '任务 2' })];
  const b = computeBoard([d], prs, [], [], {}, { id: 'demo' }, NOW);
  assert.deepEqual(b.prs.filter((p) => p.tasks?.length).map((p) => [p.number, p.tasks]), [[32, ['plan-a#2']]]);
  const conv = b.diagnostics.convention;
  assert.deepEqual(conv.filter((x) => x.rule === 7).map((x) => [x.pr, x.detail]), [
    [30, 'PR 标题里的「Plan-A#1」像任务引用，但对不上这条分支线的文档或里程碑代号；建议写成「plan-a#1」'],
    [31, 'PR 标题里的「M9」像任务引用，但对不上这条分支线的文档或里程碑代号；建议写成「<spec 名>#<编号>」或文档里已有的里程碑代号'],
  ]);
  assert.deepEqual(conv.filter((x) => x.rule === 1).map((x) => [x.line, x.detail]), [
    [7, '标题「任务 9：混在任务行里的标题式任务」像标题式任务，但本文档已有任务行，它不会被当成任务；建议改成「- [ ] 9 混在任务行里的标题式任务」'],
  ]);
});


test('未勾选的合并关联不能掩盖停滞和待同步前置的提前开工', () => {
  for (const checked of [' ', 'x']) {
    const docs = [inline(`## 分组\n\n- [${checked}] 1 前置\n- [ ] 2 后继（依赖 1）\n- [ ] 3 后继（依赖 1）\n`)];
    const prs = [pr(1, { title: '任务 1', state: 'MERGED', mergedAt: at(1440) }), pr(2, { title: '任务 2' })];
    const sessions = [session('old', [say(docs, '任务 3', at(5 * 1440), at(5 * 1440))])];
    const b = computeBoard(docs, prs, sessions, [], { 1: { state: 'pending' } }, { id: 'demo' }, NOW);
    const t = byNum(b);
    for (const n of ['2', '3']) assert.equal(t[n].conflicts.includes('l'), checked !== 'x');
    const merged = computeBoard(docs, [...prs, pr(3, { title: '任务 3', state: 'MERGED', mergedAt: at(1440) })], sessions, [], {}, { id: 'demo' }, NOW);
    assert.equal(byNum(merged)['3'].activity, 'stale');
    assert.doesNotMatch(merged.conflicts.find((c) => c.type === 'o').detail, /没有 PR/);
  }
});

test('N17 docRef 分支线：PR 写不带前缀的文档原名，认回本线带前缀的文档；个人版 PR 照旧认主工作区那份', () => {
  const adr = (docId, text, extra = {}) => ({ docId, archived: false, ...parseTasksDoc(text, docId), ...extra });
  const docs = [adr('ADR-0042-x', '- [ ] 1 甲\n- [ ] 2 乙\n'),
    adr('next:ADR-0042-x', '- [ ] 1 甲\n- [ ] 94 丙\n', { alias: 'ADR-0042-x', workspaceId: 'next' })];
  const cfg = { id: 'demo', repo: { path: '/ws/repo' }, branchLines: [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'next/x', docFiles: ['adr/ADR-0042-x.md'], docFilter: '^next:' }] };
  const r = linkPrs(docs, [
    pr(1, { title: 'feat(94): 某功能（ADR-0042-x#94）', baseRefName: 'next/x' }),
    pr(2, { title: 'docs: ADR-0042 任务 94 记录', baseRefName: 'next/x' }),
    pr(3, { title: 'fix: ADR-0042-x#1', baseRefName: 'main' }),
  ], cfg);
  const tasksOf = (n) => r.links.filter((l) => l.pr === n).map((l) => l.taskKey);
  assert.deepEqual(tasksOf(1), ['next:ADR-0042-x#94'], '完整键用原名也认得');
  assert.deepEqual(tasksOf(2), ['next:ADR-0042-x#94'], '只在本线文档里找编号');
  assert.deepEqual(tasksOf(3), ['ADR-0042-x#1'], '个人版不受影响');
  assert.deepEqual(r.conflicts.filter((c) => c.type === 'h'), []);
  // 未归类 PR 用全部文档：原名归主工作区那份，不被别名抢走
  assert.deepEqual(linkPrs(docs, [pr(4, { title: 'x ADR-0042-x#1', baseRefName: 'other' })], cfg).links.map((l) => l.taskKey), ['ADR-0042-x#1']);
});

test('N17 docRef 文档与主工作区那份同路径：会话 touch 只把主工作区那份放进上下文，不让同号任务变歧义、不把 ref 独有任务记成进行中', () => {
  const adr = (docId, text, extra = {}) => ({ docId, archived: false, path: 'adr/ADR-0042-x.md', ...parseTasksDoc(text, docId), ...extra });
  const docs = [adr('ADR-0042-x', '- [ ] 1 甲\n- [ ] 2 乙\n'),
    adr('next:ADR-0042-x', '- [ ] 1 甲\n- [ ] 94 丙\n', { alias: 'ADR-0042-x', ref: 'next/x', workspaceId: 'next' })];
  const cfg = { id: 'demo', repo: { path: '/ws/repo' }, branchLines: [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'next/x', docFiles: ['adr/ADR-0042-x.md'], docFilter: '^next:' }] };
  const touch = () => sig('touch', at(30), at(30), { docPath: 'adr/ADR-0042-x.md' });
  const b = sBoard(docs, [session('s1', [touch(), say(docs, '任务 1 先做', at(20), at(10))]),
    session('s2', [touch(), say(docs, '任务 94 先做', at(20), at(10))])], { config: cfg });
  const keys = (id) => b.tasks.filter((t) => t.sessions.some((l) => l.sessionId === id)).map((t) => t.key);
  assert.deepEqual(keys('s1'), ['ADR-0042-x#1'], '同号任务按主工作区那份关联，不报歧义');
  assert.deepEqual(keys('s2'), [], 'ref 独有的任务号不靠同路径 touch 关联');
  assert.equal(b.conflicts.filter((c) => c.type === 'h' && c.sessionId === 's1').length, 0);
});

test('N17 docRef 分支线已合并待同步：「等我处理」的同步卡带 fetchRef', () => {
  const docs = [{ docId: 'next:ADR-0042-x', archived: false, alias: 'ADR-0042-x', ref: 'origin/next/x', ...parseTasksDoc('- [ ] 94 丙\n', 'next:ADR-0042-x') }];
  const cfg = { id: 'demo', repo: { path: '/ws/repo' }, branchLines: [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!next:)' },
    { id: 'next', name: '新引擎线', base: 'next/x', docRef: 'origin/next/x', docFiles: ['adr/ADR-0042-x.md'], docFilter: '^next:' }] };
  const b = prBoard(docs, [merged(5, { title: 'feat: ADR-0042-x#94', baseRefName: 'next/x' })], { 5: { state: 'pending', reason: null } }, cfg);
  assert.deepEqual(b.waiting.find((w) => w.pr === 5).workspace, { id: 'repo', path: '/ws/repo', branch: 'next/x', fetchRef: 'origin/next/x' });
});


// ---- N22 任务 22.2 · PR #27 review：英 / 日写法的误判不能改变统计与下一步 ----
test('英 / 日前置表：否定、待解决、问号不算解除，依赖它的任务仍是 blocked；明确标记才解除', () => {
  const table = (item) => `| ID | Item | Blocks |\n|---|---|---|\n| P1 | ${item} | 2 |\n## Tasks\n- [ ] 1 one\n- [ ] 2 two\n`;
  for (const item of ['sandbox (not resolved)', 'to be resolved by ops', 'must be resolved first', 'resolved?', 'unresolved', 'サンドボックス（解決済みではない）', '未解決',
    // PR #27 第二轮：全角问号、否定连接、明确的 no / false 值、带说明的非完整标记
    'サンドボックス（解決済み？）', '解決済みではなく未対応', 'resolved: no', 'resolved = false', 'Resolved: false', '解決済み：未', 'resolved by ops']) {
    const t = byNum(board([inline(table(item))]));
    assert.equal(t['2'].next, 'blocked', item);
  }
  for (const item of ['Resolved (2026-09-23): use A', 'sandbox (resolved)', 'domain, resolved', 'API key (done)', '解決済み：A 案', 'アカウント（提供済み）',
    'Resolved 2026-09-23', 'resolved: use plan A', '対応済み。', 'key (provided 2026-09-20)']) {
    const t = byNum(board([inline(table(item))]));
    assert.equal(t['2'].next, 'ready', item);
  }
});

test('英 / 日作废：只认完整括号标记（可带日期）；「(void return type)」「（廃止予定の API）」是普通说明，任务照常计数、依赖照常阻塞', () => {
  const plain = byNum(board([inline('- [ ] 1 Add API (void return type)\n- [ ] 2 Consume API（依赖 1）\n- [ ] 3 Flag (obsolete flag compatibility)\n- [ ] 4 旧 API の置き換え（廃止予定の API）\n')]));
  assert.deepEqual(['1', '3', '4'].map((n) => plain[n].status), ['not_started', 'not_started', 'not_started']);
  assert.equal(plain['2'].next, 'blocked', '依赖的 1 不是作废任务，2 仍等它');
  assert.equal(board([inline('- [ ] 1 Add API (void return type)\n- [ ] 2 Consume API（依赖 1）\n')]).stats.all.total, 2);

  const voided = byNum(board([inline('- [ ] 1 Old [void]\n- [ ] 2 Older (obsolete 2026-09-01)\n- [ ] 3 古い案【廃止 2026-09-01】\n- [ ] 4 next\n')]));
  assert.deepEqual(['1', '2', '3'].map((n) => voided[n].status), [null, null, null]);
});

test('日文前置列表：「、」一侧没有关系词时只是列举，条件不丢；两侧都有关系词才切子句', () => {
  const head = '| ID | 事项 | 阻塞 |\n|---|---|---|\n| ~~P1~~ | 已提供 | 1 |\n| P2 | key | 1 |\n';
  for (const title of ['部署（需要 P1 アカウント、P2 key）', 'デプロイ（P1 のキー、P2 のアカウントが必要）']) {
    const d = inline(`${head}## T\n- [ ] 1 ${title}\n- [ ] 2 two\n`);
    const ext = d.relations.filter((r) => r.via === 'title').flatMap((r) => r.objects.filter((o) => o.type === 'prereq').map((o) => o.id));
    assert.deepEqual(ext.sort(), ['P1', 'P2'], title);
    assert.equal(byNum(board([d]))['1'].next, 'blocked', `${title}：P1 已解除、P2 未解决，仍阻塞`);
  }
  // 两侧都有关系词：仍按子句切（依赖 + 并行）
  const d = inline('- [ ] 1 one\n- [ ] 2 two\n- [ ] 3 three\n- [ ] 4 four（1 に依存、3 と並行）\n');
  assert.deepEqual(d.relations.map((r) => r.kind).sort(), ['dep', 'parallel']);
});

test('N35 会话引用问题只对人发的消息报：派活说明、命令对不上不报，人发的照报', () => {
  const docs = [withPath(inline(SIMPLE))];
  const b = sBoard(docs, [session('s7', [
    { ...say(docs, '实现任务 99', at(50), at(40), 'dispatch'), toolUseId: 'tg' },
    say(docs, 'fix: 任务 98', at(39), at(30), 'command'),
    say(docs, '看看任务 97', at(20), at(10)),
  ])]);
  assert.deepEqual(b.conflicts.filter((c) => c.type === 'h').map((c) => /97/.test(c.detail)), [true]);
});
