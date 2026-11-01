// AI 声明当前任务。解析、关联与声明率；扫描器的产出在 sessions / codex-sessions 测试里。全部是虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard, linkSessions } from '../src/engine.mjs';
import { declarations, extractRefs } from '../src/refs.mjs';
import { summarize } from '../src/summary.mjs';
import { focusOf } from '../hooks/model.mjs';

const NOW = '2026-09-20T08:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) - min * 6e4).toISOString();
const doc = (text, docId) => ({ docId, archived: false, path: `${docId}.md`, ...parseTasksDoc(text, docId) });
const PLAN = doc('- [ ] 1 第一件\n- [ ] 2 第二件\n- [ ] 3 第三件\n- [ ] 4 第四件\n', 'plan');
const DOCS = [PLAN];
let n = 0;
const sig = (kind, from, until, extra) => ({ kind, at: from, until, file: 'r/s.jsonl', line: ++n, ...extra });
const say = (text, from, until = from) => sig('prompt', from, until, {
  snippet: text, refs: extractRefs(text, { knownDocIds: ['plan'], knownCodes: [] }) });
const cmd = (text, from, until = from, extra) => sig('command', from, until, {
  snippet: text, refs: extractRefs(text, { knownDocIds: ['plan'], knownCodes: [] }), ...extra });
const decl = (line, from, until = from, extra) => {
  const [d] = declarations(line);
  const { text, ...rest } = d;
  return sig('declare', from, until, { ...rest, snippet: text, ...extra });
};
const session = (id, signals, over = {}) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/repo'], branches: [], title: `标题 ${id}`,
  firstAt: signals[0].at, lastAt: signals.map((s) => s.until).sort().at(-1), lastSummary: null, signals, aiOnlyMentions: 0, brokenLines: 0, ...over });
const board = (sessions, docs = DOCS, prs = []) => computeBoard(docs, prs, sessions, [], {}, { id: 'demo' }, NOW);
const view = (b, key) => b.tasks.find((t) => t.key === key);
const working = (b) => b.tasks.filter((t) => t.sessions.some((l) => l.workAt)).map((t) => t.key);
const main = (b, id = 's') => focusOf(summarize(b), id);

// ---- 解析 ----

test('声明行：单任务、多任务、none；行尾空白不算', () => {
  assert.deepEqual(declarations('[yuiboard] task plan#1'), [{ text: '[yuiboard] task plan#1', keys: ['plan#1'], bad: [] }]);
  assert.deepEqual(declarations('好的\n[yuiboard] task plan#1 plan#2  \n开始')[0].keys, ['plan#1', 'plan#2']);
  assert.deepEqual(declarations('[yuiboard] task none'), [{ text: '[yuiboard] task none', keys: [], bad: [], none: true }]);
  assert.deepEqual(declarations('[yuiboard] task plan#1\n做完了\n[yuiboard] task none').map((d) => Boolean(d.none)), [false, true], '一条回复里可以有多行');
});

test('声明行：必须独占一行、顶格；代码块和引用块里的不算；普通文字不算', () => {
  for (const text of [
    '下面写 [yuiboard] task plan#1 即可',
    '> [yuiboard] task plan#1',
    '```\n[yuiboard] task plan#1\n```',
    '~~~md\n[yuiboard] task plan#1\n~~~',
    '说明\n\n    [yuiboard] task plan#1',
    '- [yuiboard] task plan#1',
    '`[yuiboard] task plan#1`',
    '[YUIBOARD] task plan#1',
    '[yuiboard] task',
    '继续做任务 1',
  ]) assert.deepEqual(declarations(text), [], text);
});

test('声明行：写法不对的引用单独列出', () => {
  assert.deepEqual(declarations('[yuiboard] task plan#1 38 没有井号'), [{ text: '[yuiboard] task plan#1 38 没有井号', keys: ['plan#1'], bad: ['38', '没有井号'] }]);
  assert.deepEqual(declarations('[yuiboard] task none plan#1')[0].bad, ['none'], 'none 只能单独写');
});

