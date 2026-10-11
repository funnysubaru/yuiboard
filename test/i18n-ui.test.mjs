// 界面多语言（N22 任务 22.3）：在 en / ja 下渲染关键视图，确认界面文案已翻、服务端说明经 tx 翻、用户内容原样；语言切换写 localStorage 后重载。
// i18n.mjs 是共享单例：先 setLang 再带查询串重新 import app.mjs，模块顶层的常量（五态、视图名）才会按该语言求值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './fixtures/fake-dom.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { setLang, LANG_KEY } from '../web/i18n.mjs';
import { server as enServer } from '../web/i18n-en.mjs';

globalThis.document = createFakeDocument();
const NOW = new Date('2026-09-26T08:00:00Z');
// 任务 1 的标题恰好是界面词「总览」：它是用户内容，任何语言下都不能被翻
const SOURCE = '# 演示\n\n## 里程碑 M1：地基\n\n- [~] 1 总览\n- [ ] 2 普通任务\n';

function board() {
  const doc = { docId: 'demo', path: 'tasks.md', sourceType: 'spec-dir', sourceLabel: 'spec', workspaceId: 'repo',
    kind: 'tasks', archived: false, ...parseTasksDoc(SOURCE, 'demo') };
  const b = computeBoard([doc], [], [], [], {}, { id: 'demo' }, NOW);
  b.workspaces = [{ id: 'repo', path: '/tmp/demo-repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  return b;
}
const load = (lang) => { setLang(lang); return import(`../web/app.mjs?${lang}`); };
const rowOf = (root, num) => root.querySelectorAll('.row').find((r) => r.querySelector('.id').textContent === num);

test('i18n 界面：英文下导航、五态、按钮与相对时间已翻，任务标题原样', async (t) => {
  t.after(() => setLang('zh'));
  const app = await load('en');
  assert.deepEqual(app.VIEWS.map((v) => v.text), ['Overview', 'Gantt', 'Graph', 'Next up', 'Needs attention', 'Diagnostics']);
  const root = app.renderOverview(board(), app.newState(NOW.getTime()));
  const row = rowOf(root, '1');
  assert.equal(row.querySelector('.st').textContent, '◔In progress');
  assert.equal(row.querySelector('.title').textContent, '总览');
  assert.equal(row.querySelector('.task-detail').textContent, 'Details');
  assert.equal(root.querySelector('h2').textContent, 'Tasks');
  assert.equal(app.ago('2026-09-26T07:59:57Z', NOW.getTime()), '3s ago');

  // 甘特：今天线与月份缩写（英文用 Intl 月份名）
  const gantt = app.renderGantt(board(), app.newState(NOW.getTime())).textContent;
  assert.match(gantt, /Today/);
  assert.match(gantt, /Sep/);
});

test('i18n 界面：日文下导航与五态已翻', async (t) => {
  t.after(() => setLang('zh'));
  const app = await load('ja');
  assert.deepEqual(app.VIEWS.map((v) => v.text), ['概要', 'ガント', '関係図', '次にやること', '要確認', '診断']);
  const row = rowOf(app.renderOverview(board(), app.newState(NOW.getTime())), '1');
  assert.equal(row.querySelector('.st').textContent, '◔進行中');
  assert.equal(row.querySelector('.title').textContent, '总览');
});

test('i18n 界面：服务端发来的说明经 tx 翻译（配置错误、警告横幅）', async (t) => {
  // 模拟服务端消息词典（src/ 里 msg 标记的句子由另一处补进词典）
  enServer['示例：项目 {0} 读取失败'] = 'Sample: project {0} failed to read';
  t.after(() => { delete enServer['示例：项目 {0} 读取失败']; setLang('zh'); });
  const app = await load('en');
  const page = (list) => {
    const main = document.createElement('div');
    main.append(...app.renderPage({ list, projectId: 'demo', board: board(), state: app.newState(NOW.getTime()) }));
    return main;
  };
  const err = page({ errors: [{ projectId: null, message: '示例：项目 demo 读取失败' }], warnings: [], projects: [] });
  assert.equal(err.querySelector('.errpage').querySelector('h2').textContent, 'The config file has errors, so devboard can’t load projects');
  assert.deepEqual(err.querySelector('.errpage').querySelectorAll('li').map((li) => li.textContent),
    ['Sample: project demo failed to read', 'Fix the config, then restart devboard.']);

  const projects = [{ id: 'demo', name: '演示', errors: [], refreshError: null }];
  const ok = page({ errors: [], warnings: ['示例：项目 x 读取失败'], projects });
  assert.equal(ok.querySelector('.banner').textContent, 'Warning: Sample: project x failed to read');
});

test('i18n 语言切换：顶栏下拉列出三种语言、选中当前语言；切换写 localStorage 并重载，存不了也照样重载', async (t) => {
  const store = new Map();
  let reloads = 0;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.location = { hash: '', reload: () => { reloads++; } };
  t.after(() => { delete globalThis.localStorage; delete globalThis.location; setLang('zh'); });
  const app = await load('en');
  const state = app.newState(NOW.getTime());
  const header = app.renderHeader([{ id: 'demo', name: '演示' }], 'demo', board(), state);
  const sel = header.querySelector('[role=combobox][aria-label=Language]');
  const opts = sel.parentNode.querySelectorAll('[role=option]');
  const text = (o) => o.childNodes.at(-1).textContent; // 第一个子节点是 ✓ 标记
  assert.deepEqual(opts.map(text), ['中文', '日本語', 'English'], '各语言写自己的名字');
  assert.deepEqual(opts.filter((o) => o.getAttribute('aria-selected') === 'true').map(text), ['English']);
  assert.equal(sel.querySelector('.ddval').textContent, 'English');
  // 项目选择仍是顶栏第一个下拉
  assert.equal(header.querySelector('[role=combobox]').getAttribute('aria-label'), 'Project');

  sel.dispatch('click');
  opts[1].dispatch('click');
  assert.equal(store.get(LANG_KEY), 'ja');
  assert.equal(reloads, 1);

  globalThis.localStorage = { setItem: () => { throw new Error('quota'); } };
  app.switchLang('zh');
  assert.equal(reloads, 2);
});

test('i18n 日期选择：月份、星期、日期朗读名按界面语言；日 / 英周日起', async (t) => {
  t.after(() => setLang('zh'));
  for (const [lang, label, title, first, day, prev] of [
    ['en', 'Start date', 'September 2026', 'Sun', 'Saturday, September 19, 2026', 'Previous month'],
    ['ja', '開始日', '2026年9月', '日', '2026年9月19日土曜日', '前の月'],
  ]) {
    const app = await load(lang);
    const state = app.newState(NOW.getTime());
    state.recentFrom = '2026-09-19';
    const root = app.renderOverview(board(), state);
    const btn = root.querySelector(`[aria-label=${label}]`);
    btn.dispatch('click');
    assert.equal(root.querySelector('.dptitle').textContent, title, lang);
    assert.equal(root.querySelector('th').textContent, first, lang);
    assert.equal(root.querySelector('[data-date=2026-09-19]').getAttribute('aria-label'), day, lang);
    assert.ok(root.querySelector(`[aria-label=${prev}]`), lang);
  }
});
