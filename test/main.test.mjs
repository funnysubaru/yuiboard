// 驱动真实浏览器入口；只替换浏览器与网络边界，不复制 main 的重画 / 缓存判断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createFakeDocument } from './fixtures/fake-dom.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { computeBoard } from '../src/engine.mjs';
import { main, hashFor } from '../web/app.mjs';

const NOW = new Date('2026-09-27T08:00:00Z');
const SOURCE = '# 演示\n\n- [ ] 1 任务一\n  原文第一版\n\n- [ ] 2 任务二\n  第二项正文';

async function browser(t, { view = 'overview', focus = 'demo#1', prs = [] } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const doc = { docId: 'demo', path: 'tasks.md', sourceType: 'spec-dir', workspaceId: 'repo',
    kind: 'tasks', archived: false, ...parseTasksDoc(SOURCE, 'demo') };
  const board = computeBoard([doc], prs, [], [], {}, { id: 'demo' }, NOW);
  board.version = 1;
  const dom = createFakeDocument();
  const listeners = new Map();
  const streams = [];
  const requests = [];
  let readText = () => Promise.resolve(SOURCE.split('\n'));
  const response = (body) => ({ status: 200, json: async () => body });
  const globals = {
    document: dom,
    location: { hash: hashFor(view, 'demo', focus) },
    addEventListener: (type, fn) => listeners.set(type, fn),
    EventSource: class {
      constructor() { streams.push(this); }
      close() { this.closed = true; }
    },
    fetch: async (url) => {
      requests.push(url);
      if (url === '/api/projects') return response({ errors: [], warnings: [], projects: [{ id: 'demo', name: '演示', errors: [] }] });
      if (url.endsWith('/board')) return response(structuredClone(board));
      if (url.endsWith('/docs/demo')) return response({ lines: await readText() });
      throw new Error(`非预期请求：${url}`);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  await main();
  await setImmediate(); // 等待真实 Promise 链完成；计时器只由测试时钟推进。
  return {
    dom, requests,
    emit: (type, event) => listeners.get(type)(event),
    text: (load) => { readText = load; },
    navigate: async (view, focus = 'demo#1') => {
      location.hash = hashFor(view, 'demo', focus);
      await listeners.get('hashchange')();
      await setImmediate();
    },
    update: async () => {
      board.version++;
      streams.at(-1).onmessage({ data: JSON.stringify({ version: board.version }) });
      await setImmediate();
    },
  };
}

const button = (dom, text) => dom.querySelectorAll('button').find((b) => b.textContent === text);
const positions = (dom, selectors) => selectors.map((s) => {
  const el = dom.querySelector(s);
  assert.ok(el, `${s} 已由真实视图渲染`);
  return [el.scrollTop, el.scrollLeft];
});
const scroll = (dom, selectors) => selectors.forEach((s, i) => {
  const el = dom.querySelector(s);
  assert.ok(el, `${s} 已由真实视图渲染`);
  el.scrollTop = 100 + i;
  el.scrollLeft = 20 + i;
});

test('main：SSE 整页替换后恢复搜索词、焦点、选区及同位置各滚动区', async (t) => {
  const app = await browser(t);
  const { dom } = app;
  button(dom, '查看原文').dispatch('click');
  await setImmediate();
  const search = dom.querySelector('[aria-label="搜索任务"]');
  search.value = '任务';
  search.dispatch('input');
  search.focus();
  search.setSelectionRange(0, 1);
  const selectors = ['.drawer', '.srcview', '.evlist'];
  scroll(dom, selectors);
  const saved = positions(dom, selectors);
  await app.update();
  const replacement = dom.querySelector('[aria-label="搜索任务"]');
  assert.ok(replacement !== search, '确实发生了整页重画');
  assert.equal(replacement.getAttribute('value'), '任务');
  assert.ok(dom.activeElement === replacement, '焦点回到新搜索框');
  assert.deepEqual([replacement.selectionStart, replacement.selectionEnd], [0, 1]);
  assert.deepEqual(replacement.focusOptions, { preventScroll: true });
  assert.deepEqual(positions(dom, selectors), saved);
});

test('main：甘特滚动随 SSE 保留，换视图或换任务抽屉不套用旧滚动位置', async (t) => {
  const app = await browser(t, { view: 'gantt' });
  const selectors = ['.drawer', '.gscroll'];
  scroll(app.dom, selectors);
  const saved = positions(app.dom, selectors);
  await app.update();
  assert.deepEqual(positions(app.dom, selectors), saved);
  await app.navigate('graph');
  scroll(app.dom, ['.gwrap']);
  const graphScroll = positions(app.dom, ['.gwrap']);
  await app.update();
  assert.deepEqual(positions(app.dom, ['.gwrap']), graphScroll);
  await app.navigate('overview');
  assert.equal(app.dom.querySelector('.drawer').scrollTop, 0, '换视图从头开始');
  app.dom.querySelector('.drawer').scrollTop = 150;
  await app.navigate('overview', 'demo#2');
  assert.equal(app.dom.querySelector('.drawer').scrollTop, 0, '换抽屉从头开始');
});

test('main：滚轮 / 触摸持续输入推迟 SSE 重画，最后输入满 800ms 才替换节点', async (t) => {
  const app = await browser(t);
  const before = app.dom.querySelector('.drawer');
  app.emit('wheel');
  await app.update();
  t.mock.timers.tick(799);
  assert.ok(app.dom.querySelector('.drawer') === before, '尚未替换抽屉节点');
  app.emit('touchmove');
  t.mock.timers.tick(1); // 原定时器到期，必须按新触摸时间再等。
  assert.ok(app.dom.querySelector('.drawer') === before, '尚未替换抽屉节点');
  t.mock.timers.tick(798);
  assert.ok(app.dom.querySelector('.drawer') === before, '尚未替换抽屉节点');
  t.mock.timers.tick(1);
  assert.ok(app.dom.querySelector('.drawer') !== before, '静止满 800ms 后替换抽屉节点');
  // 用户主动切换视图不受后台重画等待限制。
  app.emit('wheel');
  await app.navigate('next');
  assert.ok(app.dom.querySelector('#v-next'));
});

test('main：新版本标记原文过期，后台重读期间保留旧文且只发一次请求', async (t) => {
  const app = await browser(t);
  const { dom } = app;
  assert.match(dom.querySelector('.drawer').textContent, /原文第一版/);
  const docsReads = () => app.requests.filter((url) => url.endsWith('/docs/demo')).length;
  assert.equal(docsReads(), 1);
  let resolveText;
  app.text(() => new Promise((resolve) => { resolveText = resolve; }));
  dom.querySelector('.drawer').scrollTop = 180;
  await app.update();
  assert.equal(docsReads(), 2, '新版本触发后台重读');
  assert.match(dom.querySelector('.drawer').textContent, /原文第一版/);
  assert.doesNotMatch(dom.querySelector('.drawer').textContent, /正在读取原文/);
  assert.equal(dom.querySelector('.drawer').scrollTop, 180);
  await app.navigate('overview'); // 重读期间再重画，不重复请求。
  assert.equal(docsReads(), 2);
  resolveText(SOURCE.replace('原文第一版', '原文第二版').split('\n'));
  await setImmediate();
  assert.match(dom.querySelector('.drawer').textContent, /原文第二版/);
  assert.doesNotMatch(dom.querySelector('.drawer').textContent, /原文第一版/);
  assert.equal(dom.querySelector('.drawer').scrollTop, 180);
});

async function openPicker(app) {
  button(app.dom, '＋ 手动关联 PR').dispatch('click');
  await setImmediate();
  const input = app.dom.querySelector('.picker').querySelector('input');
  assert.ok(app.dom.activeElement === input, '首次展开仍聚焦选择器');
  input.value = '42';
  input.dispatch('input');
  input.setSelectionRange(0, 1);
  app.dom.querySelector('.plist').scrollTop = 70;
}

test('main：SSE 保留已展开的手动关联选择器、搜索词与列表滚动位置', async (t) => {
  const app = await browser(t);
  await openPicker(app);
  await app.update();
  const input = app.dom.querySelector('.picker').querySelector('input');
  assert.equal(input.getAttribute('value'), '42');
  assert.equal(app.dom.querySelector('.plist').scrollTop, 70);
  button(app.dom.querySelector('.picker'), '取消').dispatch('click');
  await openPicker(app); // 关闭后再次展开，仍须自动聚焦。
});

test('main：已展开选择器在 SSE 后不覆盖原来的光标选区', async (t) => {
  const app = await browser(t);
  await openPicker(app);
  await app.update();
  const input = app.dom.querySelector('.picker').querySelector('input');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 1]);
});

