// 前端视图测试 + UI 稿对照走查（tasks.md「执行约定 · UI 稿对照走查」）。
// 视图函数在假 DOM 上渲染后断言；UI 稿里的颜色变量、五态图标文字、导航从 test/fixtures/ui-mockup.html 自动抽取再比对，
// 改 UI 稿而实现没跟上时这里会失败。之后每个界面任务都在本文件补本视图的对照断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeDocument } from './fixtures/fake-dom.mjs';
import { parseTasksDoc } from '../src/docs.mjs';
import { parseAdrDoc } from '../src/adr.mjs';
import { computeBoard, STATUSES } from '../src/engine.mjs';
import { STATUS_UI, VIEWS, renderOverview, renderPage, renderHeader, renderNav, renderDrawer, renderNext, parseHash, hashFor, newState, ago, refreshRequest, main } from '../web/app.mjs';

import { renderGraph } from '../web/app.mjs';
import { layoutGraph } from '../web/svg.mjs';

globalThis.document = createFakeDocument();

const NOW = new Date('2026-09-26T08:00:00Z');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MOCK = read('fixtures/ui-mockup.html');
const WEB = new URL('../web/', import.meta.url);

// ---------- 夹具：真实解析器 + 真实 engine 生成的 Board ----------

const DEMO = `# 演示计划

- [ ] 0 分组前的任务

## 里程碑 M1：地基

- [x] 1 父任务
- [x] 1.1 子任务甲
- [x] 1.2 子任务乙

## 里程碑 M2：进行中

- [~] 2 正在做
- [ ] 3 <script>alert("x")</script> 标题
- [x] ~~4 作废的任务~~ **【作废】**
`;

function planDoc(docId, text, extra = {}) {
  return {
    docId, sourceType: 'spec-dir', sourceLabel: 'spec', path: `.claude/specs/${docId}/tasks.md`, workspaceId: 'repo',
    archived: false, kind: 'tasks', ...parseTasksDoc(text, docId), ...extra,
  };
}

