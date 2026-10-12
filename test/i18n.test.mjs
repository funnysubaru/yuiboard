import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { scan, cjkInCode } from './i18n-scan.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { t, tx, setLang, getLang, pickLang, SLOTS } from '../web/i18n.mjs';
import { msg, joinList } from '../src/msg.mjs';
import { summarize } from '../src/summary.mjs';
import { extractRefs } from '../src/refs.mjs';
import { paneOf, focusOf, commandText } from '../hooks/model.mjs';
import { say, logLang } from '../src/say.mjs';
import ja, { server as jaServer } from '../web/i18n-ja.mjs';
import en, { server as enServer } from '../web/i18n-en.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const WEB = ['web/app.mjs', 'web/svg.mjs', 'hooks/model.mjs']; // model.mjs：Claude Code mod 的全部界面文案（N25）
const SRC = [
  ...readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`),
  ...readdirSync(new URL('../src/sessions', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `src/sessions/${f}`),
  'ops/devboard-ctl.mjs', // 命令行输出给人看的说明（N26.1）
];
const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join();

// 服务端不会显示到页面上的中文字面量（解析用的关键词、正则片段等）。新增显示用的句子请用 msg 标记，不要加到这里。
const SRC_NOT_DISPLAYED = new Set([
  '(?:里程碑|[Mm]ilestone|マイルストーン)\\s*([A-Za-z]+\\d+(?:-[A-Za-z0-9]+)?)',
  '^\\s*[-*]\\s+\\[(.)\\]\\s+(~~)?(\\*\\*)?((?:Task\\s*|タスク\\s*)?({0})\\.?)[\\s:：](.*)$',
  '(\\d+(?:\\.\\d+)?|[半一两二三四五六七八九十])',
  '{0}(?:\\s*[–—~～〜-]\\s*{1})?\\s*(工作日|営業日|天|日|小时|時間|{2}|分钟|min|分)',
  '只读 git 白名单外的命令：git {0}',
  '{0}\n…（描述超过 64 KB，已截断）',
  '‹已遮蔽›',
  '(?:、|，|,\\s*and(?![A-Za-z])|,|/|和|及|与|&|(?<![A-Za-z])and(?![A-Za-z])|と)',
  '(?<![A-Za-z])(?:任务|タスク|[Tt]asks?)\\s*[:：#]?\\s*({0}(?:\\s*{1}\\s*{2})*)(?![A-Za-z0-9]|\\.\\d)(\\s*[（(]\\s*(?:部分|一部|[Pp]artial)\\s*[)）])?',
  '{0}|需要|が必要|\\b(?:needs?|requires?|after)\\b|前提タスク|以降',
  '（',
  '）',
  '{0} 起',
  '^(?:任务\\s*|タスク\\s*|Task\\s*)?({0})(?=[\\s:：]|$)',
  ': 心跳\n\n',
  '拒绝写入 {0}：只允许 cache/<项目> 或 data/<项目> 目录',
]);

const allKeys = () => {
  const keys = new Map();
  for (const f of WEB) for (const k of scan(read(f), ['t']).keys) keys.set(k.key, `${f}:${k.line}`);
  for (const f of SRC) for (const k of scan(read(f), ['msg']).keys) keys.set(k.key, `${f}:${k.line}`);
  return keys;
};

test('i18n：前端没有漏包 t() 的中文字面量', () => {
  for (const f of WEB) assert.deepEqual(scan(read(f), ['t']).bare.map((b) => `${f}:${b.line} ${b.text}`), []);
});

test('i18n：hooks/*.tsx 的代码（注释除外）不含中日文字符，文案都由 hooks/model.mjs 产出（N25 需求 8.3）', () => {
  const tsx = readdirSync(new URL('../hooks', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => `hooks/${f}`);
  assert.ok(tsx.length > 0);
  for (const f of tsx) assert.deepEqual(cjkInCode(read(f)).map((b) => `${f}:${b.line} ${b.text}`), []);
});

test('i18n：TSX 检查的回归用例——JSX 文本写中文、相邻两个 t() 都报，只有中文注释不报（N25 review）', () => {
  // 现有 scan() 不认 JSX：这两个反例它都漏
  assert.deepEqual(cjkInCode('const A = () => (\n  <Text>未翻译的文字</Text>\n);').map((b) => b.line), [2]);
  assert.deepEqual(cjkInCode("const B = () => <Box><Text>{t('总览')}</Text><Text>{t('诊断')}</Text></Box>;").map((b) => b.line), [1]);
  assert.deepEqual(cjkInCode([
    '// 行注释：中文',
    '/* 块注释',
    '   跨行：日本語 */',
    "const url = 'http://127.0.0.1:4317'; // 字符串里的 // 不是注释",
    '/** 文档注释 */ export const C = () => <Text>{label}</Text>;',
  ].join('\n')), []);
  assert.deepEqual(cjkInCode("const u = 'http://x/中文';").map((b) => b.line), [1], '字符串里的 // 之后照样检查');
});

test('i18n：mod 面板（paneOf）在日 / 英界面里不残留中文（N25 需求 8.1）', (t_) => {
  t_.after(() => setLang('zh'));
  // 用户内容全用 ASCII：输出里剩下的中日文只可能来自漏译的界面文案
  const md = '# Plan\n\n## Phase one\n\n- [ ] 1 Build the thing\n  - [ ] 1.1 Sub step\n- [ ] 2 Next (depends on 1)\n- [x] 3 Done thing\n\nstray line - [ ] x\n';
  const docs = [{ docId: 'plan', archived: false, sourceType: 'spec-dir', sourceLabel: 'spec', path: 'docs/plan/tasks.md', workspaceId: 'repo', kind: 'tasks', ...parseTasksDoc(md, 'plan') }];
  const pr = (number, title, state) => ({ number, title, body: '', url: '', state, isDraft: false, baseRefName: 'main', headRefName: `b${number}`, labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: state === 'MERGED' ? '2026-09-21T00:00:00Z' : null, closedAt: null,
    mergeCommit: state === 'MERGED' ? { oid: 'f'.repeat(40) } : null });
  const signal = { kind: 'prompt', at: '2026-09-25T23:50:00.000Z', until: '2026-09-25T23:59:00.000Z', file: 'r/s.jsonl', line: 1, snippet: 'plan task 1',
    refs: extractRefs('plan task 1', { knownDocIds: ['plan'], knownCodes: [] }) };
  const sessions = [{ source: 'claude-code', id: 's1', files: ['r/s.jsonl'], cwds: ['/ws/repo'], branches: [], title: 'Session one', firstAt: signal.at, lastAt: signal.until,
    lastSummary: 'x', signals: [signal], aiOnlyMentions: 0, brokenLines: 0 }];
  const board = computeBoard(docs, [pr(5, 'Task 2', 'MERGED'), pr(6, 'Task 9', 'OPEN'), pr(7, 'chore: misc', 'OPEN')], sessions, [], {},
    { id: 'demo', repo: { path: '/ws/repo' } }, '2026-09-26T00:00:00.000Z');
  board.workspaces = [{ id: 'repo', path: '/ws/repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  const summary = summarize(board);
  const projects = { errors: [], warnings: [], projects: [{ id: 'demo', name: 'Demo', branchLines: [], errors: [], refreshError: null }] };
  const now = Date.parse('2026-09-26T00:00:00Z');
  const base = { summary, projects, projectId: 'demo', toggled: [], focus: focusOf(summary, 's1'), url: 'http://127.0.0.1:4317', now, problems: [] };
  const problems = [{ kind: 'offline', url: 'http://127.0.0.1:4317', message: 'ECONNREFUSED' }, { kind: 'oversize' },
    { kind: 'http', status: 500, messages: ['m1', 'm2', 'm3', 'm4'] }];
  const panes = () => [
    ...['overview', 'check', 'diag'].map((view) => paneOf({ ...base, view })),
    paneOf({ ...base, view: 'overview', focus: null, problems }),
    paneOf({ ...base, summary: null, projectId: null, view: 'overview', problems }),
  ];
  const texts = (p) => [...p.header, ...p.banners, ...p.focus, ...p.body, ...(p.more ? [p.more] : [])].flatMap((r) => r.texts);
  const run = (l) => { setLang(l); return [commandText(), ...panes().flatMap(texts)]; };
  const zh = run('zh');
  assert.ok(zh.some((s) => s.includes('本会话正在做')) && zh.some((s) => s.includes('当前目录不在看板的项目里')), '夹具覆盖到 mod 自己的文案');
  assert.deepEqual(run('en').filter((s) => /[぀-ヿ㐀-鿿！-｠]/.test(s)), [], 'en 残留中日文');
  // 日文译文本身含汉字：查与中文输出逐条相同、又含汉字的（漏译会原样回落成中文）
  assert.deepEqual(run('ja').filter((s, i) => /[㐀-鿿]/.test(s) && s === zh[i]), [], 'ja 漏译');
});

test('i18n：服务端会显示的中文都用 msg 标记', () => {
  for (const f of SRC) {
    const left = scan(read(f), ['msg']).bare.filter((b) => !SRC_NOT_DISPLAYED.has(b.text));
    assert.deepEqual(left.map((b) => `${f}:${b.line} ${b.text}`), []);
  }
});

test('i18n：每个翻译键在日 / 英词典里都有，占位符一致，词典里没有多余的键', () => {
  const keys = allKeys();
  for (const [name, dict] of [['ja', ja], ['en', en]]) {
    const missing = [...keys].filter(([k]) => !Object.hasOwn(dict, k)).map(([k, at]) => `${at} ${k}`);
    assert.deepEqual(missing, [], `${name} 缺译`);
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepEqual(stale, [], `${name} 多余`);
    const bad = Object.entries(dict).filter(([k, v]) => placeholders(k) !== placeholders(v)).map(([k]) => k);
    assert.deepEqual(bad, [], `${name} 占位符不一致`);
  }
});

test('i18n：语言选择——手动选过的优先，其次浏览器语言，都不认识用英文', () => {
  assert.equal(pickLang('ja', ['zh-CN']), 'ja');
  assert.equal(pickLang(null, ['zh-TW', 'en']), 'zh');
  assert.equal(pickLang('xx', ['ja-JP']), 'ja');
  assert.equal(pickLang(null, ['fr-FR', 'en-GB']), 'en');
  assert.equal(pickLang(null, ['fr-FR']), 'en');
  assert.equal(pickLang(null, undefined), 'en');
});

test('i18n：tx 只按服务端词典整句翻译；插值默认原样（用户内容），只有 SLOTS 登记的子句 / 列表才再翻', (t_) => {
  t_.after(() => setLang('zh'));
  setLang('zh');
  assert.equal(t`共 ${3} 项`, '共 3 项');
  assert.equal(tx('随便一句'), '随便一句');
  setLang('en');
  assert.equal(tx('复选框已勾选，但没有关联 PR（仅文档确认）'), 'Checked, but no linked PR (checked in doc only)');
  assert.equal(tx('路径不存在：/a/b'), 'Path does not exist: /a/b');
  // 用户内容恰好等于词典键也不翻：路径、会话标题、会话原话
  assert.equal(tx('路径不存在：总览'), 'Path does not exist: 总览');
  assert.equal(tx('会话「进行中」'), 'session “进行中”');
  assert.equal(tx('人发消息：「进行中、总览」'), 'Message from you: “进行中、总览”');
  // 嵌套：子句「会话「x」」「PR 标题」翻译，里面的标题原样；引用列表原样（引用项里也可能有「、」），「等 N 个」照词典
  assert.equal(tx('会话「总览」里的「3」有歧义，可能是 a#3、b#3'), '“3” in the session “总览” is ambiguous; it could be a#3、b#3');
  assert.equal(tx('PR 标题里的「x」有歧义，可能是 a#1、b#1、c#1、d#1、e#1 等 7 个'),
    `“x” in the PR title is ambiguous; it could be ${enServer['{0} 等 {1} 个'].replace('{0}', 'a#1、b#1、c#1、d#1、e#1').replace('{1}', '7')}`);
  // 界面里的模板不参与服务端句子匹配
  assert.equal(tx('文档里的任务标题'), '文档里的任务标题');
  assert.equal(tx('no cjk'), 'no cjk');
  setLang('ja');
  assert.equal(tx('依赖 a#1、a#2 还没完成，却已有 PR #3'), '依存先 a#1、a#2 が未完了なのに、PR #3 があります');
});

test('i18n：joinList 拼的列表——英文换「, 」，中日去掉标记；没有标记的「、」（引用原文）不动', (t_) => {
  t_.after(() => setLang('zh'));
  const S = `依赖 ${joinList(['a#1', 'b、c#2'])} 还没完成，却已有 PR ${joinList(['#3', '#4'])}`;
  const more = `PR 标题里的「x」有歧义，可能是 ${joinList(['a#1', 'b#1', 'c#1', 'd#1', 'e#1'])} 等 7 个`;
  setLang('zh');
  assert.equal(tx(S), '依赖 a#1、b、c#2 还没完成，却已有 PR #3、#4');
  setLang('ja');
  assert.equal(tx(S), '依存先 a#1、b、c#2 が未完了なのに、PR #3、#4 があります');
  setLang('en');
  assert.ok(tx(S).includes('a#1, b、c#2') && tx(S).includes('#3, #4') && !tx(S).includes('\u2063'), tx(S));
  assert.ok(tx(more).includes('a#1, b#1, c#1, d#1, e#1') && !tx(more).includes('\u2063'), tx(more));
  assert.equal(tx(`未登记的句子 ${joinList(['1', '2'])}`), '未登记的句子 1、2', '没对上模板也不留标记');
});

test('i18n：真实歧义说明里文档名含「、」时，引用项原样保留（PR #28 review），列表分隔照样换（N26.2）', (t_) => {
  t_.after(() => setLang('zh'));
  const docs = ['alpha、beta', 'gamma'].map((docId) => ({ docId, archived: false, ...parseTasksDoc('- [ ] 1 one\n', docId) }));
  const pr = { number: 7, title: 'Task 1', body: '', url: '', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'b7', labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null };
  const b = computeBoard(docs, [pr], [], [], {}, { id: 'demo' }, '2026-09-26T00:00:00.000Z');
  const detail = b.conflicts.find((c) => c.type === 'h' && c.pr === 7).detail;
  assert.equal(detail, 'PR 标题里的「1」有歧义，可能是 alpha、beta#1\u2063、gamma#1');
  assert.equal(tx(detail), 'PR 标题里的「1」有歧义，可能是 alpha、beta#1、gamma#1');
  setLang('en');
  assert.equal(tx(detail), '“1” in the PR title is ambiguous; it could be alpha、beta#1, gamma#1', '文档名里的「、」不动，列表分隔换成「, 」');
});

test('i18n：用户原文里的 U+2063 不被当成列表标记（PR #34 review）', (t_) => {
  t_.after(() => setLang('zh'));
  // 单独的标记、标记 +「、」、两个标记：普通插值没经过 joinList 转义，一律原样（yuiboard#1 review）
  const paths = ['/tmp/A\u2063B.md', '/tmp/A\u2063、B.md', '/tmp/A\u2063\u2063B.md'];
  // 文档名正好含分隔符序列（新旧两种写法），经 joinList 转义后仍是两个候选
  const docs = ['al\u2063、pha', 'be、\u2063ta', 'gamma'].map((docId) => ({ docId, archived: false, ...parseTasksDoc('- [ ] 1 one\n', docId) }));
  const pr = { number: 7, title: 'Task 1', body: '', url: '', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'b7', labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null };
  const detail = computeBoard(docs, [pr], [], [], {}, { id: 'demo' }, '2026-09-26T00:00:00.000Z').conflicts.find((c) => c.type === 'h').detail;
  for (const l of ['zh', 'ja', 'en']) {
    setLang(l);
    for (const p of paths) assert.ok(tx(`配置文件 ${p} 读取失败：x`).includes(p), `${l}: ${tx(`配置文件 ${p} 读取失败：x`)}`);
    assert.ok(tx(detail).includes('al\u2063、pha#1') && tx(detail).includes('be、\u2063ta#1'), `${l}: ${tx(detail)}`);
  }
  assert.ok(tx(detail).endsWith('al\u2063、pha#1, be、\u2063ta#1, gamma#1'), tx(detail));
});

test('i18n：真实超过 5 个候选的截断歧义说明，中日英都能翻（PR #37 review）', (t_) => {
  t_.after(() => setLang('zh'));
  const docs = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((docId) => ({ docId, archived: false, ...parseTasksDoc('- [ ] 1 one\n', docId) }));
  const pr = { number: 7, title: 'Task 1', body: '', url: '', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'b7', labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null };
  const detail = computeBoard(docs, [pr], [], [], {}, { id: 'demo' }, '2026-09-26T00:00:00.000Z').conflicts.find((c) => c.type === 'h').detail;
  assert.match(detail, / 等 6 个$/);
  setLang('zh');
  assert.equal(tx(detail), 'PR 标题里的「1」有歧义，可能是 d1#1、d2#1、d3#1、d4#1、d5#1 等 6 个');
  setLang('ja');
  assert.ok(tx(detail).includes('d1#1、d2#1、d3#1、d4#1、d5#1') && !tx(detail).includes('\u2063'), tx(detail));
  setLang('en');
  assert.ok(tx(detail).includes('d1#1, d2#1, d3#1, d4#1, d5#1') && !tx(detail).includes('\u2063'), tx(detail));
});

test('i18n：SLOTS 登记的模板都是服务端词典里的键，位置都是真实占位符', () => {
  for (const [key, slots] of Object.entries(SLOTS)) {
    assert.ok(Object.hasOwn(enServer, key) && Object.hasOwn(jaServer, key), key);
    for (const idx of Object.keys(slots)) assert.ok(key.includes(`{${idx}}`), `${key} 没有 {${idx}}`);
  }
});

test('日志与 devboard-ctl 输出的语言（N26.1）：DEVBOARD_LANG 优先，其次 LC_ALL / LC_MESSAGES / LANG，都不认识用英文', (t_) => {
  const saved = process.env.DEVBOARD_LANG;
  t_.after(() => { if (saved === undefined) delete process.env.DEVBOARD_LANG; else process.env.DEVBOARD_LANG = saved; });
  assert.equal(logLang({}), 'en', 'launchd / systemd 下通常没有 LANG');
  assert.equal(logLang({ LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(logLang({ LANG: 'C', LC_ALL: 'ja_JP.UTF-8' }), 'ja');
  assert.equal(logLang({ LANG: 'zh_CN.UTF-8', DEVBOARD_LANG: 'en' }), 'en');
  assert.equal(logLang({ DEVBOARD_LANG: 'xx', LANG: 'fr_FR' }), 'en');
  process.env.DEVBOARD_LANG = 'en';
  assert.equal(say(msg`devboard 已启动：${'http://127.0.0.1:4317/'}`), 'devboard is running: http://127.0.0.1:4317/');
  assert.equal(say(msg`文档 ${3}（重解析 ${1}）`), 'docs 3 (reparsed 1)');
  assert.equal(say(msg`GitHub 请求 ${2}（剩余 ${msg`未知`}）`), 'GitHub requests 2 (remaining unknown)');
  assert.equal(say(msg`配置错误：${msg`没有 id 为 ${'x'} 的项目`}`), 'Config error: No project with id x', '子句也翻');
  assert.equal(say(msg`前置 ${joinList(['1', '2'])} 无法排期`), 'Prerequisites can’t be scheduled: 1, 2');
  process.env.DEVBOARD_LANG = 'zh';
  assert.equal(say(msg`前置 ${joinList(['1', '2'])} 无法排期`), '前置 1、2 无法排期', '中文原样，只去列表标记');
  assert.equal(getLang(), 'zh', '不改页面语言');
});