test('main：已展开选择器的 SSE 重画不抢走任务搜索框焦点', async (t) => {
  const app = await browser(t);
  await openPicker(app);
  const search = app.dom.querySelector('[aria-label="搜索任务"]');
  search.focus();
  search.setSelectionRange(0, 0);
  await app.update();
  assert.ok(app.dom.activeElement === app.dom.querySelector('[aria-label="搜索任务"]'));
});

test('main：抽屉局部重画在卸载输入框前保存焦点与选区，恢复到新选择器', async (t) => {
  const app = await browser(t);
  await openPicker(app);
  for (const action of ['查看原文', '收起']) {
    const old = app.dom.activeElement;
    // 程序化 click 不先转移焦点；等同焦点仍在输入框时触发抽屉局部更新。
    button(app.dom, action).dispatch('click');
    await setImmediate();
    const input = app.dom.querySelector('.picker').querySelector('input');
    assert.ok(old !== input, '局部更新确实重建了选择器');
    assert.ok(app.dom.activeElement === input, '脱离页面的旧输入框不再是 activeElement');
    assert.equal(input.getAttribute('value'), '42');
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 1]);
  }
});

test('main：局部重画不会把其他控件的焦点抢给已展开选择器', async (t) => {
  const app = await browser(t);
  await openPicker(app);
  const search = app.dom.querySelector('[aria-label="搜索任务"]');
  search.focus();
  button(app.dom, '查看原文').dispatch('click');
  await setImmediate();
  assert.ok(app.dom.activeElement === search);
  const collapse = button(app.dom, '收起');
  collapse.focus(); // 模拟浏览器把真实点击的按钮聚焦，再发生局部重画。
  collapse.dispatch('click');
  await setImmediate();
  assert.ok(app.dom.activeElement === app.dom.body, '原按钮已卸载，选择器不擅自抢焦点');
});