function fixtureBoard() {
  const docs = [
    planDoc('demo', DEMO),
    planDoc('done-doc', '# 已完成\n\n## 阶段 1\n\n- [x] 1 做完了\n'),
    planDoc('partial-doc', '# 半截\n\n- [ ] 1 能认的\n- [ ] 2.写法有误\n'),
    planDoc('empty-doc', '# 清单\n\n- [ ] 写代码\n'),
    {
      docId: 'plan-only', sourceType: 'spec-dir', sourceLabel: 'spec', path: '.claude/specs/plan-only', workspaceId: 'repo',
      archived: false, kind: 'planning', title: null, groups: [], tasks: [],
      parse: { state: 'planning', reason: '规划中（暂无任务）：目录里有文档但还没有 tasks.md', unrecognizedLines: [],
        unknownRelations: [], unknownEstimates: [], mermaidUsed: false, diagnostics: [], uncheckedBoxes: 0 },
    },
    planDoc('old-doc', '# 旧\n\n- [ ] 1 归档里的任务\n', { archived: true }),
  ];
  const board = computeBoard(docs, [], [], [], {}, { id: 'demo' }, NOW);
  board.workspaces = [{ id: 'repo', path: '/tmp/demo-repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  board.freshness.docsReadAt = '2026-09-26T07:59:57.000Z';
  return board;
}

const overview = (state = newState(NOW.getTime())) => renderOverview(fixtureBoard(), state);
const texts = (nodes) => nodes.map((n) => n.textContent);

// 自绘下拉（N24 任务 24.2）：按 aria-label 找 combobox；choose = 点开再点选项，同鼠标操作
const combo = (root, label) => root.querySelectorAll('[role=combobox]').find((c) => label == null || c.getAttribute('aria-label') === label);
const optsOf = (cb) => cb.parentNode.querySelectorAll('[role=option]');
const optText = (o) => o.childNodes.at(-1).textContent; // 第一个子节点是 ✓ 标记
const optTexts = (cb) => optsOf(cb).map(optText);
const chosen = (cb) => optsOf(cb).filter((o) => o.getAttribute('aria-selected') === 'true').map(optText);
function choose(cb, text) {
  cb.dispatch('click');
  const o = optsOf(cb).find((x) => optText(x) === text);
  assert.ok(o, `有选项「${text}」`);
  o.dispatch('click');
}
// 日期选择（N24 任务 24.3）：点开按钮再点某天（须是当前所示月份里可选的日子）
function pickDate(btn, day) {
  btn.dispatch('click');
  const b = btn.parentNode.querySelector(`[data-date=${day}]`);
  assert.ok(b && !b.hasAttribute('disabled'), `${day} 可选`);
  b.dispatch('click');
}
const docOf = (root, docId) => root.querySelectorAll('.doc').find((d) => d.querySelector('.gname').textContent === docId);
const groupOf = (root, title) => root.querySelectorAll('.lv2').find((g) => g.querySelector('.gname').textContent === title);
const rowOf = (root, num) => root.querySelectorAll('.row').find((r) => r.querySelector('.id').textContent === num);
const nextEl = (el) => el.parentNode.children[el.parentNode.children.indexOf(el) + 1];

test('手动刷新：立即提示，区分接受与合并，失败泛化；旧请求与旧项目不覆盖反馈', async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (url, options) => {
    assert.equal(url, '/api/projects/demo/refresh');
    assert.equal(options.method, 'POST');
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  try {
    const shown = [];
    let current = true;
    const refresh = refreshRequest('demo', () => current, (message) => shown.push(message));
    const first = refresh();
    assert.equal(shown.at(-1), '正在发送刷新请求…');
    const second = refresh();
    pending[1].resolve({ status: 202, json: async () => ({ merged: true }) });
    await second;
    assert.equal(shown.at(-1), '刷新请求已合并');
    const count = shown.length;
    pending[0].resolve({ status: 202, json: async () => ({ merged: false }) });
    await first;
    assert.equal(shown.length, count, '慢响应不能覆盖最新提示');

    const accepted = refresh();
    pending[2].resolve({ status: 202, json: async () => ({ merged: false }) });
    await accepted;
    assert.equal(shown.at(-1), '刷新请求已接受，等待看板更新');

    for (const response of [
      { status: 500, json: async () => ({ message: 'secret' }) },
      { status: 202, json: async () => ({ merged: 'yes', message: 'secret' }) },
    ]) {
      const run = refresh();
      pending.at(-1).resolve(response);
      await run;
      assert.equal(shown.at(-1), '刷新请求失败，请稍后重试');
    }
    const failure = refresh();
    pending.at(-1).reject(new Error('secret'));
    await failure;
    assert.equal(shown.at(-1), '刷新请求失败，请稍后重试');

    const oldProject = refresh();
    current = false;
    const before = shown.length;
    pending.at(-1).resolve({ status: 202, json: async () => ({ merged: true }) });
    await oldProject;
    assert.equal(shown.length, before, '切换项目后不显示旧响应');

    const state = newState(NOW.getTime());
    state.refreshFeedback = '刷新请求已合并';
    const header = renderHeader([{ id: 'demo', name: '演示' }], 'demo', fixtureBoard(), state);
    const feedback = header.querySelector('.refresh-feedback');
    assert.equal(feedback.getAttribute('aria-live'), 'polite');
    assert.equal(feedback.textContent, '刷新请求已合并');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('真实入口刷新反馈随新版看板清除，响应期间保持按钮焦点', async () => {
  const saved = Object.fromEntries(['document', 'fetch', 'location', 'addEventListener', 'EventSource']
    .map((key) => [key, globalThis[key]]));
  const doc = createFakeDocument();
  doc.body = doc.createElement('body');
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.activeElement = null;
  let respond;
  let events;
  let boardVersion = 1;
  globalThis.document = doc;
  globalThis.location = { hash: '#/overview?project=demo' };
  globalThis.addEventListener = () => {};
  globalThis.EventSource = class { constructor() { events = this; } close() {} };
  globalThis.fetch = (url) => {
    if (url === '/api/projects') return Promise.resolve({ status: 200, json: async () => ({
      errors: [], warnings: [], projects: [{ id: 'demo', name: '演示', branchLines: [], errors: [] }],
    }) });
    if (url === '/api/projects/demo/board') return Promise.resolve({ status: 200, json: async () => {
      const board = fixtureBoard();
      board.version = boardVersion;
      return board;
    } });
    if (url === '/api/projects/demo/refresh') return new Promise((resolve) => { respond = resolve; });
    throw new Error(`未预期请求：${url}`);
  };
  try {
    await main();
    const header = doc.body.querySelector('header');
    const button = header.querySelector('button[aria-label=刷新看板]');
    const feedback = header.querySelector('.refresh-feedback');
    doc.activeElement = button;
    button.dispatch('click');
    assert.equal(feedback.textContent, '正在发送刷新请求…');
    respond({ status: 202, json: async () => ({ merged: true }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feedback.textContent, '刷新请求已合并');
    assert.equal(doc.body.querySelector('header'), header, '反馈不能重画页面');
    assert.equal(header.querySelector('.refresh-feedback'), feedback, '播报区须保持已挂载节点');
    assert.equal(doc.activeElement, button, '请求响应不丢键盘焦点');

    doc.activeElement = null; // 假 DOM 没有 focus()；此处只验证 SSE 更新后的提示。
    boardVersion = 2;
    events.onmessage({ data: JSON.stringify({ version: 2 }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '', '新版看板落地后不再显示旧刷新提示');

    doc.body.querySelector('button[aria-label=刷新看板]').dispatch('click');
    respond({ status: 202, json: async () => ({ merged: false }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '刷新请求已接受，等待看板更新');
    boardVersion = 3;
    events.onmessage({ data: JSON.stringify({ version: 3 }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '', '已接受的请求随新版看板清除');

    doc.body.querySelector('button[aria-label=刷新看板]').dispatch('click');
    boardVersion = 4;
    events.onmessage({ data: JSON.stringify({ version: 4 }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '正在发送刷新请求…', 'POST 未返回仍显示请求中');
    respond({ status: 202, json: async () => ({ merged: false }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '', '迟到的 POST 不恢复等待提示');

    doc.body.querySelector('button[aria-label=刷新看板]').dispatch('click');
    respond({ status: 202, json: async () => ({ merged: false }) });
    await new Promise((resolve) => setImmediate(resolve));
    events.onmessage({ data: JSON.stringify({ version: 4 }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '刷新请求已接受，等待看板更新', '同版本推送不清等待提示');

    doc.body.querySelector('button[aria-label=刷新看板]').dispatch('click');
    respond({ status: 500, json: async () => ({ message: 'secret' }) });
    await new Promise((resolve) => setImmediate(resolve));
    boardVersion = 5;
    events.onmessage({ data: JSON.stringify({ version: 5 }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(doc.body.querySelector('.refresh-feedback').textContent, '刷新请求失败，请稍后重试', '后续看板更新不掩盖请求错误');
  } finally {
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  }
});

// ---------- UI 稿对照 ----------

function themeVars(css) {
  const block = (re) => {
    const m = re.exec(css);
    assert.ok(m, `找不到颜色变量块 ${re}`);
    return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(([, k, v]) => [k, v.trim()]));
  };
  return {
    light: block(/(?:^|\n):root\{([^}]*)\}/),
    darkBySystem: block(/:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/),
    darkByButton: block(/:root\[data-theme="dark"\]\{([^}]*)\}/),
  };
}

test('UI 稿对照：亮 / 暗（系统）/ 暗（按钮）三套颜色变量与 UI 稿一致', () => {
  const mock = themeVars(MOCK);
  assert.ok(Object.keys(mock.light).includes('--s-done') && Object.keys(mock.darkByButton).length > 10, '抽取到了变量');
  assert.deepEqual(themeVars(read('../web/style.css')), mock);
});

test('UI 稿对照：五态图标与文字（按阶段顺序）', () => {
  const s = /const S\s*=\s*\{(.*?)\};/.exec(MOCK);
  assert.ok(s, 'UI 稿里的 S 表');
  const mock = [...s[1].matchAll(/(\w+):\['([^']+)','([^']+)'\]/g)].map(([, cls, icon, text]) => [cls, icon, text]);
  assert.equal(mock.length, 5);
  assert.deepEqual(STATUSES.map((st) => [STATUS_UI[st].cls, STATUS_UI[st].icon, STATUS_UI[st].text]), mock);
  assert.equal(mock[0].join(' '), 'todo ○ 未开始');
});

test('UI 稿对照：导航按钮的 data-v 与文字都出自 UI 稿，且顺序一致', () => {
  const nav = /<nav id="nav">([\s\S]*?)<\/nav>/.exec(MOCK)[1];
  const mock = [...nav.matchAll(/<button data-v="(\w+)"[^>]*>([^<]+)/g)].map(([, v, t]) => [v, t.trim()]);
  assert.equal(mock.length, 6);
  const impl = renderNav('overview', 'demo').children.map((b) => [b.getAttribute('data-v'), b.textContent]);
  assert.deepEqual(impl, VIEWS.map((v) => [v.id, v.text]));
  const at = impl.map((item) => mock.findIndex((m) => m[0] === item[0] && m[1] === item[1]));
  assert.ok(at.every((i) => i >= 0), `导航项都在 UI 稿里：${JSON.stringify(impl)}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), '顺序同 UI 稿');
  assert.equal(renderNav('overview', 'demo').querySelector('button.on').getAttribute('data-v'), 'overview');
});

// ---------- 总览 ----------

test('总览数字卡：整体进度（百分比 + 已完成数 + 分段条）与进行中', () => {
  const root = overview();
  const cards = root.querySelectorAll('.stat');
  assert.deepEqual(texts(cards.slice(0, 3).map((c) => c.querySelector('.l'))), ['整体进度', '可开工', '◔ 进行中']);
  // 未归档、未作废：demo 6 条 + done-doc 1 + partial-doc 1 = 8；已完成 1、1.1、1.2、done-doc#1 = 4
  assert.equal(cards[0].querySelector('.n').textContent, '50%');
  assert.equal(cards[0].querySelector('.sub').textContent, '4 / 8 个任务已合并完成');
  const bar = cards[0].querySelector('.pbar').children;
  assert.deepEqual(bar.map((i) => i.className), ['done', 'doing'], '分段顺序同 UI 稿，0 的段不画');
  assert.equal(bar[0].style.getPropertyValue('width'), '50%', '宽度经 CSSOM 设置（CSP 不允许行内 style）');
  assert.equal(cards[2].querySelector('.n').textContent, '1');
  assert.equal(cards[2].querySelector('.sub').textContent, '0 运行中 · 0 停滞');
});

test('任务树：文档 lv1 → 分组 lv2 → 任务行，文档顺序保留、归档文档不出现', () => {
  const root = overview();
  assert.deepEqual(texts(root.querySelectorAll('.doc').map((d) => d.querySelector('.gname'))),
    ['demo', 'done-doc', 'partial-doc', 'empty-doc', 'plan-only']);
  const demo = docOf(root, 'demo');
  assert.ok(demo.children[0].classList.contains('lv1'));
  assert.deepEqual(texts(demo.querySelectorAll('.lv2').map((g) => g.querySelector('.gname'))), ['里程碑 M1：地基', '里程碑 M2：进行中']);
  for (const g of root.querySelectorAll('.lv2')) {
    const block = g.parentNode; // N23：分组标题与它的任务包在 .gblock 里，展开时加 open 画成卡片
    assert.ok(block.classList.contains('gblock') && block.parentNode.classList.contains('rows') && block.parentNode.parentNode.classList.contains('doc'), '分组挂在文档下');
    assert.equal(block.classList.contains('open'), !g.classList.contains('closed'), '展开的分组才是卡片');
  }
  for (const r of root.querySelectorAll('.row')) assert.ok(r.parentNode.classList.contains('rows'));
  // 文档顺序：分组前的任务 0 排最前，直接挂在文档下
  assert.deepEqual(texts(demo.querySelectorAll('.row').map((r) => r.querySelector('.id'))), ['0', '1', '1.1', '1.2', '2', '3', '4']);
  assert.equal(rowOf(demo, '0').parentNode.parentNode, demo);
  assert.equal(root.querySelectorAll('.row').some((r) => r.textContent.includes('归档里的任务')), false);
});

test('任务行：列顺序为状态徽标、编号、标题、标签；状态 = 图标 + 文字 + 颜色 class', () => {
  const root = overview();
  const r1 = rowOf(root, '1');
  assert.deepEqual(r1.children.map((c) => c.className), ['st-cell', 'id', 'title', 'tags', 'linkbtn task-detail']);
  assert.equal(r1.querySelector('.st').className, 'st done');
  assert.equal(r1.querySelector('.st').textContent, '●已合并完成');
  assert.equal(r1.querySelector('.tags').textContent, '仅文档确认');
  assert.match(r1.querySelector('.title').textContent, /子任务 2\/2 完成/);
  assert.ok(rowOf(root, '1.1').classList.contains('child'));
  assert.equal(rowOf(root, '2').querySelector('.st').className, 'st doing');
  assert.equal(rowOf(root, '0').querySelector('.st').textContent, '○未开始');
  const v = rowOf(root, '4');
  assert.ok(v.classList.contains('void'));
  assert.equal(v.querySelector('.st').textContent, '⊘作废');
});

test('「只看未完成的分组」默认勾选：全部完成的文档 / 分组默认折叠，可点开；取消勾选全部展开', () => {
  const root = overview();
  const box = root.querySelector('input[type=checkbox]');
  assert.ok(box.hasAttribute('checked'));
  assert.match(box.parentNode.textContent, /只看未完成的分组/);

  const m1 = groupOf(root, '里程碑 M1：地基');
  assert.ok(m1.classList.contains('closed') && nextEl(m1).classList.contains('hide'));
  assert.ok(!groupOf(root, '里程碑 M2：进行中').classList.contains('closed'));
  assert.match(m1.querySelector('.gp').textContent, /● 全部完成/);
  const doneDoc = docOf(root, 'done-doc');
  assert.ok(doneDoc.children[0].classList.contains('closed'), '全部完成的文档默认折叠（需求 10.5）');
  assert.ok(!docOf(root, 'demo').children[0].classList.contains('closed'));

  m1.dispatch('click');
  assert.ok(groupOf(root, '里程碑 M1：地基').classList.contains('closed'), '选择分组文字不触发折叠');
  m1.querySelector('button.caret').dispatch('click');
  assert.ok(!groupOf(root, '里程碑 M1：地基').classList.contains('closed'), '点开后展开');
  groupOf(root, '里程碑 M1：地基').querySelector('button.caret').dispatch('click');
  assert.ok(groupOf(root, '里程碑 M1：地基').classList.contains('closed'), '再点折叠');

  box.checked = false;
  box.dispatch('change');
  assert.equal(root.querySelectorAll('.grp').filter((g) => g.classList.contains('closed')).length, 0);
  assert.equal(root.querySelectorAll('.rows').filter((r) => r.classList.contains('hide')).length, 0);
});

test('任务树折叠重画后保留文档、分组和父任务按钮焦点', () => {
  const state = newState(NOW.getTime());
  state.onlyOpen = false;
  const root = overview(state);
  document.body.replaceChildren(root);
  for (const selector of ['button.caret', 'button.tcaret']) {
    const labels = root.querySelectorAll(selector).map((el) => el.getAttribute('aria-label'));
    for (const label of labels) {
      const button = () => root.querySelectorAll(selector).find((el) => el.getAttribute('aria-label') === label);
      button().focus();
      button().dispatch('click');
      assert.ok(document.activeElement === button(), label);
      button().dispatch('click');
      assert.ok(document.activeElement === button(), label);
    }
  }
  document.body.replaceChildren();
});

test('搜索框按编号 / 标题过滤，并展开命中的分组', () => {
  const root = overview();
  const input = root.querySelector('input[type=search]');
  input.value = '子任务';
  input.dispatch('input');
  assert.deepEqual(texts(root.querySelectorAll('.row').map((r) => r.querySelector('.id'))), ['1.1', '1.2']);
  assert.deepEqual(texts(root.querySelectorAll('.doc').map((d) => d.querySelector('.gname'))), ['demo']);
  assert.ok(!groupOf(root, '里程碑 M1：地基').classList.contains('closed'), '已完成分组里命中也展开');
  input.value = '1.2';
  input.dispatch('input');
  assert.deepEqual(texts(root.querySelectorAll('.row').map((r) => r.querySelector('.id'))), ['1.2']);
  input.value = '不存在';
  input.dispatch('input');
  assert.equal(root.querySelector('.empty').textContent, '没有匹配的任务');
});

test('标题等外部文本只以文本节点进入页面：<script> 字样渲染为纯文本', () => {
  const root = overview();
  assert.equal(rowOf(root, '3').querySelector('.title').textContent, '<script>alert("x")</script> 标题');
  assert.equal(root.querySelectorAll('script').length, 0);
});

test('规划中 / 解析不完整 / 未解析出任务 如实显示，不显示成 0 个任务', () => {
  const root = overview();
  const note = (id) => docOf(root, id).querySelector('.docnote');
  assert.equal(note('plan-only').textContent, '规划中（暂无任务）：目录里有文档但还没有 tasks.md');
  assert.match(note('partial-doc').textContent, /^⚠ 解析不完整：第 4 行/);
  assert.ok(note('partial-doc').classList.contains('warn'));
  assert.match(note('empty-doc').textContent, /^未解析出任务：/);
  assert.equal(note('demo'), null);
  assert.equal(docOf(root, 'empty-doc').querySelector('.gp').textContent, '', '不显示 0/0');

  const side = root.querySelectorAll('.dp').map((d) => d.querySelector('.dh').textContent);
  assert.deepEqual(side, ['demo3/6 · 50%', 'done-doc1/1 · 100%', 'partial-doc0/1 · 0%', 'empty-doc未解析出任务', 'plan-only规划中（暂无任务）']);
});

test('ADR 文档级条目（任务 2.3）：来源类型标「ADR」、编号 + 标题、状态原文；含任务行时任务照常挂在下面', () => {
  const adrDoc = (docId, text) => ({
    docId, sourceType: 'adr-dir', sourceLabel: 'ADR', path: `docs/adr/${docId}.md`, workspaceId: 'repo',
    archived: false, ...parseAdrDoc(text, docId),
  });
  const docs = [
    adrDoc('ADR-0014-前端工程架构', '# ADR-0014: 前端工程架构\n\n- **状态**: 已采纳（待实现）\n\n- [ ] 验收清单无编号\n'),
    adrDoc('ADR-0020-含任务', '# ADR-0020 — 含任务\n\n## 状态\n\n待评审 (v1.3)\n\n## 步骤\n\n- [x] 1 第一步\n- [ ] 2 第二步\n'),
    adrDoc('README', '# 约定\n'),
  ];
  const board = computeBoard(docs, [], [], [], {}, { id: 'demo' }, NOW);
  const root = renderOverview(board, newState(NOW.getTime()));
  const heads = root.querySelectorAll('.lv1');
  assert.deepEqual(heads.map((l) => l.querySelector('.flag').textContent), ['ADR', 'ADR', 'ADR']);
  assert.deepEqual(texts(heads.map((l) => l.querySelector('.gname'))), ['ADR-0014 前端工程架构', 'ADR-0020 含任务', 'README 约定']);
  assert.deepEqual(heads.map((l) => l.querySelector('.adrst')?.textContent ?? null), ['已采纳（待实现）', '待评审 (v1.3)', null]);
  assert.equal(heads[0].querySelector('.path').textContent, 'docs/adr/ADR-0014-前端工程架构.md');
  const [a14, a20] = root.querySelectorAll('.doc');
  assert.equal(a14.querySelector('.docnote'), null, '没有任务行的 ADR 不提示「未解析出任务」');
  assert.equal(a14.querySelectorAll('.row').length, 0);
  assert.deepEqual(texts(a20.querySelectorAll('.row').map((r) => r.querySelector('.id'))), ['1', '2']);
  assert.equal(heads[1].querySelector('.gp').textContent, '1/2');
});

// ---------- 整页 ----------

const LIST = { errors: [], warnings: [], projects: [{ id: 'demo', name: '演示', errors: [], refreshError: null }] };
const page = (opts) => {
  const main = document.createElement('div');
  main.append(...renderPage({ list: LIST, projectId: 'demo', state: newState(NOW.getTime()), ...opts }));
  return main;
};

test('顶栏：品牌、项目选择、工作区分支与提交、文档读取时间、亮暗切换', () => {
  const root = page({ board: fixtureBoard() });
  const header = root.querySelector('header');
  assert.equal(header.querySelector('.brand').textContent, 'AI 开发进度看板');
  assert.equal(header.querySelector('.brand').querySelector('img').getAttribute('alt'), 'YUIBoard');
  assert.equal(header.querySelector('.brand').querySelector('img').getAttribute('src'), '/yuiboard-logo.png');
  const proj = combo(header, '项目');
  assert.deepEqual([optTexts(proj), chosen(proj), proj.querySelector('.ddval').textContent], [['演示'], ['演示'], '演示']);
  assert.deepEqual(texts(header.querySelectorAll('.meta')[0].children), ['工作区 demo-repo · main @ aaaaaaaa', '文档 3 秒前', 'AI 会话 未读取', 'GitHub 未读取']);
  assert.equal(header.querySelector('button[title=切换亮/暗]').textContent, '◐');
  assert.ok(root.querySelector('#v-overview'));

  const detached = fixtureBoard();
  detached.workspaces = [{ id: 'repo', path: '/x/仓库', branch: null, commit: null, detached: true, error: null }];
  assert.match(page({ board: detached }).querySelector('.meta').textContent, /工作区 仓库 · （分离 HEAD） @ 未知/);

  // N17：docRef 分支线写「<分支线>读取」，悬停说明不切换分支、fetch 后才更新
  const ref = fixtureBoard();
  ref.workspaces = [{ id: 'next', label: '新引擎线', path: '/x/widget', ref: 'origin/next/x', branch: 'origin/next/x', commit: 'b'.repeat(40), detached: false, error: null }];
  const span = page({ board: ref }).querySelector('.meta').children[0];
  assert.equal(span.textContent, '新引擎线读取 widget · origin/next/x @ bbbbbbbb');
  assert.match(span.getAttribute('title'), /只读 origin\/next\/x 上的文档，不切换分支；本机 fetch 之后才会更新/);
});

test('错误页：全局配置错误、单项目配置错误、看板读取失败都写明原因，不显示空看板', () => {
  const global = page({ list: { errors: [{ projectId: null, message: '配置文件 x 不是合法 JSON（第 3 行第 5 列）' }], warnings: [], projects: [] }, projectId: undefined });
  assert.match(global.querySelector('.errpage').textContent, /不是合法 JSON（第 3 行第 5 列）/);
  assert.equal(global.querySelector('#v-overview'), null);

  const bad = { ...LIST, projects: [{ id: 'demo', name: '演示', errors: [{ projectId: 'demo', message: '项目 demo 的 repo.path 项：路径不存在' }] }] };
  const proj = page({ list: bad });
  assert.match(proj.querySelector('.errpage').textContent, /项目 演示 的配置有问题，已停用.*路径不存在/);
  assert.equal(proj.querySelector('#v-overview'), null);

  const failed = page({ error: { title: '看板读取失败', messages: ['看板推算失败：boom'] } });
  assert.match(failed.querySelector('.errpage').textContent, /看板读取失败看板推算失败：boom/);
  assert.equal(page({}).querySelector('main').textContent, '正在读取看板…');
});

test('配置警告与最近一次刷新失败显示为横幅，看板照常显示', () => {
  const list = { ...LIST, warnings: ['server.host 是 0.0.0.0，不是回环地址'], projects: [{ ...LIST.projects[0], refreshError: '看板推算失败：boom' }] };
  const root = page({ list, board: fixtureBoard() });
  assert.deepEqual(texts(root.querySelectorAll('.banner')), ['警告：server.host 是 0.0.0.0，不是回环地址', '看板推算失败：boom']);
  assert.ok(root.querySelector('#v-overview'));
});

test('hash 路由：#/<视图>?project=…&focus=…，未知视图回落总览', () => {
  assert.deepEqual(parseHash('#/overview?project=widget'), { view: 'overview', project: 'widget', focus: null, line: null });
  assert.deepEqual(parseHash(''), { view: 'overview', project: null, focus: null, line: null });
  assert.deepEqual(parseHash('#/nope'), { view: 'overview', project: null, focus: null, line: null });
  assert.equal(hashFor('overview', '中文 项目'), '#/overview?project=%E4%B8%AD%E6%96%87+%E9%A1%B9%E7%9B%AE');
  assert.equal(parseHash(hashFor('overview', '中文 项目')).project, '中文 项目');
  assert.deepEqual(parseHash(hashFor('overview', 'p', 'collab#2.5b')), { view: 'overview', project: 'p', focus: 'collab#2.5b', line: null });
});

test('相对时间', () => {
  const now = NOW.getTime();
  assert.equal(ago(null, now), '未读取');
  assert.equal(ago('2026-09-26T07:59:57Z', now), '3 秒前');
  assert.equal(ago('2026-09-26T07:58:00Z', now), '2 分钟前');
  assert.equal(ago('2026-09-26T05:00:00Z', now), '3 小时前');
  assert.equal(ago('2026-09-24T08:00:00Z', now), '2 天前');
});

test('静态检查：web/ 不用 HTML 字符串建节点；入口页没有内联脚本与行内样式（CSP）', () => {
  for (const f of readdirSync(WEB)) {
    const src = readFileSync(new URL(f, WEB), 'utf8');
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML/, f);
  }
  const html = readFileSync(new URL('index.html', WEB), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/style.css">/);
  assert.match(html, /<script type="module" src="\/app.mjs"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\sstyle=/);
});

// ---------- 任务 2.5：行内关系 / 标签、任务详情抽屉、原文查看 ----------

const REL = `# 关系演示

## 前置条件

| 编号 | 事项 | 阻塞 |
|---|---|---|
| P1 | sandbox 访问 | 3 |
| ~~P2~~ | 已提供 | 2 |

## 里程碑 M1：一

- [x] 1 地基
- [ ] 2 第二（依赖 1；可与 3 并行）
  - 这是 2 的正文
  - <b>正文</b>第二行
- [ ] 3 第三（依赖 1、99）
- [ ] 4 第四（依赖 2）
`;
const REL_PATH = '.claude/specs/rel/tasks.md';
const REL_LINES = REL.split('\n').slice(0, -1);

function relBoard() {
  const doc = planDoc('rel', REL);
  // 解析器的 SourceRef.file 取 opts.file；与 PlanDoc.path 一致，查看器才能反查文档
  Object.assign(doc, parseTasksDoc(REL, 'rel', { file: REL_PATH }));
  return computeBoard([doc], [], [], [], {}, { id: 'demo' }, NOW);
}
const relState = (focus, extra = {}) => ({ ...newState(NOW.getTime()), project: 'demo', focus, ...extra });
// 抽屉的节点：[遮罩, 抽屉]
const drawerOf = (focus, state = relState(focus)) => renderDrawer(relBoard(), state, () => { location.hash = hashFor(state.view, state.project); });
const kvPairs = (aside) => {
  const dl = aside.querySelector('dl');
  return dl.children.filter((c) => c.tagName === 'DT').map((dt) => [dt.textContent, nextEl(dt)]);
};

test('总览行内：「依赖 …」「∥ 可与 … 并行」、⛔ 外部阻塞（已解除的不显示）、仅文档确认、⚠ 不一致', () => {
  const root = renderOverview(relBoard(), relState(null));
  const deps = (n) => texts(rowOf(root, n).querySelectorAll('.dep'));
  assert.deepEqual(deps('2'), ['依赖 1', '∥ 可与 3 并行']);
  assert.deepEqual(deps('3'), ['依赖 1', '∥ 可与 2 并行'], '并行两端都可见，悬空的 99 不写进依赖说明');
  assert.deepEqual(deps('1'), []);

  const tags = (n) => rowOf(root, n).querySelector('.tags').children;
  assert.deepEqual(texts(tags('3')), ['⛔ P1', '⚠ 不一致']);
  assert.equal(tags('3')[0].className, 'blk');
  assert.match(tags('3')[1].getAttribute('title'), /找不到的对象：99/, '悬停看冲突明细');
  assert.deepEqual(texts(tags('2')), [], 'P2 已解除，不挂 ⛔');
  assert.deepEqual(texts(tags('1')), ['仅文档确认'], '冲突 c 就是「仅文档确认」，不再算「不一致」');
});

test('任务文字只读且点击不打开抽屉；详情按钮保留任务路由', () => {
  globalThis.location = { hash: '' };
  const root = renderOverview(relBoard(), relState(null));
  const row = rowOf(root, '3');
  row.querySelector('.title').dispatch('click');
  row.dispatch('click');
  assert.equal(location.hash, '', '点击文字或行空白都不开抽屉');
  assert.equal(row.querySelector('[contenteditable]'), null);
  const detail = row.querySelector('button.task-detail');
  assert.equal(detail.textContent, '详情');
  assert.match(detail.getAttribute('aria-label'), /rel#3/);
  detail.dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'overview', project: 'demo', focus: 'rel#3', line: null });
});

test('任务抽屉：头部「文档 · 分组」、编号 + 标题、状态徽标 + 行尾标签；键值区各项标题与顺序同 UI 稿', () => {
  const [scrim, aside] = drawerOf('rel#3');
  assert.ok(scrim.classList.contains('scrim') && scrim.classList.contains('open'));
  assert.ok(aside.classList.contains('drawer') && aside.classList.contains('open'));
  assert.equal(aside.getAttribute('aria-label'), '任务详情');
  const hd = aside.querySelector('.hd');
  assert.equal(hd.querySelector('.crumb').textContent, 'rel · 里程碑 M1：一');
  assert.equal(hd.querySelector('h2').textContent, '3　第三（依赖 1、99）');
  assert.deepEqual(texts(hd.querySelector('.hdtags').children), ['○未开始', '⛔ P1', '⚠ 不一致']);

  assert.deepEqual(kvPairs(aside).map(([k]) => k), ['为什么是这个状态', '前置', '后续', '可并行', '外部阻塞', '文档位置']);
  assert.deepEqual(kvPairs(drawerOf('rel#4')[1]).map(([k]) => k), ['为什么是这个状态', '前置', '后续', '可并行', '文档位置'],
    '没有外部阻塞就不列这一项');
  assert.deepEqual(texts(aside.querySelectorAll('h3')), ['正文', '关系来源', 'PR', 'AI 会话', '甘特时间'], '查看器未打开时的区块顺序');
});

test('任务抽屉键值区：状态依据、前置（可点 + 状态徽标，悬空「找不到」）、后续、可并行（没写「文档没写」）、外部阻塞、文档位置', () => {
  const kv = (focus) => Object.fromEntries(kvPairs(drawerOf(focus)[1]));
  const k3 = kv('rel#3');
  assert.equal(k3['为什么是这个状态'].textContent, '没有关联的会话或 PR，文档也没勾选');
  assert.equal(k3['为什么是这个状态'].getAttribute('title'), '规则 8.2-5');
  assert.equal(k3['前置'].textContent, '1 ●已合并完成99 找不到');
  const a = k3['前置'].querySelector('a');
  assert.equal(parseHash(a.getAttribute('href')).focus, 'rel#1', '前置可点，跳到该任务的抽屉');
  assert.equal(parseHash(a.getAttribute('href')).project, 'demo');
  assert.equal(k3['前置'].querySelector('.flag').textContent, '找不到');
  assert.equal(k3['后续'].textContent, '无');
  assert.equal(k3['外部阻塞'].textContent, 'P1 未解除');
  assert.equal(k3['文档位置'].textContent, `${REL_PATH} 第 16 行 · 查看原文`);

  const k2 = kv('rel#2');
  assert.equal(k2['后续'].textContent, '4');
  assert.equal(parseHash(k2['后续'].querySelector('a').getAttribute('href')).focus, 'rel#4');
  assert.equal(k2['可并行'].textContent, '3');
  assert.equal(k2['外部阻塞'].textContent, 'P2（已解除）');
  assert.equal(kv('rel#4')['可并行'].textContent, '文档没写');
  assert.equal(kv('rel#1')['为什么是这个状态'].textContent, '文档里已勾选，没找到 PR → 仅文档确认');
});

test('关系来源：每条依赖 / 并行 / 外部阻塞都有来源类型、文件、行号与原文', () => {
  const aside = drawerOf('rel#2')[1];
  const boxes = aside.querySelectorAll('.rel');
  assert.deepEqual(texts(boxes.map((b) => b.querySelector('b'))), ['依赖 1', '可并行 3', '外部阻塞 P2（已解除）']);
  assert.equal(boxes[0].querySelector('.src').textContent, `任务标题 · ${REL_PATH} 第 13 行`);
  assert.equal(boxes[0].querySelector('.quote').textContent, '「- [ ] 2 第二（依赖 1；可与 3 并行）」');
  assert.equal(boxes[1].querySelector('.src').textContent, `任务标题 · ${REL_PATH} 第 13 行`, '并行关系也带来源');
  assert.equal(boxes[2].querySelector('.src').textContent, `前置条件表 · ${REL_PATH} 第 8 行`);
  assert.deepEqual(texts(drawerOf('rel#3')[1].querySelectorAll('.rel').map((b) => b.querySelector('b'))),
    ['依赖 1', '依赖 99（找不到）', '可并行 2', '外部阻塞 P1']);
  assert.equal(drawerOf('rel#4')[1].querySelectorAll('.rel').length, 1);
});

test('正文按 Markdown 显示：先请求原文，读到后只取任务行之后到正文末行；只有一行的任务不请求', () => {
  const asked = [];
  const state = relState('rel#2', { need: (docId) => asked.push(docId) });
  const body = (aside) => nextEl(aside.querySelectorAll('h3').find((x) => x.textContent === '正文'));
  assert.equal(body(drawerOf('rel#2', state)[1]).textContent, '正在读取原文…');
  assert.deepEqual(asked, ['rel']);

  state.texts.set('rel', { lines: REL_LINES });
  const md = body(drawerOf('rel#2', state)[1]);
  assert.equal(md.className, 'md');
  assert.deepEqual(texts(md.querySelectorAll('li')), ['这是 2 的正文', '<b>正文</b>第二行此处未按 Markdown 渲染']);
  assert.equal(md.querySelectorAll('b').length, 0, '原文里的 HTML 标签照字面显示，不变成节点，并标明未渲染（N12）');

  state.texts.set('rel', { error: '文档 x 已不存在' });
  assert.equal(body(drawerOf('rel#2', state)[1]).textContent, '原文读取失败：文档 x 已不存在');

  const asked3 = [];
  assert.match(body(drawerOf('rel#3', relState('rel#3', { need: (d) => asked3.push(d) }))[1]).textContent, /只有一行/);
  assert.deepEqual(asked3, []);
});

test('查看原文：抽屉内纯文本 + 行号，任务行高亮、任务区间淡底；关系来源的「第 N 行」跳到该行；可收起', () => {
  const state = relState('rel#2');
  state.texts.set('rel', { lines: REL_LINES });
  const aside = drawerOf('rel#2', state)[1];
  aside.querySelectorAll('button').find((b) => b.textContent === '查看原文').dispatch('click');
  assert.deepEqual(texts(aside.querySelectorAll('h3')), ['正文', '关系来源', 'PR', 'AI 会话', '甘特时间', `原文 · ${REL_PATH}收起`]);
  const lines = aside.querySelectorAll('.ln');
  assert.equal(lines.length, REL_LINES.length);
  assert.deepEqual(texts(lines[12].children), ['13', '- [ ] 2 第二（依赖 1；可与 3 并行）']);
  assert.deepEqual(aside.querySelectorAll('.target').map((l) => l.querySelector('.no').textContent), ['13']);
  assert.deepEqual(aside.querySelectorAll('.hl').map((l) => l.querySelector('.no').textContent), ['13', '14', '15']);

  aside.querySelectorAll('button').find((b) => b.textContent === '第 8 行').dispatch('click');
  assert.deepEqual(aside.querySelectorAll('.target').map((l) => l.querySelector('.no').textContent), ['8']);

  aside.querySelectorAll('button').find((b) => b.textContent === '收起').dispatch('click');
  assert.equal(aside.querySelector('.srcview'), null);
  assert.equal(state.viewer, null);
});

test('抽屉关闭：✕ 与遮罩都去掉地址里的 focus=；整页在地址带 focus= 时才叠加抽屉，任务不存在不画', () => {
  globalThis.location = { hash: '#/overview?project=demo&focus=rel%233' };
  const [scrim, aside] = drawerOf('rel#3');
  aside.querySelector('button[title=关闭（Esc）]').dispatch('click');
  assert.equal(parseHash(location.hash).focus, null);
  location.hash = '#/overview?project=demo&focus=rel%233';
  scrim.dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'overview', project: 'demo', focus: null, line: null });

  assert.deepEqual(drawerOf('rel#404'), []);
  const whole = (focus) => {
    const root = document.createElement('div');
    root.append(...renderPage({ list: LIST, projectId: 'demo', board: relBoard(), state: relState(focus) }));
    return root;
  };
  assert.equal(whole(null).querySelector('aside'), null);
  assert.ok(whole('rel#2').querySelector('aside.drawer'));
  assert.ok(whole('rel#2').querySelector('#v-overview'), '抽屉叠在总览之上');
});

// ---------- 任务 2.6：下一步视图 ----------

const NEXT = `# 下一步演示

## 前置条件

| 编号 | 事项 | 阻塞 |
|---|---|---|
| P1 | **提供 sandbox 访问**（项目 ref、迁移权限） | 5 |
| P4 | 措辞 | 不阻塞 |

## 里程碑 M1：一

- [x] 1 地基
- [ ] 2 甲（依赖 1；可与 3 并行）
- [ ] 3 乙（依赖 1）
- [ ] 4 丙（依赖 1）
- [~] 6 正在做
- [ ] 7 等 6（依赖 6）
- [ ] 5 要 sandbox
- [ ] 8 等 5（依赖 5）
- [ ] 9 等 8（依赖 8）
- [ ] 10 等 4（依赖 4）
`;
const nextBoard = () => computeBoard([planDoc('nx', NEXT)], [], [], [], {}, { id: 'demo' }, NOW);
const colOf = (root, i) => root.querySelectorAll('.col')[i];
const cardLine = (tk) => [tk.querySelector('.top').textContent, tk.querySelector('.tt').textContent, ...texts(tk.querySelectorAll('.why'))];

test('下一步：四栏标题、计数与提示语同 UI 稿', () => {
  const root = renderNext(nextBoard(), relState(null, { view: 'next' }));
  assert.equal(root.getAttribute('id'), 'v-next');
  const cols = root.querySelector('.cols').children;
  assert.deepEqual(cols.map((c) => c.querySelector('h2').textContent),
    ['▶ 可开工3', '⏳ 即将可开工1', '⛔ 被阻塞4', '🙋 等我处理1']);
  assert.deepEqual(texts(cols.map((c) => c.querySelector('.hint'))), [
    '前置任务均已确认完成。同一个框里的任务可以并行做。',
    '前置任务已经在做或有 PR 了，全部确认完成后才能开工。',
    '外部条件或前置任务还没开始。',
    '只有你能推进的事。',
  ]);
  for (const hint of texts(cols.map((c) => c.querySelector('.hint')))) assert.ok(MOCK.includes(hint), `提示语出自 UI 稿：${hint}`);
  assert.equal(cols[3].querySelector('.count').className, 'count warn');
});

test('下一步 · 可开工：同一批渲染在一个虚线框里，批号按显示顺序', () => {
  const col = colOf(renderNext(nextBoard(), relState(null)), 0);
  const batches = col.querySelectorAll('.batch');
  assert.deepEqual(batches.map((b) => [b.querySelector('.bl').textContent, b.querySelectorAll('.tk').map((t) => t.querySelector('.tt').textContent)]),
    [['第 1 批 · 可并行', ['甲（依赖 1；可与 3 并行）', '乙（依赖 1）']], ['第 2 批', ['丙（依赖 1）']]]);
  assert.deepEqual(cardLine(batches[0].querySelector('.tk')), ['○未开始nx · 2', '甲（依赖 1；可与 3 并行）', '依赖已满足：1']);
});

test('下一步 · 即将可开工写「在等：」，被阻塞列外部前置（红字）与卡住的前置及其状态', () => {
  const root = renderNext(nextBoard(), relState(null));
  assert.deepEqual(colOf(root, 1).querySelectorAll('.tk').map(cardLine), [['○未开始nx · 7', '等 6（依赖 6）', '在等：6 进行中']]);
  const blocked = colOf(root, 2).querySelectorAll('.tk');
  assert.deepEqual(blocked.map(cardLine), [
    ['○未开始nx · 5', '要 sandbox', '外部前置：P1'],
    ['○未开始nx · 8', '等 5（依赖 5）', '在等：5 未开始'],
    ['○未开始nx · 9', '等 8（依赖 8）', '在等：8 未开始'],
    ['○未开始nx · 10', '等 4（依赖 4）', '在等：4 未开始'],
  ]);
  assert.equal(blocked[0].querySelector('.why').className, 'why red');
  assert.equal(blocked[1].querySelector('.why').className, 'why');
});

test('下一步 · 等我处理：未解除的外部前置卡片列出直接卡住与连带阻塞的任务；不阻塞 / 已解除的不列', () => {
  const cards = colOf(renderNext(nextBoard(), relState(null)), 3).querySelectorAll('.tk');
  assert.deepEqual(cards.map(cardLine), [['⛔ P1nx', '提供 sandbox 访问', '卡住 5，并连带 8、9']]);
  assert.equal(cards[0].querySelector('.blk').textContent, '⛔ P1');
  assert.equal(cards[0].querySelector('.tt').getAttribute('title'), '提供 sandbox 访问（项目 ref、迁移权限）');
});

test('下一步 · collab 实物：13、14、15.1、16、17 全部被阻塞，可开工为空；P1 卡住 13、14 并连带 15.1、16、17', () => {
  const text = read('./fixtures/collab-m0-space-run.tasks.md');
  const board = computeBoard([planDoc('collab', text)], [], [], [], {}, { id: 'c' }, NOW);
  const root = renderNext(board, relState(null));
  assert.equal(colOf(root, 0).querySelectorAll('.tk').length, 0);
  assert.equal(colOf(root, 0).querySelector('.muted').textContent, '暂无');
  assert.deepEqual(colOf(root, 2).querySelectorAll('.tk').map((t) => t.querySelector('.top').children[1].textContent),
    ['collab · 13', 'collab · 14', 'collab · 15.1', 'collab · 16', 'collab · 17']);
  assert.deepEqual(colOf(root, 3).querySelectorAll('.tk').map((t) => [t.querySelector('.blk').textContent, t.querySelector('.why').textContent]),
    [['⛔ P1', '卡住 13、14，并连带 15.1、16、17'], ['⛔ P5', '卡住 13，并连带 15.1、16、17']]);
});

test('下一步：点卡片开任务抽屉（地址加 focus=，停在下一步）；外部前置卡片开第一个直接卡住的任务', () => {
  globalThis.location = { hash: '' };
  const root = renderNext(nextBoard(), relState(null, { view: 'next' }));
  colOf(root, 1).querySelector('.tk').dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'next', project: 'demo', focus: 'nx#7', line: null });
  colOf(root, 3).querySelector('.tk').dispatch('click');
  assert.equal(parseHash(location.hash).focus, 'nx#5');
});

test('总览「可开工」数字卡：数字 = 可开工任务数，点击进下一步；整页按 view 渲染下一步并可叠加抽屉', () => {
  globalThis.location = { hash: '' };
  const board = nextBoard();
  const card = renderOverview(board, relState(null)).querySelectorAll('.stat')[1];
  assert.equal(card.querySelector('.n').textContent, '3');
  assert.equal(card.querySelector('.sub').textContent, '依赖都满足了');
  assert.ok(!card.classList.contains('nolink'));
  card.dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'next', project: 'demo', focus: null, line: null });

  const root = document.createElement('div');
  root.append(...renderPage({ list: LIST, projectId: 'demo', board, state: relState('nx#7', { view: 'next' }) }));
  assert.ok(root.querySelector('#v-next'));
  assert.equal(root.querySelector('#v-overview'), null);
  assert.equal(root.querySelector('nav').querySelector('button.on').getAttribute('data-v'), 'next');
  assert.ok(root.querySelector('aside.drawer'));
});

// ---------- 任务 2.7：关系图 ----------

const GRAPH = `# 图演示

## 里程碑 M1：一

- [x] 1 地基
- [ ] 2 甲（依赖 1；可与 3 并行）
- [ ] 3 乙
- [ ] 4 丙（依赖 3）
- [ ] 5 丁（依赖 2）
- [ ] 6 戊（依赖 4、5）
- [ ] 7 环甲（依赖 8）
- [ ] 8 环乙（依赖 7）
- [x] ~~9 作废~~ **【作废】**
`;
const graphBoard = () => computeBoard([planDoc('g', GRAPH), planDoc('rel', REL)], [], [], [], {}, { id: 'demo' }, NOW);
const graphOf = (state = relState(null, { view: 'graph' })) => renderGraph(graphBoard(), state);
const gnodes = (root) => root.querySelectorAll('.gnode');
const gnode = (root, num) => gnodes(root).find((n) => n.getAttribute('data-id') === `g#${num}`);
const ids = (list) => list.map((k) => k.replace(/^g#/, ''));
const nodeY = (n) => Number(/,(\d+)\)/.exec(n.getAttribute('transform'))[1]);

test('关系图：导航「关系图」排在甘特图之后；#/graph 渲染关系图视图，地址带 focus= 时叠加抽屉', () => {
  assert.deepEqual(VIEWS.map((v) => v.id).slice(0, 3), ['overview', 'gantt', 'graph']);
  assert.equal(parseHash('#/graph?project=demo').view, 'graph');
  const root = document.createElement('div');
  root.append(...renderPage({ list: LIST, projectId: 'demo', board: graphBoard(), state: relState('g#4', { view: 'graph' }) }));
  assert.ok(root.querySelector('#v-graph'));
  assert.equal(root.querySelector('#v-overview'), null);
  assert.ok(root.querySelector('aside.drawer'));
});

test('关系图：文档下拉、图例四项、说明文字；「只看未完成」「淡化已完成」默认勾选', () => {
  const state = relState(null, { view: 'graph' });
  const root = graphOf(state);
  const docSel = combo(root, '文档');
  assert.deepEqual(optTexts(docSel), ['g', 'rel']);
  assert.deepEqual(chosen(docSel), ['g'], '缺省选第一份文档');
  assert.deepEqual(optsOf(docSel).map((o) => o.getAttribute('title')), graphBoard().docs.map((d) => d.title), '文档标题放悬停提示');
  assert.deepEqual(texts(root.querySelector('.legend').children.filter((c) => c.tagName === 'SPAN')).filter((s) => s.trim()).map((s) => s.trim()),
    ['依赖（先后顺序）', '可并行', '被阻塞 / 无法排期', '依赖成环']);
  assert.match(root.querySelector('.note').textContent, /^从左往右读/);
  const boxes = root.querySelectorAll('input[type=checkbox]');
  assert.deepEqual(boxes.map((b) => [b.parentNode.textContent.trim(), b.hasAttribute('checked')]),
    [['只看未完成', true], ['淡化已完成', true]]);
  assert.equal(state.graphOpenOnly, true);
  assert.equal(state.graphFade, true);

  choose(combo(root, '文档'), 'rel');
  assert.equal(state.graphDoc, 'rel');
  assert.deepEqual(chosen(combo(root, '文档')), ['rel']);
  assert.ok(root.querySelector('.gnode[data-id=rel#2]'), '换文档后只重画本视图');
});

test('关系图：「只看未完成」隐藏已完成节点及指向它们的线；取消后显示并按「淡化已完成」变淡；作废任务不画', () => {
  const root = graphOf();
  const edgeEnds = () => root.querySelectorAll('.gedge').flatMap((e) => [e.getAttribute('data-a'), e.getAttribute('data-b')]);
  assert.equal(gnode(root, '1'), undefined);
  assert.ok(!edgeEnds().includes('g#1'));
  assert.equal(gnode(root, '9'), undefined, '作废任务不画');

  const [openOnly] = root.querySelectorAll('input[type=checkbox]');
  openOnly.checked = false;
  openOnly.dispatch('change');
  assert.ok(gnode(root, '1').classList.contains('done'));
  assert.ok(root.querySelector('.gedge[data-a=g#1][data-b=g#2]'), '显示已完成后画出 1 → 2');
  const fade = root.querySelectorAll('input[type=checkbox]')[1]; // 重画后是新节点
  fade.checked = false;
  fade.dispatch('change');
  assert.ok(!gnode(root, '1').classList.contains('done'));
  assert.equal(root.querySelectorAll('input[type=checkbox]')[0].hasAttribute('checked'), false, '重画后开关保持');
});

test('关系图层级：列 = 最长前置链；列内重心法排序；列头「第 1 层 · 无前置」', () => {
  // 最长链决定列：c 同时依赖 a（第 1 层）与 b（第 2 层）→ 第 3 层
  const { layer, cols } = layoutGraph([
    { id: 'a', dep: [] }, { id: 'b', dep: ['a'] }, { id: 'c', dep: ['a', 'b'] }, { id: 'd', dep: ['x'] },
  ]);
  assert.deepEqual(Object.fromEntries(layer), { a: 0, b: 1, c: 2, d: 0 }, '图外的前置（x）不算');
  assert.deepEqual(cols, [['a', 'd'], ['b'], ['c']]);

  const root = graphOf();
  // 1 已隐藏 → 2 没有图内前置，与 3 同在第 1 层；第 2 层文档顺序是 4、5、8，重心法把 5（前置 2 排第 0）提到 4（前置 3 排第 1）前面
  const col = (xs) => ids(gnodes(root).filter((n) => xs.includes(n.getAttribute('data-id').slice(2)))
    .sort((a, b) => nodeY(a) - nodeY(b)).map((n) => n.getAttribute('data-id')));
  assert.deepEqual(col(['2', '3']), ['2', '3']);
  assert.deepEqual(col(['4', '5', '8']), ['5', '4', '8']);
  assert.deepEqual(col(['6', '7']), ['6', '7']);
  const x = (num) => Number(/\((\d+),/.exec(gnode(root, num).getAttribute('transform'))[1]);
  assert.ok(x('2') === x('3') && x('3') < x('4') && x('4') === x('5') && x('5') === x('8') && x('8') < x('6') && x('6') === x('7'));
  assert.deepEqual(texts(root.querySelectorAll('.laycol')), ['第 1 层 · 无前置', '第 2 层', '第 3 层']);
});

test('关系图节点：状态色条 + 编号 + 图标 + 截断标题 + 第二行；成环红粗框、外部阻塞红虚框与红字', () => {
  const root = graphOf();
  const n6 = gnode(root, '6');
  assert.ok(n6.querySelector('rect.sbar.todo'));
  assert.equal(n6.querySelector('tspan.gid').textContent, '6');
  assert.equal(n6.querySelectorAll('text')[0].textContent, '6  ○ 戊（依赖 4、5）');
  assert.equal(n6.querySelector('text.gx').textContent, '未开始');
  assert.equal(n6.querySelector('title').textContent, '6 戊（依赖 4、5） · 未开始');
  assert.ok(gnode(root, '7').classList.contains('cyc') && gnode(root, '8').classList.contains('cyc'));
  assert.ok(!n6.classList.contains('cyc'));

  const state = relState(null, { view: 'graph', graphDoc: 'rel' });
  const rel = renderGraph(graphBoard(), state).querySelector('.gnode[data-id=rel#3]');
  assert.ok(rel.classList.contains('blocked'));
  assert.equal(rel.querySelector('text.gx').textContent, '⛔ P1');
  assert.ok(rel.querySelector('text.gx').classList.contains('red'));
  assert.match(rel.querySelectorAll('text')[0].textContent, /第三（依赖 1、99）$/);
});

test('关系图连线：依赖为带箭头的曲线；并行为虚线，同列从右侧绕弧', () => {
  const root = graphOf();
  const dep = root.querySelector('.gedge[data-a=g#3][data-b=g#4]');
  assert.equal(dep.getAttribute('marker-end'), 'url(#garr)');
  assert.match(dep.getAttribute('d'), /^M[\d.]+ [\d.]+ C/);
  const par = root.querySelector('svg.gsvg').querySelectorAll('.gedge.par'); // 图例里也有一条示意虚线，只数图内的
  assert.equal(par.length, 1, '并行两端各写一次也只画一条');
  assert.equal(par[0].getAttribute('marker-end'), null);
  assert.match(par[0].getAttribute('d'), / C/, '2、3 同列 → 绕弧');
});

test('关系图悬停：前置蓝（pre）、后续灰（post）、可并行绿（parhl），其余变淡；移开清除；点节点开抽屉', () => {
  globalThis.location = { hash: '' };
  const root = graphOf();
  gnode(root, '4').dispatch('mouseenter');
  const cls = (num) => ['sel', 'pre', 'post', 'parhl', 'fade'].find((c) => gnode(root, num).classList.contains(c));
  assert.deepEqual(['4', '3', '6', '2', '5'].map(cls), ['sel', 'pre', 'post', 'fade', 'fade']);
  assert.ok(root.querySelector('.gedge[data-a=g#3][data-b=g#4]').classList.contains('on'));
  assert.ok(root.querySelector('.gedge[data-a=g#2][data-b=g#5]').classList.contains('fade'));
  gnode(root, '2').dispatch('mouseenter');
  assert.equal(cls('3'), 'parhl');
  gnode(root, '2').dispatch('mouseleave');
  assert.equal(root.querySelectorAll('.fade').length, 0);

  gnode(root, '5').dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'graph', project: 'demo', focus: 'g#5', line: null });
});

// ---------- 任务 3.6：PR 标签、PR 详情、分支线切换、数字卡、顶栏与降级横幅 ----------

import { PR_UI, prKind, degradedBanners, scopeBanner } from '../web/app.mjs';
import { normalizePr } from '../src/github.mjs';

// 个人版按 docFilter 归文档；协作版不配 docFilter（PR 可关联任何文档，用来演示「分支线不同才加前缀」），
// 它的文档靠 workspaceId = 分支线 id（从该分支线的独立工作区读出）归线。
const LINES = [
  { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
  { id: 'collab', name: '协作版', base: 'v2/collab' },
];
const PR_DOC = `# PR 演示

- [ ] 1 草稿中
- [ ] 2 等合并
- [ ] 3 已合并待同步
- [x] 4 已合并
- [ ] 5 关闭的
- [ ] 6 等 3（依赖 3）
- [ ] 7 跨分支线
`;
const mkPr = (number, over = {}) => ({ number, title: `任务 ${number - 10}`, body: '', url: `https://github.com/acme/demo/pull/${number}`,
  state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: `b${number}`, labels: [], createdAt: '2026-09-20T08:00:00Z',
  updatedAt: '2026-09-25T08:00:00Z', readyAt: null, mergedAt: null, closedAt: null, mergeCommit: null, ...over });
const DEMO_PRS = [
  mkPr(11, { isDraft: true, createdAt: '2026-09-24T08:00:00Z' }),
  mkPr(12, { readyAt: '2026-09-19T08:00:00Z' }),
  mkPr(13, { state: 'MERGED', mergedAt: '2026-09-25T12:00:00Z', mergeCommit: 'b'.repeat(40) }),
  mkPr(14, { state: 'MERGED', mergedAt: '2026-09-22T12:00:00Z', mergeCommit: 'c'.repeat(40) }),
  mkPr(15, { state: 'CLOSED', closedAt: '2026-09-23T12:00:00Z' }),
  mkPr(16, { isDraft: true, title: '[V2] 任务 7', baseRefName: 'v2/collab', createdAt: '2026-09-25T08:00:00Z' }),
];
function prDemoBoard() {
  const docs = [planDoc('pr-demo', PR_DOC), planDoc('collab-demo', '# 协作\n\n- [ ] 1 协作任务\n', { workspaceId: 'collab' })];
  const sync = { 13: { state: 'pending', reason: null }, 14: { state: 'synced', reason: null } };
  const board = computeBoard(docs, DEMO_PRS, [], [], sync, { id: 'demo', repo: { path: '/ws/repo' }, branchLines: LINES }, NOW);
  board.workspaces = [{ id: 'repo', path: '/ws/repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null }];
  board.freshness.docsReadAt = '2026-09-26T07:59:57.000Z';
  board.freshness.github.lastSuccessAt = '2026-09-26T07:58:00.000Z';
  return board;
}
const prState = (extra = {}) => relState(null, { lines: LINES, ...extra });
const LINE_LIST = { errors: [], warnings: [], projects: [{ id: 'demo', name: '演示', errors: [], refreshError: null, branchLines: LINES }] };
const linePage = (state, board = prDemoBoard(), list = LINE_LIST) => {
  const root = document.createElement('div');
  root.append(...renderPage({ list, projectId: 'demo', board, state }));
  return root;
};
const tagsOfRow = (root, num) => rowOf(root, num).querySelectorAll('a.pr');

test('UI 稿对照：PR 标签五种状态的文字与 UI 稿 prLabel 一致，各有对应样式 class', () => {
  const m = /const prLabel = n => \{const p=PRS\[n\];return \{(.*?)\}\[p\.st\];\};/.exec(MOCK);
  assert.ok(m, 'UI 稿里的 prLabel');
  const mock = Object.fromEntries([...m[1].matchAll(/(\w+):'([^']+)'/g)].map(([, k, v]) => [k, v]));
  assert.deepEqual(PR_UI, mock);
  const css = read('../web/style.css');
  for (const k of Object.keys(PR_UI)) assert.match(css, new RegExp(`\\.pr\\.${k}\\{`), k);
  assert.deepEqual(DEMO_PRS.map((p) => prKind({ ...p, localSync: p.number === 13 ? 'pending' : null })),
    ['draft', 'ready', 'unsynced', 'merged', 'closed', 'draft']);
});

test('任务行尾 PR 标签：#号 + 状态文字、class 随状态；分支线相同省略前缀、不同才加；悬停写标题与分支线；无 PR 不显示', () => {
  const root = renderOverview(prDemoBoard(), prState());
  const tag = (num) => tagsOfRow(root, num).map((a) => [a.className, a.textContent]);
  assert.deepEqual(tag('1'), [['pr draft', '#11 draft·等 review']]);
  assert.deepEqual(tag('2'), [['pr ready', '#12 ready·等合并']]);
  assert.deepEqual(tag('3'), [['pr unsynced', '#13 已合并·待同步本地']]);
  assert.deepEqual(tag('4'), [['pr merged', '#14 已合并']]);
  assert.deepEqual(tag('5'), [['pr closed', '#15 已关闭']]);
  assert.deepEqual(tag('7'), [['pr draft', '协作版 #16 draft·等 review']], '协作版 PR 挂在个人版文档上，加分支线前缀');
  assert.deepEqual(tag('6'), [], '没有 PR 的任务不显示 PR 标签');
  assert.equal(tagsOfRow(root, '1')[0].getAttribute('title'), '任务 1\n分支线：个人版');
  // 待同步：状态仍是 ◕ 等待合并，标签是虚线的「已合并·待同步本地」
  assert.equal(rowOf(root, '3').querySelector('.st').textContent, '◕等待合并');
  // 顺序：⛔ 之后、仅文档确认 / ⚠ 之前（UI 稿 tagsOf）；3 的 ⚠ 是冲突 a（PR 已合并但复选框未勾）
  assert.deepEqual(rowOf(root, '3').querySelector('.tags').children.map((c) => c.className), ['pr unsynced', 'flag']);
});

test('点 PR 标签：地址 focus=#号（打开 PR 详情），阻止冒泡不触发任务行；任务抽屉头部与「PR」区也挂标签', () => {
  const root = renderOverview(prDemoBoard(), prState({ line: null }));
  const a = tagsOfRow(root, '3')[0];
  assert.deepEqual(parseHash(a.getAttribute('href')), { view: 'overview', project: 'demo', focus: '#13', line: null });
  let stopped = false;
  a.listeners.click[0]({ stopPropagation: () => { stopped = true; } });
  assert.ok(stopped);

  const [, aside] = renderDrawer(prDemoBoard(), prState({ focus: 'pr-demo#7' }), () => {});
  assert.deepEqual(texts(aside.querySelector('.hdtags').querySelectorAll('a.pr')), ['协作版 #16 draft·等 review']);
  assert.deepEqual(texts(aside.querySelectorAll('h3')), ['正文', '关系来源', 'PR', 'AI 会话', '甘特时间']);
  const box = nextEl(aside.querySelectorAll('h3').find((x) => x.textContent === 'PR'));
  assert.equal(box.querySelector('a.pr').textContent, '协作版 #16 draft·等 review', '抽屉里的 PR 框总写分支线（需求 5.5）');
  assert.equal(box.querySelector('.prt').textContent, '[V2] 任务 7');
  assert.equal(box.querySelector('.src').textContent, '来源：PR 标题里的「任务 7」 · 解除关联', '任务 4.2：同 UI 稿，来源后接「解除关联」');
  const [, none] = renderDrawer(prDemoBoard(), prState({ focus: 'pr-demo#6' }), () => {});
  assert.equal(nextEl(none.querySelectorAll('h3').find((x) => x.textContent === 'PR')).textContent, '还没有 PR。');
});

test('PR 详情抽屉：#号 · 分支线、标题、head → base、状态、时间线、本地同步、GitHub 链接；关联任务带来源与原文，点任务回到任务抽屉', () => {
  globalThis.location = { hash: '' };
  const state = prState({ focus: '#13' });
  const [scrim, aside] = renderDrawer(prDemoBoard(), state, () => { location.hash = hashFor(state.view, state.project); });
  assert.equal(aside.getAttribute('aria-label'), 'PR 详情');
  assert.equal(aside.querySelector('.crumb').textContent, '#13 · 个人版');
  assert.equal(aside.querySelector('h2').textContent, '任务 3');
  assert.equal(aside.querySelector('.hdtags').textContent, '#13 已合并·待同步本地');
  const kv = Object.fromEntries(kvPairs(aside).map(([k, dd]) => [k, dd]));
  assert.deepEqual(Object.keys(kv), ['分支', '状态', '时间线', '本地同步', 'GitHub']);
  assert.equal(kv['分支'].textContent, 'b13 → main');
  assert.equal(kv['状态'].textContent, '已合并·待同步本地');
  assert.match(kv['时间线'].textContent, /^创建 09-2\d \d\d:00合并 09-2\d \d\d:00$/);
  assert.match(kv['本地同步'].textContent, /本地 main 还没有这个合并提交/);
  assert.equal(kv['GitHub'].querySelector('a').getAttribute('href'), 'https://github.com/acme/demo/pull/13');
  assert.equal(kv['GitHub'].querySelector('a').getAttribute('rel'), 'noreferrer');
  const box = aside.querySelector('.box');
  assert.equal(box.querySelector('.src').textContent, '来源：PR 标题里的「任务 3」');
  assert.equal(box.querySelector('.quote').textContent, '「任务 3」');
  assert.equal(box.querySelector('.prtask').textContent, 'pr-demo · 3 ◕等待合并 已合并待同步');
  assert.equal(parseHash(box.querySelector('.prtask').querySelector('a').getAttribute('href')).focus, 'pr-demo#3', 'PR → 任务定位');
  scrim.dispatch('click');
  assert.equal(parseHash(location.hash).focus, null);

  // 关闭的 PR 时间线写关闭时间；没关联任务的 PR 写明原因；不存在的 PR 号不画
  const [, closed] = renderDrawer(prDemoBoard(), prState({ focus: '#15' }), () => {});
  assert.match(closed.querySelector('dl').textContent, /关闭 09-2\d/);
  assert.deepEqual(renderDrawer(prDemoBoard(), prState({ focus: '#99' }), () => {}), []);
});

test('PR 详情 · collab 实物：#360 标题里的 M0-c 展开为该里程碑全部任务，一框列出；任务抽屉「PR」框写同一来源', () => {
  const PRS = JSON.parse(read('./fixtures/prs.json')).map(normalizePr);
  const WIDGET = { id: 'widget', repo: { path: '/ws/repo' }, branchLines: [
    { id: 'personal', name: '个人版', base: 'main', docFilter: '^(?!collab-)' },
    { id: 'collab', name: '协作版', base: 'v2/collab', titlePrefix: '[V2]', labels: ['collab-v2'], docFilter: '^collab-' }] };
  const board = computeBoard([planDoc('collab-m0-space-run', read('./fixtures/collab-m0-space-run.tasks.md'))], PRS, [], [],
    { 360: { state: 'synced', reason: null }, 365: { state: 'pending', reason: null } }, WIDGET, NOW);
  const state = relState('#360', { lines: WIDGET.branchLines });
  const [, aside] = renderDrawer(board, state, () => {});
  assert.equal(aside.querySelector('.crumb').textContent, '#360 · 协作版');
  const boxes = aside.querySelectorAll('.box');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].querySelector('.src').textContent, '来源：PR 标题里的「M0-c」（里程碑代号，展开为该里程碑全部任务）');
  assert.equal(boxes[0].querySelectorAll('.prtask').length, 22);

  const [, task] = renderDrawer(board, { ...state, focus: 'collab-m0-space-run#3' }, () => {});
  const prBox = nextEl(task.querySelectorAll('h3').find((x) => x.textContent === 'PR'));
  assert.equal(prBox.querySelector('.src').textContent, '来源：PR 标题里的「M0-c」（里程碑代号，展开为该里程碑全部任务） · 解除关联');
  const root = renderOverview(board, state);
  assert.deepEqual(texts(tagsOfRow(root, '3')), ['#360 已合并'], '同一分支线：不加前缀');
  assert.deepEqual(texts(tagsOfRow(root, '11')), ['#365 已合并·待同步本地']);
  assert.deepEqual(texts(tagsOfRow(root, '15.2')), ['#372 draft·等 review']);
});

test('总览数字卡：六张齐全，标题与说明同 UI 稿；等待合并含待同步数；待同步卡点进下一步', () => {
  globalThis.location = { hash: '' };
  const stats = /<div class="stats">([\s\S]*?)<div class="two">/.exec(MOCK)[1];
  const S = Object.fromEntries([.../const S\s*=\s*\{(.*?)\};/.exec(MOCK)[1].matchAll(/(\w+):\['([^']+)'/g)].map(([, k, icon]) => [k, icon]));
  const mockLabels = [...stats.matchAll(/<div class="l">(.*?)<\/div>/g)].map(([, l]) => l.replace(/\$\{S\.(\w+)\[0\]\}/, (_, k) => S[k]));
  const cards = renderOverview(prDemoBoard(), prState()).querySelectorAll('.stat');
  assert.equal(cards.length, 6);
  assert.deepEqual(texts(cards.map((c) => c.querySelector('.l'))), mockLabels);
  const line = (c) => [c.querySelector('.n').textContent, c.querySelector('.sub').textContent];
  assert.deepEqual(cards.slice(3).map(line), [
    ['2', 'draft PR'], ['2', 'ready PR · 含 1 个已合并待同步'], ['1', 'GitHub 已合并，本地没 pull'],
  ]);
  const mockSubs = [...stats.matchAll(/<div class="sub">(.*?)<\/div>/g)].map(([, x]) => x.replace('${unsynced}', '1'));
  for (const c of cards.slice(3)) assert.ok(mockSubs.includes(c.querySelector('.sub').textContent), '说明语出自 UI 稿');
  assert.deepEqual(cards.slice(3).map((c) => c.querySelector('.n').className), ['n review', 'n merge', 'n warn']);
  cards[5].dispatch('click');
  assert.equal(parseHash(location.hash).view, 'next');
});

test('顶栏分支线分段按钮：全部 + 各分支线，选中写入地址 line=（保留 focus=）；切换后统计与任务树随之重算', () => {
  globalThis.location = { hash: '' };
  const all = linePage(prState({ focus: 'pr-demo#1' }));
  const seg = all.querySelector('.seg');
  assert.equal(seg.getAttribute('aria-label'), '分支线');
  assert.deepEqual(seg.children.map((b) => [b.getAttribute('data-line'), b.textContent, b.className]),
    [['all', '全部', 'on'], ['personal', '个人版', ''], ['collab', '协作版', '']]);
  seg.children[2].dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'overview', project: 'demo', focus: 'pr-demo#1', line: 'collab' });
  assert.equal(parseHash(hashFor('next', 'demo', null, 'collab')).line, 'collab');

  const sub = (root) => root.querySelectorAll('.stat')[0].querySelector('.sub').textContent;
  assert.equal(sub(all), '1 / 8 个任务已合并完成');
  const collab = linePage(prState({ line: 'collab' }));
  assert.equal(collab.querySelector('.seg').querySelector('button.on').textContent, '协作版');
  assert.equal(sub(collab), '0 / 1 个任务已合并完成');
  assert.deepEqual(texts(collab.querySelectorAll('.doc').map((d) => d.querySelector('.gname'))), ['collab-demo']);
  const personal = linePage(prState({ line: 'personal' }));
  assert.equal(sub(personal), '1 / 7 个任务已合并完成');
  assert.deepEqual(personal.querySelectorAll('.stat').slice(3).map((c) => c.querySelector('.n').textContent), ['2', '2', '1']);
  // 导航与抽屉关闭都保留 line=；不认识的分支线当「全部」
  personal.querySelector('nav').children[0].dispatch('click');
  assert.equal(parseHash(location.hash).line, 'personal');
  assert.equal(linePage(prState({ line: 'nope' })).querySelector('.seg').querySelector('button.on').textContent, '全部');
  assert.equal(linePage(prState(), prDemoBoard(), LIST).querySelector('.seg'), null, '没配分支线不显示');
});

test('顶栏：GitHub 最后成功拉取时间、「正在刷新」、「↻ 刷新」调 state.refresh', () => {
  const board = prDemoBoard();
  let calls = 0;
  const idle = linePage(prState({ refresh: () => { calls++; } }), board);
  assert.deepEqual(texts(idle.querySelector('.meta').children).slice(1), ['文档 3 秒前', 'AI 会话 未读取', 'GitHub 2 分钟前']);
  const btn = idle.querySelector('button[title=请求重读文档与 GitHub；会话按周期检查]');
  assert.equal(btn.textContent, '↻ 刷新');
  btn.dispatch('click');
  assert.equal(calls, 1);
  board.freshness.refreshing = { docs: false, sessions: false, github: true };
  assert.equal(linePage(prState(), board).querySelector('.meta').querySelector('.busy').textContent, '正在刷新…');
});

test('降级横幅：未包含 PR 信息、来自缓存、额度将尽与恢复时间；非回环监听警告', () => {
  const now = NOW.getTime();
  const b = prDemoBoard();
  assert.deepEqual(degradedBanners(b, now), []);
  b.degraded.noPrData = true;
  b.freshness.refreshing = { docs: false, sessions: false, github: true };
  assert.deepEqual(degradedBanners(b, now), ['未包含 PR 信息：还没成功拉到过 GitHub 数据，状态只按文档与 AI 会话推算（正在拉取）']);

  const c = prDemoBoard();
  Object.assign(c.degraded, { prFromCache: true });
  Object.assign(c.freshness.github, { lastSuccessAt: '2026-09-26T06:30:00Z', error: 'unreachable', message: 'GitHub 不可达' });
  assert.match(degradedBanners(c, now)[0], /^GitHub 数据来自 \d\d-\d\d \d\d:30 的缓存（GitHub 不可达）$/);

  const r = prDemoBoard();
  r.freshness.github.pausedUntil = '2026-09-26T08:45:00Z';
  r.freshness.github.scopeHint = '令牌带写权限（repo），devboard 只读使用';
  assert.deepEqual(degradedBanners(r, now).map((x) => x.replace(/\d\d-\d\d \d\d:45/, 'T')),
    ['GitHub 额度将尽，自动刷新已暂停，预计 T 恢复；期间使用缓存数据'], '令牌权限提示不在这里，见 scopeBanner');
  r.freshness.github.pausedUntil = '2026-09-26T07:00:00Z';
  assert.equal(degradedBanners(r, now).length, 0, '恢复时间已过就不再提示暂停');

  // 整页：配置警告（非回环监听）+ 降级横幅一起放在主区顶部，看板照常显示
  const list = { ...LINE_LIST, warnings: ['server.host 是 0.0.0.0，不是回环地址'] };
  const root = linePage(prState(), b, list);
  assert.deepEqual(texts(root.querySelectorAll('.banner')), ['警告：server.host 是 0.0.0.0，不是回环地址', degradedBanners(b, now)[0]]);
  assert.ok(root.querySelector('#v-overview'));
});

test('令牌权限提示（N4）：横幅带「知道了」，点后本浏览器不再显示同一文案；文案变了重新出现；诊断页照常显示', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    const b = prDemoBoard();
    assert.equal(scopeBanner(b), null, '没有提示就没有横幅');
    b.freshness.github.scopeHint = '令牌带写权限（repo），devboard 只读使用';
    const root = linePage(prState(), b);
    const banner = root.querySelectorAll('.banner').find((n) => n.textContent.startsWith('令牌权限提示：'));
    assert.equal(banner.textContent, '令牌权限提示：令牌带写权限（repo），devboard 只读使用 知道了');
    banner.querySelector('button').dispatch('click');
    assert.equal(banner.getAttribute('hidden'), '', '点了立即隐藏，不等重画');
    assert.equal(store.get('devboard:scope-hint-dismissed'), '令牌带写权限（repo），devboard 只读使用');
    assert.equal(texts(linePage(prState(), b).querySelectorAll('.banner')).some((t) => t.startsWith('令牌权限提示')), false, '重画后不再显示');
    b.freshness.github.scopeHint = '令牌带写权限（repo, workflow），devboard 只读使用';
    assert.ok(scopeBanner(b), '权限变了、文案不同就重新出现');
  } finally {
    delete globalThis.localStorage;
  }
});

test('下一步 · 等我处理：PR 卡片在外部前置之前——待同步「本地 pull 一下 <分支>」、ready「合并」、draft「review」，写分支线与已等多久；点卡片开 PR 详情', () => {
  globalThis.location = { hash: '' };
  const root = renderNext(prDemoBoard(), prState({ view: 'next' }));
  const cards = colOf(root, 3).querySelectorAll('.tk');
  assert.deepEqual(cards.map(cardLine), [
    ['#12 ready·等合并个人版', '合并 #12（等合并）', 'ready 已等 7 天'],
    ['#11 draft·等 review个人版', 'review #11（草稿中）', 'draft 已等 2 天'],
    ['#13 已合并·待同步本地个人版', '本地 pull 一下 main', `GitHub ${cardDay('2026-09-25T12:00:00Z')} 已合并；本地 main 还没有这个合并提交；任务 pr-demo#3 文档尚未勾选，仍须确认完整交付；6 须全部前置完成才会解锁。`],
    ['#16 draft·等 review协作版', 'review #16（跨分支线）', 'draft 已等 1 天'],
  ]);
  assert.equal(cards[2].querySelector('.tt').getAttribute('title'), '在 /ws/repo 拉取 main');
  // N17：docRef 分支线没有检出，待同步改让人 fetch，写明 docRef
  const fb = prDemoBoard();
  fb.waiting.find((w) => w.pr === 13).workspace.fetchRef = 'origin/next/x';
  const fcard = colOf(renderNext(fb, prState({ view: 'next' })), 3).querySelectorAll('.tk')[2].querySelector('.tt');
  assert.equal(fcard.textContent, '本地 fetch 一下 origin/next/x');
  assert.equal(fcard.getAttribute('title'), '在 /ws/repo 运行 git fetch，更新 origin/next/x（看板从这个 ref 读文档，不用切分支或 pull）');
  assert.equal(colOf(root, 3).querySelector('h2').textContent, '🙋 等我处理4');
  cards[2].dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'next', project: 'demo', focus: '#13', line: null });
  // 即将可开工写在等的 PR：6 在等 3，3 已合并待同步本地
  assert.deepEqual(colOf(root, 1).querySelectorAll('.tk').map(cardLine), [['○未开始pr-demo · 6', '等 3（依赖 3）', '在等：3 已合并·待同步本地 #13']]);
  // 选了分支线（整页按 line= 筛选）：只列该分支线的 PR
  const collab = linePage(prState({ view: 'next', line: 'collab' }));
  assert.deepEqual(colOf(collab, 3).querySelectorAll('.tk').map((t) => t.querySelector('.tt').textContent), ['review #16（[V2] 任务 7）'],
    '任务在另一条分支线的文档里、已被筛掉时，括号里改写 PR 标题');
  // 一个任务都没关联的 PR 标「未关联任务」（它不进总览的任务数字卡）
  const b = prDemoBoard();
  b.waiting.find((w) => w.pr === 11).tasks = [];
  const flags = colOf(renderNext(b, prState({ view: 'next' })), 3).querySelectorAll('.tk').map((t) => t.querySelector('.flag')?.textContent ?? null);
  assert.deepEqual(flags, [null, '未关联任务', null, null]);
});
const cardDay = (iso) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- 任务 6.5：诊断 ----------

import { renderDiag } from '../web/app.mjs';

// 在总览夹具上补 server 才填的诊断字段；PR 一个未关联（带引用问题）、一个已关联
function diagBoard() {
  const board = fixtureBoard();
  Object.assign(board.diagnostics, {
    config: { path: '/space/devboard/devboard.config.json', projects: 2, warnings: ['server.host 不是回环地址'] },
    sources: [{ message: '工作区 repo 的来源「ADR」读取失败：目录不存在 docs/adr' }],
    sessionSources: [{ source: 'claude-code', dir: '/home/me/.claude/projects', available: true, error: null, sessions: 5,
      unreadableFiles: [{ file: 'a/x.jsonl', error: 'EACCES' }], brokenLines: [{ file: 'a/y.jsonl', count: 3 }], messages: [] }],
    github: { at: '2026-09-26T07:58:00.000Z', requests: 2 },
  });
  board.diagnostics.sessions = { total: 5, linked: 2, unlinked: 3, aiOnlyMentions: 7 };
  board.freshness.github = { lastSuccessAt: '2026-09-26T07:58:00.000Z', error: null, message: null, detail: null,
    rate: { remaining: 4988, limit: 5000, resetAt: '2026-09-26T09:00:00Z' }, pausedUntil: null, scopeHint: '令牌缺少 read:org 权限' };
  board.prs = [
    { number: 12, title: '修一个小问题', state: 'OPEN', isDraft: true, tasks: [], refIssues: ['PR 标题引用了不存在的任务：9'] },
    { number: 13, title: '任务 2', state: 'MERGED', isDraft: false, tasks: ['demo#2'], refIssues: [] },
  ];
  board.diagnostics.convention = [
    { rule: 1, docId: 'partial-doc', line: 4, detail: '像任务行，但不是「- [ ] 编号 标题」的写法' },
    { rule: 7, pr: 12, detail: 'PR 标题引用了不存在的任务：9' },
  ];
  return board;
}
const kvOf = (root) => {
  const dl = root.querySelector('dl.kv');
  const dts = dl.querySelectorAll('dt');
  return new Map(dts.map((dt) => [dt.textContent, nextEl(dt)]));
};

test('诊断：导航最后一项「诊断」；#/diag 渲染诊断视图（卡片 + 标题 + 键值区）', () => {
  assert.equal(VIEWS.at(-1).id, 'diag');
  assert.equal(parseHash('#/diag?project=demo').view, 'diag');
  const root = document.createElement('div');
  root.append(...renderPage({ list: LIST, projectId: 'demo', board: diagBoard(), state: { ...newState(NOW.getTime()), view: 'diag', project: 'demo' } }));
  const sec = root.querySelector('#v-diag');
  assert.ok(sec);
  assert.equal(root.querySelector('#v-overview'), null);
  assert.equal(root.querySelector('nav').querySelector('button.on').getAttribute('data-v'), 'diag');
  assert.equal(sec.querySelector('.card').querySelector('h2').textContent, '诊断');
});

test('诊断键值区：配置、工作区、文档、不满足约定、未关联 PR、AI 会话、GitHub 各项齐全（UI 稿五项 + tasks 补的两项）', () => {
  const kv = kvOf(renderDiag(diagBoard(), newState(NOW.getTime())));
  assert.deepEqual([...kv.keys()], ['配置', '工作区', '文档', '不满足约定', '未关联 PR', 'AI 会话', 'GitHub']);
  // UI 稿里的五个键都在，且顺序一致
  const mock = [.../<div class="kv">([\s\S]*?)<\/div><\/div>/.exec(MOCK.slice(MOCK.indexOf("getElementById('v-diag')")))[1].matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
  assert.deepEqual(mock, [...kv.keys()].filter((k) => mock.includes(k)));
  assert.equal(mock.length, 5);

  const text = (k) => kv.get(k).textContent;
  assert.match(text('配置'), /^devboard\.config\.json 已加载 · 项目 2 个警告：server\.host 不是回环地址$/);
  assert.equal(text('工作区'), `demo-repo · main @ ${'a'.repeat(8)}`);
  assert.match(text('不满足约定'), /^2 处（任务行写法 1 · PR 标题写法 1）/);
  assert.deepEqual(texts(kv.get('不满足约定').querySelectorAll('li')), [
    '第 1 条 任务行写法 · partial-doc 第 4 行：像任务行，但不是「- [ ] 编号 标题」的写法',
    '第 7 条 PR 标题写法 · PR #12：PR 标题引用了不存在的任务：9',
  ]);
  assert.match(text('未关联 PR'), /^1 个 PR 没关联到任务/);
  assert.deepEqual(texts(kv.get('未关联 PR').querySelectorAll('li')), ['#12 draft·等 review · 修一个小问题（PR 标题引用了不存在的任务：9）']);
  assert.match(text('AI 会话'), /Claude Code：\/home\/me\/\.claude\/projects · 5 个会话/);
  assert.match(text('AI 会话'), /识别出任务的会话 2 个 · 识别不出任务的 3 个 · 只在 AI 回复里被提到的 7 次（不计）/);
  assert.deepEqual(texts(kv.get('AI 会话').querySelectorAll('li')), ['a/x.jsonl：读取失败（EACCES）', 'a/y.jsonl：3 行读不懂，已跳过']);
  assert.match(text('GitHub'), /^gh 已登录 · 最近请求 2 分钟前 · 本轮 2 次请求 · 剩余额度 4988 \/ 5000/);
  assert.match(text('GitHub'), /权限提示：令牌缺少 read:org 权限/);
});

test('诊断 · 文档：概要计数，可展开看每份的来源类型、解析状态、任务数、未识别行号、Mermaid；来源目录问题另列', () => {
  const dd = kvOf(renderDiag(diagBoard(), newState(NOW.getTime()))).get('文档');
  const summary = dd.querySelector('summary').textContent;
  // 6 份文档（含规划中、归档）；partial-doc 与 empty-doc 有问题；夹具里没有 ADR、没有启用 Mermaid
  assert.equal(summary, '6 份规划文档（2 份有解析问题，可展开看行号） · 0 篇 ADR · Mermaid 依赖图已启用 0 份');
  const items = dd.querySelectorAll('li');
  assert.equal(items.length, 6);
  assert.equal(items[0].children[0].textContent, 'demo · spec（spec-dir） · 解析正常 · 7 个任务');
  const partial = items.find((li) => li.textContent.startsWith('partial-doc'));
  assert.match(partial.textContent, /⚠ 解析不完整 · 1 个任务/);
  assert.match(partial.textContent, /未识别的疑似任务行：第 4 行/);
  assert.match(items.find((li) => li.textContent.startsWith('old-doc')).textContent, /已归档/);
  assert.match(items.find((li) => li.textContent.startsWith('plan-only')).textContent, /规划中（暂无任务）/);
  assert.equal(dd.children.at(-1).textContent, '工作区 repo 的来源「ADR」读取失败：目录不存在 docs/adr');
});

test('诊断降级：未配会话来源、未拿到 PR、GitHub 出错 / 暂停、没有约定问题时如实写出', () => {
  const board = diagBoard();
  board.diagnostics.sessionSources = [];
  board.degraded.noSessionData = true;
  board.degraded.noPrData = true;
  board.diagnostics.convention = [];
  board.diagnostics.github = null;
  board.freshness.github = { ...board.freshness.github, error: 'rate-limited', message: 'GitHub 额度将尽，暂停到额度重置',
    detail: 'API rate limit exceeded', pausedUntil: '2026-09-26T09:00:00Z', scopeHint: null };
  const kv = kvOf(renderDiag(board, newState(NOW.getTime())));
  assert.equal(kv.get('AI 会话').textContent, '没有配置会话来源（页面不含 AI 会话信息）');
  assert.equal(kv.get('未关联 PR').textContent, '未包含 PR 信息（还没成功读到 GitHub）');
  assert.equal(kv.get('不满足约定').textContent, '没有发现');
  const gh = kv.get('GitHub').textContent;
  assert.match(gh, /^GitHub 额度将尽，暂停到额度重置 · 本次启动后还没请求过 · 剩余额度 4988 \/ 5000 · 最近成功 2 分钟前 · 暂停到 /);
  assert.match(gh, /API rate limit exceeded$/);
  assert.ok(!/权限提示/.test(gh));
});

test('诊断：展开状态记在 state 上，重画后保持', () => {
  const state = newState(NOW.getTime());
  const details = renderDiag(diagBoard(), state).querySelector('details');
  assert.equal(details.getAttribute('open'), null, '默认收起');
  details.open = true; // 浏览器里点 summary 后 open 已变，再派发 toggle
  details.dispatch('toggle');
  assert.equal(renderDiag(diagBoard(), state).querySelector('details').getAttribute('open'), '');
  details.open = false;
  details.dispatch('toggle');
  assert.equal(renderDiag(diagBoard(), state).querySelector('details').getAttribute('open'), null);
});

// ---------- 任务 5.5：会话标记、抽屉会话区、停滞卡 ----------

import { extractRefs } from '../src/refs.mjs';
import { mask, MASKED } from '../src/mask.mjs';

const SESS = `# 会话演示

- [ ] 1 跑着的任务
- [ ] 2 最近活跃的任务
- [ ] 3 停下的任务
- [ ] 4 没有会话
- [ ] 5 已发 PR 还在改
- [ ] 6 发了 PR 的旧任务
`;
const ago55 = (min) => new Date(NOW.getTime() - min * 6e4).toISOString();
let sigLine = 0;
const prompt55 = (text, from, until = from) => ({ kind: 'prompt', at: ago55(from), until: ago55(until), file: 'r/s.jsonl', line: ++sigLine,
  refs: extractRefs(text, { knownDocIds: ['sess-demo'], knownCodes: [] }), snippet: text });
const sess55 = (id, title, lastSummary, signals) => ({ source: 'claude-code', id, files: ['r/s.jsonl'], cwds: ['/ws/repo'], branches: [],
  title, firstAt: signals[0].at, lastAt: signals.map((x) => x.until).sort().at(-1), lastSummary, signals, aiOnlyMentions: 0, brokenLines: 0 });
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
function sessBoard() {
  const sessions = [
    sess55('s1', '适配会话来源', '已按字节偏移增量读 jsonl', [prompt55('sess-demo 的任务 1', 30, 2)]),
    sess55('s2', null, null, [4, 3, 2, 1].map((i) => prompt55('sess-demo 的任务 2', 300 + i, 180))),
    sess55('s3', '焦点段识别', mask(`子 agent 派活的识别还没做，token 是 ${SECRET}`), [prompt55('sess-demo 的任务 3', 4 * 1440 + 120, 4 * 1440 + 60)]),
    sess55('s4', '改 review 意见', '改完了', [prompt55('sess-demo 的任务 5', 5, 1)]),
    sess55('s5', '很早的会话', '旧的', [prompt55('sess-demo 的任务 6', 2000, 1990)]),
  ];
  const prs = [mkPr(15, { isDraft: true }), mkPr(16, { isDraft: true })]; // 标题「任务 5」「任务 6」
  const board = computeBoard([planDoc('sess-demo', SESS)], prs, sessions, [], {}, { id: 'demo' }, NOW);
  board.freshness.docsReadAt = '2026-09-26T07:59:57.000Z';
  board.freshness.sessionsReadAt = '2026-09-26T07:59:55.000Z';
  return board;
}
const aiOf = (root, num) => rowOf(root, num).querySelectorAll('span.ai');

test('UI 稿对照：行尾会话标记三种文字与 class（圆点 + 来源名 + 运行中 / 最近活跃 / 停滞 N 天），插在 ⛔ 与 PR 之间', () => {
  const lab = Object.fromEntries([.../running:'([^']+)',recent:'([^']+)',stalled:'([^']+)'/.exec(MOCK).slice(1).entries()].map(([i, t]) => [['running', 'recent', 'stalled'][i], t]));
  assert.ok(/\.ai\.running \.dot\{animation:pulse/.test(read('../web/style.css')), '运行中圆点有脉冲动画');
  const root = renderOverview(sessBoard(), relState(null));
  const tag = (num) => { const [a] = aiOf(root, num); return [a.className, a.querySelector('.dot') ? 'dot' : null, a.textContent]; };
  assert.deepEqual(tag('1'), ['ai running', 'dot', lab.running]);
  assert.deepEqual(tag('2'), ['ai recent', 'dot', lab.recent]);
  assert.deepEqual(tag('3'), ['ai stalled', 'dot', lab.stalled], '停滞 4 天');
  assert.equal(aiOf(root, '4').length, 0, '没有会话不标');
  // 已发 PR 的任务：会话正运行才标，且在 PR 标签之前；旧会话不挂「最近活跃」
  const tags5 = rowOf(root, '5').querySelector('.tags').children;
  assert.deepEqual(tags5.map((x) => x.className), ['ai running', 'pr draft']);
  assert.equal(aiOf(root, '6').length, 0);
});

test('总览「进行中」数字卡副标题「N 运行中 · N 停滞」；顶栏「AI 会话 N 秒前」', () => {
  const board = sessBoard();
  const root = linePage(relState(null), board, LIST);
  const doing = root.querySelectorAll('.stat')[2];
  assert.deepEqual([doing.querySelector('.n').textContent, doing.querySelector('.sub').textContent], ['3', '1 运行中 · 1 停滞']);
  assert.deepEqual(texts(root.querySelector('.meta').children), ['文档 3 秒前', 'AI 会话 5 秒前', 'GitHub 未读取']);
  assert.equal(/<span>文档 3 秒前<\/span><span>AI 会话 5 秒前<\/span><span>GitHub/.test(MOCK), true, '顺序同 UI 稿顶栏');
});

test('横幅「未包含 AI 会话信息」：会话来源全部不可用 / 没配会话来源时显示原因', () => {
  const b = sessBoard();
  assert.deepEqual(degradedBanners(b, NOW.getTime()), []);
  b.degraded.noSessionData = true;
  assert.deepEqual(degradedBanners(b, NOW.getTime()), ['未包含 AI 会话信息：「进行中」只按文档里的 [~] 标记判定（没有配置会话来源）']);
  b.diagnostics.sessionSources = [{ source: 'claude-code', available: false, error: '记录目录不存在：/x' }];
  assert.match(degradedBanners(b, NOW.getTime())[0], /（记录目录不存在：\/x）$/);
  assert.ok(texts(linePage(relState(null), b, LIST).querySelectorAll('.banner')).some((t) => t.startsWith('未包含 AI 会话信息')));
});

test('任务抽屉「AI 会话」区：标记 + 标题、来源 · 开始 · 最近活动、最后一条（已遮蔽）、判定依据（证据与位置）；没有会话写明', () => {
  const board = sessBoard();
  const drawer = (key) => renderDrawer(board, relState(`sess-demo#${key}`), () => {})[1];
  const section = (aside) => {
    const h3 = aside.querySelectorAll('h3').find((x) => x.textContent === 'AI 会话');
    return h3.parentNode.children.slice(h3.parentNode.children.indexOf(h3) + 1);
  };
  const h3s = texts(drawer('1').querySelectorAll('h3'));
  assert.deepEqual(h3s.slice(h3s.indexOf('PR')), ['PR', 'AI 会话', '甘特时间'], '接在 PR 区之后（同 UI 稿）；任务 6.2 的甘特时间区再往后');

  const [box] = section(drawer('1'));
  assert.equal(box.className, 'box sess');
  assert.deepEqual(box.children.map((c) => c.className), ['shd', 'src', 'last', 'src'], '字段顺序同 UI 稿');
  assert.equal(box.children[0].textContent, 'Claude 运行中适配会话来源');
  assert.equal(box.children[0].querySelector('b').textContent, '适配会话来源');
  assert.match(box.children[1].textContent, /^Claude Code · 开始 09-26 \d\d:30 · 最近活动 2 分钟前$/);
  assert.equal(box.children[2].textContent, '最后一条：「已按字节偏移增量读 jsonl」');
  const ev = box.children[3];
  assert.match(ev.textContent, /^判定依据：人发消息：「sess-demo 的任务 1」 · r\/s\.jsonl 第 \d+ 行$/);

  // 停滞：更早的最近活动写日期时刻 +（N 天前）；摘要是 5.2 遮蔽后的文本，令牌不出现在页面上
  const stale = section(drawer('3'))[0];
  assert.equal(stale.querySelector('span.ai').textContent, 'Claude 停滞 4 天');
  assert.match(stale.children[1].textContent, /最近活动 09-2\d \d\d:00（4 天前）$/);
  assert.equal(stale.children[2].textContent, `最后一条：「子 agent 派活的识别还没做，token 是 ${MASKED}」`);
  assert.ok(!drawer('3').textContent.includes(SECRET));

  // 无标题的会话写会话 id；证据多于 3 条只列前 3 条
  const recent = section(drawer('2'))[0];
  assert.equal(recent.querySelector('b').textContent, '会话 s2');
  assert.equal(recent.children.length, 3, '没有摘要时不写「最后一条」');
  assert.deepEqual(recent.children[2].querySelectorAll('.sev').map((x) => x.textContent.split(' · ')[0]),
    ['人发消息：「sess-demo 的任务 2」', '人发消息：「sess-demo 的任务 2」', '人发消息：「sess-demo 的任务 2」', '… 另有 1 条']);

  const none = section(drawer('4'));
  assert.equal(none[0].textContent, '没有关联的 AI 会话。');
  assert.equal(none[0].className, 'muted');
  // 抽屉头部的行尾标签也带会话标记
  assert.equal(drawer('1').querySelector('.hdtags').querySelector('span.ai').textContent, 'Claude 运行中');
});

test('下一步 · 等我处理：停滞会话卡片（标记 + 「编号 标题：会话停了」+ 遮蔽后的最后一条 +「要不要接着做？」），排在 PR 之后、外部前置之前；点开任务抽屉', () => {
  globalThis.location = { hash: '' };
  const root = renderNext(sessBoard(), relState(null, { view: 'next' }));
  const cards = colOf(root, 3).querySelectorAll('.tk');
  const stale = cards.find((c) => c.querySelector('span.ai'));
  assert.deepEqual(cardLine(stale), ['Claude 停滞 4 天', '3 停下的任务：会话停了', `最后一条：「子 agent 派活的识别还没做，token 是 ${MASKED}」。要不要接着做？`]);
  assert.equal(stale.querySelector('span.ai').className, 'ai stalled');
  assert.equal(cards.indexOf(stale), cards.length - 1, 'PR 卡片（#15、#16 draft）在前');
  assert.ok(!root.textContent.includes(SECRET));
  stale.dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'next', project: 'demo', focus: 'sess-demo#3', line: null });
  // UI 稿同款卡片
  assert.match(MOCK, /<span class="ai stalled"><span class="dot"><\/span>Claude 停滞 4 天<\/span><\/div><div class="tt">3\.2 焦点段识别：会话停了<\/div><div class="why">最后一条：「[^」]+」。要不要接着做？/);
});

test('N10：Codex 来源名——行尾标记、抽屉、关系图、最近变化、诊断页都写 Codex；同一任务两种来源时取最近活动那个', () => {
  // 任务 1 同时关联 Claude 会话 c1 与 Codex 会话 x1；latest 决定哪个更晚
  const mixBoard = (latest) => {
    const c1 = sess55('c1', 'Claude 那边', null, [prompt55('sess-demo 的任务 1', 40, latest === 'claude' ? 1 : 20)]);
    const x1 = { ...sess55('codex:x1', 'Codex 这边', '（虚构）好', [prompt55('sess-demo 的任务 1', 30, latest === 'codex' ? 1 : 20)]), source: 'codex' };
    return computeBoard([planDoc('sess-demo', SESS)], [], [c1, x1], [], {}, { id: 'demo' }, NOW);
  };
  for (const [latest, short] of [['codex', 'Codex'], ['claude', 'Claude']]) {
    const board = mixBoard(latest);
    assert.equal(aiOf(renderOverview(board, relState(null)), '1')[0].textContent, `${short} 运行中`, `行尾标记（最近：${latest}）`);
    const node = renderGraph(board, relState(null, { view: 'graph' })).querySelector('.gnode[data-id="sess-demo#1"]');
    assert.ok(node.textContent.includes(`● ${short} 运行中`), `关系图节点（最近：${latest}）`);
  }
  const board = mixBoard('codex');
  const [, aside] = renderDrawer(board, relState('sess-demo#1'), () => {});
  const boxes = aside.querySelectorAll('.box.sess');
  assert.deepEqual(boxes.map((b) => b.children[1].textContent.split(' · ')[0]).sort(), ['Claude Code', 'Codex']);
  assert.ok(renderOverview(board, relState(null)).textContent.includes('sess-demo 1 · Codex 会话仍在运行'), '最近变化');
  board.diagnostics.sessionSources = [{ source: 'codex', dir: '/home/me/.codex/sessions', available: true, error: null, sessions: 1, unreadableFiles: [], brokenLines: [], messages: ['2026/10/01/rollout-x.jsonl：父会话记录不存在，单独显示'] }];
  const diag = renderDiag(board, newState(NOW.getTime())).textContent;
  assert.match(diag, /Codex：\/home\/me\/\.codex\/sessions · 1 个会话/);
  assert.ok(diag.includes('父会话记录不存在，单独显示'), '来源自带的诊断消息照常列出');
});

// ---------- 任务 6.3：最近变化（总览右栏「这几天发生了什么」） ----------

function recentBoard() {
  const docs = [planDoc('pr-demo', PR_DOC), planDoc('collab-demo', '# 协作\n\n- [ ] 1 协作任务\n', { workspaceId: 'collab' })];
  const prs = [...DEMO_PRS, mkPr(17, { title: '改 README', state: 'MERGED', createdAt: '2026-09-10T08:00:00Z', mergedAt: '2026-09-25T06:00:00Z' })];
  const sync = { 13: { state: 'pending', reason: null }, 14: { state: 'synced', reason: null } };
  const board = computeBoard(docs, prs, [], [], sync, { id: 'demo', repo: { path: '/ws/repo' }, branchLines: LINES }, NOW);
  // 会话事件的数据链路在 engine.test 测过；这里手放两条，只看文字
  board.recent.events.push(
    { kind: 'session', at: '2026-09-26T07:58:00Z', sessionId: 's1', source: 'claude-code', activity: 'running', tasks: ['pr-demo#1'] },
    { kind: 'session', at: '2026-09-22T06:00:00Z', sessionId: 's2', source: 'claude-code', activity: 'stale', tasks: ['pr-demo#6'] });
  board.recent.events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return board;
}
const recentOf = (root) => root.querySelector('.side').querySelectorAll('.sec')[0];
const evLines = (sec) => sec.querySelectorAll('.ev').map((e) => [e.querySelector('.t').textContent, e.children[1].textContent]);

test('最近变化：总览右栏第一块，标题「这几天发生了什么 · 近 7 天」同 UI 稿；起始日日期选择默认 7 天前、不晚于今天；注明复选框无历史', () => {
  const sec = recentOf(renderOverview(recentBoard(), relState(null)));
  const mock = /<h2>(这几天发生了什么) <span[^>]*>([^<]+)<\/span><\/h2>/.exec(MOCK);
  assert.equal(sec.querySelector('h2').textContent, `${mock[1]} ${mock[2]}`);
  const btn = sec.querySelector('[aria-label=起始日]');
  assert.equal(btn.textContent, '2026-09-19▾');
  btn.dispatch('click');
  const day = (d) => sec.querySelector(`[data-date=${d}]`);
  assert.equal(day('2026-09-19').parentNode.getAttribute('aria-selected'), 'true', '默认 7 天前');
  assert.ok(day('2026-09-27').hasAttribute('disabled'), '不晚于今天（max）');
  assert.ok(!day('2026-09-26').hasAttribute('disabled'));
  assert.match(sec.querySelector('.evbar').textContent, /复选框的勾选变化没有历史/);
});

test('最近变化：逐条「时间 + 事件」按时间倒序，句式同 UI 稿；待同步与未关联用警示色', () => {
  const sec = recentOf(renderOverview(recentBoard(), relState(null)));
  for (const phrase of ['已在 GitHub 合并', '本地还没 pull', '没关联到任务', '开了 draft PR', 'Claude 会话仍在运行', '的会话之后再没动过（停滞）']) {
    assert.ok(MOCK.includes(phrase), `句式出自 UI 稿：${phrase}`);
  }
  assert.deepEqual(evLines(sec).slice(0, 8), [
    ['刚刚', 'pr-demo 1 · Claude 会话仍在运行'],
    ['09-25', '#13 已在 GitHub 合并（pr-demo 任务 3） · 本地还没 pull'],
    ['09-25', '#16 开了 draft PR（pr-demo 任务 7）'],
    ['09-25', '#17 已合并 · 没关联到任务'],
    ['09-24', '#11 开了 draft PR（pr-demo 任务 1）'],
    ['09-23', '#15 关闭未合并（pr-demo 任务 5）'],
    ['09-22', '#14 已合并 → pr-demo 4 完成'],
    ['09-22', 'pr-demo 6 的会话之后再没动过（停滞）'],
  ]);
  const ev = sec.querySelectorAll('.ev');
  assert.equal(ev[1].querySelector('b.warntext').textContent, ' · 本地还没 pull');
  assert.equal(ev[3].querySelector('span.warntext').textContent, '没关联到任务');
  assert.equal(evLines(sec).at(-1)[1], '#12 转为 ready（pr-demo 任务 2）', '起始日当天 0 点起算');
});

test('最近变化：改起始日只重画本区块、标题改写「· 日期 起」；选分支线时只留该线的 PR 与文档任务', () => {
  const state = relState(null);
  const sec = recentOf(renderOverview(recentBoard(), state));
  const input = sec.querySelector('[aria-label=起始日]');
  pickDate(input, '2026-09-24');
  assert.equal(state.recentFrom, '2026-09-24');
  assert.ok(sec.querySelector('[aria-label=起始日]') === input, '按钮本身没被重画');
  assert.equal(input.textContent, '2026-09-24▾');
  assert.equal(sec.querySelector('h2').textContent, '这几天发生了什么 · 2026-09-24 起');
  assert.deepEqual(evLines(sec).map(([t]) => t), ['刚刚', '09-25', '09-25', '09-25', '09-24']);
  pickDate(input, '2026-09-26');
  assert.deepEqual(evLines(sec).map(([, x]) => x), ['pr-demo 1 · Claude 会话仍在运行']);

  const root = linePage(prState({ line: 'collab' }), recentBoard());
  assert.deepEqual(evLines(recentOf(root)).map(([, x]) => x), ['#16 开了 draft PR（pr-demo 任务 7）']);
});

// ---------- 任务 4.2：未关联 PR 列表与手动关联交互 ----------

import { unlinkedPrs } from '../web/app.mjs';

// 在 3.6 的 PR 夹具上补几个认不出任务的 PR：#20 个人版 open、#22 个人版近期已合并、#23 个人版一个多月前已合并（超出近 14 天）、
// #21 协作版 draft、#24 协作版「任务 1」——协作版没配 docFilter，pr-demo 与 collab-demo 都有任务 1 → 只有歧义关联
const EXTRA_PRS = [
  mkPr(20, { title: '重构日志' }),
  mkPr(21, { isDraft: true, title: '[V2] 杂项', baseRefName: 'v2/collab' }),
  mkPr(22, { state: 'MERGED', title: '修文案', mergedAt: '2026-09-25T12:00:00Z', mergeCommit: 'd'.repeat(40) }),
  mkPr(23, { state: 'MERGED', title: '很久以前', mergedAt: '2026-08-01T12:00:00Z', mergeCommit: 'e'.repeat(40) }),
  mkPr(24, { title: '[V2] 任务 1', baseRefName: 'v2/collab' }),
];
const AT = '2026-09-26T07:00:00Z';
function manualBoard(manual = []) {
  const docs = [planDoc('pr-demo', PR_DOC), planDoc('collab-demo', '# 协作\n\n- [ ] 1 协作任务\n', { workspaceId: 'collab' })];
  const sync = { 13: { state: 'pending', reason: null }, 14: { state: 'synced', reason: null } };
  const board = computeBoard(docs, [...DEMO_PRS, ...EXTRA_PRS], [], manual.map((r) => ({ project: 'demo', at: AT, ...r })), sync,
    { id: 'demo', repo: { path: '/ws/repo' }, branchLines: LINES }, NOW);
  board.recentClosedPrDays = 14;
  return board;
}
const unlSec = (root) => root.querySelectorAll('.sec').find((s) => s.querySelector('h2')?.textContent.startsWith('未关联任务的 PR'));
const unlRows = (sec) => sec.querySelectorAll('.unl').map((r) => r.querySelector('a.pr').textContent);
const btnOf = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const spy = () => { const calls = []; return { calls, manual: (c) => { calls.push(c); } }; };

test('UI 稿对照 · 总览右栏「未关联任务的 PR」：标题 + 计数、说明语，每行 PR 标签 + 标题 +「关联」；位于「各份文档进度」之前', () => {
  const m = /<h2>(未关联任务的 PR) <span class="count">\$\{UNLINKED\.length\}<\/span><\/h2>\s*<div class="muted"[^>]*>(.*?)<\/div>/.exec(MOCK);
  assert.ok(m, 'UI 稿里的未关联区块');
  const root = renderOverview(manualBoard(), prState());
  const sec = unlSec(root);
  assert.equal(sec.querySelector('h2').textContent, `${m[1]} 4`);
  assert.equal(sec.querySelector('.count').textContent, '4');
  assert.equal(sec.querySelector('.unlnote').textContent, m[2]);
  const row = sec.querySelectorAll('.unl')[0];
  assert.deepEqual(row.children.map((c) => [c.tagName, c.className]), [['A', 'pr ready'], ['SPAN', 'tt'], ['BUTTON', 'btn sm']]);
  assert.deepEqual([row.children[1].textContent, row.children[1].getAttribute('title'), row.children[2].textContent], ['重构日志', '重构日志', '关联']);
  const heads = root.querySelector('.side').children.map((s) => s.querySelector('h2').textContent);
  assert.equal(heads.findIndex((x) => x.startsWith('未关联任务的 PR')) + 1, heads.indexOf('各份文档进度'), 'UI 稿顺序：紧挨在「各份文档进度」之前');
});

test('未关联 PR：含只有歧义关联的；按分支线（配置顺序）、open 在前；「近 N 天已合并 / 关闭」开关默认开，关掉只剩 open；选分支线只列该线', () => {
  const board = manualBoard();
  const state = prState();
  const sec = unlSec(renderOverview(board, state));
  // #24「任务 1」有歧义 → 未关联；#23 超出近 14 天不列；已关联的（含关闭的 #15）不列
  assert.deepEqual(unlRows(sec), ['#20 ready·等合并', '#22 已合并', '#24 ready·等合并', '#21 draft·等 review']);
  assert.deepEqual(texts(sec.querySelectorAll('.unlgrp')), ['个人版', '协作版'], '「全部」时每条分支线一行小标题');
  assert.match(board.prs.find((p) => p.number === 24).refIssues[0], /有歧义/);
  const sw = sec.querySelector('label.unlsw');
  assert.equal(sw.textContent, ' 近 14 天已合并 / 关闭');
  const box = sw.querySelector('input');
  assert.equal(box.hasAttribute('checked'), true);
  box.checked = false;
  box.dispatch('change');
  assert.equal(state.unlRecent, false);
  assert.deepEqual(unlRows(sec), ['#20 ready·等合并', '#24 ready·等合并', '#21 draft·等 review'], '开关只重画本区块');
  assert.equal(sec.querySelector('.count').textContent, '3');
  // 选了分支线：只列该线，不再分小标题
  assert.deepEqual(unlinkedPrs(board, prState({ line: 'collab' })).map((p) => p.number), [24, 21]);
  const collab = unlSec(renderOverview(board, prState({ line: 'collab' })));
  assert.deepEqual(unlRows(collab), ['#24 ready·等合并', '#21 draft·等 review']);
  assert.equal(collab.querySelectorAll('.unlgrp').length, 0);
  // 没拿到 PR 数据时如实写出
  const none = manualBoard();
  none.degraded.noPrData = true;
  assert.equal(unlSec(renderOverview(none, prState())).querySelectorAll('.unl').length, 0);
  assert.match(unlSec(renderOverview(none, prState())).textContent, /未包含 PR 信息/);
});

test('「关联」：打开 PR 详情并直接展开任务选择器；选择器按编号 / 标题过滤，整页重画后仍展开、搜索词保留；选中即 POST link 并收起', () => {
  globalThis.location = { hash: '' };
  const board = manualBoard();
  const { calls, manual } = spy();
  const state = prState({ manual });
  btnOf(unlSec(renderOverview(board, state)), '关联').dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'overview', project: 'demo', focus: '#20', line: null });
  state.focus = '#20';
  const [, aside] = renderDrawer(board, state, () => {});
  const pk = aside.querySelector('.picker');
  const input = pk.querySelector('input');
  assert.equal(input.getAttribute('placeholder'), '搜索编号 / 标题');
  // 候选：未作废、未关联本 PR 的任务，本 PR 分支线（个人版）的文档在前
  assert.deepEqual(texts(pk.querySelectorAll('.pitem').map((b) => b.querySelector('b'))).slice(0, 2), ['pr-demo · 1', 'pr-demo · 2']);
  assert.equal(pk.querySelectorAll('.pitem').at(-1).querySelector('b').textContent, 'collab-demo · 1');
  const filter = (q) => { input.value = q; input.dispatch('input'); return texts(pk.querySelectorAll('.pitem').map((b) => b.querySelector('b'))); };
  assert.deepEqual(filter('7'), ['pr-demo · 7'], '按编号');
  assert.deepEqual(filter('1'), ['pr-demo · 1', 'collab-demo · 1']);
  assert.deepEqual(filter('草稿'), ['pr-demo · 1'], '按标题');
  assert.deepEqual(filter('collab-demo#'), ['collab-demo · 1'], '按任务键');
  assert.deepEqual(filter('没有这个'), []);
  assert.equal(pk.querySelector('.pmore').textContent, '没有匹配的');
  filter('7');
  // 会话 / GitHub 变化触发整页重画：选择器照旧展开、搜索词与过滤结果保留
  const [, again] = renderDrawer(board, state, () => {});
  assert.equal(again.querySelector('.picker').querySelector('input').getAttribute('value'), '7');
  assert.deepEqual(texts(again.querySelectorAll('.pitem').map((b) => b.querySelector('b'))), ['pr-demo · 7']);
  pk.querySelector('.pitem').dispatch('click');
  assert.deepEqual(calls, [{ taskKey: 'pr-demo#7', pr: 20, action: 'link' }]);
  assert.equal(pk.querySelector('input'), null, '选中后收起');
  assert.equal(state.picker, null);
  // 直接点标签进 PR 详情（没点「关联」）：选择器收起，点按钮才展开
  const [, plain] = renderDrawer(board, state, () => {});
  assert.equal(plain.querySelector('.picker').querySelector('input'), null);
  btnOf(plain, '＋ 手动关联任务').dispatch('click');
  assert.ok(plain.querySelector('.picker').querySelector('input'));
  btnOf(plain, '取消').dispatch('click');
  assert.equal(plain.querySelector('.picker').querySelector('input'), null);
});

test('解除关联：自动关联的 PR 框写「解除关联」（POST unlink）；解除后行尾标签消失，抽屉显示「已手动解除」+ 原来源 + 撤销（DELETE）', () => {
  const { calls, manual } = spy();
  const [, before] = renderDrawer(manualBoard(), prState({ focus: 'pr-demo#1', manual }), () => {});
  btnOf(before, '解除关联').dispatch('click');
  assert.deepEqual(calls, [{ taskKey: 'pr-demo#1', pr: 11, action: 'unlink' }]);

  const board = manualBoard([{ taskKey: 'pr-demo#1', pr: 11, action: 'unlink' }]);
  assert.deepEqual(tagsOfRow(renderOverview(board, prState()), '1'), [], '行尾不再挂 #11');
  const [, aside] = renderDrawer(board, prState({ focus: 'pr-demo#1', manual }), () => {});
  const h3 = aside.querySelectorAll('h3').find((x) => x.textContent === 'PR');
  assert.equal(nextEl(h3).textContent, '还没有 PR。');
  const off = aside.querySelector('.box.off');
  assert.equal(off.children[0].textContent, '已手动解除 #11 任务 1');
  assert.equal(off.querySelector('.src').textContent, '原来源：PR 标题里的「任务 1」 · 撤销');
  btnOf(off, '撤销').dispatch('click');
  assert.deepEqual(calls.at(-1), { taskKey: 'pr-demo#1', pr: 11 });
  // #11 一个任务都不剩 → 进未关联列表；PR 详情里「已手动解除」列出任务并可撤销
  assert.ok(unlinkedPrs(board, prState()).some((p) => p.number === 11));
  const [, pr] = renderDrawer(board, prState({ focus: '#11', manual }), () => {});
  const prOff = pr.querySelector('.box.off');
  assert.equal(prOff.querySelector('.prtask').textContent, 'pr-demo · 1 ○未开始 草稿中');
  btnOf(prOff, '撤销').dispatch('click');
  assert.deepEqual(calls.at(-1), { taskKey: 'pr-demo#1', pr: 11 });
  // PR 详情里自动关联的任务同样可解除
  const [, p13] = renderDrawer(board, prState({ focus: '#13', manual }), () => {});
  btnOf(p13, '解除关联').dispatch('click');
  assert.deepEqual(calls.at(-1), { taskKey: 'pr-demo#3', pr: 13, action: 'unlink' });
});

test('「＋ 手动关联 PR」：按 PR 号 / 标题搜索，已关联的不列；手动关联后来源写「手动关联」、可撤销；失效记录在 PR 详情里可删除', () => {
  const { calls, manual } = spy();
  const [, aside] = renderDrawer(manualBoard(), prState({ focus: 'pr-demo#6', manual }), () => {});
  btnOf(aside, '＋ 手动关联 PR').dispatch('click');
  const pk = aside.querySelector('.picker');
  const input = pk.querySelector('input');
  assert.equal(input.getAttribute('placeholder'), '搜索 PR 号 / 标题');
  const labels = () => texts(pk.querySelectorAll('.pitem').map((b) => b.querySelector('b')));
  assert.deepEqual(labels().slice(0, 3), ['#24', '#21', '#20'], 'open 在前、号大在前');
  input.value = '#22';
  input.dispatch('input');
  assert.deepEqual(labels(), ['#22']);
  assert.equal(pk.querySelector('.pitem').textContent, '#22 已合并 · 修文案');
  input.value = '文案';
  input.dispatch('input');
  pk.querySelector('.pitem').dispatch('click');
  assert.deepEqual(calls, [{ taskKey: 'pr-demo#6', pr: 22, action: 'link' }]);

  const board = manualBoard([{ taskKey: 'pr-demo#6', pr: 22, action: 'link' }, { taskKey: 'pr-demo#99', pr: 20, action: 'link' }]);
  assert.deepEqual(texts(tagsOfRow(renderOverview(board, prState()), '6')), ['#22 已合并']);
  assert.ok(!unlinkedPrs(board, prState()).some((p) => p.number === 22), '手动关联后离开未关联列表');
  const [, linked] = renderDrawer(board, prState({ focus: 'pr-demo#6', manual }), () => {});
  const box = nextEl(linked.querySelectorAll('h3').find((x) => x.textContent === 'PR'));
  assert.equal(box.querySelector('.src').textContent, '来源：手动关联 · 撤销');
  btnOf(box, '撤销').dispatch('click');
  assert.deepEqual(calls.at(-1), { taskKey: 'pr-demo#6', pr: 22 });
  // 失效关联（冲突 j）：记录保留，PR 详情里写明并可删除（需求 7.5）
  const [, pr20] = renderDrawer(board, prState({ focus: '#20', manual }), () => {});
  const flag = pr20.querySelectorAll('.flag').find((f) => /不存在的任务/.test(f.textContent));
  assert.match(flag.textContent, /^⚠ 手动关联记录指向不存在的任务 pr-demo#99/);
  btnOf(flag, '删除这条记录').dispatch('click');
  assert.deepEqual(calls.at(-1), { taskKey: 'pr-demo#99', pr: 20 });
});

test('手动关联文件读不了：红色横幅，「关联」「＋ 手动关联」「解除关联」全部禁用，「关联」进来也不展开选择器；写失败原因同样用红色横幅', () => {
  const board = manualBoard();
  board.degraded.manualBroken = 'JSON 格式错误：Unexpected token';
  const root = linePage(prState(), board);
  const banner = root.querySelector('.banner.err');
  assert.match(banner.textContent, /^手动关联文件读不了：JSON 格式错误：Unexpected token。现在只用自动关联/);
  assert.ok(unlSec(root).querySelectorAll('.unl').every((r) => r.querySelector('button').hasAttribute('disabled')));
  const [, task] = renderDrawer(board, prState({ focus: 'pr-demo#1' }), () => {});
  assert.ok(btnOf(task, '＋ 手动关联 PR').hasAttribute('disabled'));
  assert.ok(btnOf(task, '解除关联').hasAttribute('disabled'));
  const [, pr] = renderDrawer(board, prState({ focus: '#20', picker: { id: 'tasks-for:20', q: '' } }), () => {});
  assert.equal(pr.querySelector('.picker').querySelector('input'), null);
  assert.ok(btnOf(pr, '＋ 手动关联任务').hasAttribute('disabled'));

  assert.equal(linePage(prState(), manualBoard()).querySelector('.banner.err'), null, '正常时没有红色横幅');
  assert.equal(linePage(prState({ linkError: '只接受本页面发起的请求' }), manualBoard()).querySelector('.banner.err').textContent,
    '手动关联没保存：只接受本页面发起的请求');
});

// ---------- 任务 6.4：需要确认 ----------

import { renderCheck, checkItems, CONFLICT_TEXT } from '../web/app.mjs';

// PR 演示看板 + 覆盖 a–o 的冲突明细（形状同 engine：任务类带 taskKey，PR 类带 pr，会话类带 sessionId + source，j 两者都带）
function checkBoard() {
  const board = prDemoBoard();
  const t = (type, num, detail, extra = {}) => ({ type, taskKey: `pr-demo#${num}`, detail, ...extra });
  board.conflicts = [
    t('a', 3, 'PR #13 已合并，但复选框未勾'),
    t('b', 4, '复选框已勾，但 PR #12 还没合并'),
    t('c', 4, '复选框已勾选，但没有关联 PR（仅文档确认）'),
    { type: 'c', taskKey: 'collab-demo#1', detail: '复选框已勾选，但没有关联 PR（仅文档确认）' },
    t('d', 5, '关联的 PR #15 均已关闭未合并'),
    t('e', 2, '编号 2 在文档里出现了不止一次'),
    t('f', 6, '依赖了找不到的对象：99', { source: { file: '.claude/specs/pr-demo/tasks.md', line: 8, text: '- [ ] 6 等 3（依赖 99）' } }),
    t('g', 7, '与 6 构成循环依赖'),
    { type: 'h', pr: 12, detail: 'PR 标题引用了不存在的任务：9' },
    { type: 'h', sessionId: 's-1', source: { file: 'r/s.jsonl', line: 3, text: '做任务 9' }, detail: '会话「修 bug」引用了不存在的任务：9' },
    { type: 'i', pr: 11, detail: '标题指向 pr-demo#1，描述却指向 pr-demo#2' },
    { type: 'j', taskKey: 'pr-demo#99', pr: 15, detail: '手动关联记录指向不存在的任务 pr-demo#99（PR #15），请改挂或删除这条记录' },
    t('k', 1, '子任务已全部完成（2 个），父任务还是未开始'),
    t('l', 6, '依赖 3 还没完成，却已有 PR #14'),
    t('m', 5, '任务已作废，仍关联着 PR #15'),
    { type: 'n', pr: 16, detail: 'PR 标题没有分支线前缀 [V2]' },
    t('o', 1, '进行中但没有 PR，关联 AI 会话已 4 天没有动静'),
  ];
  return board;
}
const checkState = (extra = {}) => prState({ view: 'check', ...extra });
const groupsOf = (root) => root.querySelectorAll('details.cgrp');
const groupEl = (root, type) => root.querySelector(`details[data-type=${type}]`);
const boxLine = (b) => `${b.querySelector('b').textContent}${b.childNodes[1].textContent}`;

test('需要确认：导航在「下一步」之后，带警示计数（= 本视图全部条数，含仅文档确认）；#/check 渲染视图，标题与副文同 UI 稿', () => {
  const ids = VIEWS.map((v) => v.id);
  assert.equal(ids.indexOf('check'), ids.indexOf('next') + 1);
  assert.equal(parseHash('#/check?project=demo').view, 'check');
  const root = linePage(checkState(), checkBoard());
  const btn = root.querySelector('nav').querySelector('button[data-v=check]');
  assert.equal(btn.getAttribute('class'), 'on');
  assert.equal(btn.querySelector('span.count.warn').textContent, '17', '与「全部类型」同为 17 条，仅文档确认也计');
  assert.equal(checkItems(checkBoard(), checkState()).length, 17);
  const card = root.querySelector('#v-check').querySelector('.card');
  assert.equal(card.querySelector('h2').textContent, '需要确认 · 这些只是提示，不会改动任务状态');
  assert.match(MOCK, /需要确认 <span[^>]*>· 这些只是提示，不会改动任务状态/, 'UI 稿同一句');
  // 只剩仅文档确认：照样计数；没有冲突：视图写「没有」
  const onlyC = checkBoard();
  onlyC.conflicts = onlyC.conflicts.filter((x) => x.type === 'c');
  const cRoot = linePage(checkState(), onlyC);
  assert.equal(cRoot.querySelector('nav').querySelector('button[data-v=check]').querySelector('span.count.warn').textContent, '2');
  assert.equal(cRoot.querySelector('#v-check').querySelectorAll('div.box').length, 2);
  const clean = prDemoBoard();
  clean.conflicts = [];
  const none = linePage(checkState(), clean);
  assert.equal(none.querySelector('nav').querySelector('button[data-v=check]').querySelector('span'), null);
  assert.equal(none.querySelector('#v-check').querySelector('.empty').textContent, '没有需要确认的事项。');
});

test('需要确认：a–o 每类一组（中文类型名 + 条数），组内一条一个框「类型 · 对象」+ 说明原文；c 默认收起、其余展开', () => {
  const root = renderCheck(checkBoard(), checkState());
  assert.deepEqual(groupsOf(root).map((g) => g.getAttribute('data-type')), [...'abcdefghijklmno']);
  assert.equal(new Set(Object.values(CONFLICT_TEXT)).size, 15);
  for (const g of groupsOf(root)) {
    const type = g.getAttribute('data-type');
    const boxes = g.querySelectorAll('div.box');
    assert.equal(g.querySelector('summary').textContent, `${CONFLICT_TEXT[type]}（${boxes.length}）`);
    assert.equal(g.getAttribute('open'), type === 'c' ? null : '', `${type} 的默认展开状态`);
    for (const b of boxes) assert.equal(b.querySelector('b').textContent, CONFLICT_TEXT[type]);
  }
  const line = (type, i = 0) => boxLine(groupEl(root, type).querySelectorAll('div.box')[i]);
  assert.equal(line('a'), 'PR 已合并、文档未勾 · pr-demo 3');
  assert.equal(line('c', 1), '仅文档确认 · collab-demo 1');
  assert.equal(line('h'), '引用有歧义 / 不存在 · #12');
  assert.equal(line('h', 1), '引用有歧义 / 不存在 · 会话 s-1');
  assert.equal(line('j'), '失效的手动关联 · #15');
  assert.equal(groupEl(root, 'a').querySelector('.src').textContent, 'PR #13 已合并，但复选框未勾');
  // 悬空依赖、会话引用问题另起一行写出文档 / 记录位置
  assert.deepEqual(texts(groupEl(root, 'f').querySelectorAll('.src')),
    ['依赖了找不到的对象：99', '.claude/specs/pr-demo/tasks.md 第 8 行：- [ ] 6 等 3（依赖 99）']);
  assert.equal(groupEl(root, 'h').querySelectorAll('.src').at(-1).textContent, 'r/s.jsonl 第 3 行：做任务 9');
  assert.equal(groupEl(root, 'a').querySelector('div.box').getAttribute('title'), '已合并待同步', '悬停看任务标题');
});

test('需要确认：按类型筛选只留所选类型；选 c 时展开；展开状态记在 state 上，重画后保持', () => {
  const state = checkState();
  const root = renderCheck(checkBoard(), state);
  const sel = combo(root, '类型');
  assert.equal(optTexts(sel)[0], '全部类型（17）');
  assert.ok(optTexts(sel).includes('仅文档确认（2）'));
  assert.deepEqual(chosen(sel), ['全部类型（17）']);
  choose(sel, `${CONFLICT_TEXT.l}（1）`);
  assert.equal(state.checkType, 'l');
  assert.deepEqual(groupsOf(root).map((g) => g.getAttribute('data-type')), ['l']);
  assert.equal(root.querySelectorAll('div.box').length, 1);
  choose(combo(root, '类型'), '仅文档确认（2）');
  assert.equal(groupEl(root, 'c').getAttribute('open'), '');
  choose(combo(root, '类型'), '全部类型（17）');
  assert.equal(state.checkType, null);
  assert.equal(groupsOf(root).length, 15);
  // 手动展开 c，整页重画后仍展开；再收起回到默认
  const c = groupEl(root, 'c');
  c.open = true;
  c.dispatch('toggle');
  assert.equal(groupEl(renderCheck(checkBoard(), state), 'c').getAttribute('open'), '');
  c.open = false;
  c.dispatch('toggle');
  assert.equal(groupEl(renderCheck(checkBoard(), state), 'c').getAttribute('open'), null);
  // 看板新版本里所选类型没了 → 回到全部
  const s2 = checkState({ checkType: 'l' });
  const b2 = checkBoard();
  b2.conflicts = b2.conflicts.filter((x) => x.type !== 'l');
  assert.equal(groupsOf(renderCheck(b2, s2)).length, 14);
});

test('需要确认：点框跳到任务 / PR（地址加 focus=，停在本视图）；会话没有详情页不可点；失效手动关联可直接删记录', () => {
  globalThis.location = { hash: '' };
  const calls = [];
  const root = renderCheck(checkBoard(), checkState({ manual: (c) => calls.push(c) }));
  const box = (type, i = 0) => groupEl(root, type).querySelectorAll('div.box')[i];
  box('a').dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'check', project: 'demo', focus: 'pr-demo#3', line: null });
  box('n').dispatch('click');
  assert.equal(parseHash(location.hash).focus, '#16');
  box('j').dispatch('click');
  assert.equal(parseHash(location.hash).focus, '#15', '任务键已不存在的手动关联跳到 PR');
  assert.equal(box('h', 1).getAttribute('class'), 'box');
  assert.equal(box('h', 0).getAttribute('class'), 'box go');
  box('j').querySelector('button').dispatch('click');
  assert.deepEqual(calls, [{ taskKey: 'pr-demo#99', pr: 15 }]);
  // 整页：地址带 focus= 时在需要确认视图上叠加抽屉
  const page2 = linePage(checkState({ focus: 'pr-demo#3' }), checkBoard());
  assert.ok(page2.querySelector('#v-check'));
  assert.ok(page2.querySelector('aside.drawer'));
});

test('需要确认：选分支线后只列该分支线的任务与 PR，会话类只在「全部」列出；导航计数随之变', () => {
  const state = checkState({ line: 'collab' });
  const root = linePage(state, checkBoard());
  const boxes = root.querySelector('#v-check').querySelectorAll('div.box');
  assert.deepEqual(boxes.map(boxLine), ['仅文档确认 · collab-demo 1', '分支线约定不一致 · #16']);
  assert.equal(root.querySelector('nav').querySelector('span.count').textContent, '2', '仅文档确认也计');
});

test('需要确认 · 实物推算：悬空与在环任务出现在这里（下一步把它们归到「需要确认」）', () => {
  const board = computeBoard([planDoc('cy', '# 环\n\n- [ ] 1 甲（依赖 2）\n- [ ] 2 乙（依赖 1）\n- [ ] 3 丙（依赖 99）\n')], [], [], [], {}, { id: 'demo' }, NOW);
  assert.deepEqual(board.tasks.map((v) => v.next), ['confirm', 'confirm', 'confirm']);
  const root = renderCheck(board, relState(null, { view: 'check' }));
  assert.deepEqual(groupEl(root, 'g').querySelectorAll('div.box').map(boxLine), ['循环依赖 · cy 1', '循环依赖 · cy 2']);
  assert.deepEqual(groupEl(root, 'f').querySelectorAll('div.box').map(boxLine), ['悬空依赖 · cy 3']);
});

// ---------- 任务 6.2：甘特图 ----------

import { renderGantt } from '../web/app.mjs';

const GANTT = `# 甘特演示

## 前置条件

| 编号 | 事项 | 阻塞 |
|---|---|---|
| P1 | sandbox 访问 | 5 |

## 里程碑 M1：已完成

- [x] 1 地基
- [x] 2 墙（依赖 1）

## 里程碑 M2：进行中

- [ ] 3 屋顶（依赖 2）
  - **预计耗时**：2 天
- [ ] 4 装修（依赖 3）
- [ ] 5 要 sandbox（依赖 3）
- [ ] 6 等 5（依赖 5）
`;
// 1 已勾选无 PR 无会话 → 无时间；2 有已合并 PR → 事实段；3 draft PR → 事实到今天 + 预估；4 排在 3 之后、默认工期；5 外部阻塞、6 被传染
const ganttBoard = () => computeBoard([planDoc('gt', GANTT)], [
  mkPr(12, { state: 'MERGED', createdAt: '2026-09-20T08:00:00Z', mergedAt: '2026-09-22T08:00:00Z', mergeCommit: 'd'.repeat(40) }),
  mkPr(13, { isDraft: true, createdAt: '2026-09-25T08:00:00Z' }),
], [], [], { 12: { state: 'synced', reason: null } }, { id: 'demo' }, NOW);
const ganttState = (extra = {}) => relState(null, { view: 'gantt', ...extra });
const glabel = (root, num) => root.querySelectorAll('.gl').find((l) => l.getAttribute('data-key') === `gt#${num}`);
const grow = (root, num) => root.querySelectorAll('g.gr').find((g) => g.getAttribute('data-key') === `gt#${num}`);
const glabelOf = (root, text) => root.querySelectorAll('.gl').find((l) => l.querySelector('.tt')?.textContent === text || l.textContent.startsWith(`▸${text}`) || l.textContent.startsWith(`▾${text}`));
const mockGantt = MOCK.slice(MOCK.indexOf('function renderGantt'), MOCK.indexOf('function hl('));

test('甘特图：导航在总览之后；#/gantt 渲染甘特图并可叠加抽屉；总览「整体进度」卡点进甘特', () => {
  globalThis.location = { hash: '' };
  assert.deepEqual(VIEWS.map((v) => v.id).slice(0, 3), ['overview', 'gantt', 'graph']);
  assert.equal(parseHash('#/gantt?project=demo').view, 'gantt');
  const root = document.createElement('div');
  root.append(...renderPage({ list: LIST, projectId: 'demo', board: ganttBoard(), state: ganttState({ focus: 'gt#3' }) }));
  assert.ok(root.querySelector('#v-gantt'));
  assert.equal(root.querySelector('#v-overview'), null);
  assert.ok(root.querySelector('aside.drawer'));

  const card = renderOverview(ganttBoard(), relState(null, { line: null })).querySelectorAll('.stat')[0];
  assert.ok(!card.classList.contains('nolink'));
  card.dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'gantt', project: 'demo', focus: null, line: null });
});

test('UI 稿对照：甘特图例（五态色块 + 图标文字、预估斜纹、今天）、缩放「周 / 天 / 月」默认「天」、依赖线开关默认关、说明条', () => {
  const state = ganttState();
  const root = renderGantt(ganttBoard(), state);
  const legend = root.querySelector('.legend');
  const items = legend.children.filter((c) => c.tagName === 'SPAN' && !c.classList.contains('spacer')).map((c) => c.textContent);
  for (const x of ['预估（非事实）', '┃ 今天']) assert.ok(mockGantt.includes(x), `UI 稿图例有「${x}」`);
  assert.deepEqual(items, [...STATUSES.map((s) => `${STATUS_UI[s].icon} ${STATUS_UI[s].text}`), '预估（非事实）', '┃ 今天']);
  assert.deepEqual(legend.querySelectorAll('.sw').map((s) => s.className), ['sw todo', 'sw doing', 'sw review', 'sw merge', 'sw done', 'sw lgest']);

  const mockSeg = /<div class="seg">(.*?)<\/div>/.exec(mockGantt)[1];
  const mockZoom = [...mockSeg.matchAll(/<button( class="on")?>(.)<\/button>/g)].map(([, on, t]) => [t, !!on]);
  const btns = legend.querySelector('.seg').querySelectorAll('button');
  assert.deepEqual(btns.map((b) => [b.textContent, b.classList.contains('on')]), mockZoom);
  assert.deepEqual(mockZoom, [['周', false], ['天', true], ['月', false]]);
  assert.equal(state.ganttZoom, 'day');

  const box = legend.querySelector('input');
  assert.equal(box.parentNode.textContent.trim(), '显示全部依赖线');
  assert.equal(box.hasAttribute('checked'), false);
  const note = root.querySelector('.note').textContent;
  assert.ok(note.startsWith('实色 = 真实发生（开始取 AI 会话或 PR 创建，结束取 PR 合并）。斜纹 = 预估：只按依赖先后排'));
  assert.match(note, /不考虑人力与并发/);
  assert.equal(root.querySelector('.glabels').querySelector('.gh').textContent, '任务（点分组可折叠）');
});

test('甘特缩放：点「周」换 24 px / 天、「月」6 px / 天，按钮高亮随之变；默认「天」40 px / 天', () => {
  const state = ganttState();
  const root = renderGantt(ganttBoard(), state);
  const width = () => Number(root.querySelector('svg').getAttribute('width'));
  const w40 = width();
  root.querySelector('button[data-zoom=week]').dispatch('click');
  assert.equal(state.ganttZoom, 'week');
  assert.equal(width(), (w40 * 24) / 40);
  assert.ok(root.querySelector('button[data-zoom=week]').classList.contains('on'));
  root.querySelector('button[data-zoom=month]').dispatch('click');
  assert.equal(width(), (w40 * 6) / 40);
});

test('甘特横条：事实段实色 gfact、预估段斜纹 gest（不用实色 class）；悬停提示事实与预估措辞不混用；条后「预估 · 默认工期」', () => {
  const root = renderGantt(ganttBoard(), ganttState());
  const r3 = grow(root, '3');
  const fact = r3.querySelector('rect.gfact');
  const est = r3.querySelector('rect.gest');
  assert.equal(fact.getAttribute('class'), 'gfact review');
  assert.equal(est.getAttribute('class'), 'gest review');
  assert.equal(est.getAttribute('fill'), 'url(#gpat-review)', '预估段填斜纹 pattern');
  assert.ok(root.querySelector('pattern#gpat-review'));
  for (const r of root.querySelectorAll('rect.gest')) assert.ok(!r.classList.contains('gfact'), '预估段不带实色 class');

  const tipF = fact.querySelector('title').textContent;
  const tipE = est.querySelector('title').textContent;
  assert.match(tipF, /^事实：开始 09-25 \d\d:\d\d（PR #13）· 至今（尚未完成）$/);
  assert.doesNotMatch(tipF, /预估/);
  assert.match(tipE, /^预估：预估开始 .* → 预估结束 .*（工期：文档预计耗时 16 小时；只按依赖先后排）$/);
  assert.doesNotMatch(tipE, /事实|合并于|至今/);

  assert.equal(r3.querySelector('text.gblab').textContent, '预估');
  const r4 = grow(root, '4');
  assert.equal(r4.querySelector('rect.gfact'), null, '未开始没有事实段');
  assert.equal(r4.querySelector('text.gblab').textContent, '预估 · 默认工期');
  assert.match(r4.querySelector('rect.gest').querySelector('title').textContent, /工期：默认工期/);
  // 今天红线
  assert.ok(root.querySelector('line.gtoday'));
  assert.equal(root.querySelector('text.gtodayt').textContent, '今天');
});

test('甘特无法排期：行内红字写原因、轴上不画；分组行注明预估不含无法排期；全局汇总「无法排期（N）」', () => {
  const root = renderGantt(ganttBoard(), ganttState());
  const lab = (num) => grow(root, num).querySelector('text.gblab');
  assert.equal(lab('5').textContent, '无法排期：外部前置 P1');
  assert.equal(lab('6').textContent, '无法排期：前置 5 无法排期');
  assert.equal(lab('5').querySelector('tspan').getAttribute('class'), 'red');
  assert.equal(grow(root, '5').querySelector('rect.gest'), null);
  assert.equal(grow(root, '5').querySelector('rect.gfact'), null);
  const g2 = glabelOf(root, '里程碑 M2：进行中');
  assert.match(g2.querySelector('.prog').textContent, /^0\/4 · 0% · 预估 \d\d-\d\d（不含 2 个无法排期）$/);
  assert.equal(g2.querySelector('.prog').querySelector('.red').textContent, '（不含 2 个无法排期）');
  assert.match(root.querySelector('.gall').textContent, /^全部 2\/6（33%）· 预估完成 \d\d-\d\d（不含 2 个无法排期任务）· 无法排期（2）· 无时间（1）$/);
});

test('甘特分组：全部完成的分组默认折叠，点开后展开并记进 localStorage；无时间任务收在段末「无时间（N）」可展开', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    const state = ganttState();
    const root = renderGantt(ganttBoard(), state);
    const g1 = glabelOf(root, '里程碑 M1：已完成');
    assert.equal(g1.querySelector('.caret').textContent, '▸', '全部完成默认折叠');
    assert.equal(glabel(root, '2'), undefined);
    assert.equal(glabelOf(root, '里程碑 M2：进行中').querySelector('.caret').textContent, '▾');
    assert.ok(glabel(root, '3'));
    // 标签列与时间轴行数一致（同序、同高）
    assert.equal(root.querySelectorAll('.gl').length, root.querySelectorAll('g.gr').length);

    g1.dispatch('click');
    assert.equal(glabelOf(root, '里程碑 M1：已完成').querySelector('.caret').textContent, '▾');
    assert.deepEqual(JSON.parse(store.get('devboard:gantt-fold:demo')), { 'grp:gt/L9': true });
    assert.ok(glabel(root, '2'));
    assert.equal(glabel(root, '1'), undefined, '无时间的任务不在原位');
    const nt = root.querySelectorAll('.gl.nt')[0];
    assert.equal(nt.textContent, '▸无时间（1）');
    nt.dispatch('click');
    assert.equal(grow(root, '1').querySelector('text.gblab').textContent, '无时间（仅文档确认、无 PR 无会话）');
    assert.equal(grow(root, '1').querySelector('rect.gfact'), null);
    // 事实段已合并：悬停写合并于 + 来源
    assert.match(grow(root, '2').querySelector('rect.gfact').querySelector('title').textContent, /^事实：开始 09-20 .*（PR #12）· 合并于 09-22 .*（PR #12）$/);
    // 下次打开（新 state）从 localStorage 读回
    const again = renderGantt(ganttBoard(), ganttState());
    assert.equal(glabelOf(again, '里程碑 M1：已完成').querySelector('.caret').textContent, '▾');
  } finally {
    delete globalThis.localStorage;
  }
});

test('甘特悬停：前置 / 后续保留、其余变淡，画后续折线箭头；移开清除；「显示全部依赖线」常显；点条或行开任务抽屉', () => {
  globalThis.location = { hash: '' };
  const state = ganttState();
  const root = renderGantt(ganttBoard(), state);
  glabel(root, '3').dispatch('mouseenter');
  assert.ok(glabel(root, '6').classList.contains('dim'));
  assert.ok(grow(root, '6').classList.contains('dim'));
  for (const n of ['3', '4', '5']) assert.ok(!glabel(root, n).classList.contains('dim'), n);
  // 3 → 4 有两端时间，画一条折线 + 箭头；5 无法排期没有横条，不画线
  assert.deepEqual(root.querySelector('g.glinks').children.map((p) => p.getAttribute('class')), ['glink post', 'garr post']);
  glabel(root, '3').dispatch('mouseleave');
  assert.equal(root.querySelectorAll('.dim').length, 0);
  assert.equal(root.querySelector('g.glinks').children.length, 0);

  root.querySelector('input').checked = true;
  root.querySelector('input').dispatch('change');
  assert.equal(state.ganttAllLinks, true);
  assert.ok(root.querySelector('g.glinks').children.length > 0, '开关打开后常显依赖线');

  grow(root, '4').querySelector('rect.gest').dispatch('click');
  assert.deepEqual(parseHash(location.hash), { view: 'gantt', project: 'demo', focus: 'gt#4', line: null });
  glabel(root, '5').dispatch('click');
  assert.equal(parseHash(location.hash).focus, 'gt#5');
});

test('任务抽屉「甘特时间」区：事实（开始 / 合并于 + 来源）、预估（工期来源）、无法排期原因、无时间', () => {
  const board = ganttBoard();
  const kv = (num) => {
    const [, aside] = renderDrawer(board, relState(`gt#${num}`, { view: 'gantt' }), () => {});
    const dl = aside.querySelector('dl.gtime');
    return dl ? dl.children.filter((c) => c.tagName === 'DT').map((dt) => [dt.textContent, nextEl(dt).textContent]) : aside.querySelector('h3').textContent;
  };
  const k3 = kv('3');
  assert.deepEqual(k3.map(([k]) => k), ['事实', '预估']);
  assert.match(k3[0][1], /^开始 09-25 .*（PR #13）· 至今（尚未完成）$/);
  assert.match(k3[1][1], /^预估开始 .*工期：文档预计耗时 16 小时/);
  assert.deepEqual(kv('5'), [['无法排期', '外部前置 P1']]);
  assert.deepEqual(kv('1'), [['无时间', '已完成但没有关联 PR 或会话，没有事实时间，不画在时间轴上']]);
  assert.match(kv('2')[0][1], /合并于 09-22 .*（PR #12）$/);
});

// ---------- 组合筛选、搜索与地址同步（任务 6.6） ----------

import { parseFilters, filterBoard } from '../web/app.mjs';

const FLT = `# 筛选演示

## 里程碑 M1：地基

- [x] 1 已完成
- [ ] 2 有 PR
- [ ] 3 悬空（依赖 9）

## 里程碑 M2：后续

- [ ] 4 未开始
- [x] ~~5 作废~~
`;
// flt：1 已完成（冲突 c）、2 挂 #12 等待合并、3 悬空依赖（冲突 f）、4 未开始、5 作废；other 是另一来源类型、同代号 M1；old 已归档
function fltBoard() {
  const docs = [
    planDoc('flt', FLT),
    planDoc('other', '# 另一份\n\n## 里程碑 M1：别处\n\n- [ ] 1 别处的任务\n', { sourceType: 'adr-dir', sourceLabel: 'ADR' }),
    planDoc('old', '# 旧\n\n- [ ] 1 归档任务\n', { archived: true }),
  ];
  const board = computeBoard(docs, [mkPr(12, { title: 'flt 任务 2' })], [], [], {}, { id: 'demo' }, NOW);
  board.workspaces = [];
  board.freshness.docsReadAt = '2026-09-26T07:59:57.000Z';
  return board;
}
const fltState = (extra = {}) => relState(null, extra);
const fltPage = (state, board = fltBoard()) => {
  const root = document.createElement('div');
  root.append(...renderPage({ list: LIST, projectId: 'demo', board, state }));
  return root;
};
const bigN = (root) => root.querySelector('.stat.big').querySelector('.n').textContent;
const treeRows = (root) => root.querySelector('#tree').querySelectorAll('.row').map((r) => r.querySelector('.id').textContent);
// 下拉的 data-f 在外层 label 上（取其中的 combobox），复选框的在 input 上
const fsel = (root, field) => { const el = root.querySelector(`[data-f=${field}]`); return el.tagName === 'LABEL' ? combo(el) : el; };

test('筛选地址：hashFor 与 parseFilters 互相还原；布尔只在非缺省时写（open=0 表示取消「只看未完成」），非法值当没写', () => {
  const f = { doc: 'flt', src: 'spec-dir', ms: 'M1', status: 'not_started', conflict: true, archived: true, hideVoid: true,
    onlyOpen: false, q: '#12', recentFrom: '2026-09-01', checkType: 'f' };
  const hash = hashFor('gantt', 'demo', 'flt#3', 'personal', f);
  assert.equal(hash, '#/gantt?project=demo&line=personal&doc=flt&src=spec-dir&ms=M1&status=not_started&conflict=1&archived=1&novoid=1&open=0&q=%2312&from=2026-09-01&type=f&focus=flt%233');
  assert.deepEqual(parseFilters(hash), f);
  assert.deepEqual(parseHash(hash), { view: 'gantt', project: 'demo', focus: 'flt#3', line: 'personal' });
  const none = parseFilters('#/overview?project=demo');
  assert.deepEqual(none, { doc: null, src: null, ms: null, status: null, conflict: false, archived: false, hideVoid: false,
    onlyOpen: true, q: '', recentFrom: null, checkType: null });
  assert.equal(hashFor('overview', 'demo', null, null, { ...newState(), ...none }), '#/overview?project=demo', '缺省筛选不进地址');
  assert.deepEqual(parseFilters('#/x?status=toString&from=9月1日'), none);
});

test('筛选下拉：总览工具栏「筛选」（规划文档 / 来源类型 / 里程碑 / 状态 / 有冲突 / 已归档 / 隐藏作废）；改一项写进地址，按地址还原后下拉与计数一致', () => {
  globalThis.location = { hash: '' };
  const state = fltState();
  let root = fltPage(state);
  const menu = root.querySelector('details.fdrop');
  assert.equal(menu.querySelector('summary').textContent, '筛选');
  assert.deepEqual(menu.querySelector('.fpanel').querySelectorAll('label').map((l) => l.childNodes[0].textContent.trim() || l.textContent.trim()),
    ['规划文档', '来源类型', '里程碑', '状态', '只看有冲突的任务', '显示已归档文档', '隐藏作废任务']);
  assert.deepEqual(optTexts(fsel(root, 'doc')), ['全部', 'flt', 'other'], '已归档文档默认不列');
  assert.deepEqual(optTexts(fsel(root, 'src')), ['全部', 'spec', 'ADR']);
  assert.deepEqual(optTexts(fsel(root, 'ms')), ['全部', 'M1', 'M2'], '同代号跨文档合并为一项');
  assert.equal(fsel(root, 'doc').getAttribute('aria-label'), '筛选：规划文档');
  assert.deepEqual(optsOf(fsel(root, 'src')).map((o) => o.getAttribute('title')), [null, 'spec-dir', 'adr-dir'], '来源类型悬停看原名');

  choose(fsel(root, 'doc'), 'flt');
  assert.deepEqual(parseHash(location.hash), { view: 'overview', project: 'demo', focus: null, line: null });
  assert.equal(parseFilters(location.hash).doc, 'flt');
  // 路由：地址 → state → 整页重画
  const restored = { ...fltState(), ...parseFilters(location.hash) };
  root = fltPage(restored);
  assert.equal(root.querySelector('details.fdrop').querySelector('summary').textContent, '筛选（1）');
  assert.deepEqual(chosen(fsel(root, 'doc')), ['flt']);
  assert.deepEqual(optTexts(fsel(root, 'doc')), ['全部', 'flt', 'other'], '选中后仍能改选别的文档');
  assert.deepEqual(optTexts(fsel(root, 'ms')), ['全部', 'M1', 'M2']);

  const box = fsel(root, 'conflict');
  box.checked = true;
  box.dispatch('change');
  assert.match(location.hash, /doc=flt&conflict=1/);
  root = fltPage({ ...fltState(), ...parseFilters(location.hash) });
  const clear = root.querySelector('.fpanel').querySelectorAll('button').find((b) => b.textContent === '清除筛选');
  clear.dispatch('click');
  assert.equal(location.hash, '#/overview?project=demo');
});

test('筛选随视图切换、打开抽屉、切分支线一起留在地址里；本项目没有的文档 / 里程碑当没选', () => {
  globalThis.location = { hash: '' };
  const state = fltState({ doc: 'flt', status: 'not_started' });
  const root = fltPage(state);
  root.querySelector('nav').querySelectorAll('button').find((b) => b.getAttribute('data-v') === 'gantt').dispatch('click');
  assert.equal(parseHash(location.hash).view, 'gantt');
  assert.deepEqual([parseFilters(location.hash).doc, parseFilters(location.hash).status], ['flt', 'not_started']);
  rowOf(root, '3').querySelector('button.task-detail').dispatch('click');
  assert.deepEqual([parseHash(location.hash).focus, parseFilters(location.hash).doc], ['flt#3', 'flt']);
  root.querySelector('.stat.big').dispatch('click');
  assert.equal(parseFilters(location.hash).status, 'not_started', '数字卡进甘特也带着筛选');

  const bad = fltState({ doc: 'nope', ms: 'M9' });
  fltPage(bad);
  assert.deepEqual([bad.doc, bad.ms], [null, null]);
});

test('组合筛选：数字卡、文档进度、甘特分组与全局汇总都按可见任务重算；文档级与任务级条件可叠加', () => {
  const all = fltPage(fltState());
  assert.equal(bigN(all), '20%', '未筛选：1 / 5（作废与归档不计）');
  const m1 = fltPage(fltState({ ms: 'M1' }));
  assert.equal(bigN(m1), '25%', '里程碑 M1 跨两份文档：flt 1、2、3 + other 1');
  assert.deepEqual(treeRows(m1), ['1', '2', '3', '1'], '按里程碑筛选时不按「全部完成」折叠');
  const combo = fltPage(fltState({ ms: 'M1', src: 'spec-dir' }));
  assert.equal(bigN(combo), '33%');
  assert.match(combo.querySelector('.side').textContent, /flt1\/3 · 33%/, '右栏各份文档进度随之重算');
  assert.ok(!combo.querySelector('.side').textContent.includes('other'));

  const gantt = fltPage(fltState({ view: 'gantt', doc: 'flt', status: 'done' }));
  assert.match(gantt.querySelector('.gall').textContent, /^全部 1\/1（100%）/);
  const g1 = gantt.querySelectorAll('.gl.g2');
  assert.deepEqual(g1.map((g) => g.querySelector('.tt').textContent), ['里程碑 M1：地基'], '没剩任务的分组不画');
  assert.match(g1[0].querySelector('.prog').textContent, /^1\/1 · 100%/);
  const gAll = fltPage(fltState({ view: 'gantt', doc: 'flt' }));
  assert.match(gAll.querySelectorAll('.gl.g2')[0].querySelector('.prog').textContent, /^1\/3 · 33%/);
});

test('组合筛选：有冲突只留带冲突的任务（仅文档确认不算）；已归档默认隐藏、可筛出并标「已归档」；可隐藏作废任务', () => {
  const c = fltPage(fltState({ conflict: true }));
  assert.deepEqual(treeRows(c), ['3']);
  assert.equal(c.querySelector('#tree').querySelectorAll('.doc').length, 1, '没剩任务的文档整份不显示');

  assert.ok(!docOf(fltPage(fltState()), 'old'));
  const arch = fltPage(fltState({ archived: true }));
  const old = docOf(arch, 'old');
  assert.ok(old.querySelector('.flag').textContent === '已归档');
  assert.equal(bigN(arch), '16%', '显示已归档后计入统计：1 / 6');

  assert.ok(rowOf(fltPage(fltState()), '5').classList.contains('void'), '作废默认显示');
  assert.equal(rowOf(fltPage(fltState({ hideVoid: true })), '5'), undefined);
});

test('组合筛选：关系图、下一步、需要确认按同一范围', () => {
  const graph = fltPage(fltState({ view: 'graph', src: 'adr-dir' }));
  assert.deepEqual(optTexts(combo(graph.querySelector('#v-graph'), '文档')), ['other']);
  const next = fltPage(fltState({ view: 'next', doc: 'other' }));
  assert.deepEqual(next.querySelectorAll('.tk').map((t) => t.querySelector('.top').textContent.replace(/^.*?(?=other)/, '')), ['other · 1']);
  const check = fltPage(fltState({ view: 'check', status: 'done' }));
  assert.deepEqual(check.querySelectorAll('.box').map((b) => b.getAttribute('data-type')), ['c']);
});

test('搜索：提示「编号 / 标题 / PR 号」；按 PR 号（带不带 #）命中挂该 PR 的任务；搜索词逐字写进地址（不整页重画）', () => {
  globalThis.location = { hash: '#/overview?project=demo' };
  globalThis.history = { state: null, replaceState: (_s, _t, url) => { location.hash = url; } };
  try {
    const state = fltState();
    const root = fltPage(state);
    const input = root.querySelector('input[type=search]');
    assert.equal(input.getAttribute('placeholder'), '搜索编号 / 标题 / PR 号');
    input.value = '#12';
    input.dispatch('input');
    assert.deepEqual(treeRows(root), ['2']);
    assert.equal(parseFilters(location.hash).q, '#12');
    input.value = '12';
    input.dispatch('input');
    assert.deepEqual(treeRows(root), ['2']);
    input.value = '3';
    input.dispatch('input');
    assert.deepEqual(treeRows(root), ['3'], '纯数字仍按编号找');
    assert.equal(root.querySelector('input[type=search]'), input, '只重画任务树，搜索框还是原来那个节点');

    // 起始日、需要确认的类型、只看未完成同样写进地址
    pickDate(root.querySelector('[aria-label=起始日]'), '2026-09-01');
    assert.equal(parseFilters(location.hash).recentFrom, '2026-09-01');
    const only = root.querySelector('input[type=checkbox]');
    only.checked = false;
    only.dispatch('change');
    assert.equal(parseFilters(location.hash).onlyOpen, false);
    const cstate = fltState({ view: 'check' });
    choose(combo(renderCheck(fltBoard(), cstate), '类型'), `${CONFLICT_TEXT.f}（1）`);
    assert.equal(parseFilters(location.hash).checkType, 'f');
  } finally {
    delete globalThis.history;
  }
});

test('甘特说明条：写出配置里的每日工时与默认工期（Board.defaults）；没有时按 8 小时 / 1 天', () => {
  const board = fltBoard();
  const note = (b) => renderGantt(b, fltState({ view: 'gantt' })).querySelector('.note').textContent;
  assert.match(note(board), /按每日 8 小时换算.*默认工期 1 天/);
  board.defaults = { hoursPerDay: 6, defaultDurationDays: 2 };
  assert.match(note(board), /按每日 6 小时换算.*默认工期 2 天/);
});

test('性能：40 份文档 × 30 个任务、400 个 PR 上，组合筛选 + 统计重算 + 总览渲染在 300 ms 以内（需求 17.3）', () => {
  const docs = [];
  for (let d = 0; d < 40; d++) {
    let text = `# 大样本 ${d}\n\n## 里程碑 M${d % 4}：阶段\n\n`;
    for (let i = 1; i <= 30; i++) text += `- [${i % 3 === 0 ? 'x' : ' '}] ${i} 任务 ${i}${i > 1 ? `（依赖 ${i - 1}）` : ''}\n`;
    docs.push(planDoc(`big-${String(d).padStart(2, '0')}`, text, { sourceType: d % 2 ? 'spec-dir' : 'task-list' }));
  }
  const prs = Array.from({ length: 400 }, (_, i) => mkPr(100 + i, { title: `big-${String(i % 40).padStart(2, '0')} 任务 ${(i % 30) + 1}` }));
  const board = computeBoard(docs, prs, [], [], {}, { id: 'demo' }, NOW);
  assert.ok(board.tasks.filter((v) => v.prs.length).length >= 100, '夹具 PR 确实关联上任务');
  const state = fltState({ ms: 'M1', src: 'spec-dir', status: 'not_started', q: '任务' });
  const t0 = performance.now();
  const shown = filterBoard(board, state);
  const root = fltPage(state, board);
  const ms = performance.now() - t0;
  assert.ok(shown.docs.length === 10 && shown.docs.every((d) => d.tasks.every((t) => board.tasks.find((v) => v.key === t.key).status === 'not_started')));
  assert.ok(root.querySelector('#tree').querySelectorAll('.row').length > 0);
  assert.ok(ms < 300, `耗时 ${ms.toFixed(1)} ms`);
});

// ---------- 任务 6.7：UI 稿对照收尾走查 ----------

// UI 稿里某个渲染函数的源码片段（到下一个顶层 function 为止）
const mockFn = (name) => { const s = MOCK.slice(MOCK.indexOf(`function ${name}(`)); return s.slice(0, s.indexOf('\nfunction ', 1)); };
// 片段里某个标签的开头文字（「<h2>▶ 可开工 <span…」→「▶ 可开工」；模板插值前截断）
const mockHeads = (src, tag) => [...src.matchAll(new RegExp(`<${tag}[^>]*>([^<$]+)`, 'g'))].map((m) => m[1].trim()).filter(Boolean);
const headsOf = (root, sel) => texts(root.querySelectorAll(sel)).map((t) => t.trim());

test('UI 稿对照收尾：导航六项的 data-v 与文字、次序和 UI 稿完全一致', () => {
  const nav = /<nav id="nav">([\s\S]*?)<\/nav>/.exec(MOCK)[1];
  const mock = [...nav.matchAll(/<button data-v="(\w+)"[^>]*>([^<]+)/g)].map(([, v, t]) => [v, t.trim()]);
  assert.deepEqual(VIEWS.map((v) => [v.id, v.text]), mock);
});

test('UI 稿对照收尾：六个视图与任务 / PR 两种抽屉的关键区块齐全（区块标题取自 UI 稿）', () => {
  globalThis.location = { hash: '' };
  const page = (view, focus = null) => linePage(prState({ view, focus }));
  const checkSrc = mockFn('renderCheck');
  const want = {
    overview: ['h2', mockHeads(mockFn('renderOverview'), 'h2')],
    next: ['h2', mockHeads(mockFn('renderNext'), 'h2')],
    check: ['h2', mockHeads(checkSrc.slice(0, checkSrc.indexOf("'v-diag'")), 'h2')],
    diag: ['dt', mockHeads(checkSrc.slice(checkSrc.indexOf("'v-diag'")), 'dt')],
  };
  assert.deepEqual(want.overview[1], ['任务', '这几天发生了什么', '未关联任务的 PR', '各份文档进度']);
  assert.equal(want.next[1].length, 4);
  for (const [view, [sel, heads]] of Object.entries(want)) {
    const sec = page(view).querySelector(`#v-${view}`);
    assert.ok(sec, `#v-${view}`);
    const got = headsOf(sec, sel);
    for (const t of heads) assert.ok(got.some((g) => g.startsWith(t)), `${view} 缺「${t}」：${JSON.stringify(got)}`);
  }
  // 甘特图：缩放「周 / 天 / 月」+ 标签列与时间轴；关系图：文档下拉 + 图例 + SVG
  const gantt = page('gantt').querySelector('#v-gantt');
  assert.deepEqual(headsOf(gantt.querySelector('.seg'), 'button'), ['周', '天', '月']);
  assert.ok(gantt.querySelector('.gantt') && gantt.querySelector('svg'));
  const graph = page('graph').querySelector('#v-graph');
  assert.ok(combo(graph, '文档') && graph.querySelector('svg'));

  // 任务抽屉：UI 稿 openTask 的键值区与三个小节；PR 抽屉：PR 详情的键值区
  const drawerSrc = mockFn('openTask');
  const task = page('overview', 'pr-demo#3').querySelector('aside.drawer');
  const dts = headsOf(task, 'dt');
  for (const t of mockHeads(drawerSrc, 'dt').filter((x) => x !== '外部阻塞')) assert.ok(dts.includes(t), `任务抽屉缺「${t}」`);
  assert.deepEqual(mockHeads(drawerSrc, 'h3').filter((t) => !headsOf(task, 'h3').includes(t)), [], '任务抽屉小节');
  const pr = page('overview', '#13').querySelector('aside.drawer');
  assert.equal(pr.getAttribute('aria-label'), 'PR 详情');
  assert.deepEqual(headsOf(pr, 'dt'), ['分支', '状态', '时间线', '本地同步', 'GitHub']);
});

test('UI 稿对照收尾：UI 稿的窄屏规则（max-width 媒体查询）在 style.css 里原样存在', () => {
  const rules = (css) => [...css.matchAll(/@media \(max-width:\d+px\)\{(?:[^{}]*\{[^}]*\})+[^{}]*\}|@media \(max-width:\d+px\)\{[^{}]*\{[^}]*\}\}/g)]
    .map((m) => m[0].replace(/\s+/g, ''));
  const mock = [...new Set(rules(MOCK))];
  assert.ok(mock.length >= 3, `抽到 ${mock.length} 条`);
  const css = new Set(rules(read('../web/style.css')));
  for (const r of mock) assert.ok(css.has(r), `缺窄屏规则 ${r}`);
});

test('无任务的 ADR / 规划中文档：标题行不画折叠三角（没有可折叠的内容）', () => {
  const root = overview();
  const plan = docOf(root, 'plan-only');
  assert.equal(plan.querySelector('.caret').textContent, '');
  assert.equal(docOf(root, 'demo').querySelector('.caret').textContent, '▾');
});

test('父任务可收起子任务（需求 10.2）：默认展开；点三角只折叠、不开抽屉；有搜索词时全展开', () => {
  globalThis.location = { hash: '' };
  const state = newState(NOW.getTime());
  state.onlyOpen = false; // 让「全部完成」的 M1 分组展开，看得到 1 的子任务
  const root = overview(state);
  const demoRow = (n) => docOf(root, 'demo').querySelectorAll('.row').find((r) => r.querySelector('.id').textContent === n);
  const ids = () => texts(docOf(root, 'demo').querySelectorAll('.row').map((r) => r.querySelector('.id')));
  assert.deepEqual(ids().filter((n) => n.startsWith('1')), ['1', '1.1', '1.2'], '默认展开');
  assert.equal(demoRow('1.1').querySelector('.tcaret'), null, '子任务没有三角');
  const caret = demoRow('1').querySelector('.tcaret');
  assert.equal(caret.textContent, '▾');
  caret.dispatch('click');
  assert.deepEqual(ids().filter((n) => n.startsWith('1')), ['1'], '收起后只剩父任务');
  assert.equal(demoRow('1').querySelector('.tcaret').textContent, '▸');
  assert.equal(location.hash, '', '点三角不打开任务抽屉');
  assert.ok(state.toggled.has('task:demo#1'));
  state.q = '子任务';
  assert.deepEqual(texts(docOf(renderOverview(fixtureBoard(), state), 'demo').querySelectorAll('.row').map((r) => r.querySelector('.id'))), ['1.1', '1.2'],
    '有搜索词时命中的子任务照常显示');
});

test('N1：任务抽屉与统计区分关联 PR 合并和文档确认完成', () => {
  const p = { number: 77, title: '任务 1', body: '', url: '', state: 'MERGED', isDraft: false, baseRefName: 'main', headRefName: 'b77',
    labels: [], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', readyAt: null, mergedAt: '2026-09-22T00:00:00Z',
    closedAt: null, mergeCommit: 'a'.repeat(40) };
  const board = computeBoard([planDoc('p', '# P\n\n- [ ] 1 甲\n')], [p], [], [], { 77: { state: 'synced' } }, { id: 'demo' }, NOW);
  const [, aside] = renderDrawer(board, prState({ focus: 'p#1' }), () => {});
  assert.match(aside.textContent, /相关 PR 已合并.*文档尚未勾选.*进行中/);
  assert.doesNotMatch(aside.textContent, /还没有 PR/);
  assert.equal(renderOverview(board, prState()).querySelector('.stat').querySelector('.n').textContent, '0%');
});

test('「任务 N（部分）」：任务抽屉的状态依据写明部分 PR 已合并，PR 框的来源标「部分」', () => {
  const p = { number: 77, title: 'fix: 探针', body: '任务 1（部分）', url: '', state: 'MERGED', isDraft: false, baseRefName: 'main', headRefName: 'b77',
    labels: [], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', readyAt: null, mergedAt: '2026-09-22T00:00:00Z',
    closedAt: null, mergeCommit: 'a'.repeat(40) };
  const board = computeBoard([planDoc('p', '# P\n\n- [ ] 1 甲\n')], [p], [], [], { 77: { state: 'synced', reason: null } }, { id: 'demo' }, NOW);
  const [, aside] = renderDrawer(board, prState({ focus: 'p#1' }), () => {});
  assert.match(aside.textContent, /PR #77 标了「部分」、已合并.*文档尚未勾选.*进行中/);
  assert.doesNotMatch(aside.textContent, /还没有 PR/);
  const box = nextEl(aside.querySelectorAll('h3').find((x) => x.textContent === 'PR'));
  assert.match(box.querySelector('.src').textContent, /^来源：PR 描述里的「任务 1（部分）」 · 部分：这个 PR 只做了一部分，合并后不算完成/);
});

import { mdBlock } from '../web/app.mjs';

test('正文 Markdown 子集：嵌套列表、复选框、行内代码 / 加粗 / 删除线 / 链接、代码块、引用、段落与续行', () => {
  const md = mdBlock([
    '  - 拷 `run_engine.py` 骨架；**不拷** `image_backends/`',
    '    - **实测结果(物质证据)**：① `import` 均过；② **forked `svg_export.py` 真出 PNG**',
    '      续行接在上一项里',
    '  - [x] 已验',
    '  - ~~作废的做法~~ 见 [文档](https://example.com/a) 与 [本地](docs/x.md)',
    '  1. 第一步',
    '',
    '  > 注意：*.mjs 不是斜体',
    '  ```',
    '  const a = 1;',
    '  ```',
    '  普通段落',
  ]);
  const [ul, ol] = md.children.filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
  assert.deepEqual([ul.tagName, ul.children.length, ol.tagName], ['UL', 3, 'OL']);
  const first = ul.children[0];
  assert.deepEqual(texts(first.querySelectorAll('code')), ['run_engine.py', 'image_backends/', 'import', 'svg_export.py']);
  assert.equal(first.querySelector('ul').children.length, 1, '更深缩进的列表嵌在上一项里');
  const nested = first.querySelector('ul').children[0];
  assert.deepEqual(texts(nested.querySelectorAll('b')), ['实测结果(物质证据)', 'forked svg_export.py 真出 PNG']);
  assert.equal(nested.querySelectorAll('b')[1].querySelector('code').textContent, 'svg_export.py', '加粗里的代码照样认');
  assert.equal(nested.querySelectorAll('br').length, 1, '续行接在同一项里并换行');
  assert.equal(ul.children[1].querySelector('.box').textContent, '☑');
  const links = ul.children[2].querySelectorAll('a');
  assert.deepEqual([links.length, links[0].getAttribute('href'), ul.children[2].querySelector('s').textContent], [1, 'https://example.com/a', '作废的做法'],
    '只有 http(s) 链接变成超链接');
  assert.match(ul.children[2].textContent, /与 本地$/);
  assert.equal(md.querySelector('blockquote').textContent, '注意：*.mjs 不是斜体');
  assert.equal(md.querySelector('pre').querySelector('code').textContent, 'const a = 1;\n');
  assert.equal(md.children.at(-1).textContent, '普通段落');
});

test('任务抽屉标题按行内 Markdown 显示：** 与反引号不再原样露出', () => {
  const board = computeBoard([planDoc('p', '# P\n\n- [x] 0.1 fork 到 `ext/skill/` —— ✅ **2026-06-27 完成**\n')], [], [], [], {}, { id: 'demo' }, NOW);
  const [, aside] = renderDrawer(board, prState({ focus: 'p#0.1' }), () => {});
  const h2 = aside.querySelector('h2');
  assert.equal(h2.textContent, '0.1　fork 到 ext/skill/ —— ✅ 2026-06-27 完成');
  assert.deepEqual([h2.querySelector('code').textContent, h2.querySelector('b').textContent], ['ext/skill/', '2026-06-27 完成']);
});

// ---------- N12：Markdown 超出子集时不静默走样（A 常见写法补齐，B 其余照原文并标明、诊断报出） ----------
import { mdText, mdUnrenderedLines } from '../web/md.mjs';

const mdOne = (line) => mdBlock([line]).children[0];
const RAW = '此处未按 Markdown 渲染';

test('N12 行内斜体：只认下划线、两侧不贴字母数字；snake_case / __tests__ / *.mjs / cron */5 / 1.2~1.8 照字面', () => {
  const p = mdOne('_Requirements: 4.1, 4.5_ 与 _验收: **甲** 通过_');
  assert.deepEqual(texts(p.querySelectorAll('i')), ['Requirements: 4.1, 4.5', '验收: 甲 通过']);
  assert.equal(p.textContent, 'Requirements: 4.1, 4.5 与 验收: 甲 通过');
  assert.equal(p.querySelectorAll('i')[1].querySelector('b').textContent, '甲', '斜体里照样认加粗');
  for (const s of ['snake_case_name 和 native_x_y', '__tests__ 与 __x__', '`*.mjs` 与 *.mjs 与 changePlan.*', 'cron */5 与 (R1.*, R2.4)', '1.2~1.8 与 a~b']) {
    const el = mdOne(s);
    assert.equal(el.querySelector('i'), null, s);
    assert.equal(el.querySelector('b'), null, s);
    assert.equal(el.querySelector('s'), null, s);
    assert.equal(el.textContent, s.replaceAll('`', ''), s);
    assert.equal(el.querySelector('.mdraw'), null, `${s} 是正常文字，不标未渲染`);
  }
  assert.equal(mdText('**甲** _乙_ `_丙_` snake_case'), '甲 乙 _丙_ snake_case', '纯文本同一解析：斜体去记号，代码里照字面');
});

test('N12 GFM 表格：表头、对齐、单元格行内 Markdown、\\| 字面竖线；包在可横向滚动的容器里', () => {
  const md = mdBlock([
    '- 对照表：',
    '  | 名称 | 数量 | 说明 |',
    '  |:-----|-----:|:----:|',
    '  | `a` | 3 | **重点** 与 x \\| y |',
    '  | 第二行 | 4 | 换行<br>写法 |',
    '之后的段落',
  ]);
  const wrap = md.querySelector('.mdtable');
  assert.ok(wrap, '表格包在 .mdtable 里');
  assert.equal(wrap.parentNode.tagName, 'LI', '缩进在列表项下的表格挂在该项里');
  assert.deepEqual(texts(wrap.querySelectorAll('th')), ['名称', '数量', '说明']);
  assert.deepEqual(wrap.querySelectorAll('th').map((c) => c.style.getPropertyValue('text-align')), ['left', 'right', 'center']);
  const rows = wrap.querySelector('tbody').querySelectorAll('tr');
  assert.equal(rows.length, 2);
  const cells = rows[0].querySelectorAll('td');
  assert.equal(cells.length, 3, '\\| 不分列');
  assert.equal(cells[0].querySelector('code').textContent, 'a');
  assert.equal(cells[2].querySelector('b').textContent, '重点');
  assert.equal(cells[2].textContent, '重点 与 x | y');
  assert.equal(rows[1].querySelectorAll('td')[2].textContent, `换行<br>写法${RAW}`, '单元格里的 HTML 照原文并标明');
  assert.equal(md.children.at(-1).textContent, '之后的段落');
  // 没有分隔行 / 列数对不上就不是表格，照普通文字
  assert.equal(mdBlock(['a | b', 'c | d']).querySelector('table'), null);
  assert.equal(mdBlock(['| a | b |', '|---|']).querySelector('table'), null);
  // 表格遇到新块就结束（PR #42 review）：后面的列表项 / 引用 / 围栏即使含 | 也交回外层，不吞进表格
  const tbl = ['- 父项', '  | 说明 | 值 |', '  |---|---|', '  | data | x |'];
  const next = mdBlock([...tbl, '- 另一项 | 带竖线']);
  assert.deepEqual(texts(next.querySelector('ul').children), ['父项说明值datax', '另一项 | 带竖线'], '缩进退出的列表项另起一项');
  assert.equal(next.querySelector('tbody').querySelectorAll('tr').length, 1);
  const quote = mdBlock([...tbl, '  > 引用 | 带竖线']);
  assert.equal(quote.querySelectorAll('blockquote').length, 1);
  assert.equal(quote.querySelector('tbody').querySelectorAll('tr').length, 1);
  const fenced = mdBlock([...tbl, '  ```', '  a | b', '  ```']);
  assert.equal(fenced.querySelector('pre').textContent, 'a | b\n');
  assert.equal(fenced.querySelector('tbody').querySelectorAll('tr').length, 1);
  assert.equal(mdBlock([...tbl, '  - 子项 | 带竖线']).querySelector('tbody').querySelectorAll('tr').length, 1, '同缩进的子列表项也结束表格');
});

test('N12 引用：连续 > 行合成一个引用，里面按块排（列表）；列表项下缩进的 > 不再露出字面「>」', () => {
  const md = mdBlock([
    '> 第一行',
    '> 第二行 _斜体_',
    '> - 引用里的列表项',
    '> - 第二项',
    '',
    '- 列表项',
    '  > 挂在列表项下的引用',
  ]);
  const quotes = md.querySelectorAll('blockquote');
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].parentNode, md, '连续的 > 行只成一个引用');
  assert.equal(quotes[0].querySelector('p').textContent, '第一行第二行 斜体');
  assert.equal(quotes[0].querySelector('i').textContent, '斜体');
  assert.deepEqual(texts(quotes[0].querySelector('ul').querySelectorAll('li')), ['引用里的列表项', '第二项']);
  assert.equal(quotes[1].parentNode.tagName, 'LI');
  assert.equal(quotes[1].textContent, '挂在列表项下的引用');
  assert.ok(!md.textContent.includes('>'));
});

test('N12 代码块：保留围栏内的相对缩进，认 ~~~ 围栏；围栏里的写法不当 Markdown 也不标', () => {
  const md = mdBlock([
    '- 步骤',
    '  ```js',
    '  if (a) {',
    '    run(*.mjs, _x_);',
    '  }',
    '  ```',
    '~~~',
    '<br> ![图](a.png)',
    '~~~',
  ]);
  const [a, b] = md.querySelectorAll('pre');
  assert.equal(a.textContent, 'if (a) {\n  run(*.mjs, _x_);\n}\n');
  assert.equal(b.textContent, '<br> ![图](a.png)\n');
  assert.equal(md.querySelector('.mdraw'), null);
  assert.deepEqual(mdUnrenderedLines(['```', '<br>', '```', '~~~~', '# 不是标题', '~~~~']), []);
});

test('N12 认不了的写法照原文显示并标「此处未按 Markdown 渲染」；<v> / <id> / <docRef> 占位符与行内代码里的不标', () => {
  const lines = [
    '- 实测：',
    '  #### 实测记录',
    '  - 截图 ![界面](shot.png)',
    '---',
    '说明见脚注[^1]',
    '[^1]: 脚注内容',
    '第一行<br>第二行',
    '用 <v>、<id>、<docRef> 占位，`<br>` 与 `![x](y)` 在代码里',
    'a <= b 且 c > d',
  ];
  const md = mdBlock(lines);
  const marked = md.querySelectorAll('.mdraw');
  assert.ok(marked.every((m) => m.textContent === RAW));
  const before = (m) => m.parentNode.childNodes[m.parentNode.childNodes.indexOf(m) - 1].textContent;
  assert.deepEqual(marked.map(before),
    ['#### 实测记录', '截图 ![界面](shot.png)', '---', '说明见脚注[^1]', '[^1]: 脚注内容', '第一行<br>第二行'],
    '照原文显示：图片不变成链接、标题不吞掉 #、HTML 不变成节点');
  assert.equal(md.children.at(-1).textContent, '说明见脚注[^1]' + RAW + '[^1]: 脚注内容' + RAW + '第一行<br>第二行' + RAW
    + '用 <v>、<id>、<docRef> 占位，<br> 与 ![x](y) 在代码里a <= b 且 c > d', '其余照段落续行，占位符与比较号不标');
  assert.equal(md.querySelector('a'), null);
  assert.equal(md.querySelector('img'), null);
  assert.equal(md.querySelector('hr'), null);
  // 服务端诊断与页面标记同一口径
  assert.deepEqual(mdUnrenderedLines(lines).map((x) => [x.i, x.kind]),
    [[1, 'heading'], [2, 'image'], [3, 'hr'], [4, 'footnote'], [5, 'footnote'], [6, 'html']]);
});

test('N12 分组标题、文档标题走同一行内 Markdown：HTML 处渲染，悬停取纯文本', () => {
  const docs = [
    planDoc('n12', '# 计划 `core` 模块\n\n## **里程碑 M1**：_地基_\n\n- [ ] 1 第一项\n'),
    { docId: 'ADR-0001-x', sourceType: 'adr-dir', sourceLabel: 'ADR', path: 'docs/adr/ADR-0001-x.md', workspaceId: 'repo',
      archived: false, ...parseAdrDoc('# ADR-0001: 用 `h()` 建节点\n\n- **状态**: 已采纳\n', 'ADR-0001-x') },
  ];
  const board = computeBoard(docs, [], [], [], {}, { id: 'demo' }, NOW);
  const state = () => ({ ...newState(NOW.getTime()), project: 'demo', onlyOpen: false });
  const root = renderOverview(board, state());
  const heads = root.querySelectorAll('.lv1');
  const docHead = heads.find((x) => x.textContent.includes('n12'));
  const adrHead = heads.find((x) => x.textContent.includes('ADR-0001'));
  assert.equal(docHead.querySelector('.gname').getAttribute('title'), '计划 core 模块');
  const grp = root.querySelector('.lv2').querySelector('.gname');
  assert.equal(grp.textContent, '里程碑 M1：地基');
  assert.equal(grp.querySelector('b').textContent, '里程碑 M1');
  assert.equal(grp.querySelector('i').textContent, '地基');
  assert.equal(adrHead.querySelector('.gname').querySelector('code').textContent, 'h()');
  const gantt = renderGantt(board, state());
  const g2 = gantt.querySelector('.g2').querySelector('.tt');
  assert.deepEqual([g2.textContent, g2.getAttribute('title'), g2.querySelector('b').textContent], ['里程碑 M1：地基', '里程碑 M1：地基', '里程碑 M1']);
  assert.equal(gantt.querySelector('.g1').querySelector('.tt').getAttribute('title'), '计划 core 模块');
  const [, drawer] = renderDrawer(board, { ...state(), focus: 'n12#1' }, () => {});
  const crumb = drawer.querySelector('.crumb');
  assert.deepEqual([crumb.textContent, crumb.querySelector('b').textContent], ['n12 · 里程碑 M1：地基', '里程碑 M1']);
});

test('N12 诊断：正文里认不了的写法按「第 8 条 Markdown 写法」报出文档与行号，附改写建议；与抽屉标记一致', () => {
  const lines = ['# 演示', '', '- [ ] 1 第一项', '  - 截图 ![图](a.png)', '  ```', '  <br> 在代码里', '  ```', '  用 <v> 占位',
    '- [ ] 2 第二项', '  #### 记录', '  第一行<br>第二行'];
  const doc = planDoc('n12-diag', lines.join('\n'));
  assert.deepEqual(doc.parse.unrenderedMarkdown.map((x) => [x.line, x.kind]), [[4, 'image'], [10, 'heading'], [11, 'html']]);
  const board = computeBoard([doc], [], [], [], {}, { id: 'demo' }, NOW);
  assert.deepEqual(board.diagnostics.convention.map((x) => [x.rule, x.line]), [[8, 4], [8, 10], [8, 11]]);
  const kv = kvOf(renderDiag(board, newState(NOW.getTime())));
  assert.match(kv.get('不满足约定').textContent, /^3 处（Markdown 写法 3）/);
  assert.deepEqual(texts(kv.get('不满足约定').querySelectorAll('li')), [
    '第 8 条 Markdown 写法 · n12-diag 第 4 行：图片不按 Markdown 渲染，照原文显示；建议改成链接 [说明](地址)',
    '第 8 条 Markdown 写法 · n12-diag 第 10 行：正文里的标题不按 Markdown 渲染，照原文显示；建议改成加粗行',
    '第 8 条 Markdown 写法 · n12-diag 第 11 行：HTML 标签不按 Markdown 渲染，照原文显示；建议改成 Markdown 写法，或放进行内代码',
  ]);
  const marks = doc.tasks.map((x) => mdBlock(lines.slice(x.bodyRange[0], x.bodyRange[1])).querySelectorAll('.mdraw').length);
  assert.deepEqual(marks, [1, 2]);
});

test('N6：各视图任务标题复用行内 Markdown，悬停 / SVG 去格式且保留代码内标记与原始数据', () => {
  const title = '**甲 `*.mjs`** ~~旧~~ [文档](https://example.com) `**代码**` <img> 未闭合**';
  const plain = '甲 *.mjs 旧 文档 **代码** <img> 未闭合**';
  const board = computeBoard([planDoc('p', `# P\n\n- [ ] 0.1 ${title}\n- [ ] 0.2 后续（依赖 0.1）\n`)], [], [], [], {}, { id: 'demo' }, NOW);
  board.conflicts.push({ type: 'a', taskKey: 'p#0.1', detail: '测试冲突' });
  const original = JSON.stringify(board);
  const state = () => ({ ...newState(NOW.getTime()), project: 'demo', onlyOpen: false });
  const overviewTitle = rowOf(renderOverview(board, state()), '0.1').querySelector('.title');
  const nextTitle = renderNext(board, state()).querySelector('.tk').querySelector('.tt');
  const ganttTitle = renderGantt(board, state()).querySelector('.gl[data-key="p#0.1"]');
  const [, drawer] = renderDrawer(board, { ...state(), focus: 'p#0.2' }, () => {});
  for (const el of [overviewTitle, nextTitle, ganttTitle.querySelector('.tt')]) {
    assert.equal(el.textContent, plain);
    assert.equal(el.querySelector('b').textContent, '甲 *.mjs');
    assert.deepEqual(texts(el.querySelectorAll('code')), ['*.mjs', '**代码**']);
    assert.equal(el.querySelector('img'), null, 'HTML 原文仍是文本');
  }
  assert.equal(overviewTitle.getAttribute('title'), plain);
  assert.equal(nextTitle.getAttribute('title'), plain);
  assert.equal(ganttTitle.getAttribute('title'), `0.1 ${plain} · 未开始`);
  assert.equal(drawer.querySelector('.rels').querySelector('a').getAttribute('title'), plain);
  assert.equal(renderCheck(board, state()).querySelector('.box[data-type=a]').getAttribute('title'), plain);
  const graph = renderGraph(board, state()).querySelector('.gnode[data-id="p#0.1"]');
  assert.equal(graph.querySelector('title').textContent, `0.1 ${plain} · 未开始`);
  assert.equal(graph.querySelector('text').textContent, `0.1  ○ ${Array.from(plain).slice(0, 11).join('')}…`, '去格式之后再截断');
  assert.equal(JSON.stringify(board), original, '只改显示，不改标题或关联数据');
});

test('N6：等我处理、PR 关联任务和任务选择器的标题一致，选择器不嵌套链接', () => {
  const title = '**标题** `path/*` [文档](https://example.com)';
  const plain = '标题 path/* 文档';
  const board = computeBoard([planDoc('p', `# P\n\n- [ ] 0.1 ${title}\n- [ ] 0.2 ${title}\n`)],
    [mkPr(77, { title: '任务 0.1', isDraft: true })], [], [], {}, { id: 'demo' }, NOW);
  board.sessions.push({ id: 's', source: 'claude-code' });
  board.tasks.find((v) => v.key === 'p#0.2').sessions.push({ sessionId: 's', lastAt: NOW.toISOString() });
  board.waiting.push({ kind: 'stale', taskKey: 'p#0.2' });
  const next = renderNext(board, prState());
  const titles = next.querySelectorAll('.tt');
  assert.ok(titles.some((el) => el.textContent === `review #77（${plain}）` && el.querySelector('code')));
  const stale = titles.find((el) => el.textContent === `0.2 ${plain}：会话停了`);
  assert.equal(stale.getAttribute('title'), `p · ${plain}`);
  const [, drawer] = renderDrawer(board, prState({ focus: '#77', picker: { id: 'tasks-for:77', q: '' } }), () => {});
  assert.match(drawer.querySelector('.prtask').textContent, /标题 path\/\* 文档$/);
  assert.equal(drawer.querySelector('.prtask').querySelector('b').textContent, '标题');
  const option = drawer.querySelector('.pitem');
  assert.equal(option.querySelector('.muted').textContent, plain);
  assert.equal(option.querySelector('a'), null, '按钮内只显示文字，避免嵌套可交互链接');
  let stopped = false;
  stale.querySelector('a').listeners.click[0]({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, '打开标题里的链接时，不连带触发父任务卡片');
});

test('N6：甘特行只处理自身焦点的 Enter，标题链接冒泡的 Enter 不打开任务抽屉', () => {
  globalThis.location = { hash: '' };
  const board = computeBoard([planDoc('p', '# P\n\n- [ ] 1 [文档](https://example.com)\n')], [], [], [], {}, { id: 'demo' }, NOW);
  const row = renderGantt(board, ganttState()).querySelector('.gl[data-key="p#1"]');
  const keydown = row.listeners.keydown[0];
  keydown({ key: 'Enter', target: row.querySelector('a'), currentTarget: row });
  assert.equal(location.hash, '', '后代链接的 Enter 不触发父任务行');
  keydown({ key: 'Escape', target: row, currentTarget: row });
  assert.equal(location.hash, '', '其他按键不打开任务');
  keydown({ key: 'Enter', target: row, currentTarget: row });
  assert.equal(parseHash(location.hash).focus, 'p#1', '任务行自身的键盘入口仍可用');
});

test('N1 review：同步说明区分勾选、混合关联及其他 PR 阻塞', () => {
  for (const syncState of ['pending', 'unknown']) for (const unchecked of [false, true]) for (const blocked of [false, 'open', 'pending']) {
    const docs = [planDoc('p', `# P\n\n- [x] 1 已确认\n- [${unchecked ? ' ' : 'x'}] 2 另一任务\n`)];
    const prs = [mkPr(11, { title: '任务 1、2（部分）', state: 'MERGED', mergedAt: '2026-09-25T12:00:00Z' })];
    if (blocked) prs.push(mkPr(12, { title: '任务 1、2', isDraft: true, ...(blocked === 'pending' ? { state: 'MERGED', mergedAt: '2026-09-25T12:00:00Z' } : {}) }));
    const board = computeBoard(docs, prs, [], [], { 11: { state: syncState }, 12: { state: 'pending' } }, { id: 'demo' }, NOW);
    const [, drawer] = renderDrawer(board, prState({ focus: '#11' }), () => {});
    const explanation = Object.fromEntries(kvPairs(drawer))['本地同步'].textContent;
    assert.match(explanation, blocked ? /任务 p#1 文档已勾选，仍有其他未合并或待同步 PR/ : syncState === 'pending'
      ? /任务 p#1 文档已勾选，本地同步后即完成/ : /任务 p#1 文档已勾选，已按完成计/);
    assert.equal(explanation.includes('任务 p#2 文档尚未勾选'), unchecked);
    if (unchecked) assert.equal(explanation.includes('任务 p#2 文档尚未勾选，仍须确认完整交付；仍有其他未合并或待同步 PR'), !!blocked);
    if (syncState === 'unknown') assert.match(explanation, /本地同步未核对/);
    if (syncState === 'pending') {
      assert.ok(renderNext(board, prState()).textContent.includes(explanation), '操作卡与 PR 抽屉共用说明');
      if (unchecked && blocked !== 'open') {
        const [, taskDrawer] = renderDrawer(board, prState({ focus: 'p#2' }), () => {});
        assert.match(Object.fromEntries(kvPairs(taskDrawer))['为什么是这个状态'].textContent, /仍须文档勾选确认/);
      }
      if (!blocked) {
        const [, taskDrawer] = renderDrawer(board, prState({ focus: 'p#1' }), () => {});
        assert.match(Object.fromEntries(kvPairs(taskDrawer))['为什么是这个状态'].textContent, /文档已勾选，本地同步后即完成/);
      }
    }
  }
});

// ---- N11：未接 GitHub 的项目 ----
const offGithub = (b) => {
  b.freshness.github = { ...b.freshness.github, lastSuccessAt: null, scopeHint: null, state: 'off', message: '未接 GitHub' };
  return b;
};

test('N11 未接 GitHub：顶栏中性显示「未接 GitHub」，无降级横幅、无令牌横幅', () => {
  const b = offGithub(prDemoBoard());
  b.degraded.noPrData = true; // 就算服务端误给了也不该出「未包含 PR 信息」
  const head = renderHeader(LINE_LIST.projects, 'demo', b, prState());
  const span = head.querySelectorAll('span').find((x) => x.textContent === '未接 GitHub');
  assert.ok(span, '顶栏有「未接 GitHub」');
  assert.equal(span.getAttribute('class'), 'muted', '中性样式，不是警告');
  assert.ok(!head.textContent.includes('还没成功拉取过'));
  assert.deepEqual(degradedBanners(b, NOW.getTime()), []);
  assert.equal(scopeBanner(b), null);
});

test('N11 未接 GitHub：「等我处理」说明不含 PR；诊断页 GitHub 栏写「未配置」', () => {
  const b = offGithub(prDemoBoard());
  const col = colOf(renderNext(b, relState(null, { lines: LINES })), 3);
  assert.equal(col.querySelector('.hint').textContent, '只有你能推进的事。本项目未接 GitHub，这里不含 PR。');
  const kv = kvOf(renderDiag(offGithub(diagBoard()), newState(NOW.getTime())));
  assert.equal(kv.get('GitHub').textContent, '未配置：本项目没有 repo.github，不读取 PR');
});

// ---- N24：顶栏工作区只占一行 ----
test('N24 顶栏工作区：选分支线只显示该线的工作区（没有自己的就是主仓库）；「全部」且多个时显示「工作区 N 个」，明细在悬停层', () => {
  const b = prDemoBoard();
  b.workspaces = [
    { id: 'repo', path: '/ws/repo', branch: 'main', commit: 'a'.repeat(40), detached: false, error: null },
    { id: 'collab', path: '/ws/collab', branch: 'v2/collab', commit: 'b'.repeat(40), detached: false, error: null },
    { id: 'next', label: '新引擎', path: '/ws/repo', ref: 'origin/next/x', branch: 'origin/next/x', commit: 'c'.repeat(40), detached: false, error: null },
  ];
  const wsText = (line) => {
    const head = renderHeader(LINE_LIST.projects, 'demo', b, { ...prState(), line });
    return head.querySelector('.meta').querySelectorAll('.ws').map((x) => x.textContent);
  };
  assert.deepEqual(wsText('collab'), ['工作区 collab · v2/collab @ bbbbbbbb']);
  assert.deepEqual(wsText('next'), ['新引擎读取 repo · origin/next/x @ cccccccc']);
  assert.deepEqual(wsText('personal'), ['工作区 repo · main @ aaaaaaaa'], '没有自己检出的分支线显示主仓库');

  const all = renderHeader(LINE_LIST.projects, 'demo', b, { ...prState(), line: null }).querySelector('.meta');
  const sum = all.querySelector('.ws-sum');
  assert.equal(sum.getAttribute('tabindex'), '0', '键盘可聚焦以展开明细');
  assert.equal(sum.getAttribute('aria-label'), '工作区 3 个');
  assert.equal(sum.querySelector('.ws-pop').querySelectorAll('.ws').length, 3);

  b.workspaces = b.workspaces.slice(0, 1);
  const one = renderHeader(LINE_LIST.projects, 'demo', b, { ...prState(), line: null }).querySelector('.meta');
  assert.equal(one.querySelector('.ws-sum'), null, '只有一个工作区时直接显示');
  assert.equal(one.querySelectorAll('.ws').length, 1);
});

// ---------- N24：自绘下拉与日期选择 ----------

test('自绘下拉：APG combobox 的 aria 关系；键盘展开 / 移动 / 打字跳转 / 选定，Esc 与 Tab 收起不改', () => {
  const state = checkState();
  const root = renderCheck(checkBoard(), state);
  const cb = combo(root, '类型');
  const list = cb.parentNode.querySelector('[role=listbox]');
  assert.deepEqual(['aria-haspopup', 'aria-expanded', 'tabindex'].map((k) => cb.getAttribute(k)), ['listbox', 'false', '0']);
  assert.equal(cb.getAttribute('aria-controls'), list.getAttribute('id'));
  assert.equal(list.getAttribute('aria-labelledby'), cb.getAttribute('id'));
  assert.ok(list.hasAttribute('hidden'));
  const key = (k) => cb.dispatch('keydown', { key: k });
  const active = () => optText(list.querySelector(`#${cb.getAttribute('aria-activedescendant')}`));
  const all = optTexts(cb);

  assert.ok(key('ArrowDown').defaultPrevented);
  assert.equal(cb.getAttribute('aria-expanded'), 'true');
  assert.ok(!list.hasAttribute('hidden'));
  assert.equal(active(), all[0], '展开时高亮当前选中项');
  assert.deepEqual(state.dd, { label: '类型', active: 0 }, '展开状态记在 state 上');
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(active(), all[2]);
  key('End');
  key('ArrowDown');
  assert.equal(active(), all.at(-1), '到底不绕回');
  key('Home');
  key('ArrowUp');
  assert.equal(active(), all[0]);
  key('p');
  assert.match(active(), new RegExp(`^${CONFLICT_TEXT.a}`), '打字跳到下一项以该字符开头的');
  key('P');
  assert.match(active(), new RegExp(`^${CONFLICT_TEXT.d}`), '再按一次跳到再下一项');

  const esc = key('Escape');
  assert.ok(esc.stopped, 'Esc 不冒泡，抽屉不跟着关');
  assert.deepEqual([cb.getAttribute('aria-expanded'), cb.hasAttribute('aria-activedescendant'), list.hasAttribute('hidden')], ['false', false, true]);
  assert.equal(state.dd, null);
  assert.equal(state.checkType, null, 'Esc 不改选');
  assert.ok(!key('Escape').stopped, '收起时 Esc 照常交给抽屉');

  key(' ');
  key('ArrowDown');
  const tab = key('Tab');
  assert.ok(!tab.defaultPrevented, 'Tab 照常移走焦点');
  assert.equal(cb.getAttribute('aria-expanded'), 'false');
  assert.equal(state.checkType, null, 'Tab 不选');

  // 收起时打字直接展开到匹配项；Enter 选定 → 本视图重画，新 combobox 显示所选项
  key('仅');
  assert.equal(active(), '仅文档确认（2）');
  key('Enter');
  assert.equal(state.checkType, 'c');
  assert.equal(state.dd, null);
  const again = combo(root, '类型');
  assert.ok(again !== cb, '选定后按原逻辑重画本视图');
  assert.deepEqual(chosen(again), ['仅文档确认（2）']);
  assert.equal(again.querySelector('.ddval').textContent, '仅文档确认（2）');
  assert.equal(optsOf(again).find((o) => o.getAttribute('aria-selected') === 'true').querySelector('.ddck').textContent, '✓');
});

test('自绘下拉：点按切换展开，点同一项不触发变更；state.dd 在则重新渲染时照样展开在原高亮项', () => {
  const state = checkState();
  let root = renderCheck(checkBoard(), state);
  const cb = combo(root, '类型');
  cb.dispatch('click');
  assert.equal(cb.getAttribute('aria-expanded'), 'true');
  cb.dispatch('click');
  assert.equal(cb.getAttribute('aria-expanded'), 'false');
  cb.dispatch('click');
  optsOf(cb)[0].dispatch('click');
  assert.ok(combo(root, '类型') === cb, '选了原来那项不重画');
  assert.equal(cb.getAttribute('aria-expanded'), 'false');

  cb.dispatch('click');
  optsOf(cb)[3].dispatch('mouseenter');
  assert.deepEqual(state.dd, { label: '类型', active: 3 }, '鼠标移上去即高亮');
  root = renderCheck(checkBoard(), state); // 等同 SSE 整页重画
  const redrawn = combo(root, '类型');
  assert.equal(redrawn.getAttribute('aria-expanded'), 'true');
  assert.equal(redrawn.getAttribute('aria-activedescendant'), optsOf(redrawn)[3].getAttribute('id'));
  assert.ok(optsOf(redrawn)[3].classList.contains('active'));
});

// 假 DOM 没有布局：手动给触发器外层和弹层定矩形（弹层量的是 left:0 时的位置），看 fitPopup 平移多少
test('弹层定位（PR #29 review）：窄屏日历右对齐后左缘出界时夹回视口；靠右的语言菜单与触发器右对齐；不出界不动', async () => {
  const rect = (left, width) => () => ({ left, right: left + width, width });
  const place = async (root, pop, vw, [rootLeft, rootW], popW, open) => {
    document.documentElement.clientWidth = vw;
    root.getBoundingClientRect = rect(rootLeft, rootW);
    pop.getBoundingClientRect = rect(rootLeft, popW);
    open();
    await Promise.resolve();
    return pop.style.getPropertyValue('left');
  };
  try {
    const sec = recentOf(renderOverview(recentBoard(), relState(null)));
    const btn = sec.querySelector('[aria-label=起始日]');
    const dlg = sec.querySelector('[role=dialog]');
    // review 实测：320px 视口 clientWidth=305，触发器右缘约 154.3，日历宽 246 → 右对齐会到 −91.7，应夹到左缘 8
    assert.equal(await place(btn.parentNode, dlg, 305, [80, 74.3], 246, () => btn.dispatch('click')), `${8 - 80}px`);
    btn.dispatch('click');
    assert.equal(await place(btn.parentNode, dlg, 1280, [80, 74.3], 246, () => btn.dispatch('click')), '', '宽屏不出界不平移');
    btn.dispatch('click');

    const lang = combo(renderHeader([{ id: 'demo', name: 'Demo' }], 'demo', null, newState(NOW.getTime())), '界面语言');
    const list = lang.parentNode.querySelector('[role=listbox]');
    assert.equal(await place(lang.parentNode, list, 1280, [1180, 90], 160, () => lang.dispatch('click')), `${90 - 160}px`, '右缘与触发器对齐');
  } finally {
    delete document.documentElement.clientWidth;
  }
});

test('日期选择：日历按界面语言、中文周一起；今天之后禁用，翻月、方向键 / PageUp / Home / End，选定只重画本区块；Esc 收起还焦点', () => {
  const state = relState(null);
  const sec = recentOf(renderOverview(recentBoard(), state));
  const btn = sec.querySelector('[aria-label=起始日]');
  const dlg = sec.querySelector('[role=dialog]');
  assert.deepEqual(['aria-haspopup', 'aria-expanded', 'aria-controls'].map((k) => btn.getAttribute(k)), ['dialog', 'false', dlg.getAttribute('id')]);
  assert.ok(dlg.hasAttribute('hidden'));
  btn.dispatch('click');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.ok(!dlg.hasAttribute('hidden'));
  const title = () => dlg.querySelector('.dptitle').textContent;
  const grid = dlg.querySelector('[role=grid]');
  const focused = () => document.activeElement.getAttribute('data-date');
  assert.equal(title(), '2026年9月');
  assert.deepEqual(texts(grid.querySelectorAll('th')), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
  assert.equal(grid.querySelectorAll('button')[0].getAttribute('data-date'), '2026-08-31', '9 月 1 日是周二，首格是上月 31 日');
  assert.ok(grid.querySelectorAll('button')[0].classList.contains('other'));
  assert.equal(grid.querySelectorAll('button').length, 42, '固定 6 行');
  assert.equal(focused(), '2026-09-19', '打开时焦点在所选日');
  assert.equal(document.activeElement.getAttribute('aria-label'), '2026年9月19日星期六');
  assert.equal(document.activeElement.getAttribute('tabindex'), '0');
  assert.equal(grid.querySelector('[data-date=2026-09-26]').getAttribute('aria-current'), 'date');
  assert.ok(dlg.querySelector('[aria-label=下个月]').hasAttribute('disabled'), '下月全在 max 之后');

  const key = (k) => grid.dispatch('keydown', { key: k });
  key('ArrowRight');
  assert.equal(focused(), '2026-09-20');
  key('ArrowDown');
  assert.equal(focused(), '2026-09-26', '越过 max 停在 max');
  key('Home');
  assert.equal(focused(), '2026-09-21', '本周一');
  key('End');
  assert.equal(focused(), '2026-09-26', '本周日在 max 之后，停在 max');
  key('ArrowUp');
  key('ArrowLeft');
  assert.equal(focused(), '2026-09-18');
  assert.ok(key('PageUp').defaultPrevented);
  assert.deepEqual([title(), focused()], ['2026年8月', '2026-08-18']);
  assert.ok(!dlg.querySelector('[aria-label=下个月]').hasAttribute('disabled'));
  key('PageDown');
  assert.deepEqual([title(), focused()], ['2026年9月', '2026-09-18']);
  dlg.querySelector('[aria-label=上个月]').dispatch('click');
  assert.equal(title(), '2026年8月');
  dlg.querySelector('[aria-label=下个月]').dispatch('click');
  assert.equal(title(), '2026年9月');
  assert.deepEqual(state.dp, { label: '起始日', active: '2026-09-18' });

  document.activeElement.dispatch('click'); // Enter / Space 由日子 button 原生转成 click
  assert.equal(state.recentFrom, '2026-09-18');
  assert.equal(sec.querySelector('h2').textContent, '这几天发生了什么 · 2026-09-18 起');
  assert.deepEqual([btn.getAttribute('aria-expanded'), dlg.hasAttribute('hidden'), state.dp], ['false', true, null]);
  assert.ok(document.activeElement === btn, '选定后焦点回到按钮');

  btn.dispatch('click');
  assert.equal(focused(), '2026-09-18');
  assert.equal(grid.querySelector('[data-date=2026-09-18]').parentNode.getAttribute('aria-selected'), 'true');
  key('ArrowLeft');
  const esc = dlg.dispatch('keydown', { key: 'Escape' });
  assert.ok(esc.stopped, 'Esc 不冒泡，抽屉不跟着关');
  assert.deepEqual([btn.getAttribute('aria-expanded'), dlg.hasAttribute('hidden'), state.recentFrom], ['false', true, '2026-09-18']);
  assert.ok(document.activeElement === btn);

  // state.dp 在则重新渲染时照样展开在原来的日子
  state.dp = { label: '起始日', active: '2026-08-05' };
  const again = recentOf(renderOverview(recentBoard(), state));
  assert.equal(again.querySelector('[aria-label=起始日]').getAttribute('aria-expanded'), 'true');
  assert.equal(again.querySelector('.dptitle').textContent, '2026年8月');
  assert.equal(again.querySelector('[data-date=2026-08-05]').getAttribute('tabindex'), '0');
});