// ---- 关联 ----

test('声明的任务算实际工作：进行中，运行中，证据写明是 AI 声明', () => {
  const b = board([session('s', [decl('[yuiboard] task plan#1', at(10), at(2))])]);
  const v = view(b, 'plan#1');
  assert.deepEqual([v.status, v.inProgressBy, v.activity], ['in_progress', ['session'], 'running']);
  assert.equal(v.sessions[0].evidence[0].note, 'AI 声明：「[yuiboard] task plan#1」');
  assert.equal(v.sessions[0].workAt, at(10));
});

test('中途从 A 换到 B：之后的活动只续 B', () => {
  const s = session('s', [decl('[yuiboard] task plan#1', at(60), at(50)), decl('[yuiboard] task plan#2', at(49), at(2))]);
  const b = board([s]);
  assert.equal(view(b, 'plan#1').sessions[0].lastAt, at(50));
  assert.equal(view(b, 'plan#2').sessions[0].lastAt, at(2));
  assert.deepEqual(main(b).keys, ['plan#2']);
});

test('none 清空焦点：之后的活动谁也不续，后来提到的任务也不算在做', () => {
  const s = session('s', [decl('[yuiboard] task plan#1', at(60), at(50)), decl('[yuiboard] task none', at(49), at(40)), say('顺便看一下 plan#2', at(30), at(2))]);
  const b = board([s]);
  assert.equal(view(b, 'plan#1').sessions[0].lastAt, at(50));
  assert.deepEqual(working(b), ['plan#1']);
  assert.equal(view(b, 'plan#2').status, 'not_started');
  assert.equal(main(b).recent, true, '面板不写「正在做」');
});

test('有声明后，后来提到的任务抢不走：人点名、命令、分支、PR 登记都只留记录', () => {
  const prs = [{ number: 9, title: '任务 4', body: '', url: '', state: 'OPEN', isDraft: true, baseRefName: 'main', headRefName: 'feat/x', labels: [], createdAt: at(99), updatedAt: at(99), mergedAt: null, closedAt: null, readyAt: null }];
  const s = session('s', [decl('[yuiboard] task plan#1', at(60), at(50)), say('plan#2 也看看', at(40), at(35)),
    cmd('git commit -m "任务 3 收尾"', at(30), at(25)), sig('branch', at(20), at(10), { branch: 'feat/x' }), sig('pr-link', at(9), at(2), { pr: 9 })]);
  const b = board([s], DOCS, prs);
  assert.deepEqual(working(b), ['plan#1']);
  assert.equal(view(b, 'plan#1').sessions[0].lastAt, at(2), '活动继续算在声明的任务上');
  assert.equal(view(b, 'plan#2').sessions[0].lastAt, at(40), '提到只留在那一刻');
  assert.deepEqual([view(b, 'plan#2').status, view(b, 'plan#3').status], ['not_started', 'not_started']);
  assert.equal(view(b, 'plan#4').status, 'in_review', 'PR 状态仍由 PR 决定');
  assert.deepEqual(main(b).keys, ['plan#1']);
});

test('声明之前的现有规则照旧，声明接管之后的焦点', () => {
  const s = session('s', [say('做 plan#2', at(60), at(50)), decl('[yuiboard] task plan#1', at(49), at(2))]);
  const b = board([s]);
  assert.equal(view(b, 'plan#2').sessions[0].lastAt, at(50));
  assert.deepEqual(main(b).keys, ['plan#1']);
});

test('对不上的声明不采用，报 h；焦点、声明状态都不变', () => {
  const s = session('s', [say('做 plan#2', at(60), at(50)), decl('[yuiboard] task plan#99', at(40), at(30)), decl('[yuiboard] task 编号', at(29), at(2))]);
  s.signals[0].worked = at(55);
  const b = board([s]);
  assert.deepEqual(b.conflicts.filter((c) => c.sessionId).map((c) => [c.type, c.detail, c.source.text]), [
    ['h', '会话「标题 s」声明了对不上的任务：plan#99', '[yuiboard] task plan#99'],
    ['h', '会话「标题 s」声明了对不上的任务：编号', '[yuiboard] task 编号'],
  ]);
  assert.equal(view(b, 'plan#2').sessions[0].lastAt, at(2), '没采用，现有规则继续');
  assert.equal(b.sessions[0].declared, undefined);
  assert.equal(b.diagnostics.declarations.declared, 0);
});

