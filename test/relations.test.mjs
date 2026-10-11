import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseTasksDoc } from '../src/docs.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.tasks.md`, import.meta.url), 'utf8');
const num = (key) => key.split('#')[1];
// Ref → 可读形式：任务编号用 + 连接，P 编号原样，悬空前加 !
const show = (refs) => refs.map((r) => (r.type === 'prereq' ? `${r.dangling ? '!' : ''}${r.id}`
  : r.dangling ? `!${r.raw}` : r.keys.map(num).join('+'))).join(',');
const rels = (doc, kind) => doc.relations.filter((r) => !kind || r.kind === kind);
const at = (doc, line, kind) => rels(doc, kind).filter((r) => r.source.line === line).map((r) => `${show(r.subjects)} <- ${show(r.objects)}`);
// 按 engine 的读法把关系摊成边：dep 为「后 <- 前」，parallel 为无序对（跳过自身）。
function edges(doc, kind) {
  const out = new Set();
  for (const r of rels(doc, kind)) {
    for (const s of r.subjects.flatMap((x) => x.keys)) {
      for (const o of r.objects.flatMap((x) => x.keys)) {
        if (s === o) continue;
        out.add(kind === 'parallel' ? [num(s), num(o)].sort().join('~') : `${num(s)}<-${num(o)}`);
      }
    }
  }
  return out;
}
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const doc1 = (text, opts) => parseTasksDoc(text, 'd', opts);

// ---- 实物：collab-m0-space-run（虚构项目夹具） ----

const real = parseTasksDoc(fixture('collab-m0-space-run'), 'collab-m0-space-run');
const realText = fixture('collab-m0-space-run');

test('实物：标题括号里的依赖列表与并行（2.5b）', () => {
  assert.deepEqual(at(real, 213), ['2.5b <- 2.5,2.6,2.8', '2.5b <- 2.9,2.10']);
  assert.deepEqual(rels(real).filter((r) => r.source.line === 213).map((r) => [r.kind, r.via]), [['dep', 'title'], ['parallel', 'title']]);
});

test('实物：依次、→ 与 /、与 3–7 并行（4、8）', () => {
  assert.deepEqual(at(real, 345), ['4 <- 3,2.7,2.8', '4.2 <- 4.1', '4.3 <- 4.2']);
  assert.deepEqual(at(real, 409, 'dep'), ['8 <- 2.3,2.4', '8.2 <- 8.1', '8.3,8.4 <- 8.2', '8.5 <- 8.3,8.4']);
  assert.deepEqual(at(real, 409, 'parallel'), ['8.3,8.4 <- 8.3,8.4', '8 <- 3+4+5+6+7']);
});

test('实物：范围只取同父同层且实际存在的任务（依赖 1–15、8.1–8.5、18.1–18.5 可并行）', () => {
  assert.deepEqual(at(real, 645), ['16 <- 1+2+3+4+5+6+7+8+9+10+11+12+13+14+15']);
  assert.deepEqual(at(real, 531), ['18 <- 8.1+8.2+8.3+8.4+8.5,5.1,2.5b,2.6', '18.1+18.2+18.3+18.4+18.5 <- 18.1+18.2+18.3+18.4+18.5']);
});

test('实物：「需要 P1 … + P2（…）+ P5」→ 外部阻塞；删除线里的「需要 P2」不算', () => {
  assert.deepEqual(at(real, 597), ['13 <- P1,P2,P5', '13 <- 10,11,8.5']);
  assert.deepEqual(at(real, 443), ['8.5 <- P5'], '「依赖 P5 的本地回跳地址」');
  assert.deepEqual(at(real, 129), [], '1.9：~~需要 P2 的 key~~ 已划掉');
});

test('实物：分组说明段——子句继承主语、「X 起」', () => {
  // > 2.1–2.4 不依赖任何 spike，可与 M0-a 并行；2.5 起依赖 1.3 的分叉决定。
  assert.deepEqual(at(real, 139), ['2.1+2.2+2.3+2.4 <- 1+1.1+1.2+1.3+1.4+1.5+1.6+1.7+1.8+1.9', '2.5+2.5b+2.6+2.7+2.8+2.9+2.10 <- 1.3']);
  assert.deepEqual(rels(real).filter((r) => r.source.line === 139).map((r) => [r.kind, r.via, r.subjects[0].type]),
    [['parallel', 'group-note', 'range'], ['dep', 'group-note', 'from']]);
  assert.ok(!edges(real, 'dep').has('2.1<-1.3'), '「不依赖」没有产生边');
});

