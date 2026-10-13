// N25 任务 2：hooks/model.mjs 的纯函数（design §4.1）。摘要按 design §3.1 的字段手写最小对象，数据虚构。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { langOf, pickProject, focusOf, focusPath, paneOf, fit, commandText, rowCost, TEXT_BUDGET } from '../hooks/model.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { extractRefs } from '../src/refs.mjs';
import { normalizePr } from '../src/github.mjs';
import { summarize } from '../src/summary.mjs';
import { overallStats, checkItems, statusWhy, CONFLICT_TEXT } from '../web/app.mjs';
import { setLang } from '../web/i18n.mjs';

test('langOf：Claude 设置的 language 优先，其次系统区域，都认不出用 en', () => {
  for (const [setting, locale, want] of [
    ['japanese', 'en-US', 'ja'], ['Japanese', undefined, 'ja'], ['日本語', 'zh-CN', 'ja'], ['ja', 'en-US', 'ja'],
    ['chinese', 'ja-JP', 'zh'], ['中文', undefined, 'zh'], ['简体中文', 'en-US', 'zh'], ['zh-CN', 'ja-JP', 'zh'], ['Traditional Chinese', null, 'zh'],
    ['english', 'ja-JP', 'en'], ['English', 'zh-Hans-CN', 'en'],
    // 设置为空或认不出 → 看区域
    [undefined, 'ja-JP', 'ja'], [null, 'zh-Hans-CN', 'zh'], ['', 'en-US', 'en'], ['French', 'ja_JP.UTF-8', 'ja'], ['Javanese', 'zh-CN', 'zh'],
    // 都认不出 → en
    [undefined, undefined, 'en'], ['French', 'fr-FR', 'en'], [null, 'C', 'en'], ['jav', 'enx', 'en'],
  ]) assert.equal(langOf(setting, locale), want, `langOf(${setting}, ${locale})`);
});

// ---------- 认项目 ----------

const proj = (id, sessions, paths) => ({ id, summary: { sessions: sessions.map((s) => ({ id: s, source: 'claude-code', title: s })),
  workspaces: paths.map((p, i) => ({ id: `w${i}`, path: p })) } });

test('pickProject：会话 id 命中优先于路径命中', () => {
  const entries = [proj('by-path', [], ['/x/proj']), proj('by-session', ['s1'], ['/elsewhere'])];
  assert.equal(pickProject(entries, 's1', '/x/proj/src'), 'by-session');
  assert.equal(pickProject(entries, 's-other', '/x/proj/src'), 'by-path');
});

test('pickProject：路径按段比，等于或在其下才中；尾斜杠无影响；summary 为 null 跳过；都不中为 null', () => {
  const entries = [{ id: 'none', summary: null }, proj('a', [], ['/x/proj', '/x/proj-collab/']), proj('b', [], ['/y'])];
  assert.equal(pickProject(entries, 's', '/x/proj'), 'a');
  assert.equal(pickProject(entries, 's', '/x/proj/'), 'a');
  assert.equal(pickProject(entries, 's', '/x/proj/web/deep'), 'a');
  assert.equal(pickProject(entries, 's', '/x/proj-collab'), 'a'); // 工作区自带尾斜杠
  assert.equal(pickProject(entries, 's', '/x/proj2'), null); // 同名前缀不误中
  assert.equal(pickProject(entries, 's', '/x'), null); // 工作区的上级目录不算
  assert.equal(pickProject(entries, 's', '/y/z'), 'b');
  assert.equal(pickProject(entries, 's', '/z'), null);
  assert.equal(pickProject(entries, 's', null), null);
  assert.equal(pickProject([{ id: 'none', summary: null }], 's', '/x/proj'), null);
});

// ---------- 聚焦 ----------

// alpha：0.1 无分组；1 → 1.2 → 1.2.3 三级父子，都在分组 g1。old 已归档。
const docTask = (docId, number, groupId = null, parent = null) =>
  ({ key: `${docId}#${number}`, number, title: `任务 ${number}`, checkbox: 'open', void: false, docId, groupId, parentKey: parent && `${docId}#${parent}` });
const DOCS = [
  { docId: 'alpha', title: 'Alpha', archived: false, groups: [{ id: 'g1', title: '阶段 1' }],
    tasks: [docTask('alpha', '0.1'), docTask('alpha', '1', 'g1'), docTask('alpha', '1.2', 'g1', '1'), docTask('alpha', '1.2.3', 'g1', '1.2')] },
  { docId: 'beta', title: 'Beta', archived: false, groups: [], tasks: [docTask('beta', '1'), docTask('beta', '2')] },
  { docId: 'old', title: 'Old', archived: true, groups: [], tasks: [docTask('old', '1')] },
];
const link = (sessionId, activity, lastAt) => ({ sessionId, activity, firstAt: '2025-09-20T00:00:00Z', lastAt });
const view = (key, sessions) => ({ key, status: 'in_progress', sessions, prs: [], deps: { on: [], unmet: [], external: [] } });
// tasks[] 故意不按文档顺序排
const SUMMARY = { docs: DOCS, tasks: [
  view('beta#2', [link('s-run', 'running', '2025-09-27T00:00:00Z')]),
  view('beta#1', [link('s-recent', 'recent', '2025-09-27T00:00:00.000Z')]),
  view('old#1', [link('s-recent', 'running', '2025-09-28T00:00:00Z'), link('s-old', 'running', '2025-09-28T00:00:00Z')]),
  view('alpha#1.2', [link('s-run', 'running', '2025-09-26T00:00:00Z'), link('s-recent', 'recent', '2025-09-28T00:00:00Z')]),
  view('alpha#0.1', [link('s-run', 'recent', '2025-09-28T00:00:00Z'), link('s-recent', 'recent', '2025-09-26T00:00:00Z')]),
  view('alpha#1', []),
] };

test('focusOf：有运行中的取全部运行中，最近活动的排第一（主任务）', () => {
  assert.deepEqual(focusOf(SUMMARY, 's-run'), { keys: ['beta#2', 'alpha#1.2'], recent: false, at: '2025-09-27T00:00:00Z' });
  // 同一时刻按文档顺序
  const s = { docs: DOCS, tasks: [view('beta#1', [link('s', 'running', '2025-09-27T00:00:00Z')]), view('alpha#0.1', [link('s', 'running', '2025-09-27T00:00:00.000Z')])] };
  assert.deepEqual(focusOf(s, 's').keys, ['alpha#0.1', 'beta#1']);
});