test('部分对得上：采用对得上的，其余报 h', () => {
  const b = board([session('s', [decl('[yuiboard] task plan#1 plan#99', at(10), at(2))])]);
  assert.deepEqual(working(b), ['plan#1']);
  assert.deepEqual(b.conflicts.filter((c) => c.sessionId).map((c) => c.detail), ['会话「标题 s」声明了对不上的任务：plan#99']);
});

test('docRef 分支线的原名与 ADR 简称、范围都按现有口径解析', () => {
  const next = { ...doc('- [ ] 5 第五件\n- [ ] 6 第六件\n', 'next:ADR-1-x'), alias: 'ADR-1-x' };
  const b = board([session('s', [decl('[yuiboard] task ADR-1-x#5–6', at(10), at(2))])], [PLAN, next]);
  assert.deepEqual(working(b), ['next:ADR-1-x#5', 'next:ADR-1-x#6']);
});

test('子 agent 那一路分开算：它的声明不改主线，主线的声明也不改它', () => {
  const lane = { lane: 'tool-1' };
  const s = session('s', [
    decl('[yuiboard] task plan#1', at(60), at(2)),
    sig('dispatch', at(50), at(50), { refs: extractRefs('', {}), toolUseId: 'tool-1' }),
    sig('agent', at(49), at(49), lane),
    decl('[yuiboard] task plan#2', at(48), at(10), lane),
    decl('[yuiboard] task plan#3', at(9), at(3), lane),
    cmd('git commit -m "plan#4"', at(8), at(3), lane),
  ]);
  const b = board([s]);
  assert.deepEqual(working(b), ['plan#1', 'plan#2', 'plan#3']);
  assert.equal(view(b, 'plan#2').sessions[0].lastAt, at(10));
  assert.equal(view(b, 'plan#4').status, 'not_started', '这一路有声明，命令里写的任务抢不走');
  assert.deepEqual(main(b).keys, ['plan#1'], '面板主任务看主线');
});

test('子 agent 没声明时照旧：主线声明不影响它派活时冻结的任务', () => {
  const lane = { lane: 'tool-1' };
  const s = session('s', [
    sig('dispatch', at(50), at(50), { refs: extractRefs('plan#2', { knownDocIds: ['plan'] }), toolUseId: 'tool-1', snippet: 'plan#2' }),
    sig('agent', at(49), at(49), lane),
    decl('[yuiboard] task plan#1', at(48), at(2)),
    cmd('git status', at(10), at(3), lane),
  ]);
  assert.equal(view(board([s]), 'plan#2').sessions[0].lastAt, at(3));
});

test('没有声明的会话：结果与没有这条规则时完全相同', () => {
  const plain = session('s', [say('做 plan#2', at(60), at(50)), cmd('git commit -m "plan#3"', at(40), at(2))]);
  const with0 = linkSessions(DOCS, [plain], [], new Map(), { id: 'demo' });
  assert.deepEqual(with0.links.map((l) => [l.taskKey, l.lastAt, Boolean(l.workAt)]), [['plan#2', at(50), false], ['plan#3', at(2), true]]);
  assert.equal(with0.declared.size, 0);
});

test('fork 复制来的声明：会话上下文照用，工作只算最早的会话', () => {
  const d = decl('[yuiboard] task plan#1', at(60), at(50));
  const b = board([session('a', [d]), session('b', [{ ...d }, say('继续', at(10))], { firstAt: at(59) })]);
  assert.deepEqual(view(b, 'plan#1').sessions.filter((l) => l.workAt).map((l) => l.sessionId), ['a']);
});