test('实物：未识别的依赖说法进 unknownRelations，其它叙述不误报', () => {
  assert.deepEqual(real.parse.unknownRelations, [
    { file: 'collab-m0-space-run', line: 119, text: '最迟在任务 12.2 之前做完' },
    { file: 'collab-m0-space-run', line: 531, text: '18.6 最后统一外观' },
  ]);
});

test('实物：每条关系都带 source（文件、行号、原文）', () => {
  assert.ok(real.relations.length > 30);
  for (const r of real.relations) {
    assert.equal(r.source.file, 'collab-m0-space-run');
    assert.equal(realText.split('\n')[r.source.line - 1].trim().slice(0, 160), r.source.text);
    assert.ok(['title', 'body', 'group-note', 'prereq-table', 'mermaid'].includes(r.via));
  }
});

// ---- 合成夹具 ----

const syn = parseTasksDoc(fixture('synthetic-inline'), 'synthetic-inline');

test('合成：英文逗号列表、T 前缀、依赖：无、2.x、悬空、串行、自依赖照样记录', () => {
  const t = fixture('synthetic-inline');
  assert.deepEqual(at(syn, lineOf(t, '加粗编号的子任务')), ['1.1 <- 0.1,20']);
  assert.deepEqual(rels(syn).filter((r) => r.source.line === lineOf(t, 'T20')).map((r) => [r.kind, show(r.subjects), r.objects.length]),
    [['none', '20', 0]], '「依赖：无。」记为文档声明无依赖');
  assert.deepEqual(at(syn, lineOf(t, '2.5b')), ['2.5b <- 2.10+2.5b+2.5+2.6+2.7+2.8+2.9'], '2.x = 2 的全部子任务（排除自身归 engine）');
  const dangling = rels(syn).find((r) => r.source.line === lineOf(t, '4a.1'));
  assert.deepEqual(dangling.objects, [{ raw: '9.9', type: 'task', keys: [], dangling: true }]);
  assert.deepEqual(at(syn, lineOf(t, '串行写法')), ['8 <- 7'], '「7 → 8 串行」');
  assert.deepEqual(at(syn, lineOf(t, '围栏之后')), ['8 <- 7', '8 <- 8'], '自依赖原样记下，由 engine 标环');
});

test('合成：分组别名作引用、说明段里的英文逗号列表可并行', () => {
  const line = lineOf(fixture('synthetic-inline'), '本组依赖');
  assert.deepEqual(at(syn, line), ['1+1.1+1.2+1.3 <- 0.1+20', '1.1,1.2 <- 1.1,1.2']);
  assert.equal(syn.relations.find((r) => r.source.line === line).objects[0].type, 'group');
});

// ---- 写法逐条 ----

const base = '# T\n## 阶段 1\n- [ ] 1 一\n- [ ] 2 二\n- [ ] 2.1 二一\n- [ ] 2.2 二二\n- [ ] 2.3 二三\n- [ ] 3 三\n- [ ] 4 四\n';

test('列表分隔符：、，, 和 及 与 /；遇到非 Ref 即停', () => {
  const d = doc1(`${base}- [ ] 5 五（依赖 1、2，3 和 4）\n- [ ] 6 六（依赖 1 及 2 与 3/4 的产出，另说 7）\n`);
  assert.deepEqual(at(d, 10), ['5 <- 1,2,3,4']);
  assert.deepEqual(at(d, 11), ['6 <- 1,2,3,4']);
});

