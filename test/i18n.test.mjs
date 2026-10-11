import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { scan } from './i18n-scan.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { t, tx, setLang, pickLang, SLOTS } from '../web/i18n.mjs';
import ja, { server as jaServer } from '../web/i18n-ja.mjs';
import en, { server as enServer } from '../web/i18n-en.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const WEB = ['web/app.mjs', 'web/svg.mjs'];
const SRC = [
  ...readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f}`),
  ...readdirSync(new URL('../src/sessions', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `src/sessions/${f}`),
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
  '警告：{0}',
  '配置错误：{0}',
  '请求处理失败：{0} {1}：{2}',
  '文档 {0}（重解析 {1}）',
  '会话 {0}（文件 {1}）',
  '未知',
  '，{0}',
  'GitHub 请求 {0}（剩余 {1}）{2}',
  '[{0}] {1} 写缓存 {2}.json 失败：{3}',
  '[{0}] {1} 手动关联文件读不了：{2}',
  '读不了',
  '手动关联 {0}',
  '手动关联后补查本地同步',
  ': 心跳\n\n',
  'devboard 已启动：{0}',
  'devboard 启动失败：{0}',
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

test('i18n：真实歧义说明里文档名含「、」时，引用项原样保留（PR #28 review）', (t_) => {
  t_.after(() => setLang('zh'));
  const docs = ['alpha、beta', 'gamma'].map((docId) => ({ docId, archived: false, ...parseTasksDoc('- [ ] 1 one\n', docId) }));
  const pr = { number: 7, title: 'Task 1', body: '', url: '', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'b7', labels: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null };
  const b = computeBoard(docs, [pr], [], [], {}, { id: 'demo' }, '2026-09-26T00:00:00.000Z');
  const detail = b.conflicts.find((c) => c.type === 'h' && c.pr === 7).detail;
  assert.equal(detail, 'PR 标题里的「1」有歧义，可能是 alpha、beta#1、gamma#1');
  setLang('en');
  assert.equal(tx(detail), '“1” in the PR title is ambiguous; it could be alpha、beta#1、gamma#1');
});

test('i18n：SLOTS 登记的模板都是服务端词典里的键，位置都是真实占位符', () => {
  for (const [key, slots] of Object.entries(SLOTS)) {
    assert.ok(Object.hasOwn(enServer, key) && Object.hasOwn(jaServer, key), key);
    for (const idx of Object.keys(slots)) assert.ok(key.includes(`{${idx}}`), `${key} 没有 {${idx}}`);
  }
});
