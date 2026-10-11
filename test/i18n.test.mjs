import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { scan } from './i18n-scan.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { t, tx, setLang, getLang, pickLang, SLOTS } from '../web/i18n.mjs';
import { msg, joinList } from '../src/msg.mjs';
import { say, logLang } from '../src/say.mjs';
import ja, { server as jaServer } from '../web/i18n-ja.mjs';
import en, { server as enServer } from '../web/i18n-en.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const WEB = ['web/app.mjs', 'web/svg.mjs'];
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
  const path = '/tmp/A\u2063B.md';
  const cfg = `配置文件 ${path} 读取失败：x`;
  // 文档名正好含分隔符序列（新旧两种写法），经 joinList 转义后仍是两个候选
  const docs = ['al\u2063、pha', 'be、\u2063ta', 'gamma'].map((docId) => ({ docId, archived: false, ...parseTasksDoc('- [ ] 1 one\n', docId) }));
  const pr = { number: 7, title: 'Task 1', body: '', url: '', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'b7', labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null };
  const detail = computeBoard(docs, [pr], [], [], {}, { id: 'demo' }, '2026-09-26T00:00:00.000Z').conflicts.find((c) => c.type === 'h').detail;
  for (const l of ['zh', 'ja', 'en']) {
    setLang(l);
    assert.ok(tx(cfg).includes(path), `${l}: ${tx(cfg)}`);
    assert.ok(tx(detail).includes('al\u2063、pha#1') && tx(detail).includes('be、\u2063ta#1'), `${l}: ${tx(detail)}`);
  }
  assert.ok(tx(detail).endsWith('al\u2063、pha#1, be、\u2063ta#1, gamma#1'), tx(detail));
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