test('focusOf：没有运行中的取 lastAt 最晚的一个并标 recent；归档文档的任务不算', () => {
  // old#1 运行中、更晚，但在归档文档里，不算；alpha#1.2 的 lastAt 最晚
  assert.deepEqual(focusOf(SUMMARY, 's-recent'), { keys: ['alpha#1.2'], recent: true, at: '2025-09-28T00:00:00Z' });
  // 只关联了归档文档的任务 → 等于没有关联
  assert.deepEqual(focusOf(SUMMARY, 's-old'), { keys: [], recent: false, at: null });
});

test('focusOf：lastAt 按时间比，不按字符串比', () => {
  const s = { docs: DOCS, tasks: [
    view('alpha#0.1', [link('s', 'recent', '2025-09-27T00:00:00.500Z')]),
    view('beta#1', [link('s', 'recent', '2025-09-27T00:00:01Z')]),
  ] };
  assert.deepEqual(focusOf(s, 's').keys, ['beta#1']);
});

test('focusOf：同一时刻点到过的在前、没勾选的在前、没有子任务的在前，最后才按文档顺序', () => {
  // 一个 PR 连上的任务 lastAt 都一样（会话分支 = PR head）：不能总落到文档里第一个、早已勾选的任务
  const at = '2025-09-27T00:00:00Z';
  const docs = [{ ...DOCS[0], tasks: DOCS[0].tasks.map((t) => (t.number === '0.1' ? { ...t, checkbox: 'done' } : t)) }, DOCS[1]];
  const s = (named) => ({ docs, tasks: ['alpha#0.1', 'alpha#1', 'beta#1', 'beta#2'].map((k) =>
    view(k, [{ ...link('s', 'running', at), ...(named.includes(k) && { named: true }) }])) });
  assert.deepEqual(focusOf(s([]), 's').keys, ['beta#1', 'beta#2', 'alpha#1', 'alpha#0.1'], '没勾选的在前；alpha#1 有子任务，排在叶子后');
  assert.deepEqual(focusOf(s(['beta#2', 'alpha#0.1']), 's').keys, ['beta#2', 'alpha#0.1', 'beta#1', 'alpha#1'], '点到过的在前，其次没勾选');
  // 更晚的仍然优先，不管点没点到
  const late = s(['beta#2']);
  late.tasks[1].sessions[0].lastAt = '2025-09-27T00:00:01Z';
  assert.equal(focusOf(late, 's').keys[0], 'alpha#1');
  // 前两条都一样时，没有子任务的在前：alpha#1 是 1.2 的父任务，1.2 是 1.2.3 的父任务
  const tree = { docs: DOCS, tasks: ['alpha#1', 'alpha#1.2', 'alpha#1.2.3', 'beta#1'].map((k) => view(k, [link('s', 'running', at)])) };
  assert.deepEqual(focusOf(tree, 's').keys, ['alpha#1.2.3', 'beta#1', 'alpha#1', 'alpha#1.2'], '叶子在前，父任务按文档顺序排后');
  // 父任务点到过、子任务没点到：点到过优先于叶子
  tree.tasks[0].sessions[0].named = true;
  assert.equal(focusOf(tree, 's').keys[0], 'alpha#1');
});

test('focusOf：没有关联', () => {
  assert.deepEqual(focusOf(SUMMARY, 's-none'), { keys: [], recent: false, at: null });
  assert.deepEqual(focusOf({ docs: [], tasks: [] }, 's-run'), { keys: [], recent: false, at: null });
});

test('focusPath：文档、分组、从外到内的全部祖先（不含自身）', () => {
  assert.deepEqual(focusPath(SUMMARY, 'alpha#1.2.3'), ['doc:alpha', 'grp:alpha/g1', 'task:alpha#1', 'task:alpha#1.2']);
  assert.deepEqual(focusPath(SUMMARY, 'alpha#1'), ['doc:alpha', 'grp:alpha/g1']);
});

test('focusPath：无分组任务只展开文档；任务不存在为空', () => {
  assert.deepEqual(focusPath(SUMMARY, 'alpha#0.1'), ['doc:alpha']);
  assert.deepEqual(focusPath(SUMMARY, 'beta#2'), ['doc:beta']);
  assert.deepEqual(focusPath(SUMMARY, 'nope#1'), []);
});

// ---------- 面板内容 paneOf（任务 2.1、2.2；design §4、§6、§7） ----------

const URL0 = 'http://127.0.0.1:4317';
const NOW = '2025-09-27T00:30:00Z';
const NOW_MS = Date.parse(NOW);
const rowsOf = (p) => [...p.header, ...p.banners, ...p.focus, ...p.body, ...(p.more ? [p.more] : [])];
const row = (p, key) => rowsOf(p).find((r) => r.key === key);
const keys = (rows) => rows.map((r) => r.key);