test('子 lane 的嵌套派活改不了主线的声明焦点：目标 lane 的记录还没出现时也一样', () => {
  const lane = { lane: 'u' };
  const s = session('s', [
    decl('[yuiboard] task plan#1', at(60), at(50)),
    sig('dispatch', at(49), at(49), { refs: extractRefs('', {}), toolUseId: 'u' }),
    sig('agent', at(48), at(48), lane),
    sig('dispatch', at(47), at(47), { ...lane, refs: extractRefs('plan#2', { knownDocIds: ['plan'] }), toolUseId: 'v', snippet: 'plan#2' }),
    { ...say('顺便看看 plan#3', at(40), at(2)), worked: at(10) },
  ]);
  const b = board([s]);
  assert.equal(view(b, 'plan#1').sessions[0].lastAt, at(2), '主线之后的活动续在声明的任务上');
  assert.ok(view(b, 'plan#2').sessions[0].lastAt < at(2), '派出去的任务不续主线的活动');
  assert.deepEqual(main(b).keys, ['plan#1']);
});

test('没有声明时，子 lane 的嵌套派活照旧改主线焦点', () => {
  const lane = { lane: 'u' };
  const s = session('s', [
    sig('dispatch', at(49), at(49), { refs: extractRefs('', {}), toolUseId: 'u' }),
    sig('agent', at(48), at(48), lane),
    sig('dispatch', at(47), at(47), { ...lane, refs: extractRefs('plan#2', { knownDocIds: ['plan'] }), toolUseId: 'v', snippet: 'plan#2' }),
    say('继续', at(40), at(2)),
  ]);
  assert.equal(view(board([s]), 'plan#2').sessions[0].lastAt, at(2));
});

// ---- 声明率 ----

test('声明率：最近 7 天开工的 Claude 会话里有声明的比例；none 也算有声明，没干活的、只提到的、Codex、旧会话不算', () => {
  const old = at(60 * 24 * 8);
  const b = board([
    session('a', [decl('[yuiboard] task plan#1', at(30))]),
    session('b', [decl('[yuiboard] task none', at(30), at(30), { worked: at(30) })]),
    session('b2', [decl('[yuiboard] task none', at(30))]),
    session('c', [{ ...cmd('git commit -m "plan#2"', at(30)) }]),
    session('d', [say('plan#3 是什么', at(30))]),
    session('e', [decl('[yuiboard] task plan#1', at(30))], { source: 'codex' }),
    session('f', [cmd('git commit -m "plan#2"', old)]),
  ]);
  assert.deepEqual(b.diagnostics.declarations, { days: 7, started: 3, declared: 2 });
});

test('声明率：只有子 agent 声明的会话也算有声明', () => {
  const s = session('s', [sig('agent', at(30), at(30), { lane: 't' }), decl('[yuiboard] task plan#1', at(29), at(29), { lane: 't' })]);
  assert.deepEqual(board([s]).diagnostics.declarations, { days: 7, started: 1, declared: 1 });
});

test('声明率：fork 只复制了工作历史不算开工，fork 后新增工作才算', () => {
  const copied = { ...say('做 plan#2', at(60), at(50)), worked: at(55) };
  const a = session('a', [copied, decl('[yuiboard] task plan#1', at(40))]);
  assert.deepEqual(board([a, session('b', [{ ...copied }], { firstAt: at(59) })]).diagnostics.declarations, { days: 7, started: 1, declared: 1 }, '只复制');
  const more = session('b', [{ ...copied, worked: at(30) }], { firstAt: at(59) });
  assert.deepEqual(board([a, more]).diagnostics.declarations, { days: 7, started: 2, declared: 1 }, '新增工作');
});

test('声明率：none 之后没有任务关联，但真的干了活的会话算开工', () => {
  const s = session('s', [decl('[yuiboard] task none', at(30), at(30), { worked: at(29) })]);
  assert.deepEqual(board([s]).diagnostics.declarations, { days: 7, started: 1, declared: 1 });
});