test('main：总览关联按钮预设 picker 后，首次打开 PR 抽屉仍自动聚焦', async (t) => {
  const app = await browser(t, { focus: null, prs: [{ number: 42, title: '尚未关联', state: 'OPEN', isDraft: true,
    headRefName: 'feature/example', baseRefName: 'main', url: 'https://github.com/example/repo/pull/42',
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), mergedAt: null, closedAt: null, labels: [], body: '' }] });
  button(app.dom, '关联').dispatch('click');
  await app.emit('hashchange'); // 由关联按钮实际写入的地址路由，不在测试里重建 picker state。
  await setImmediate();
  const input = app.dom.querySelector('.picker').querySelector('input');
  assert.ok(app.dom.activeElement === input);
  assert.equal(input.getAttribute('aria-label'), '搜索编号 / 标题');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 0]);
});

// N24：自绘下拉与日历的展开状态记在 state 上，跟手动关联选择器一样扛得住 SSE 整页重画
const combo = (dom, label) => dom.querySelector(`[role=combobox][aria-label=${label}]`);
const activeText = (dom, cb) => dom.querySelector(`#${cb.getAttribute('aria-activedescendant')}`).childNodes.at(-1).textContent;

test('main：下拉展开时 SSE 整页重画仍展开在原高亮项、焦点回到新 combobox；点外面收起，点弹层里不收；切视图收起', async (t) => {
  const app = await browser(t);
  const { dom } = app;
  const old = combo(dom, '界面语言');
  old.focus();
  old.dispatch('keydown', { key: 'ArrowDown' });
  old.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(activeText(dom, old), '日本語');
  await app.update();
  const cb = combo(dom, '界面语言');
  assert.ok(cb !== old, '确实发生了整页重画');
  assert.equal(cb.getAttribute('aria-expanded'), 'true');
  assert.equal(activeText(dom, cb), '日本語');
  assert.ok(dom.activeElement === cb, '焦点按 aria-label 回到新 combobox');

  app.emit('pointerdown', { target: cb.parentNode.querySelector('[role=option]') });
  assert.equal(cb.getAttribute('aria-expanded'), 'true', '点在弹层里不收起');
  app.emit('pointerdown', { target: dom.querySelector('#v-overview') });
  assert.equal(cb.getAttribute('aria-expanded'), 'false');
  await app.update();
  assert.equal(combo(dom, '界面语言').getAttribute('aria-expanded'), 'false', '收起后重画不再展开');

  combo(dom, '项目').dispatch('click');
  await app.navigate('gantt');
  await app.navigate('overview');
  assert.equal(combo(dom, '项目').getAttribute('aria-expanded'), 'false', '切视图收起');
});

test('main：日历展开时 SSE 整页重画仍展开在键盘所在日、焦点回到该日；Esc 收起把焦点还给按钮', async (t) => {
  const app = await browser(t);
  const { dom } = app;
  dom.querySelector('[aria-label=起始日]').dispatch('click');
  assert.equal(dom.activeElement.getAttribute('data-date'), '2026-09-20', '默认 7 天前');
  dom.querySelector('[role=grid]').dispatch('keydown', { key: 'ArrowLeft' });
  const before = dom.activeElement;
  await app.update();
  assert.ok(dom.activeElement !== before && dom.activeElement.getAttribute('data-date') === '2026-09-19', '焦点回到新日历的同一天');
  const btn = dom.querySelector('[aria-label=起始日]');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  dom.querySelector('[role=dialog]').dispatch('keydown', { key: 'Escape' });
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.ok(dom.activeElement === btn);
  await app.update();
  assert.equal(dom.querySelector('[aria-label=起始日]').getAttribute('aria-expanded'), 'false');
});