test('编号前带「任务」二字：依赖任务 1、2 / 依赖任务 2.1 的产出 / 依赖：任务 1-2 / 与任务 3/4 并行 / 任务 1、任务 3 可并行 / 依赖 task 4', () => {
  const d = doc1(`${base}- [ ] 5 五（依赖任务 1、2）\n- [ ] 6 六（依赖任务 2.1 的 avatar prop）\n- [ ] 7 七（依赖：任务 1-2 全部完成）\n`
    + '- [ ] 8 八（与任务 3/4 并行）\n- [ ] 9 九（任务 1、任务 3 可并行）\n- [ ] 10 十（依赖 task 4 通过）\n');
  assert.deepEqual(at(d, 10), ['5 <- 1,2']);
  assert.deepEqual(at(d, 11), ['6 <- 2.1']);
  assert.deepEqual(at(d, 12), ['7 <- 1+2']);
  assert.deepEqual(at(d, 13), ['8 <- 3,4']);
  assert.deepEqual(at(d, 14), ['1,3 <- 1,3']);
  assert.deepEqual(at(d, 15), ['10 <- 4']);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('范围：长横 / 短横都算；跨父不展开；区间内没有任务即悬空', () => {
  const d = doc1(`${base}- [ ] 5 五（依赖 2.1–2.2）\n- [ ] 6 六（依赖 2.2-2.3）\n- [ ] 7 七（依赖 1–2.3）\n- [ ] 8 八（依赖 20—30）\n`);
  assert.deepEqual(at(d, 10), ['5 <- 2.1+2.2']);
  assert.deepEqual(at(d, 11), ['6 <- 2.2+2.3']);
  assert.deepEqual(at(d, 12), ['7 <- !1–2.3']);
  assert.deepEqual(at(d, 13), ['8 <- !20—30']);
});

test('父任务号与 2.x：前者指向父任务（后代由 engine 展开），后者直接列出子任务', () => {
  const d = doc1(`${base}- [ ] 5 五（依赖 2）\n- [ ] 6 六（依赖 2.x）\n- [ ] 7 七（依赖 9.x）\n`);
  assert.deepEqual(at(d, 10), ['5 <- 2']);
  assert.deepEqual(at(d, 11), ['6 <- 2.1+2.2+2.3']);
  assert.deepEqual(at(d, 12), ['7 <- !9.x']);
});

test('里程碑代号：只认本文档存在的，长代号优先，大小写不敏感', () => {
  const d = doc1('## 里程碑 M1：一\n- [ ] 1 一\n## 里程碑 M10：十\n- [ ] 2 二\n## 里程碑 M2：二\n- [ ] 3 三（依赖 M10、m1；M3 不存在）\n');
  assert.deepEqual(at(d, 6), ['3 <- 2,1']);
  assert.deepEqual(d.relations[0].objects.map((r) => r.type), ['group', 'group']);
});

test('并行四种写法：可与 X、可与列表、范围可并行、/ 可并行，两端都可见', () => {
  const d = doc1(`${base}- [ ] 5 五（可与 4 并行）\n- [ ] 6 六（可与 1、3 并行）\n- [ ] 7 七（2.1–2.3 可并行）\n- [ ] 8 八（1 / 4 可并行）\n`);
  const p = edges(d, 'parallel');
  for (const pair of ['4~5', '1~6', '3~6', '2.1~2.2', '2.1~2.3', '2.2~2.3', '1~4']) assert.ok(p.has(pair), pair);
  assert.equal(p.size, 7);
  assert.equal(edges(d, 'dep').size, 0);
});

test('顺序：依次、串行、→ 链、同段 / 两两并行、子句只由引用组成', () => {
  const d = doc1(`${base}- [ ] 5 五（2.1 / 2.2 / 2.3 依次）\n- [ ] 6 六（1 → 2 / 3 → 4）\n- [ ] 7 七（3、4 串行）\n`);
  assert.deepEqual(at(d, 10), ['2.2 <- 2.1', '2.3 <- 2.2']);
  assert.deepEqual(at(d, 11), ['2,3 <- 1', '2,3 <- 2,3', '4 <- 2,3']);
  assert.deepEqual(at(d, 12), ['4 <- 3']);
});

test('「X 完成后」；版本号不是 Ref；跨文档任务键', () => {
  const d = doc1(`${base}- [ ] 5 五（2.x 完成后开始）\n- [ ] 6 六（依赖 2.0.6）\n- [ ] 7 七（依赖 other-spec#3、d#4、T1 测试）\n`);
  assert.deepEqual(at(d, 10), ['5 <- 2.1+2.2+2.3']);
  assert.deepEqual(at(d, 11), []);
  assert.deepEqual(d.parse.unknownRelations, [], '「依赖 2.0.6」没有引用，不算未识别说法');
  const r = d.relations.find((x) => x.source.line === 12);
  assert.deepEqual(r.objects.map((o) => [o.type, o.keys, o.dangling]), [
    ['key', ['other-spec#3'], false], ['key', ['d#4'], false], ['task', ['d#1'], false],
  ], '跨文档键原样交给 engine；本文档的键就地解析');
});

test('P 编号：依赖 / 需要 都产生外部阻塞；前置表里没有的标悬空', () => {
  const d = doc1(`| # | 事项 | 阻塞 |\n|---|---|---|\n| P1 | 要账号 | 1 |\n${base}- [ ] 5 五（需要 P1 + P9；依赖 P1）\n`);
  assert.deepEqual(at(d, 13), ['5 <- P1,!P9', '5 <- P1']);
  assert.equal(d.relations.find((r) => r.source.line === 13).objects[0].type, 'prereq');
});

test('正文行：只认以 依赖 / 前置 / 并行 / 顺序 开头的，其余叙述与代码围栏不参与', () => {
  const d = doc1(`${base}- [ ] 5 五\n  - **依赖**：1, 2\n  - 前置：3\n  - 并行：4\n  - 顺序：2.1 → 2.2\n  - 需求 1.3、2 依赖它（叙述，不算）\n  \`\`\`\n  依赖 4\n  \`\`\`\n`);
  assert.deepEqual(at(d, 11), ['5 <- 1,2']);
  assert.deepEqual(at(d, 12), ['5 <- 3']);
  assert.deepEqual(at(d, 13), ['5 <- 4']);
  assert.deepEqual(at(d, 14), ['2.2 <- 2.1']);
  assert.equal(d.relations.length, 4);
  assert.deepEqual(d.relations.map((r) => r.via), ['body', 'body', 'body', 'body']);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('不含任务的章节与分组说明段以外的正文不参与（「需要确认」「依赖 1」都不产生关系）', () => {
  const text = '# 计划\n\n## 执行约定\n\n- 导航：总览、需要确认、诊断；依赖 1 最后做。\n\n## 任务\n\n### 阶段 1\n\n> 本组 1 → 2 依次。\n\n- [ ] 1 一\n- [ ] 2 二\n\n说明：1 最后做，依赖 2。\n';
  const d = doc1(text);
  assert.deepEqual(d.relations.map((r) => [r.via, r.source.line]), [['group-note', 11]]);
  assert.deepEqual(at(d, 11), ['2 <- 1']);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('含关键词且带引用、但没有命中任何模式 → 未识别说法（原文 + 行号）；没引用的不报', () => {
  const d = doc1(`${base}- [ ] 5 五（最迟在任务 2 之前做完；视觉最后统一）\n`);
  assert.deepEqual(d.parse.unknownRelations, [{ file: 'd', line: 10, text: '最迟在任务 2 之前做完' }]);
});

// ---- Mermaid 任务依赖图（design §3.4.3）----

const F = '```';
// 按来源摊成 dep 边「后<-前」（只取任务，不含 P 编号）。
const depEdges = (doc, via) => new Set(doc.relations.filter((r) => r.kind === 'dep' && r.via === via)
  .flatMap((r) => r.subjects.flatMap((s) => r.objects.filter((o) => o.type !== 'prereq').flatMap((o) => o.keys.map((ok) => s.keys.map((sk) => `${num(sk)}<-${num(ok)}`)))).flat()));

test('Mermaid：三种箭头、|说明|、链式，标签首个 token 映射任务号；映射不上的节点与注释、样式行不产出边', () => {
  const text = `${base}- [ ] 5 五（依赖 4）\n\n${F}mermaid\nflowchart LR\n  A[1 一] --> B[2 二] -.-> C((任务 3 三))\n  C ==> D{Task 4 四}\n  B -->|先| E[2.1 子]\n  D --> 5\n  X[外部系统] --> A\n  %% A --> D\n  subgraph M1\n    V[2.0.6 版本号不是任务]\n  end\n  style A fill:#fff\n${F}\n`;
  const d = doc1(text);
  assert.equal(d.parse.mermaidUsed, true, '8 个节点 6 个能映射');
  assert.deepEqual([...depEdges(d, 'mermaid')], ['2<-1', '3<-2', '4<-3', '2.1<-2', '5<-4']);
  const l = lineOf(text, 'A[1 一]');
  assert.deepEqual(d.relations.filter((r) => r.via === 'mermaid' && r.source.line === l).map((r) => r.source.text),
    ['A[1 一] --> B[2 二] -.-> C((任务 3 三))', 'A[1 一] --> B[2 二] -.-> C((任务 3 三))'], '来源 = 边所在的围栏行');
  assert.deepEqual([...depEdges(d, 'title')], ['5<-4'], '与文字关系取并集：两边都保留');
  assert.deepEqual(d.parse.unknownRelations, [], '围栏里的 --> 不当未识别说法');
});

test('Mermaid：不足一半节点能映射则整图忽略；刚好一半启用；只看 mermaid 围栏里的 flowchart / graph', () => {
  const ignored = doc1(`${base}\n${F}mermaid\ngraph TD\n  PR1 --> PR2\n  PR2 --> N[1 一]\n${F}\n`);
  assert.equal(ignored.parse.mermaidUsed, false);
  assert.deepEqual(ignored.relations.filter((r) => r.via === 'mermaid'), []);

  const half = doc1(`${base}\n${F}mermaid\ngraph TD\n  1 --> 2\n  Y[外部] --> Z[外部]\n${F}\n`);
  assert.equal(half.parse.mermaidUsed, true);
  assert.deepEqual([...depEdges(half, 'mermaid')], ['2<-1'], '没写形状的节点按 id 本身映射');

  const others = doc1(`${base}\n${F}mermaid\nsequenceDiagram\n  1 ->> 2: hi\n${F}\n${F}text\nflowchart TD\n  1 --> 2\n${F}\n`);
  assert.equal(others.parse.mermaidUsed, false, '时序图、非 mermaid 围栏都不看');
});

test('实物：collab-m0-space-run 的 Mermaid 图启用，补上文字没写的边（13、14 → 15.1），UI[18 2.0.6 …] 映射到 18', () => {
  assert.equal(real.parse.mermaidUsed, true);
  const m = depEdges(real, 'mermaid');
  for (const e of ['15.1<-13', '15.1<-14', '18<-8.5', '13<-18', '2.5b<-2.5']) assert.ok(m.has(e), e);
  assert.ok(!['title', 'body', 'group-note'].some((via) => depEdges(real, via).has('15.1<-14')), '这条边只有图里有');
});

// ---- 自举：devboard 自己的 tasks.md（任务 2.2；以后改 tasks.md 也要守住这套写法）----

// 内部 spec 不进公开仓库（N22），那边没有这份文件时跳过；文档写法另由 convention.test 用三语示例守住。
const SELF_SPEC = new URL('../.claude/specs/devboard-mvp/tasks.md', import.meta.url);
test('自举：.claude/specs/devboard-mvp/tasks.md 按最低约定整份识别，Mermaid 边集合 = 标题括号依赖边集合', { skip: !existsSync(SELF_SPEC) && '没有内部 spec（公开仓库）' }, () => {
  const text = readFileSync(SELF_SPEC, 'utf8');
  const d = parseTasksDoc(text, 'devboard-mvp');
  assert.equal(d.parse.state, 'ok');
  assert.deepEqual(d.parse.unrecognizedLines, []);
  assert.deepEqual(d.parse.unknownRelations, []);
  assert.deepEqual(d.parse.unknownEstimates, [], '无「无法识别的耗时写法」');
  assert.deepEqual(d.tasks.filter((t) => !(t.estimateHours > 0)).map((t) => t.number), [], '每个任务都有预计耗时');
  assert.deepEqual(d.groups.map((g) => g.code), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  assert.deepEqual(d.prerequisites.map((p) => [p.id, p.blocksNums]), [['P1', []], ['P2', []], ['P3', []], ['P4', []]], 'P1–P4 都不阻塞');
  assert.ok(!d.relations.some((r) => r.objects.some((o) => o.type === 'prereq')), '没有外部阻塞');

  // 标题里的「可与 … 并行」：每一处都产出 parallel，两端都落到真实任务。
  const said = d.tasks.filter((t) => /可与.+并行/.test(t.title));
  assert.ok(said.length >= 4);
  for (const t of said) {
    const r = d.relations.find((x) => x.kind === 'parallel' && x.via === 'title' && x.source.line === t.line);
    assert.ok(r, `${t.number} 的并行没识别`);
    assert.ok([...r.subjects, ...r.objects].every((x) => !x.dangling && x.keys.length), `${t.number} 的并行有悬空端`);
  }

  // 标题括号里的依赖不得有悬空引用；图与文字必须一一对应。
  assert.ok(d.relations.filter((r) => r.via === 'title').every((r) => [...r.subjects, ...r.objects].every((x) => !x.dangling)));
  assert.equal(d.parse.mermaidUsed, true);
  const [fromGraph, fromTitle] = [depEdges(d, 'mermaid'), depEdges(d, 'title')];
  assert.ok(fromTitle.size > 40);
  assert.deepEqual([...fromGraph].filter((e) => !fromTitle.has(e)), [], '图里有、标题括号里没写的边');
  assert.deepEqual([...fromTitle].filter((e) => !fromGraph.has(e)), [], '标题括号里写了、图里没画的边');
});

// ---- 英文 / 日文同义写法（NEXT 22.2）：中文写法不变，只多认等价的关键词 ----

const enBase = '# T\n## Phase 1\n- [ ] 1 one\n- [ ] 2 two\n- [ ] 2.1 two-one\n- [ ] 2.2 two-two\n- [ ] 2.3 two-three\n- [ ] 3 three\n- [ ] 4 four\n';

test('英文依赖：depends on / depends: / Dependencies: / blocked by / tasks 1 and 2 / Oxford 逗号 / &', () => {
  const d = doc1(`${enBase}- [ ] 5 five (depends on 1, 2)\n- [ ] 6 six (Depends: 3 & 4)\n- [ ] 7 seven (blocked by tasks 1 and 2.1)\n`
    + '- [ ] 8 eight (dependencies: 1, 2, and 3)\n- [ ] 9 nine (depends on Phase 1)\n- [ ] 10 ten (Depends on: none)\n- [ ] 11 eleven (no dependencies)\n');
  assert.deepEqual(at(d, 10), ['5 <- 1,2']);
  assert.deepEqual(at(d, 11), ['6 <- 3,4']);
  assert.deepEqual(at(d, 12), ['7 <- 1,2.1']);
  assert.deepEqual(at(d, 13), ['8 <- 1,2,3']);
  assert.deepEqual(rels(d).filter((r) => r.source.line === 14).map((r) => [r.kind, r.objects[0].type, r.objects[0].raw]), [['dep', 'group', 'Phase 1']]);
  assert.deepEqual(rels(d).filter((r) => r.source.line === 15).map((r) => r.kind), ['none']);
  assert.deepEqual(at(d, 16), []);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('英文 requires / after 是弱关键词：带冒号、task 前缀、非裸编号引用、或列表结束子句 / 后接完成动词才算', () => {
  const d = doc1(`${enBase}- [ ] 5 five (requires 2.1)\n- [ ] 6 six (after task 3)\n- [ ] 7 seven (after 4 is done)\n- [ ] 8 eight (After: 1, 2)\n`
    + '- [ ] 9 nine: retry after 3 failures\n- [ ] 10 ten: needs about 2 GB (requires 2 GB RAM)\n- [ ] 11 eleven: wait 2–3 days after 1\n');
  assert.deepEqual(at(d, 10), ['5 <- 2.1']);
  assert.deepEqual(at(d, 11), ['6 <- 3']);
  assert.deepEqual(at(d, 12), ['7 <- 4']);
  assert.deepEqual(at(d, 13), ['8 <- 1,2']);
  assert.deepEqual(at(d, 14), [], '「after 3 failures」是叙述');
  assert.deepEqual(at(d, 15), [], '「requires 2 GB」是叙述');
  assert.deepEqual(at(d, 16), ['11 <- 1'], '弱关键词后的引用结束子句才认；前面的 2–3 days 不是引用');
  assert.deepEqual(d.parse.unknownRelations, [], 'after / requires 不进未识别说法的关键词');
});

test('英文并行与顺序：parallel with / can run in parallel with / Parallel: / X in parallel / in order / sequentially / Order:', () => {
  const d = doc1(`${enBase}- [ ] 5 five (parallel with 4)\n- [ ] 6 six (can run in parallel with 1 and 3)\n- [ ] 7 seven (2.1–2.3 can run in parallel)\n`
    + '- [ ] 8 eight (1 / 4 in parallel)\n- [ ] 9 nine (2.1 / 2.2 / 2.3 in order)\n- [ ] 10 ten (3, 4 sequentially)\n- [ ] 11 eleven\n  - Order: 1 → 2 → 3\n  - Parallel: 4\n');
  const p = edges(d, 'parallel');
  for (const pair of ['4~5', '1~6', '3~6', '2.1~2.2', '2.1~2.3', '2.2~2.3', '1~4', '11~4']) assert.ok(p.has(pair), pair);
  assert.deepEqual(at(d, 14), ['2.2 <- 2.1', '2.3 <- 2.2']);
  assert.deepEqual(at(d, 15), ['4 <- 3']);
  assert.deepEqual(at(d, 17), ['2 <- 1', '3 <- 2']);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('英文正文行：只认以 Depends / Requires / After / Blocked by / Parallel / Order 开头的；普通叙述不产生关系', () => {
  const d = doc1(`${enBase}- [ ] 5 five\n  - **Depends on**: 1, 2\n  - Blocked by 3\n  - After the meeting we will look at 3 options\n`
    + '  - We could do this after 4 is done\n  - in order to ship 2 we need care\n');
  assert.deepEqual(at(d, 11), ['5 <- 1,2']);
  assert.deepEqual(at(d, 12), ['5 <- 3']);
  assert.equal(d.relations.length, 2);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('英文分组说明段：X onward 依赖、Milestone 代号、needs P1 外部阻塞', () => {
  const t = '| ID | Item | Blocks |\n|---|---|---|\n| P1 | sandbox | 2 |\n## Milestone M1: base\n- [ ] 1 one\n## Milestone M2: features\n'
    + '> 2.2 onward depends on M1. This group needs P1.\n- [ ] 2 two\n- [ ] 2.1 two-one\n- [ ] 2.2 two-two\n- [ ] 2.3 two-three\n';
  const d = doc1(t);
  assert.deepEqual(at(d, 7), ['2.2+2.3 <- 1', '2+2.1+2.2+2.3 <- P1']);
  assert.equal(d.groups[1].code, 'M2');
  assert.deepEqual(d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]), [['P1', false, ['2']]]);
});

test('英文前置条件表：Blocks 列、resolved / (done) 解除、none / non-blocking 不阻塞；「provided by」只是说明', () => {
  const d = doc1('| ID | Item | Blocks |\n|---|---|---|\n| P1 | test env | 1 |\n| P2 | API key (done) | none |\n| P3 | domain, resolved | non-blocking |\n'
    + '| P4 | key provided by ops | 2 |\n## Tasks\n- [ ] 1 one\n- [ ] 2 two (needs P1 + P4)\n');
  assert.deepEqual(d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]),
    [['P1', false, ['1']], ['P2', true, []], ['P3', true, []], ['P4', false, ['2']]]);
  assert.deepEqual(at(d, 9), ['2 <- P1,P4']);
});

const jaBase = '# T\n## フェーズ 1\n- [ ] 1 いち\n- [ ] 2 に\n- [ ] 2.1 にのいち\n- [ ] 2.2 にのに\n- [ ] 2.3 にのさん\n- [ ] 3 さん\n- [ ] 4 よん\n';

test('日文依赖：依存 X / 依存：X / X に依存 / X の完了後 / 前提タスク / タスク 1 と 2 / 依存：なし / 依存なし', () => {
  const d = doc1(`${jaBase}- [ ] 5 ご（依存：1、2）\n- [ ] 6 ろく（3 に依存）\n- [ ] 7 なな（タスク 1 と 2.1 に依存）\n- [ ] 8 はち（4 の完了後に着手）\n`
    + '- [ ] 9 きゅう（前提タスク 3）\n- [ ] 10 じゅう（依存：なし）\n- [ ] 11 じゅういち（依存なし）\n- [ ] 12 じゅうに（フェーズ 1 に依存）\n');
  assert.deepEqual(at(d, 10), ['5 <- 1,2']);
  assert.deepEqual(at(d, 11), ['6 <- 3']);
  assert.deepEqual(at(d, 12), ['7 <- 1,2.1']);
  assert.deepEqual(at(d, 13), ['8 <- 4']);
  assert.deepEqual(at(d, 14), ['9 <- 3']);
  assert.deepEqual(rels(d).filter((r) => r.source.line === 15).map((r) => r.kind), ['none']);
  assert.deepEqual(at(d, 16), []);
  assert.deepEqual(rels(d).filter((r) => r.source.line === 17).map((r) => [r.kind, r.objects[0].type, r.objects[0].raw]), [['dep', 'group', 'フェーズ 1']]);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('日文并行与顺序：X と並行 / 並行：X / X は並行可 / X を順に / X 直列 / 順序：；「、」在日文句子里也切子句', () => {
  const d = doc1(`${jaBase}- [ ] 5 ご（4 と並行可）\n- [ ] 6 ろく（1 に依存、3 と並行）\n- [ ] 7 なな（2.1〜2.3 は並行可）\n`
    + '- [ ] 8 はち（2.1、2.2、2.3 を順に）\n- [ ] 9 きゅう（3、4 直列）\n- [ ] 10 じゅう\n  - 順序：1 → 2 → 3\n  - 並行：4\n');
  const p = edges(d, 'parallel');
  for (const pair of ['4~5', '3~6', '10~4', '2.1~2.2', '2.1~2.3', '2.2~2.3']) assert.ok(p.has(pair), pair);
  assert.deepEqual(at(d, 11, 'dep'), ['6 <- 1']);
  assert.deepEqual(at(d, 13), ['2.2 <- 2.1', '2.3 <- 2.2']);
  assert.deepEqual(at(d, 14), ['4 <- 3']);
  assert.deepEqual(at(d, 16), ['2 <- 1', '3 <- 2']);
  assert.deepEqual(d.parse.unknownRelations, []);
});

test('日文：X 以降、P1 が必要、マイルストーン代号、前置表 ブロック / 解決済み / なし', () => {
  const t = '| ID | 事項 | ブロック |\n|---|---|---|\n| P1 | 検証環境 | 2 |\n| P2 | API キー（解決済み） | なし |\n## マイルストーン M1：基盤\n- [ ] 1 いち\n'
    + '## マイルストーン M2：機能\n> 2.2 以降は M1 に依存。\n- [ ] 2 に\n- [ ] 2.1 にのいち\n- [ ] 2.2 にのに（P1 と P2 が必要）\n';
  const d = doc1(t);
  assert.deepEqual(at(d, 8), ['2.2 <- 1']);
  assert.deepEqual(at(d, 11), ['2.2 <- P1,P2']);
  assert.equal(d.groups[1].code, 'M2');
  assert.deepEqual(d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]), [['P1', false, ['2']], ['P2', true, []]]);
});

test('中文的「、」在没有假名的句子里仍是列表分隔：「需要 P1 账号、P2 key」两个都收', () => {
  const d = doc1(`| # | 事项 | 阻塞 |\n|---|---|---|\n| P1 | a | 1 |\n| P2 | b | 1 |\n${base}- [ ] 5 五（需要 P1 账号、P2 key）\n`);
  assert.deepEqual(at(d, 14), ['5 <- P1,P2']);
});

test('Mermaid 节点标签可用「タスク N」', () => {
  const d = doc1(`${jaBase}\n${F}mermaid\nflowchart TD\n  A[タスク 1] --> B[タスク 3]\n${F}\n`);
  assert.deepEqual([...depEdges(d, 'mermaid')], ['3<-1']);
});