// 夹具一：真实解析器 + engine 推出的看板（同 test/summary.test.mjs），口径对照用
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const LINES = [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab', docFilter: '^collab-', workspace: '/ws/collab' },
];
function fixtureSummary() {
  const doc = (name, over = {}) => ({ docId: name, archived: false, sourceType: 'spec-dir', sourceLabel: 'spec', path: `.claude/specs/${name}/tasks.md`,
    workspaceId: 'repo', kind: 'tasks', ...parseTasksDoc(fixture(`${name}.tasks.md`), name), ...over });
  const collab = doc('collab-m0-space-run');
  for (const n of ['2.5b', '3', '4']) collab.tasks.find((x) => x.number === n).checkbox = 'open';
  const docs = [collab, doc('synthetic-inline'), doc('synthetic-headings', { archived: true })];
  const known = { knownDocIds: docs.map((d) => d.docId), knownCodes: docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)) };
  const say = (text, at, until, line) => ({ kind: 'prompt', at, until, file: 'r/s.jsonl', line, snippet: text, refs: extractRefs(text, known) });
  const session = (id, signals) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/collab'], branches: [], title: `标题 ${id}`,
    firstAt: signals[0].at, lastAt: signals.at(-1).until, lastSummary: '（虚构）', signals, aiOnlyMentions: 0, brokenLines: 0 });
  const sessions = [
    session('s-run', [say('继续做 collab-m0-space-run 的任务 2.5b', '2025-09-27T00:00:00.000Z', '2025-09-27T00:25:00.000Z', 1)]),
    session('s-x', [say('看看 synthetic-inline 任务 9.9 和 nope 的 1', '2025-09-26T00:00:00.000Z', '2025-09-26T00:10:00.000Z', 3)]),
  ];
  const raw = JSON.parse(fixture('prs.json'));
  const prs = [...raw,
    { ...raw[0], number: 901, title: '[V2] feat: collab-m0-space-run 任务 2.5b（部分）', baseRefName: 'v2/collab', state: 'MERGED',
      mergedAt: '2025-09-26T00:00:00Z', mergeCommit: { oid: 'f'.repeat(40) } },
    { ...raw[0], number: 902, title: 'fix: 任务 99 与 collab-m0-space-run 任务 2', state: 'OPEN', mergedAt: null, mergeCommit: null },
  ].map(normalizePr);
  const board = computeBoard(docs, prs, sessions, [], { 360: { state: 'synced' }, 365: { state: 'pending' } },
    { id: 'widget', repo: { path: '/ws/repo', github: 'acme/widget' }, branchLines: LINES }, NOW, { hoursPerDay: 8, defaultDurationDays: 1 });
  board.workspaces = [{ id: 'repo', path: '/ws/repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  return summarize(board);
}
const FX = fixtureSummary();
const projectsOf = (id, over = {}) => ({ errors: [], warnings: [], projects: [{ id, name: `项目 ${id}`, branchLines: id === 'widget' ? LINES : [], errors: [], refreshError: null, ...over }] });
const pane = (summary, over = {}) => paneOf({ summary, projects: projectsOf(summary?.projectId ?? 'widget'), projectId: summary?.projectId ?? 'widget', view: 'overview',
  toggled: [], focus: { keys: [], recent: false }, url: URL0, now: NOW_MS, problems: [], ...over });

// 夹具二：手写的最小摘要（结构同 design §3.1），任务树、聚焦与预算用。spec = [{ docId, groups, tasks:[{ number, groupId, parent, title, status, … }] }]
function build(specs, extra = {}) {
  const docs = specs.map(({ docId, groups = [], tasks, archived = false }) => ({
    docId, title: docId, path: `docs/${docId}.md`, kind: 'tasks', archived, workspaceId: 'repo', sourceType: 'spec-dir', sourceLabel: 'spec',
    parse: { state: tasks.length ? 'ok' : 'planning', unrecognizedLines: [], unknownRelations: [], unknownEstimates: [], diagnostics: [], mermaidUsed: false },
    groups, tasks: tasks.map((x) => ({ key: `${docId}#${x.number}`, number: x.number, title: x.title ?? `任务 ${x.number}`, checkbox: 'open',
      void: x.status === null, docId, groupId: x.groupId ?? null, parentKey: x.parent ? `${docId}#${x.parent}` : null })),
  }));
  const tasks = specs.flatMap((s) => s.tasks.map((x) => ({ key: `${s.docId}#${x.number}`, status: x.status === undefined ? 'not_started' : x.status,
    rule: x.rule ?? null, inProgressBy: x.inProgressBy ?? [], docOnly: false, prs: [], sessions: [], activity: null, childSummary: null,
    next: x.next ?? null, deps: { on: x.unmet ?? [], unmet: x.unmet ?? [], external: [] } })));
  const status = new Map(tasks.map((v) => [v.key, v.status]));
  const sum = (list) => {
    const counts = { not_started: 0, in_progress: 0, in_review: 0, awaiting_merge: 0, done: 0 };
    let total = 0;
    for (const x of list) { const s = status.get(x.key); if (s) { counts[s]++; total++; } }
    return { counts, total, ratio: total ? counts.done / total : null };
  };
  return { projectId: 'mini', freshness: { github: { state: 'off' } }, degraded: { noPrData: false, prFromCache: false, noSessionData: false },
    workspaces: [], diagnostics: {}, defaults: {},
    stats: { docs: docs.map((d) => ({ docId: d.docId, ...sum(d.tasks), groups: d.groups.map((g) => ({ groupId: g.id, ...sum(d.tasks.filter((x) => x.groupId === g.id)) })) })) },
    docs, tasks, conflicts: [], prs: [], sessions: [], ...extra };
}
// alpha：0.1 无分组；g1 里 1 → 1.2 → 1.2.3 三级父子；g2 里 2 已作废。beta 无分组。plan 规划中（无任务）。old 已归档。
const MINI_LINES = [{ id: 'main', name: '主线', docFilter: '^(?!beta)' }, { id: 'side', name: '支线', docFilter: '^beta' }];
const MINI = build([
  { docId: 'alpha', groups: [{ id: 'g1', title: '阶段 1' }, { id: 'g2', title: '阶段 2' }], tasks: [
    { number: '0.1', status: 'done' }, { number: '1', groupId: 'g1', status: 'in_progress' },
    { number: '1.2', groupId: 'g1', parent: '1', status: 'in_progress', rule: '8.2-4', inProgressBy: ['session'], unmet: ['alpha#0.1', 'beta#1'], next: 'blocked' },
    { number: '1.2.3', groupId: 'g1', parent: '1.2' }, { number: '2', groupId: 'g2', status: null }] },
  { docId: 'beta', tasks: [{ number: '1' }, { number: '2' }] },
  { docId: 'plan', tasks: [] },
  { docId: 'old', archived: true, tasks: [{ number: '1' }] },
]);
const miniPane = (over = {}) => paneOf({ summary: MINI, projects: { errors: [], warnings: [], projects: [{ id: 'mini', name: 'Mini', branchLines: MINI_LINES, errors: [] }] },
  projectId: 'mini', view: 'overview', toggled: [], focus: { keys: ['alpha#1.2'], recent: false }, url: URL0, now: NOW_MS, problems: [], ...over });

test('paneOf 总览：顶栏、数字与 overallStats 一致，需要确认计数 = checkItems 全部条数（含 c）', () => {
  const p = pane(FX, { focus: focusOf(FX, 's-run') });
  const all = overallStats(FX);
  assert.deepEqual(row(p, 'title').texts, ['YUIBoard', '项目 widget']);
  // 项目名与品牌同名只写一次
  const self = paneOf({ summary: FX, projects: projectsOf('widget', { name: 'YUIBoard' }), projectId: 'widget', view: 'overview', toggled: [], focus: null, url: URL0, now: NOW_MS, problems: [] });
  assert.deepEqual(row(self, 'title').texts, ['YUIBoard']);
  assert.deepEqual(p.header.filter((r) => r.kind === 'nav').map((r) => [r.view, r.active, r.texts[0]]),
    [['overview', true, '总览'], ['check', false, '需要确认'], ['diag', false, '诊断']]);
  assert.equal(row(p, 'nav:check').texts[1], String(checkItems(FX, { line: null }).length));
  assert.ok(checkItems(FX, { line: null }).some((c) => c.type === 'c'), '夹具里要有 c，计数才验证得了含 c');
  assert.equal(row(p, 'open').href, `${URL0}/#/overview?project=widget`);
  // 数字一行：进度条 10 格、百分比、完成数；各状态只写图标与数，为 0 的不出；可开工在最后
  const filled = Math.round(all.ratio * 10);
  assert.deepEqual(row(p, 'stat:progress').texts, ['▰'.repeat(filled), '▱'.repeat(10 - filled), `${Math.floor(all.ratio * 100)}%`, `${all.counts.done}/${all.total}`]);
  assert.deepEqual(row(p, 'stat:progress').tones, ['success', 'inactive', null, 'subtle']);
  for (const [s, ic] of [['in_progress', '◔'], ['in_review', '◑'], ['awaiting_merge', '◕']]) {
    const r = row(p, `stat:${s}`);
    if (all.counts[s]) assert.deepEqual([r.status, r.texts], [s, [`${ic} ${all.counts[s]}`]], s);
    else assert.equal(r, undefined, s);
  }
  assert.equal(row(p, 'stat:sync')?.texts[1], all.syncPending ? String(all.syncPending) : undefined);
  assert.equal(row(p, 'stat:stale')?.texts[0], all.stale ? `${all.stale} 停滞` : undefined);
  assert.deepEqual(row(p, 'stat:ready').texts, ['可开工', String(all.ready)]);
  assert.equal(p.header.filter((r) => r.kind === 'stat').at(-1).key, 'stat:ready');
  // 需要确认计数标黄；诊断计数 = 诊断里有问题的项数，没有就只写「诊断」
  assert.deepEqual(row(p, 'nav:check').tones, [null, 'warning']);
  const diagWarn = pane(FX, { view: 'diag' }).body.filter((r) => r.level === 0 && r.warn).length;
  assert.deepEqual(row(p, 'nav:diag').texts, diagWarn ? ['诊断', `⚠ ${diagWarn}`] : ['诊断']);
  // 数字只在总览
  assert.equal(row(pane(FX, { view: 'check' }), 'stat:ready'), undefined);
});

test('paneOf 聚焦卡片：标题行带文档名；主任务图标、编号、标题；状态原因 · 在等合成一行；不写开工判断', () => {
  const p = miniPane();
  const view = MINI.tasks.find((v) => v.key === 'alpha#1.2');
  const task = MINI.docs[0].tasks.find((x) => x.key === 'alpha#1.2');
  assert.deepEqual(keys(p.focus), ['focus', 'focus:alpha#1.2', 'focus:alpha#1.2:why']);
  assert.deepEqual(row(p, 'focus').texts, ['本会话正在做 · alpha']);
  const head = row(p, 'focus:alpha#1.2');
  assert.deepEqual([head.status, head.highlight, head.texts], ['in_progress', true, ['◔', '1.2', '任务 1.2']]);
  assert.equal(head.href, `${URL0}/#/overview?project=mini&focus=alpha%231.2`);
  assert.deepEqual(row(p, 'focus:alpha#1.2:why').texts, [`${statusWhy(view, task)} · 在等：0.1、beta#1`]); // 同文档只写编号
  // next = blocked，但卡片不写开工判断（owner 已定 4）
  const words = p.focus.flatMap((r) => r.texts).join('\n');
  for (const w of ['可开工', '被阻塞', '即将可开工', '阻塞']) assert.ok(!words.includes(w), w);
  // 没有未满足的依赖就没有「在等」
  const one = miniPane({ focus: { keys: ['alpha#1'], recent: false } });
  assert.deepEqual(keys(one.focus), ['focus', 'focus:alpha#1', 'focus:alpha#1:why']);
  assert.ok(!row(one, 'focus:alpha#1:why').texts[0].includes('在等'));
  // 标题去掉 Markdown 记号
  const md = build([{ docId: 'm', tasks: [{ number: '1', status: 'in_progress', title: '**改** `a_b.mjs` 见 [设计](x.md) ~~旧~~' }] }]);
  assert.deepEqual(row(pane(md, { projectId: 'mini', focus: { keys: ['m#1'], recent: false } }), 'focus:m#1').texts[2], '改 a_b.mjs 见 设计 旧');
});

test('paneOf 聚焦卡片：其余关联任务收进「另有 N 个关联任务」，默认收起，展开后一行一个', () => {
  const focus = { keys: ['alpha#1.2', 'beta#2', 'alpha#0.1'], recent: false };
  const p = miniPane({ focus });
  assert.deepEqual(keys(p.focus), ['focus', 'focus:alpha#1.2', 'focus:alpha#1.2:why', 'focus:others']);
  assert.deepEqual([row(p, 'focus:others').texts, row(p, 'focus:others').toggle, row(p, 'focus:others').open], [['另有 2 个关联任务'], 'focus:others', false]);
  const q = miniPane({ focus, toggled: ['focus:others'] });
  assert.deepEqual(keys(q.focus), ['focus', 'focus:alpha#1.2', 'focus:alpha#1.2:why', 'focus:others', 'focus:beta#2', 'focus:alpha#0.1']);
  assert.deepEqual([row(q, 'focus:beta#2').kind, row(q, 'focus:beta#2').texts, row(q, 'focus:beta#2').highlight], ['focusItem', ['○', '2', '任务 2'], undefined]);
  assert.deepEqual(row(q, 'focus:alpha#0.1').texts, ['●', '0.1', '任务 0.1']);
  // 只有主任务的路径默认展开、只有它在树里标出
  assert.deepEqual([row(p, 'doc:beta').open, row(p, 'task:alpha#0.1').highlight], [false, undefined]);
});

test('paneOf 聚焦卡片：recent 写「最近做的 · 文档 · 多久前」；没有聚焦任务只一行；归档 / 不存在的键不列', () => {
  assert.deepEqual(row(miniPane({ focus: { keys: ['alpha#1.2'], recent: true, at: '2025-09-26T22:30:00Z' } }), 'focus').texts, ['本会话最近做的 · alpha · 2 小时前']);
  assert.deepEqual(row(miniPane({ focus: { keys: ['alpha#1.2'], recent: true } }), 'focus').texts, ['本会话最近做的 · alpha']);
  const none = miniPane({ focus: { keys: ['nope#1'], recent: false } });
  assert.deepEqual(none.focus.map((r) => [r.key, r.kind, r.texts]), [['focus', 'empty', ['本会话还没关联到任务']]]);
  assert.deepEqual(miniPane({ focus: null }).focus.map((r) => r.kind), ['empty']);
});

test('paneOf 任务树：顺序、归档不显示、分支线名、无分组任务挂文档下、默认只展开聚焦路径', () => {
  const p = miniPane();
  assert.deepEqual(keys(p.body), ['doc:alpha', 'task:alpha#0.1', 'grp:alpha/g1', 'task:alpha#1', 'task:alpha#1.2', 'task:alpha#1.2.3', 'grp:alpha/g2', 'doc:beta', 'doc:plan']);
  assert.deepEqual(p.body.map((r) => r.level), [0, 1, 1, 2, 3, 4, 1, 0, 0]);
  // 进度在行尾（作废的不计）；项目有多条分支线才标线名
  assert.deepEqual([row(p, 'doc:alpha').texts, row(p, 'doc:alpha').end, row(p, 'doc:alpha').tones], [['alpha', '主线'], '1/4', [null, 'subtle']]);
  assert.deepEqual([row(p, 'doc:beta').texts, row(p, 'doc:beta').end, row(p, 'doc:beta').endTone], [['beta', '支线'], '0/2', undefined]);
  assert.deepEqual([row(p, 'doc:alpha').toggle, row(p, 'doc:alpha').open, row(p, 'doc:beta').open], ['doc:alpha', true, false]);
  assert.equal(row(p, 'doc:plan').toggle, undefined, '没有任务的文档不可折叠');
  assert.deepEqual([row(p, 'grp:alpha/g1').texts, row(p, 'grp:alpha/g1').end], [['阶段 1'], '0/3']);
  // 父任务同网页默认展开（owner 2026-10-10）：1、1.2 都展开，1.2.3 出现
  assert.deepEqual([row(p, 'task:alpha#1').toggle, row(p, 'task:alpha#1').open], ['task:alpha#1', true]);
  assert.deepEqual([row(p, 'task:alpha#1.2').open, row(p, 'task:alpha#1.2').highlight], [true, true]);
  assert.equal(row(p, 'task:alpha#0.1').toggle, undefined, '没有子任务的行不可折叠');
  assert.deepEqual(row(p, 'task:alpha#1.2').texts, ['◔', '1.2', '任务 1.2']);
  assert.equal(row(p, 'task:alpha#0.1').href, `${URL0}/#/overview?project=mini&focus=alpha%230.1`);
  // 没有聚焦任务时全部折叠；没有分支线配置时不标
  const none = miniPane({ focus: { keys: [], recent: false } });
  assert.deepEqual(keys(none.body), ['doc:alpha', 'doc:beta', 'doc:plan']);
  assert.deepEqual(row(pane(MINI, { projectId: 'mini' }), 'doc:alpha').texts, ['alpha']);
  const oneLine = paneOf({ summary: MINI, projects: { errors: [], warnings: [], projects: [{ id: 'mini', name: 'Mini', branchLines: MINI_LINES.slice(0, 1), errors: [] }] },
    projectId: 'mini', view: 'overview', toggled: [], focus: null, url: URL0, now: NOW_MS, problems: [] });
  assert.deepEqual(row(oneLine, 'doc:alpha').texts, ['alpha'], '只有一条线时不标');
  // 全部完成的文档进度标绿
  const all = build([{ docId: 'z', tasks: [{ number: '1', status: 'done' }] }]);
  assert.equal(row(pane(all, { projectId: 'mini' }), 'doc:z').endTone, 'success');
});

test('paneOf 状态色调：进行中按会话活动分运行中 / 停滞，已合并未 pull 单列待同步', () => {
  const s = build([{ docId: 't', tasks: ['in_progress', 'in_progress', 'in_review', 'awaiting_merge', 'awaiting_merge', 'done', 'not_started', null]
    .map((status, i) => ({ number: String(i + 1), status })) }]);
  s.tasks.find((v) => v.key === 't#2').activity = 'stale';
  s.tasks.find((v) => v.key === 't#5').syncPending = [41];
  s.tasks.find((v) => v.key === 't#4').syncPending = []; // 空数组不算
  const p = pane(s, { projectId: 'mini', focus: { keys: ['t#2'], recent: false } }); // 聚焦在 t 里，文档默认展开
  assert.deepEqual(s.tasks.map((v) => row(p, `task:${v.key}`).tone), ['run', 'stale', 'review', 'merge', 'sync', 'done', 'todo', 'void']);
  assert.equal(row(p, 'focus:t#2').tone, 'stale');
});

test('paneOf 任务树：展开的子孙沿用最外层父任务的竖条底色（band），自己的 tone 不变；顶层任务没有 band', () => {
  const s = build([{ docId: 't', tasks: [
    { number: '1', status: 'in_progress' }, { number: '1.1', parent: '1', status: 'not_started' },
    { number: '1.2', parent: '1', status: 'done' }, { number: '1.2.1', parent: '1.2', status: 'done' }, { number: '2', status: 'not_started' }] }]);
  s.tasks.find((v) => v.key === 't#1').activity = 'stale';
  const p = pane(s, { projectId: 'mini', focus: { keys: ['t#1'], recent: false } });
  const of = (k) => [row(p, `task:t#${k}`).tone, row(p, `task:t#${k}`).band];
  assert.deepEqual(['1', '1.1', '1.2', '1.2.1', '2'].map(of), [['stale', undefined], ['todo', 'stale'], ['done', 'stale'], ['done', 'stale'], ['todo', undefined]]);
});

test('paneOf 任务树：最外层任务连同展开的子孙算一块，前后两块都铺底色时隔一行，块内各行隔细缝', () => {
  // 1（运行中）→ 1.1；2（已完成）；3（未开始）；4（等待 review）；5（等待 review）
  const s = build([{ docId: 'g', tasks: [{ number: '1', status: 'in_progress' }, { number: '1.1', parent: '1', status: 'not_started' },
    { number: '2', status: 'done' }, { number: '3', status: 'not_started' }, { number: '4', status: 'in_review' }, { number: '5', status: 'in_review' }] }]);
  const p = pane(s, { projectId: 'mini', focus: { keys: ['g#1.1'], recent: false } });
  const marks = Object.fromEntries(p.body.filter((r) => r.kind === 'task').map((r) => [r.texts[1], r.gap ? 'gap' : r.sep ? 'sep' : '']));
  // 1.1 沿用 1 的底色，同一块里隔细缝；2 跟在 1 那块后面、两块都铺底色，空一行；3 未开始不铺，不隔；4 跟在 3 后面不隔；5 跟在 4 后面空一行
  assert.deepEqual(marks, { 1: '', '1.1': 'sep', 2: 'gap', 3: '', 4: '', 5: 'gap' });
});

test('paneOf 任务树：toggled 与默认相反；父任务收起后子孙不出现；作废行', () => {
  const p = miniPane({ toggled: ['doc:beta', 'grp:alpha/g2'] });
  assert.deepEqual(keys(p.body), ['doc:alpha', 'task:alpha#0.1', 'grp:alpha/g1', 'task:alpha#1', 'task:alpha#1.2', 'task:alpha#1.2.3',
    'grp:alpha/g2', 'task:alpha#2', 'doc:beta', 'task:beta#1', 'task:beta#2', 'doc:plan']);
  assert.equal(row(p, 'task:alpha#1.2.3').level, 4);
  assert.deepEqual([row(p, 'task:alpha#2').status, row(p, 'task:alpha#2').texts[0]], ['void', '⊘']);
  assert.equal(row(p, 'task:beta#1').level, 1);
  // 收起 1.2：1.2.3 不出现
  const c = miniPane({ toggled: ['task:alpha#1.2'] });
  assert.deepEqual([keys(c.body).includes('task:alpha#1.2.3'), row(c, 'task:alpha#1.2').open], [false, false]);
  // 收起祖先 1：1.2、1.2.3 都不出现
  const q = miniPane({ toggled: ['task:alpha#1'] });
  assert.deepEqual(keys(q.body).filter((k) => k.startsWith('task:alpha#1')), ['task:alpha#1']);
  assert.equal(row(q, 'task:alpha#1').open, false);
  // 收起文档：整份只剩文档行
  assert.deepEqual(keys(miniPane({ toggled: ['doc:alpha'] }).body), ['doc:alpha', 'doc:beta', 'doc:plan']);
});

test('paneOf 需要确认：按 CONFLICT_TEXT 顺序分组，总数含 c 且等于顶栏计数，c 默认折叠', () => {
  const all = checkItems(FX, { line: null });
  const p = pane(FX, { view: 'check' });
  const groups = p.body.filter((r) => r.kind === 'checkGroup');
  const types = Object.keys(CONFLICT_TEXT).filter((type) => all.some((c) => c.type === type));
  assert.deepEqual(groups.map((r) => r.key), types.map((type) => `check:${type}`));
  assert.deepEqual(groups.map((r) => r.texts[0]), types.map((type) => CONFLICT_TEXT[type]));
  const counts = groups.map((r) => Number(r.end));
  assert.deepEqual(counts, types.map((type) => all.filter((c) => c.type === type).length));
  assert.equal(String(counts.reduce((a, b) => a + b, 0)), row(p, 'nav:check').texts[1]);
  assert.equal(row(p, 'check:c').open, false);
  assert.ok(!p.body.some((r) => r.key.startsWith('check:c:')), 'c 收起时不列条目');
  assert.ok(groups.filter((r) => r.key !== 'check:c').every((r) => r.open && r.toggle === r.key));
  // 条目一行：任务「图标、编号、标题 · 说明」，PR「#、号、说明」，会话「◇、会话 · 说明」；任务与 PR 有链接，会话没有
  const items = p.body.filter((r) => r.kind === 'checkItem');
  assert.equal(items.length, all.filter((c) => c.type !== 'c').length);
  const f = items.filter((r) => r.key.startsWith('check:f:'));
  const taskItem = f.find((r) => r.texts[1] === '4a.1');
  const title = FX.docs.flatMap((d) => d.tasks).find((x) => x.key === 'synthetic-inline#4a.1').title;
  assert.deepEqual([taskItem.status, taskItem.texts.slice(2)], [FX.tasks.find((v) => v.key === 'synthetic-inline#4a.1').status, [`${title} · 依赖了找不到的对象：9.9`]]);
  // 链接画在编号上（owner 2026-10-12 晚）：任务与 PR 条目有，会话没有
  assert.equal(taskItem.href, `${URL0}/#/check?project=widget&focus=synthetic-inline%234a.1`);
  assert.ok(items.some((r) => r.texts[0] === '#' && r.texts[1] === '902' && r.href.endsWith('focus=%23902')));
  const sess = items.find((r) => r.texts[0] === '◇' && r.texts[1].startsWith('会话 s-x · ')); // 未关联的会话不在摘要的 sessions 里，退回会话 id
  assert.equal(sess.href, undefined);
  // 切换：c 展开、a 收起
  const q = pane(FX, { view: 'check', toggled: ['check:c', 'check:a'] });
  assert.deepEqual([row(q, 'check:c').open, row(q, 'check:a').open], [true, false]);
  assert.ok(q.body.some((r) => r.key === 'check:c:0') && !q.body.some((r) => r.key === 'check:a:0'));
});

test('paneOf 需要确认：每组最多 30 条加「另有 N 条」；没有条目', () => {
  const conflicts = Array.from({ length: 35 }, (_, i) => ({ type: 'f', taskKey: 'beta#1', detail: `说明 ${i}`, source: null }));
  const p = paneOf({ summary: { ...MINI, conflicts }, projects: null, projectId: 'mini', view: 'check', toggled: [], focus: null, url: URL0, now: NOW_MS, problems: [] });
  assert.equal(p.body.filter((r) => r.kind === 'checkItem').length, 30);
  const more = row(p, 'check:f:more');
  assert.deepEqual(more.texts, ['另有 5 条，在浏览器里看']);
  assert.equal(more.href, `${URL0}/#/check?project=mini&type=f`);
  assert.deepEqual(pane(MINI, { projectId: 'mini', view: 'check' }).body.map((r) => r.texts), [['没有需要确认的事项。']]);
});

test('paneOf 诊断：七项齐全、服务端错误与警告、有问题的行 warn', () => {
  const ok = pane(FX, { view: 'diag' });
  const seven = ['config', 'workspaces', 'docs', 'convention', 'prs', 'sessions', 'github'].map((k) => `diag:${k}`);
  assert.deepEqual(ok.body.filter((r) => r.level === 0).map((r) => r.key), seven);
  assert.deepEqual(ok.body.filter((r) => r.level === 0).map((r) => r.texts[0]), ['配置', '工作区', '文档', '不满足约定', '未关联 PR', 'AI 会话', 'GitHub']);
  // 没问题的项明细并进概要行，不另列
  assert.deepEqual(row(ok, 'diag:workspaces').texts, ['工作区', `repo · main @ ${'a'.repeat(8)}`]);
  assert.equal(row(ok, 'diag:workspaces:0'), undefined);
  assert.equal(row(ok, 'diag:workspaces').warn, false);
  // 网页诊断里「可展开」的说法不出现
  assert.ok(!ok.body.some((r) => r.texts.some((s) => s.includes('可展开'))));

  const bad = { ...FX,
    workspaces: [{ id: 'repo', path: '/ws/repo', branch: null, commit: null, detached: false, error: '读不到 /ws/repo：不存在' }],
    freshness: { github: { ...FX.freshness.github, error: 'auth', message: 'gh 不可用或未登录：看板只有文档与会话，没有 PR 数据' } },
    diagnostics: { ...FX.diagnostics, config: { path: '/x/devboard.config.json', projects: 2, warnings: ['server.host 为 0.0.0.0，不是本机回环地址，局域网内其它机器可能访问到看板'] },
      sessionSources: [{ source: 'claude-code', dir: '/s', available: false, error: '没有权限', sessions: 0, messages: [], unreadableFiles: [], brokenLines: [] }] } };
  const p = pane(bad, { view: 'diag', projects: { errors: [{ message: '看板尚未生成' }], warnings: ['w1'], projects: [{ id: 'widget', name: 'W', branchLines: [], errors: [], refreshError: '最近一次刷新失败：x' }] } });
  assert.deepEqual(p.body.filter((r) => r.key.startsWith('diag:server:')).map((r) => [r.texts, r.warn, r.error]),
    [[['', '看板尚未生成'], true, true], [['', '警告：w1'], true, true], [['', '最近一次刷新失败：x'], true, true]]);
  for (const k of ['config', 'workspaces', 'sessions', 'github', 'docs', 'convention']) assert.equal(row(p, `diag:${k}`).warn, true, k);
  assert.deepEqual(row(p, 'diag:config').texts, ['配置', 'devboard.config.json 已加载 · 项目 2 个']);
  assert.equal(row(p, 'diag:config:0').warn, true);
  assert.equal(row(p, 'diag:prs').warn, false);
  assert.match(row(p, 'diag:sessions:0').texts[0], /不可用：没有权限$/);
});

test('paneOf 认不出项目：顶栏 + 提示 + 每个项目一个 pick 行', () => {
  const projects = { errors: [], warnings: [], projects: [{ id: 'a', name: '甲', branchLines: [], errors: [] }, { id: 'b', branchLines: [], errors: [] }] };
  const p = paneOf({ summary: null, projects, projectId: null, view: 'overview', toggled: [], focus: null, url: `${URL0}/`, now: NOW_MS, problems: [] });
  assert.deepEqual(keys(p.header), ['title', 'open']);
  assert.equal(row(p, 'open').href, `${URL0}/`);
  assert.deepEqual(p.body.map((r) => [r.kind, r.pick ?? null, r.texts]), [['empty', null, ['当前目录不在看板的项目里']], ['pick', 'a', ['甲']], ['pick', 'b', ['b']]]);
  assert.deepEqual([p.focus, p.more], [[], null]);
});

test('paneOf 没有摘要：有问题只出顶栏与横幅；三种问题各自的横幅；没问题显示读取中', () => {
  const base = { summary: null, projects: null, projectId: 'widget', view: 'check', toggled: [], focus: null, url: URL0, now: NOW_MS };
  const p = paneOf({ ...base, problems: [
    { kind: 'offline', url: URL0, message: 'connect ECONNREFUSED 127.0.0.1:4317' },
    { kind: 'http', status: 500, messages: ['看板尚未生成'] },
    { kind: 'oversize' },
  ] });
  assert.deepEqual([p.body, p.focus, p.more], [[], [], null]);
  assert.deepEqual(keys(p.header), ['title', 'nav:overview', 'nav:check', 'nav:diag', 'open']);
  assert.deepEqual(row(p, 'nav:check').texts, ['需要确认']); // 没有摘要不出计数
  assert.deepEqual(p.banners.map((r) => r.texts), [
    ['连不上 devboard 服务', URL0, 'connect ECONNREFUSED 127.0.0.1:4317', '启动命令：node ops/devboard-ctl.mjs up'],
    ['HTTP 500', '看板尚未生成'],
    ['看板摘要超过 4 MiB，mod 读不了，请在浏览器里看'],
  ]);
  assert.ok(p.banners.every((r) => r.warn));
  assert.equal(p.banners[2].href, `${URL0}/#/check?project=widget`);
  assert.deepEqual(paneOf({ ...base, problems: [] }).body.map((r) => r.texts), [['正在读取看板…']]);
  // 横幅最多 5 条，其余合成一条
  const many = paneOf({ ...base, problems: [{ kind: 'http', status: 409, messages: Array.from({ length: 7 }, (_, i) => `m${i}`) }] });
  assert.equal(many.banners.length, 6);
  assert.deepEqual(many.banners[5].texts, ['另有 2 条错误，见诊断']);
});

test('paneOf 三语：setLang(en) 后视图名、状态、服务端句子都是英文', () => {
  setLang('en');
  try {
    const p = pane(FX, { focus: focusOf(FX, 's-run') });
    assert.deepEqual(p.header.filter((r) => r.kind === 'nav').map((r) => r.texts[0]), ['Overview', 'Needs attention', 'Diagnostics']);
    assert.equal(row(p, 'focus').texts[0], 'This session is working on · collab-m0-space-run');
    assert.deepEqual(row(p, 'stat:ready').texts, ['Ready to start', String(overallStats(FX).ready)]);
    const c = pane(FX, { view: 'check' });
    assert.equal(row(c, 'check:a').texts[0].startsWith('PR merged'), true);
    const more = miniPane({ focus: { keys: ['alpha#1.2', 'beta#2'], recent: false } });
    assert.equal(row(more, 'focus:others').texts[0], '1 more linked task(s)');
    const off = paneOf({ summary: null, projects: null, projectId: 'x', view: 'overview', toggled: [], focus: null, url: URL0, now: NOW_MS,
      problems: [{ kind: 'http', status: 500, messages: ['看板尚未生成'] }] });
    assert.deepEqual(off.banners[0].texts, ['HTTP 500', 'The board has not been built yet']);
    assert.equal(commandText(), commandText()); // 文案取自 t()，不抛错
  } finally {
    setLang('zh');
  }
});

// ---------- 文字预算（任务 2.2；design §4.2） ----------

const long = (n, ch = '长') => ch.repeat(n);
// n 份文档 × m 个任务，每份一个分组；标题 titleLen 字
const wide = (n, m, titleLen = 300) => build(Array.from({ length: n }, (_, d) => ({ docId: `d${d}`, groups: [{ id: 'g', title: long(titleLen, '组') }],
  tasks: Array.from({ length: m }, (_, i) => ({ number: String(i + 1), groupId: 'g', title: long(titleLen) })) })));
const allOpen = (s) => s.docs.flatMap((d) => [`doc:${d.docId}`, ...d.groups.map((g) => `grp:${d.docId}/${g.id}`)]);
// 按 rowCost 求和：文字之外还含 key、按钮 key 与链接地址（渲染后引擎都计入 10 万字上限）
const cost = (p) => rowsOf(p).reduce((n, r) => n + rowCost(r), 0);
const budgetOk = (p) => assert.ok(cost(p) <= TEXT_BUDGET, `总量 ${cost(p)} > ${TEXT_BUDGET}`);
const tail = (p) => { assert.match(p.more?.texts[0] ?? '', /^其余 \d+ 项在浏览器里看$/); assert.ok(p.more.href.startsWith(`${URL0}/#/`)); };

test('预算：每组 30 条、每条说明 4,000 字（所有类型都有）', () => {
  const s = wide(1, 1, 10);
  s.conflicts = Object.keys(CONFLICT_TEXT).flatMap((type) => Array.from({ length: 31 }, () => ({ type, taskKey: 'd0#1', detail: long(4000), source: { file: 'f', line: 1, text: long(4000) } })));
  const p = paneOf({ summary: s, projects: null, projectId: 'mini', view: 'check', toggled: [], focus: null, url: URL0, now: NOW_MS, problems: [] });
  budgetOk(p);
  tail(p);
  const item = p.body.find((r) => r.kind === 'checkItem');
  assert.ok(item.texts[2].endsWith(` · ${long(500)}…（省略 3500 字）`));
  assert.ok(p.body.length > 30, '整行放到预算用完');
  // 15 组：c 收起只有组行，其余各 1 组行 + 30 条 + 「另有 1 条」
  assert.equal(p.more.texts[0], `其余 ${1 + 14 * 32 - p.body.length} 项在浏览器里看`);
});

test('预算：全部文档展开；聚焦任务排在预算之外也保留它与它的路径', () => {
  const s = wide(120, 40);
  const p = pane(s, { projectId: 'mini', toggled: allOpen(s) });
  budgetOk(p);
  tail(p);
  // 其余 N 项 = 放不下的正文行数
  const full = s.docs.length * 42;
  assert.equal(p.more.texts[0], `其余 ${full - p.body.length} 项在浏览器里看`);
  // 聚焦最后一份文档的最后一个任务：远在预算之外
  const key = 'd119#40';
  const q = pane(s, { projectId: 'mini', toggled: allOpen(s).filter((k) => !k.startsWith('doc:d119') && !k.startsWith('grp:d119')), focus: { keys: [key], recent: false } });
  budgetOk(q);
  tail(q);
  assert.deepEqual(keys(q.body).slice(-3), ['doc:d119', 'grp:d119/g', `task:${key}`]);
  assert.equal(row(q, `task:${key}`).highlight, true);
});

test('预算：单个聚焦任务标题 100,001 字 → 截断并标省略，键、编号、状态、链接完整', () => {
  const s = build([{ docId: 'big', tasks: [{ number: '7', status: 'in_progress', title: long(100001) }] }]);
  const p = pane(s, { projectId: 'mini', focus: { keys: ['big#7'], recent: false } });
  budgetOk(p);
  const f = row(p, 'focus:big#7');
  assert.deepEqual(f.texts.slice(0, 2), ['◔', '7']);
  assert.equal(f.texts[2], `${long(200)}…（省略 99801 字）`);
  assert.equal(f.status, 'in_progress');
  assert.equal(f.href, `${URL0}/#/overview?project=mini&focus=big%237`);
  assert.equal(row(p, 'task:big#7').texts[2], f.texts[2]);
  assert.equal(row(p, 'title').texts[0], 'YUIBoard');
});

test('预算：30 个聚焦任务展开后只列 10 个（含主任务），「另有 20 个」，主任务行在正文里', () => {
  const s = wide(30, 20);
  const focusKeys = s.docs.map((d) => `${d.docId}#20`);
  // 全部文档展开，正文超预算
  const p = pane(s, { projectId: 'mini', focus: { keys: focusKeys, recent: false }, toggled: ['focus:others', ...allOpen(s).filter((k) => !k.includes('d0'))] });
  budgetOk(p);
  tail(p);
  const listed = p.focus.filter((r) => r.kind === 'focus' || r.kind === 'focusItem').map((r) => r.key.slice('focus:'.length));
  assert.deepEqual(listed, focusKeys.slice(0, 10));
  assert.deepEqual(row(p, 'focus:others').texts, ['另有 29 个关联任务']);
  assert.deepEqual(p.focus.at(-1).texts, ['另有 20 个']);
  assert.ok(row(p, `task:${focusKeys[0]}`));
});

test('预算：极深父任务链（长标题），聚焦任务行、文档行都在', () => {
  // 1000 级父子链，每级标题 200 字（路径本身就超预算）；聚焦最底下一级
  const depth = 1000;
  const s = build([{ docId: 'deep', tasks: Array.from({ length: depth }, (_, i) => ({ number: `n${i}`, parent: i ? `n${i - 1}` : null, title: long(200) })) }]);
  const leaf = `deep#n${depth - 1}`;
  const p = pane(s, { projectId: 'mini', focus: { keys: [leaf], recent: false } });
  budgetOk(p);
  tail(p);
  assert.ok(row(p, `task:${leaf}`) && row(p, 'doc:deep') && row(p, `task:deep#n${depth - 2}`), '文档行、聚焦行、最近的祖先都在');
  // 10 个聚焦任务各挂一条 60 级的链，全部展开：路径放不下时卡片仍全列，任务行都在
  const s10 = build(Array.from({ length: 10 }, (_, d) => ({ docId: `c${d}`,
    tasks: Array.from({ length: 60 }, (_, i) => ({ number: `n${i}`, parent: i ? `n${i - 1}` : null, title: long(200) })) })));
  const keys10 = s10.docs.map((d) => `${d.docId}#n59`);
  const q = pane(s10, { projectId: 'mini', focus: { keys: keys10, recent: false }, toggled: ['focus:others', ...allOpen(s10).slice(1)] });
  budgetOk(q);
  tail(q);
  for (const k of keys10) assert.ok(row(q, `focus:${k}`) && row(q, `task:${k}`), k);
});

test('rowCost：文字之外计入行 key、折叠按钮、视图 / 项目按钮的 key、链接地址与符号', () => {
  assert.equal(rowCost({ key: 'k', texts: ['ab', 'c'] }), 3 + 2 + 1);
  assert.equal(rowCost({ key: 'task:d#1', texts: ['x'], toggle: 'task:d#1', href: 'http://h/#/a' }), 2 + 8 + 9 + 12 + 6);
  assert.equal(rowCost({ key: 'nav:diag', texts: ['诊断'], view: 'diag' }), 3 + 8 + 'go:diag'.length);
  assert.equal(rowCost({ key: 'pick:p', texts: ['P'], pick: 'p' }), 2 + 6 + 'use:p'.length);
  assert.equal(rowCost({ key: 'doc:d', texts: ['d'], end: '1/4' }), 2 + 5 + 4);
});

test('fit：预算之内原样返回，不加末尾提示', () => {
  const r = (key, n) => ({ key, kind: 'task', level: 0, texts: [long(n)] });
  const out = fit({ header: [r('h', 10)], banners: [], body: [r('a', 10), r('b', 10)], href: 'x' }, 1000);
  assert.deepEqual([keys(out.body), out.more], [['a', 'b'], null]);
  const cut = fit({ header: [r('h', 10)], banners: [], body: [r('a', 400), r('b', 400), r('c', 10)], href: 'x' }, 1000);
  // 预留 200 后只放得下 a；b 放不下就停，c 也不再放
  assert.deepEqual([keys(cut.body), cut.more.texts], [['a'], ['其余 2 项在浏览器里看']]);
});
