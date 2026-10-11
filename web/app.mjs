// devboard 前端（design §3.13；界面以 test/fixtures/ui-mockup.html 为准）。原生 ES module，无构建步骤。
// 所有节点只经 h() 创建，外部文本（标题、路径、错误信息）只以文本节点或 setAttribute 进入页面，
// 从构造上杜绝脚本注入（design K2、需求 16.8）。
// 视图函数都是「(board, state) → 节点」，不读全局页面状态，test/ui.test.mjs 用假 DOM 在 Node 里渲染后断言；
// 只有文件末尾的 main() 碰 location / fetch，且只在浏览器里运行。

import { graphSvg, legendIcon, ganttSvg, GANTT_ZOOM } from './svg.mjs';
import { t, tx, LANGS, LANG_KEY, getLang } from './i18n.mjs';

// 界面语言（N22 任务 22.3）：界面文案一律 t`…`（中文原文即翻译键），服务端发来的中文说明套 tx()；
// 用户内容（任务标题、文档名、PR 标题、路径、会话片段）不翻。注意别把局部变量起名叫 t，会遮住翻译函数。
/** <html lang> 与日期格式用的语言标签。 */
const HTML_LANG = { zh: 'zh-CN', ja: 'ja', en: 'en' };
// 句子里要嵌节点（如任务标题的 Markdown）时，插值写 SLOT，翻译后在 SLOT 处切开放回节点：各语言语序不同，不能拆成前后两段文案。
const SLOT = '\u0001';
const withNode = (s, node) => { const [a, b = ''] = s.split(SLOT); return [a, node, b].filter((x) => x !== ''); };

/** 五态显示：图标 + 文字 + 颜色 class 三重编码（需求 10.6），与 UI 稿的 S 表逐项一致（测试比对）。 */
export const STATUS_UI = {
  not_started: { cls: 'todo', icon: '○', text: t('未开始') },
  in_progress: { cls: 'doing', icon: '◔', text: t('进行中') },
  in_review: { cls: 'review', icon: '◑', text: t('等待 review') },
  awaiting_merge: { cls: 'merge', icon: '◕', text: t('等待合并') },
  done: { cls: 'done', icon: '●', text: t('已合并完成') },
};
// 分段进度条的顺序同 UI 稿：已完成 → 等待合并 → 等待 review → 进行中，未开始部分留空。
const BAR_ORDER = ['done', 'awaiting_merge', 'in_review', 'in_progress'];

/** 导航视图，顺序与文字同 UI 稿；甘特图、关系图等随后续任务逐个加入。 */
export const VIEWS = [
  { id: 'overview', text: t('总览') },
  { id: 'gantt', text: t('甘特图') },
  { id: 'graph', text: t('关系图') },
  { id: 'next', text: t('下一步') },
  { id: 'check', text: t('需要确认') }, // 任务 6.4；id 同 UI 稿 data-v
  { id: 'diag', text: t('诊断') },
];

// 文档解析状态的页面文案（需求 2.5、2.7）。withReason：文案后面接 parse.reason；否则 reason 本身已是完整句子。
const DOC_STATE = {
  planning: { cls: '', label: t('规划中（暂无任务）'), withReason: false },
  partial: { cls: 'warn', label: t('⚠ 解析不完整'), withReason: true },
  'no-tasks': { cls: 'warn', label: t('未解析出任务'), withReason: true },
  error: { cls: 'warn', label: t('⚠ 读取失败'), withReason: false },
};

/**
 * 建节点。attrs：`on<事件>` 挂监听；`style` 为对象，经 CSSOM 设置（CSP 会拦行内 style 属性，CSSOM 不受限）；
 * 值为 true 写空属性、null / false 跳过。children 可嵌套数组，字符串与数字一律变文本节点。
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * 页面内存状态：搜索词、「只看未完成的分组」、用户手动展开 / 折叠过的节点（与默认相反的那些）；
 * 抽屉相关（任务 2.5）：focus = 地址里的 focus=（打开抽屉的任务键）、project = 当前项目 id（拼抽屉里的跳转地址）、
 * viewer = 页内原文查看器 { docId, line, scrolled } 或 null、texts = docId → 原文（null 读取中 / {lines} / {error}）、
 * need(docId) = 视图发现缺原文时请求读取（浏览器里由 main 换成真正的读取函数）。
 * 任务 3.6：line = 地址里的 line=（选中的分支线 id，null = 全部）；lines = 本项目分支线 [{id, name, docFilter}]（renderPage 从
 * /api/projects 填）；refresh() = 「↻ 刷新」（main 换成 POST /refresh）。focus 以 `#` 开头时是 PR 号，打开 PR 详情抽屉。
 */
export const newState = (now = Date.now()) => ({
  q: '', onlyOpen: true, toggled: new Set(), now, view: 'overview',
  focus: null, project: null, viewer: null, texts: new Map(), need: () => {},
  line: null, lines: [], refresh: () => {}, refreshFeedback: '',
  ...parseFilters(''), // 任务 6.6：组合筛选等地址参数的缺省值
});

/**
 * `#/<视图>?project=…&line=<分支线>&focus=<任务键 | #PR号>`；未知视图回落总览。筛选等其余参数见 parseFilters。
 * 注意 PR 号的 `#` 在地址里编码为 %23，和 hash 本身的 # 不冲突。
 */
export function parseHash(hash) {
  const [p, query = ''] = String(hash ?? '').replace(/^#\/?/, '').split('?');
  const q = new URLSearchParams(query);
  return { view: VIEWS.some((v) => v.id === p) ? p : 'overview', project: q.get('project'), focus: q.get('focus'), line: q.get('line') };
}

/**
 * 地址里的筛选与视图参数（任务 6.6，需求 10.4「筛选条件体现在页面地址中」）↔ state 字段。顺序即写进地址的顺序（design §3.13）。
 * 布尔参数只在非缺省时出现：conflict / archived / novoid 写 1；「只看未完成的分组」缺省勾选，取消时写 open=0。
 */
const FILTER_PARAMS = [
  ['doc', 'doc'], ['src', 'src'], ['ms', 'ms'], ['status', 'status'],
  ['conflict', 'conflict'], ['archived', 'archived'], ['novoid', 'hideVoid'], ['open', 'onlyOpen'],
  ['q', 'q'], ['from', 'recentFrom'], ['type', 'checkType'],
];

/** 地址 → 筛选状态（全部字段都给出，缺省值见上）；不认识的状态 / 日期写法当没写。 */
export function parseFilters(hash) {
  const q = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const status = q.get('status');
  const from = q.get('from');
  return {
    doc: q.get('doc'), src: q.get('src'), ms: q.get('ms'), status: Object.hasOwn(STATUS_UI, status ?? '') ? status : null,
    conflict: q.get('conflict') === '1', archived: q.get('archived') === '1', hideVoid: q.get('novoid') === '1',
    onlyOpen: q.get('open') !== '0', q: q.get('q') ?? '',
    recentFrom: /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : null, checkType: q.get('type'),
  };
}

/** 拼地址。f = 带筛选字段的对象（通常就是 state）；不传则只有视图、项目、分支线、focus。 */
export const hashFor = (view, project, focus, line, f = null) => {
  const filters = f ? FILTER_PARAMS.map(([k, field]) => {
    const v = f[field];
    if (field === 'onlyOpen') return [k, v === false ? '0' : null];
    return [k, v === true ? '1' : typeof v === 'string' ? v.trim() : null];
  }) : [];
  return `#/${view}?${new URLSearchParams([['project', project], ['line', line], ...filters, ['focus', focus]].filter(([k, v]) => k === 'project' || v))}`;
};

/** 只改地址、不触发 hashchange 整页重画（搜索框逐字输入、起始日、类型下拉等只重画局部的控件用），也不新增历史记录。 */
function syncHash(state) {
  globalThis.history?.replaceState(history.state, '', hashFor(state.view, state.project, state.focus, state.line, state));
}

// 同文档的任务只写编号，跨文档写完整任务键（重复编号保留 `~2` 后缀，能区分是哪一条）。
const refLabel = (key, docId) => (key.startsWith(`${docId}#`) ? key.slice(docId.length + 1) : key);

/** 相对时间，给顶栏「文档 3 秒前」用；绝对时间放在悬停提示里。 */
export function ago(iso, now) {
  if (!iso) return t('未读取');
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return t`${s} 秒前`;
  if (s < 3600) return t`${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return t`${Math.floor(s / 3600)} 小时前`;
  return t`${Math.floor(s / 86400)} 天前`;
}

// 向下取整：只有真的全部完成才显示 100%；分母为 0（没有未作废任务）显示「—」，不显示成 0% 或 100%。
const pct = (ratio) => (ratio == null ? '—' : `${Math.floor(ratio * 100)}%`);
const allDone = (st) => !!st && st.total > 0 && st.counts.done === st.total;

function stackBar({ counts, total }) {
  return h('div', { class: 'pbar' },
    total ? BAR_ORDER.map((s) => counts[s] ? h('i', { class: STATUS_UI[s].cls, style: { width: `${(counts[s] / total) * 100}%` } }) : null) : null);
}

function badge(status) {
  // 作废任务没有状态（engine 给 null），不计入进度（需求 2.4）
  // 文字单独包 span：总览任务行把图标放行首、文字放行尾（N23），别的视图照常并排显示
  if (!status) return h('span', { class: 'st void' }, h('span', { class: 'ic' }, '⊘'), h('span', { class: 'tx' }, t('作废')));
  const s = STATUS_UI[status];
  return h('span', { class: `st ${s.cls}` }, h('span', { class: 'ic' }, s.icon), h('span', { class: 'tx' }, s.text));
}

// ---------------- 自绘下拉与日期选择（N24 任务 24.2、24.3） ----------------

let popSeq = 0; // 弹层 id 序号：同一页唯一即可；整页重画换新 id 无妨，aria 引用在同一次渲染里成对出现
const flag = (el, k, on) => (on ? el.setAttribute(k, '') : el.removeAttribute(k));
// 同一时刻只开一个弹层；外层带 .pop，展开时加 .open，popClose 由各组件挂上（main 的「点外面收起」也靠它）
const closeOthers = (root) => { for (const el of document.querySelectorAll('.pop.open')) if (el !== root) el.popClose?.(); };
// 右边出界时先与触发器右对齐（顶栏右上角的语言选择），再夹进视口左右各留 8px；比视口还宽时保左缘（日历「上个月」在左）。
// 窄屏下日历右对齐后左缘会出界（PR #29 review：320px 宽时 −91px），所以按最终位置平移，不能只切换对齐方向。
// 渲染时还没挂到页面上，放进微任务等挂上再量
function fitPopup(root, pop) {
  pop.style.setProperty('left', '');
  const r = pop.getBoundingClientRect?.();
  const max = document.documentElement.clientWidth - 8;
  if (!r || r.right <= max) return;
  const dx = Math.max(8 - r.left, Math.min(root.getBoundingClientRect().right - r.right, max - r.right));
  pop.style.setProperty('left', `${dx}px`);
}

/**
 * 下拉（WAI-ARIA APG「select-only combobox」），替代原生 <select>，外观跟随主题。焦点始终在 combobox 上，
 * 高亮项用 aria-activedescendant 表示。options = [{value, text, title?}]，title 是悬停提示；
 * onChange(value) 只在选了另一项时调用，调用方可能整块重画，按 aria-label 把焦点找回新的 combobox。
 * 键盘：Enter / Space / ↑ / ↓ 展开；展开后 ↑ ↓ Home End 移动，Enter / Space 选定，Esc 收起不改，Tab 收起不选；
 * 打一个字符跳到下一项以它开头的选项。展开状态与高亮项记在 state.dd = {label, active}（按 aria-label 认）：
 * SSE 整页重画后照样展开在原来的高亮项上，同手动关联选择器；切视图时 route 清掉。cls 加在外层。
 */
export function dropdown(state, { label, value, options, onChange, cls = null }) {
  const id = `pop${++popSeq}`;
  const sel = Math.max(0, options.findIndex((o) => o.value === value));
  let active = -1;
  const items = options.map((o, i) => h('div', {
    role: 'option', id: `${id}-${i}`, class: 'ddopt', 'aria-selected': String(i === sel), title: o.title ?? null,
    onmouseenter: () => { if (i !== active) move(i); }, onclick: () => pick(i),
  }, h('span', { class: 'ddck', 'aria-hidden': 'true' }, i === sel ? '✓' : ''), o.text));
  // 按下鼠标不让选项抢走 combobox 的焦点
  const list = h('div', { role: 'listbox', id: `${id}-l`, class: 'ddlist', 'aria-labelledby': id, hidden: true, onmousedown: (e) => e.preventDefault() }, items);
  const box = h('div', {
    role: 'combobox', id, class: 'ddbtn', tabindex: 0, 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    'aria-controls': `${id}-l`, title: options[sel]?.title ?? null, onclick: () => (isOpen() ? close() : open(sel)), onkeydown: key,
  }, h('span', { class: 'ddval' }, options[sel]?.text ?? ''), h('span', { class: 'ddcaret', 'aria-hidden': 'true' }, '▾'));
  const root = h('div', { class: cls ? `dd pop ${cls}` : 'dd pop' }, box, list);
  root.popClose = close;
  const isOpen = () => root.classList.contains('open');

  function move(i) {
    items[active]?.classList.remove('active');
    active = Math.min(options.length - 1, Math.max(0, i));
    items[active].classList.add('active');
    box.setAttribute('aria-activedescendant', `${id}-${active}`);
    state.dd = { label, active };
    items[active].scrollIntoView?.({ block: 'nearest' });
  }
  function open(i) {
    if (!options.length) return;
    closeOthers(root);
    root.classList.add('open');
    flag(list, 'hidden', false);
    box.setAttribute('aria-expanded', 'true');
    move(i);
    queueMicrotask(() => fitPopup(root, list));
  }
  function close() {
    if (state.dd?.label === label) state.dd = null;
    root.classList.remove('open');
    flag(list, 'hidden', true);
    box.setAttribute('aria-expanded', 'false');
    box.removeAttribute('aria-activedescendant');
    items[active]?.classList.remove('active');
    active = -1;
  }
  function pick(i) {
    close();
    box.focus?.();
    if (i !== sel) keepFocus(document, () => onChange(options[i].value));
  }
  // 打字跳转：从当前项的下一项起找以该字符开头的，找到末尾再从头找
  const seek = (ch) => {
    const from = isOpen() ? active : sel;
    for (let k = 1; k <= options.length; k++) {
      const i = (from + k) % options.length;
      if (String(options[i].text).trim().toLowerCase().startsWith(ch)) return i;
    }
    return -1;
  };
  function key(e) {
    const k = e.key;
    const ch = k.length === 1 && k !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey ? k.toLowerCase() : null;
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) open(sel);
      else if (k === 'Home' || k === 'End') open(k === 'Home' ? 0 : options.length - 1);
      else if (ch && seek(ch) >= 0) open(seek(ch));
      else return;
    } else if (k === 'ArrowDown' || k === 'ArrowUp') move(active + (k === 'ArrowDown' ? 1 : -1));
    else if (k === 'Home' || k === 'End') move(k === 'Home' ? 0 : options.length - 1);
    else if (k === 'Enter' || k === ' ') pick(active);
    else if (k === 'Escape') { close(); e.stopPropagation(); } // 不连带关掉抽屉
    else if (k === 'Tab') return close(); // 不拦 Tab，焦点照常移走
    else if (ch) { const i = seek(ch); if (i >= 0) move(i); } else return;
    e.preventDefault();
  }
  if (state.dd?.label === label) open(state.dd.active);
  return root;
}

// 一周从哪天开始：中文日历习惯周一，日文 / 英文日历多为周日
const WEEK_START = { zh: 1, ja: 0, en: 0 };
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
// 跨月时日子按目标月天数截断（1 月 31 日 → 2 月 28 日）
const addMonths = (s, n) => {
  const d = parseYmd(s);
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return ymd(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)));
};

/**
 * 日期选择（APG「Date Picker Dialog」），替代 <input type="date">：按钮显示所选日期（aria-label 不变），
 * 点开是日历对话框，月 / 年标题、星期、日期按界面语言（Intl），min / max（'YYYY-MM-DD'，可缺）之外的日子禁用。
 * 键盘：← → 按天、↑ ↓ 按周、PageUp / PageDown 按月、Home / End 到本周首尾，Enter / Space 选定（日子是 button），
 * Esc 收起并把焦点还给按钮。展开状态与键盘所在日记在 state.dp = {label, active}，SSE 整页重画后照样展开；
 * 日子按钮的 aria-label 是完整日期，焦点随之找回。onChange(value) 只在选了另一天时调用。
 */
export function datePicker(state, { label, value, min = null, max = null, onChange }) {
  const lang = getLang();
  const fmt = (o) => new Intl.DateTimeFormat(HTML_LANG[lang], o);
  const ws = WEEK_START[lang] ?? 0;
  const clamp = (s) => (min && s < min ? min : max && s > max ? max : s);
  const id = `pop${++popSeq}`;
  let active = null;
  let activeBtn = null;
  const text = h('span', { id: `${id}-v` }, value);
  const btn = h('button', {
    type: 'button', class: 'btn dpbtn', 'aria-label': label, 'aria-describedby': `${id}-v`, 'aria-haspopup': 'dialog',
    'aria-expanded': 'false', 'aria-controls': id, onclick: () => (isOpen() ? close() : open(value, true)),
  }, text, h('span', { class: 'ddcaret', 'aria-hidden': 'true' }, '▾'));
  const title = h('span', { id: `${id}-t`, class: 'dptitle', 'aria-live': 'polite' });
  const nav = (n, aria, sym) => {
    const b = h('button', { type: 'button', class: 'dpnav', 'aria-label': aria, onclick: () => {
      show(addMonths(active, n));
      if (b.hasAttribute('disabled')) activeBtn?.focus?.(); // 翻到头按钮禁用了，焦点落回日历
    } }, sym);
    return b;
  };
  const prev = nav(-1, t('上个月'), '‹');
  const next = nav(1, t('下个月'), '›');
  const grid = h('table', { role: 'grid', class: 'dpgrid', 'aria-labelledby': `${id}-t`, onkeydown: gridKey });
  const pop = h('div', {
    role: 'dialog', id, class: 'dppop', 'aria-modal': 'false', 'aria-labelledby': `${id}-t`, hidden: true,
    onkeydown: (e) => { if (e.key === 'Escape') { close(); btn.focus?.(); e.preventDefault(); e.stopPropagation(); } },
  }, h('div', { class: 'dphead' }, prev, title, next), grid);
  // Tab 移出日历即收起；relatedTarget 为空（点了不可聚焦处、重画卸载了按钮）交给「点外面收起」与 state 处理
  const root = h('div', { class: 'dpk pop', onfocusout: (e) => { if (e.relatedTarget && !root.contains(e.relatedTarget)) close(); } }, btn, pop);
  root.popClose = close;
  const isOpen = () => root.classList.contains('open');

  // 画 active 所在的月：固定 6 行，翻月时高度不跳
  function show(day, focus = false) {
    active = clamp(day);
    state.dp = { label, active };
    const a = parseYmd(active);
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    title.textContent = fmt({ year: 'numeric', month: 'long' }).format(first);
    flag(prev, 'disabled', min && ymd(new Date(a.getFullYear(), a.getMonth(), 0)) < min);
    flag(next, 'disabled', max && ymd(new Date(a.getFullYear(), a.getMonth() + 1, 1)) > max);
    const today = ymd(new Date(state.now));
    const full = fmt({ dateStyle: 'full' });
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() - ws + 7) % 7));
    const dayAt = (i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const cell = (d) => {
      const s = ymd(d);
      const b = h('button', {
        type: 'button', tabindex: s === active ? 0 : -1, 'data-date': s, 'aria-label': full.format(d),
        class: d.getMonth() === first.getMonth() ? null : 'other', 'aria-current': s === today ? 'date' : null,
        disabled: (min && s < min) || (max && s > max), onclick: () => pick(s),
      }, d.getDate());
      if (s === active) activeBtn = b;
      return h('td', { role: 'gridcell', 'aria-selected': s === value ? 'true' : null }, b);
    };
    const week = [0, 1, 2, 3, 4, 5, 6];
    grid.replaceChildren(
      h('thead', {}, h('tr', {}, week.map((i) => h('th', { scope: 'col', abbr: fmt({ weekday: 'long' }).format(dayAt(i)) },
        fmt({ weekday: 'short' }).format(dayAt(i)))))),
      h('tbody', {}, [0, 1, 2, 3, 4, 5].map((w) => h('tr', {}, week.map((i) => cell(dayAt(w * 7 + i)))))));
    if (focus) activeBtn?.focus?.();
  }
  function gridKey(e) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const off = (parseYmd(active).getDay() - ws + 7) % 7;
    let d;
    if (step) d = addDays(active, step);
    else if (e.key === 'PageUp' || e.key === 'PageDown') d = addMonths(active, e.key === 'PageUp' ? -1 : 1);
    else if (e.key === 'Home' || e.key === 'End') d = addDays(active, e.key === 'Home' ? -off : 6 - off);
    else return;
    e.preventDefault();
    show(d, true);
  }
  function open(day, focus = false) {
    closeOthers(root);
    root.classList.add('open');
    flag(pop, 'hidden', false);
    btn.setAttribute('aria-expanded', 'true');
    show(day, focus);
    queueMicrotask(() => fitPopup(root, pop));
  }
  function close() {
    if (state.dp?.label === label) state.dp = null;
    root.classList.remove('open');
    flag(pop, 'hidden', true);
    btn.setAttribute('aria-expanded', 'false');
  }
  function pick(s) {
    close();
    btn.focus?.();
    if (s === value) return;
    value = s;
    text.textContent = s;
    onChange(s);
  }
  if (state.dp?.label === label) open(state.dp.active);
  return root;
}

// ---------------- 顶栏与导航 ----------------

/**
 * 顶栏：品牌、项目选择（需求 1.4）、分支线分段按钮（需求 10.4）、各工作区分支与提交（需求 2.2）、
 * 文档 / GitHub 读取时间与「正在刷新」（需求 13.1）、「↻ 刷新」（需求 13.2）、亮暗切换（需求 17.5）。
 * 文档时间 = 最近一次重算所用的读取时间：服务端每 5 秒检查文档，没变化不重算、不推新版本，所以空闲时这个时间会变旧。
 */
export function renderHeader(projects, projectId, board, state) {
  return h('header', {},
    h('div', { class: 'brand' }, h('img', { src: '/yuiboard-logo.png', alt: 'YUIBoard', width: 110, height: 23 }), h('small', {}, t('AI 开发进度看板'))),
    dropdown(state, { label: t('项目'), value: projectId, options: projects.map((p) => ({ value: p.id, text: p.name ?? p.id })),
      onChange: (v) => { location.hash = hashFor(state.view, v); } }),
    lineSeg(projects.find((p) => p.id === projectId)?.branchLines ?? [], projectId, state),
    h('div', { class: 'spacer' }),
    h('div', { class: 'meta' },
      workspaceMetas(board?.workspaces ?? [], state.line),
      board && h('span', { title: t`${board.freshness.docsReadAt ?? t('未读取')}（每 5 秒检查文档，有变化才重读）` }, t`文档 ${ago(board.freshness.docsReadAt, state.now)}`),
      board && h('span', { title: t`${board.freshness.sessionsReadAt ?? t('未读取')}（每 5 秒检查会话记录）` }, t`AI 会话 ${ago(board.freshness.sessionsReadAt, state.now)}`),
      board && githubMeta(board.freshness, state.now)),
    board && h('button', { class: 'btn', 'aria-label': t('刷新看板'), title: t('请求重读文档与 GitHub；会话按周期检查'), onclick: () => state.refresh() }, t('↻ 刷新')),
    board && h('span', { class: 'refresh-feedback', 'aria-live': 'polite' }, state.refreshFeedback),
    // 选项写各语言自己的名字；换语言 = 记进本浏览器后整页重载（模块顶层的文案在加载时就定了）
    dropdown(state, { label: t('界面语言'), value: getLang(), options: LANGS.map(([id, name]) => ({ value: id, text: name })), onChange: switchLang, cls: 'lang' }),
    h('button', { class: 'btn', title: t('切换亮/暗'), onclick: toggleTheme }, '◐'));
}

/** 手动选语言：存进 localStorage（存不了也照样重载，本次回到跟随浏览器）后重载整页。 */
export function switchLang(lang) {
  try { globalThis.localStorage?.setItem(LANG_KEY, lang); } catch { /* 隐私模式等存不了 */ }
  location.reload();
}

/**
 * 顶栏只占一行（N24，owner 2026-10-11 定）：选了分支线只显示该线的工作区（该线自己的检出 / docRef，没有就是主仓库）；
 * 选「全部」且不止一个工作区时显示「工作区 N 个」，悬停或键盘聚焦时弹出各工作区明细（诊断页仍列全部）。
 */
function workspaceMetas(list, line) {
  if (line) {
    const w = list.find((x) => x.id === line) ?? list.find((x) => x.id === 'repo');
    return w ? workspaceMeta(w) : null;
  }
  if (list.length <= 1) return list.map(workspaceMeta);
  return h('span', { class: 'ws-sum', tabindex: 0, 'aria-label': t`工作区 ${list.length} 个` },
    t`工作区 ${list.length} 个`, ' ▾',
    h('span', { class: 'ws-pop', role: 'tooltip' }, list.map(workspaceMeta)));
}

function workspaceMeta(w) {
  const name = w.path.split(/[\\/]/).filter(Boolean).pop();
  const branch = w.detached ? t('（分离 HEAD）') : (w.branch ?? t('未知'));
  // N17：docRef 分支线不是检出，只从该仓库的 ref 读文件；写成「<分支线>读取」免得误以为仓库切了分支
  const title = tx(w.error) ?? (w.ref ? t`${w.path}：只读 ${w.ref} 上的文档，不切换分支；本机 fetch 之后才会更新` : w.path);
  return h('span', { class: 'ws', title },
    w.ref ? t`${w.label ?? w.id}读取 ` : t('工作区 '), h('b', {}, name), ` · ${branch} @ `, h('b', {}, w.commit ? w.commit.slice(0, 8) : t('未知')));
}

// 同 UI 稿：没手动选过时按系统主题取反；选过后在 light / dark 间切换（CSS 同时尊重 prefers-color-scheme）。
function toggleTheme() {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
}

// f = 筛选状态（通常是 state）：切视图时筛选跟着走（任务 6.6，统计 / 甘特 / 关系图 / 下一步按同一筛选范围）
export function renderNav(view, projectId, line, checkCount = 0, f = null) {
  return h('nav', {}, VIEWS.map((v) => h('button', {
    'data-v': v.id, class: v.id === view ? 'on' : null, onclick: () => { location.hash = hashFor(v.id, projectId, null, line, f); },
  }, v.text, v.id === 'check' && checkCount > 0 && h('span', { class: 'count warn' }, checkCount))));
}

// ---------------- 总览 ----------------

/** 总览（需求 10.1、10.2、10.5）：数字卡 + 左栏任务树 + 右栏各份文档进度。归档文档不进主视图（需求 2.10）。 */
export function renderOverview(board, state) {
  const treeBox = h('div', { id: 'tree' });
  // 搜索、勾选、展开折叠只重画任务树，搜索框不丢焦点（需求 17.3）
  const redraw = () => keepFocus(treeBox, () => treeBox.replaceChildren(renderTree(board, state, redraw)));
  redraw();

  return h('section', { id: 'v-overview' },
    h('div', { class: 'stats' }, statCards(board, state)),
    h('div', { class: 'two' },
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' },
          h('h2', {}, t('任务')),
          h('input', { type: 'search', placeholder: t('搜索编号 / 标题 / PR 号'), 'aria-label': t('搜索任务'), value: state.q || null,
            oninput: (e) => { state.q = e.currentTarget.value; redraw(); syncHash(state); } }),
          h('label', {},
            h('input', { type: 'checkbox', checked: state.onlyOpen,
              onchange: (e) => { state.onlyOpen = e.currentTarget.checked; state.toggled.clear(); redraw(); syncHash(state); } }),
            t(' 只看未完成的分组')),
          filterMenu(board, state), // 任务 6.6：UI 稿没画，按 P4 放在工具栏
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted tbnote' }, t('行 = 文档里的任务；PR 以标签挂在行尾'))),
        treeBox),
      h('div', { class: 'card side' },
        recentSec(board, state), // 任务 6.3
        unlinkedSection(board, state), // 任务 4.2
        h('div', { class: 'sec' }, h('h2', {}, t('各份文档进度')), docProgress(board)))));
}

/**
 * 任务树：文档（lv1）→ 分组（lv2）→ 任务行，保持文档顺序（需求 10.2）。
 * 勾选「只看未完成的分组」时全部完成的文档 / 分组默认折叠（需求 10.5），点折叠按钮可展开；
 * 有搜索词时只列命中的行，并展开其所在文档与分组。
 */
export function renderTree(board, state, redraw = () => {}) {
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const stats = new Map(board.stats.docs.map((d) => [d.docId, d]));
  const q = state.q.trim().toLowerCase();
  // 纯数字或 #数字 也按 PR 号找：命中挂着该 PR 的任务（需求 10.4；已手动解除的不算）
  const pr = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  const hit = (t) => !q || t.number.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
    || (pr != null && !!views.get(t.key)?.prs.some((l) => l.pr === pr && !l.removedManually));
  // 默认折叠 = 勾选且全部完成；toggled 里记的是用户点过、与默认相反的节点。
  // 按里程碑 / 状态 / 冲突筛选时要看的就是筛出来的任务，不再按「全部完成」默认折叠（如只看已完成时）
  const foldDone = state.onlyOpen && !taskFiltered(state);
  const isOpen = (key, done) => !!q || (foldDone && done) === state.toggled.has(key);
  const toggle = (key) => () => { if (!state.toggled.delete(key)) state.toggled.add(key); redraw(); };
  // 点「详情」= 地址加 focus=，由路由打开任务详情抽屉（刷新页面、前进后退都能还原）
  const ctx = { conflicts: conflictsByTask(board), prTags: prTagger(board, state), aiTag: sessionTagger(board, state),
    open: (key) => { location.hash = hashFor(state.view, state.project, key, state.line, state); } };
  // 需求 10.2：父任务可收起子任务，默认展开（有搜索词时也全展开）；state.toggled 里有 task:<任务键> = 收起
  const byKey = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  const taskOpen = (key) => !!q || !state.toggled.has(`task:${key}`);
  ctx.fold = { open: taskOpen, toggle: (key) => (e) => { e.stopPropagation(); toggle(`task:${key}`)(); } };
  const shownRow = (t) => {
    for (let p = t.parentKey; p && byKey.has(p); p = byKey.get(p).parentKey) if (!taskOpen(p)) return false;
    return true;
  };
  const rows = (list) => list.filter(shownRow).map((t) => taskRow(t, views.get(t.key), ctx));

  const docs = board.docs.filter((d) => !d.archived).map((doc) => {
    const st = stats.get(doc.docId);
    const tasks = doc.tasks.filter(hit);
    if (q && !tasks.length) return null;
    const key = `doc:${doc.docId}`;
    const open = isOpen(key, allDone(st));
    const groups = doc.groups.map((g) => {
      const list = tasks.filter((t) => t.groupId === g.id);
      if (!list.length) return null;
      const gs = st.groups.find((x) => x.groupId === g.id);
      const gkey = `grp:${doc.docId}/${g.id}`;
      const gopen = isOpen(gkey, allDone(gs));
      // N23：展开的分组连同任务包成卡片（.gblock.open），折叠的仍是普通一行
      return h('div', { class: `gblock${gopen ? ' open' : ''}` },
        h('div', { class: `grp lv2${gopen ? '' : ' closed'}` },
          h('button', { type: 'button', class: 'caret', 'aria-label': t`折叠分组 ${doc.docId}/${g.id}`,
            'aria-expanded': String(gopen), onclick: toggle(gkey) }, '▾'),
          h('span', { class: 'gname' }, g.title),
          h('span', { class: 'gp' }, allDone(gs) && h('span', { class: 'st done' }, t`${STATUS_UI.done.icon} 全部完成`),
            `${gs.counts.done}/${gs.total}`, stackBar(gs))),
        h('div', { class: `rows${gopen ? '' : ' hide'}` }, rows(list)));
    });
    return h('div', { class: 'doc' },
      // 没有任务的文档（无任务 ADR、规划中）没东西可折叠：留空位对齐，不画三角、不可点
      h('div', { class: `grp lv1${open ? '' : ' closed'}` },
        doc.tasks.length ? h('button', { type: 'button', class: 'caret', 'aria-label': t`折叠文档 ${doc.docId}`,
          'aria-expanded': String(open), onclick: toggle(key) }, '▾') : h('span', { class: 'caret' }),
        doc.adr ? adrHead(doc) : h('span', { class: 'gname', title: doc.title }, doc.docId),
        doc.shownArchived && h('span', { class: 'flag info' }, t('已归档')), // 任务 6.6：「显示已归档文档」筛出来的
        h('span', { class: 'muted path' }, doc.path),
        h('span', { class: 'gp' }, st.total ? [`${st.counts.done}/${st.total}`, stackBar(st)] : null)),
      docNote(doc),
      // 第一个分组标题之前的任务不属于任何分组，直接挂在文档下
      h('div', { class: `rows${open ? '' : ' hide'}` }, rows(tasks.filter((t) => !t.groupId)), groups));
  }).filter(Boolean);

  return h('div', { class: 'tree' },
    docs.length ? docs : h('div', { class: 'empty' }, q || FILTER_FIELDS.some((k) => state[k]) ? t('没有匹配的任务') : t('没有可显示的规划文档')));
}

/**
 * 任务行，列顺序同 UI 稿：状态徽标、编号、标题（后接「依赖 …」「∥ 可与 … 并行」，需求 4.9）、行尾标签区、「详情」按钮。
 * ctx = { conflicts: 任务键 → 冲突明细[], open(任务键), fold: {open(任务键), toggle(任务键)}（父任务折叠三角） }。
 */
function taskRow(task, view, ctx) {
  const lab = (k) => refLabel(k, task.docId);
  return h('div', { class: `row${task.parentKey ? ' child' : ''}${task.void ? ' void' : ''}` },
    h('span', { class: 'st-cell' }, badge(view.status)),
    h('span', { class: 'id' }, task.number),
    h('span', { class: 'title', title: mdText(task.title) },
      view.childSummary && ctx.fold && h('button', { type: 'button', class: 'tcaret', 'aria-label': t`折叠子任务 ${task.key}`,
        'aria-expanded': String(ctx.fold.open(task.key)), title: ctx.fold.open(task.key) ? t('收起子任务') : t('展开子任务'),
        onclick: ctx.fold.toggle(task.key) }, ctx.fold.open(task.key) ? '▾' : '▸'),
      mdInline(task.title),
      view.childSummary && h('span', { class: 'dep' }, t`子任务 ${view.childSummary.done}/${view.childSummary.total} 完成`),
      view.deps.on.length > 0 && h('span', { class: 'dep' }, t`依赖 ${view.deps.on.map(lab).join(t('、'))}`),
      view.parallelWith.length > 0 && h('span', { class: 'dep' }, t`∥ 可与 ${view.parallelWith.map(lab).join(t('、'))} 并行`)),
    h('span', { class: 'tags' }, rowTags(view, ctx.conflicts.get(task.key), ctx.prTags(view, task), ctx.aiTag(view))),
    h('button', { type: 'button', class: 'linkbtn task-detail', 'aria-label': t`详情 ${task.key}`,
      onclick: () => ctx.open(task.key) }, t('详情')));
}

/**
 * 行尾标签，顺序同 UI 稿 tagsOf：⛔ 未解除的外部阻塞、AI 会话标记（任务 5.5，sessionTagger 生成）、PR 标签（任务 3.6，prTagger 生成）、
 * 仅文档确认、⚠ 不一致（冲突提示，悬停看明细）。冲突 c 就是「仅文档确认」本身，不再重复算「不一致」。
 */
function rowTags(view, conflicts = [], prTags = null, aiTag = null) {
  const other = conflicts.filter((c) => c.type !== 'c');
  return [
    view.deps.external.filter((e) => !e.resolved).map((e) => h('span', { class: 'blk', title: t('外部前置未满足') }, `⛔ ${e.id}`)),
    aiTag,
    prTags,
    view.docOnly && h('span', { class: 'flag info', title: t('文档里已勾选，但没有找到对应 PR') }, t('仅文档确认')),
    other.length > 0 && h('span', { class: 'flag', title: other.map((c) => tx(c.detail)).join('\n') }, t('⚠ 不一致')),
  ];
}

function conflictsByTask(board) {
  const m = new Map();
  for (const c of board.conflicts ?? []) if (c.taskKey) (m.get(c.taskKey) ?? m.set(c.taskKey, []).get(c.taskKey)).push(c);
  return m;
}

// ---------------- 最近变化（任务 6.3） ----------------

const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const SESSION_TOOL = { 'claude-code': 'Claude', codex: 'Codex' };

/**
 * 总览右栏「这几天发生了什么」（需求 10.3；UI 稿 .ev 条目「时间 + 事件」）。事件由 engine recentChanges 推出（Board.recent），
 * 这里只按起始日筛：默认近 recent.days 天，日期选择（datePicker）可改成任意日期（P4）。起始日存在 state.recentFrom
 * （'YYYY-MM-DD'，未设 = 默认窗口），按本地时区当天 0 点起算；改起始日只重画本区块。
 * 选了分支线时：PR 事件只留该分支线的 PR，会话 / 任务事件只留分支线内文档的任务（lineBoard 已筛好 docs）。
 */
function recentSec(board, state) {
  const recent = board.recent ?? { days: 7, events: [] };
  const box = h('div', { class: 'evlist' });
  const suffix = h('span', { class: 'muted' });
  const lineOf = new Map(board.prs.map((p) => [p.number, p.branchLine]));
  const shown = new Set(board.docs.flatMap((d) => d.tasks.map((t) => t.key)));
  const keep = (e) => (e.kind === 'pr' ? !state.line || lineOf.get(e.pr) === state.line
    : (e.tasks ?? [e.taskKey]).some((k) => shown.has(k)));
  const def = ymd(new Date(state.now - recent.days * 864e5));
  const draw = () => {
    const from = new Date(`${state.recentFrom || def}T00:00`).getTime();
    suffix.textContent = state.recentFrom && state.recentFrom !== def ? t`· ${state.recentFrom} 起` : t`· 近 ${recent.days} 天`;
    const list = recent.events.filter((e) => Date.parse(e.at) >= from && keep(e));
    box.replaceChildren(...(list.length ? list.map((e) => h('div', { class: 'ev' },
      h('span', { class: 't', title: clock(e.at) }, e.activity === 'running' ? t('刚刚') : day(e.at)),
      h('span', {}, evText(e)))) : [h('div', { class: 'muted evnone' }, t('这段时间没有变化'))]));
  };
  draw();
  return h('div', { class: 'sec' },
    h('h2', {}, t('这几天发生了什么 '), suffix),
    h('div', { class: 'muted evbar' },
      // 不用 label 包：点日历空白处会被转发成点按钮、把日历关掉
      h('span', {}, t('起始日 '), datePicker(state, { label: t('起始日'), value: state.recentFrom || def, max: ymd(new Date(state.now)),
        onChange: (v) => { state.recentFrom = v; draw(); syncHash(state); } })),
      t(' · 复选框的勾选变化没有历史，不在此列')),
    box);
}

/** 任务键列表 → 「docId 1、2」，多份文档用「；」隔开；word 插在编号前（「docId 任务 1」）。 */
function taskNames(keys, word = '') {
  const by = new Map();
  for (const k of keys) {
    const i = k.lastIndexOf('#');
    (by.get(k.slice(0, i)) ?? by.set(k.slice(0, i), []).get(k.slice(0, i))).push(k.slice(i + 1));
  }
  return [...by].map(([docId, nums]) => `${docId} ${word}${shortList(nums)}`).join(t('；'));
}

/** 一条最近变化的文字，句式同 UI 稿（如「#381 已在 GitHub 合并（任务 2.1）· 本地还没 pull」「#369 已合并 · 没关联到任务」）。 */
function evText(e) {
  if (e.kind === 'session') {
    const who = t`${SESSION_TOOL[e.source] ?? 'AI'} 会话`;
    return e.activity === 'stale' ? t`${taskNames(e.tasks)} 的会话之后再没动过（停滞）`
      : e.activity === 'running' ? t`${taskNames(e.tasks)} · ${who}仍在运行` : t`${taskNames(e.tasks)} · ${who}有新活动`;
  }
  if (e.kind === 'status') return `${taskNames([e.taskKey])} → ${STATUS_UI[e.status].icon} ${STATUS_UI[e.status].text}`;
  const n = `#${e.pr}`;
  const about = e.tasks.length ? t`（${taskNames(e.tasks, t('任务 '))}）` : null;
  const none = !e.tasks.length && [' · ', h('span', { class: 'warntext' }, t('没关联到任务'))];
  switch (e.action) {
    case 'opened': return [e.draft ? t`${n} 开了 draft PR` : t`${n} 开了 PR`, about, none];
    case 'ready': return [t`${n} 转为 ready`, about, none];
    case 'closed': return [t`${n} 关闭未合并`, about, none];
    default:
      if (e.localSync === 'pending') return [t`${n} 已在 GitHub 合并`, about, h('b', { class: 'warntext' }, t(' · 本地还没 pull')), none];
      return e.done.length ? t`${n} 已合并 → ${taskNames(e.done)} 完成` : [t`${n} 已合并`, about, none];
  }
}

// ---------------- 任务详情抽屉（任务 2.5） ----------------

// 关系出自文档的哪一处（RawRelation.via）
const VIA_TEXT = { title: t('任务标题'), body: t('任务正文'), 'group-note': t('分组说明'), mermaid: t('Mermaid 任务图'), 'prereq-table': t('前置条件表') };

/** 「为什么是这个状态」：命中的判定规则（需求 8.2）写成人话；规则编号放悬停提示（需求 8.8）。 */
function statusWhy(view, task) {
  if (!view.status) return t('任务已作废（整行删除线或写明作废），不计入进度');
  switch (view.rule) {
    case '8.2-1': return view.status === 'in_review' ? t('关联 PR 是 draft，等 review') : t('关联 PR 是 ready（非 draft），还没合并');
    case '8.2-2':
      if (view.syncPending?.length) {
        return t`PR ${view.syncPending.map((n) => `#${n}`).join(t('、'))} 在 GitHub 上已合并，但本地分支还没有这个合并提交 → 仍算「等待合并」，标「已合并·待同步到本地」；${task.checkbox === 'done' ? t('文档已勾选，本地同步后即完成') : t('本地同步后仍须文档勾选确认，才算完成')}`;
      }
      return view.syncUnchecked
        ? t('文档已勾选、关联 PR 已合并；拿不到合并提交或本地没有对应 base 分支，本地同步未核对，按已合并完成算')
        : t('文档已勾选、关联 PR 已合并，且本地已包含合并提交');
    case '8.2-3': return t('文档里已勾选，没找到 PR → 仅文档确认');
    case '8.2-4': {
      const part = view.inProgressBy.includes('partial') && [...new Set(view.prs.filter((l) => l.partial).map((l) => `#${l.pr}`))];
      const merged = view.inProgressBy.includes('merged');
      return [view.inProgressBy.includes('session') && t('本项目里有 AI 会话正在做这个任务'),
        view.inProgressBy.includes('marker') && t('文档里标了进行中（[~]）'),
        part && t`PR ${part.join(t('、'))} 标了「部分」、已合并；文档尚未勾选确认完整交付，仍算进行中`,
        merged && t('相关 PR 已合并，但文档尚未勾选确认完整交付，仍算进行中'),
      ].filter(Boolean).join(t('；')) + (part || merged ? '' : t('，还没有 PR'));
    }
    default: return t('没有关联的会话或 PR，文档也没勾选');
  }
}

/**
 * 任务详情抽屉（UI 稿 openTask；需求 4.9、4.10、8.8、11.4、18.1）：state.focus 指向的任务，找不到则不画。
 * 返回 [遮罩, 抽屉]；点遮罩 / ✕ 调 onClose（Esc 由 main 处理）。抽屉内的「查看原文」「第 N 行」只重画抽屉自身。
 * 原文经 state.texts / state.need 取得（GET /api/projects/:id/docs/:docId），全部以文本节点显示。
 */
export function renderDrawer(board, state, onClose) {
  if (state.focus?.startsWith('#')) return renderPrDrawer(board, state, onClose); // 任务 3.6：focus=#号 是 PR
  const task = board.docs.flatMap((d) => d.tasks).find((t) => t.key === state.focus);
  if (!task) return [];
  const aside = h('aside', { class: 'drawer open', 'aria-label': t('任务详情') });
  const redraw = () => keepFocus(aside, () => {
    aside.replaceChildren(...drawerContent(board, state, task, redraw, onClose));
    scrollToTarget(aside, state);
  });
  aside.replaceChildren(...drawerContent(board, state, task, redraw, onClose));
  return [h('div', { class: 'scrim open', onclick: onClose }), aside];
}

function drawerContent(board, state, task, redraw, onClose) {
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const titles = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t.title]));
  const view = views.get(task.key);
  const doc = board.docs.find((d) => d.docId === task.docId);
  const group = doc.groups.find((g) => g.id === task.groupId);
  const lab = (k) => refLabel(k, task.docId);
  const link = (k) => h('a', { href: hashFor(state.view, state.project, k, state.line, state), title: mdText(titles.get(k)) }, lab(k));
  const none = (text) => h('span', { class: 'muted' }, text);
  const text = (docId) => {
    const t = state.texts.get(docId);
    if (t === undefined || t?.stale) state.need(docId); // 过期的照常显示，后台重读
    return t;
  };
  // 关系来源里的文件是仓库内相对路径，反查 docId 才能在查看器里打开
  const showSource = (file, line) => {
    const d = board.docs.find((x) => x.path === file);
    if (d) { state.viewer = { docId: d.docId, line, scrolled: false }; redraw(); }
  };
  const lineBtn = (file, line) => h('button', { class: 'linkbtn', onclick: () => showSource(file, line) }, t`第 ${line} 行`);

  const dangling = [...new Set(view.deps.dangling.map((x) => x.raw))];
  const prereqs = [
    ...view.deps.on.map((k) => h('span', {}, link(k), ' ', badge(views.get(k)?.status))),
    ...dangling.map((raw) => h('span', {}, raw, ' ', h('span', { class: 'flag' }, t('找不到')))),
  ];
  const post = board.tasks.filter((v) => v.deps.on.includes(task.key)).map((v) => v.key);

  return [
    h('div', { class: 'hd' },
      h('div', { class: 'hmain' },
        h('div', { class: 'muted crumb' }, group ? `${doc.docId} · ${group.title}` : doc.docId),
        h('h2', {}, t`${task.number}　`, mdInline(task.title)),
        h('div', { class: 'hdtags' }, badge(view.status),
          rowTags(view, board.conflicts.filter((c) => c.taskKey === task.key), prTagger(board, state)(view, task), sessionTagger(board, state)(view)))),
      h('button', { class: 'btn', title: t('关闭（Esc）'), onclick: onClose }, '✕')),
    h('div', { class: 'bd' },
      h('dl', { class: 'kv' },
        h('dt', {}, t('为什么是这个状态')), h('dd', { title: view.rule ? t`规则 ${view.rule}` : null }, statusWhy(view, task)),
        h('dt', {}, t('前置')), h('dd', { class: 'rels' }, prereqs.length ? prereqs : none(t('无'))),
        h('dt', {}, t('后续')), h('dd', { class: 'rels' }, post.length ? post.map(link) : none(t('无'))),
        h('dt', {}, t('可并行')), h('dd', { class: 'rels' }, view.parallelWith.length ? view.parallelWith.map(link) : none(t('文档没写'))),
        view.deps.external.length > 0 && [
          h('dt', {}, t('外部阻塞')),
          h('dd', { class: 'rels' }, view.deps.external.map((e) => (e.resolved
            ? h('span', { class: 'muted' }, t`${e.id}（已解除）`) : h('span', { class: 'red' }, t`${e.id} 未解除`)))),
        ],
        h('dt', {}, t('文档位置')),
        h('dd', {}, h('code', {}, doc.path), t` 第 ${task.line} 行 · `,
          h('button', { class: 'linkbtn', onclick: () => showSource(doc.path, task.line) }, t('查看原文')))),
      h('h3', {}, t('正文')),
      taskBody(task, () => text(doc.docId)),
      h('h3', {}, t('关系来源')),
      relationSources(view, doc, lab, lineBtn),
      taskPrSection(board, state, view),
      taskSessionSection(board, state, view),
      taskGanttSection(task, view),
      state.viewer && sourceViewer(board, state, task, text(state.viewer.docId), redraw)),
  ];
}

// 正文 = 任务行之后到正文末行（bodyRange 闭区间），按 Markdown 排版显示；只有一行的任务不去取原文。
function taskBody(task, getText) {
  if (task.bodyRange[1] <= task.line) return h('div', { class: 'muted' }, t('这个任务在文档里只有一行，没有正文。'));
  const text = getText();
  if (!text) return h('div', { class: 'muted' }, t('正在读取原文…'));
  if (text.error) return h('div', { class: 'flag' }, t`原文读取失败：${tx(text.error)}`);
  return mdBlock(text.lines.slice(task.bodyRange[0], task.bodyRange[1]));
}

// 行内 Markdown：`代码`、**加粗**、~~删除线~~、[文字](http 链接)；最左的先认，加粗 / 删除线里面递归。
// 全部走 h() / 文本节点（design K2），原文里的 HTML 标签照字面显示；非 http(s) 链接只留文字。
// ponytail: 不认 *斜体*——实物里单星号多是 `*.mjs` 这类通配，误伤比漏认更糟；真要时再按词边界加。
const MD_INLINE = /`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|\[([^\]]+)\]\(([^)\s]+)\)/g;
function mdInline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MD_INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h('code', {}, m[1]));
    else if (m[2] != null) out.push(h('b', {}, mdInline(m[2])));
    else if (m[3] != null) out.push(h('s', {}, mdInline(m[3])));
    else out.push(/^https?:\/\//.test(m[5]) ? h('a', { href: m[5], target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, m[4]) : m[4]);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((x) => x !== '');
}

// SVG / 悬停只收纯文本；复用同一解析结果，保留代码里的星号和不配对的标记，不改任务原文。
const mdText = (text) => mdInline(text ?? '').map((part) => typeof part === 'string' ? part : part.textContent).join('');

/**
 * 块级 Markdown（任务正文够用的子集）：按缩进嵌套的 - / * / + / 1. 列表（含 [ ] [x] [~] 复选框）、``` 代码块、> 引用，
 * 其余行成段落。列表项下更深缩进的非列表行接在该项里（换行保留，中文文档的手动折行多是有意的）。
 */
const MD_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MD_BOX = { ' ': '☐', x: '☑', X: '☑', '~': '◔' };
export function mdBlock(lines) {
  const root = h('div', { class: 'md' });
  let lists = []; // 打开着的列表：{ indent, tag, el, li }
  let para = null;
  let code = null;
  const into = () => lists.at(-1)?.li ?? root;
  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) code = null;
      else code.append(document.createTextNode(`${line.replace(/^\s+/, '')}\n`));
      continue;
    }
    if (!line.trim()) { para = null; continue; }
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (text.startsWith('```')) {
      while (lists.length && lists.at(-1).indent >= indent) lists.pop();
      code = h('code', {});
      into().append(h('pre', {}, code));
      para = null;
      continue;
    }
    const item = MD_ITEM.exec(line);
    if (item) {
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      // 同缩进换了标记类型（- 换成 1.）= 另起一个列表
      while (lists.length && (lists.at(-1).indent > indent || (lists.at(-1).indent === indent && lists.at(-1).tag !== tag))) lists.pop();
      if (lists.at(-1)?.indent !== indent) {
        const el = h(tag, {});
        into().append(el);
        lists.push({ indent, tag, el, li: null });
      }
      const box = /^\[([ xX~])\]\s+(.*)$/.exec(item[3]);
      const li = h('li', {}, box && h('span', { class: 'box' }, MD_BOX[box[1]]), mdInline(box ? box[2] : item[3]));
      lists.at(-1).el.append(li);
      lists.at(-1).li = li;
      para = null;
      continue;
    }
    if (lists.length && indent > lists.at(-1).indent) { lists.at(-1).li.append(h('br', {}), ...mdInline(text)); continue; }
    lists = [];
    if (text.startsWith('>')) { root.append(h('blockquote', {}, mdInline(text.replace(/^>\s?/, '')))); para = null; continue; }
    if (para) para.append(h('br', {}), ...mdInline(text));
    else root.append(para = h('p', {}, mdInline(text)));
  }
  return root;
}

/** 每条依赖 / 并行 / 外部阻塞一个框：出自哪里、文件、行号（可在查看器里打开）、原文（需求 4.10、18.1）。 */
function relationSources(view, doc, lab, lineBtn) {
  const src = (s, via, inheritedFrom) => [
    h('div', { class: 'src' }, via ? `${VIA_TEXT[via] ?? via} · ` : null, `${s.file} `, lineBtn(s.file, s.line),
      inheritedFrom ? t` · 继承自 ${lab(inheritedFrom)}` : null),
    h('div', { class: 'quote' }, t`「${s.text}」`),
  ];
  const box = (head, lines) => h('div', { class: 'box rel' }, h('b', {}, head), lines);
  const boxes = [
    ...view.deps.edges.map((e) => box(t`依赖 ${lab(e.on)}`, e.sources.map((s) => src(s.source, s.via, s.inheritedFrom)))),
    ...view.deps.dangling.map((x) => box(t`依赖 ${x.raw}（找不到）`, src(x))),
    ...(view.parallelEdges ?? []).map((p) => box(t`可并行 ${lab(p.with)}`, p.sources.map((s) => src(s.source, s.via)))),
    ...view.deps.external.map((e) => {
      const p = (doc.prerequisites ?? []).find((x) => x.id === e.id);
      return box(t`外部阻塞 ${e.id}${e.resolved ? t('（已解除）') : ''}`, p ? src(p.source, 'prereq-table') : null);
    }),
  ];
  return boxes.length ? boxes : h('div', { class: 'muted' }, t('文档没写这个任务的依赖或并行关系。'));
}

/** 页内原文查看器（P4：纯文本 + 行号）：目标行高亮并滚到可视区，当前任务的行区间淡底。 */
function sourceViewer(board, state, task, text, redraw) {
  const v = state.viewer;
  const doc = board.docs.find((d) => d.docId === v.docId);
  const inTask = (n) => v.docId === task.docId && n >= task.bodyRange[0] && n <= task.bodyRange[1];
  return [
    h('h3', { class: 'srchd' }, t`原文 · ${doc.path}`,
      h('button', { class: 'linkbtn', onclick: () => { state.viewer = null; redraw(); } }, t('收起'))),
    !text ? h('div', { class: 'muted' }, t('正在读取原文…'))
      : text.error ? h('div', { class: 'flag' }, t`原文读取失败：${tx(text.error)}`)
        : h('div', { class: 'srcview' }, text.lines.map((line, i) => h('div', {
          class: `ln${i + 1 === v.line ? ' target' : ''}${inTask(i + 1) ? ' hl' : ''}`,
        }, h('span', { class: 'no' }, i + 1), h('span', { class: 'tx' }, line)))),
  ];
}

// 查看器的目标行只在打开 / 换目标后滚一次；节点须已挂到页面上（抽屉首次渲染时还没挂，由 main 的 paint 补滚）。
function scrollToTarget(root, state) {
  const el = state.viewer && !state.viewer.scrolled && root.querySelector('.ln.target');
  if (!el?.scrollIntoView) return;
  state.viewer.scrolled = true;
  el.scrollIntoView({ block: 'center' });
}

/**
 * ADR 文档级条目的标题部分（需求 2.6、D5）：来源类型标「ADR」、编号 + 标题、状态原文（不归一化）。
 * 文件名里没有编号时用 docId 顶替；ADR 内有任务行时任务照常挂在这一行下面。
 */
function adrHead(doc) {
  const { number, status } = doc.adr;
  return [
    h('span', { class: 'flag info' }, 'ADR'),
    h('span', { class: 'gname', title: doc.docId }, number ? `ADR-${number}` : doc.docId, doc.title ? ` ${doc.title}` : null),
    status && h('span', { class: 'adrst', title: t('文档声明的状态（原文）') }, status),
  ];
}

// 规划中 / 解析不完整 / 未解析出任务 / 读取失败 如实显示，不显示成「0 个任务、已完成」（需求 2.5、2.7）
function docNote(doc) {
  const s = DOC_STATE[doc.parse.state];
  if (!s) return null;
  const reason = doc.parse.reason;
  return h('div', { class: `docnote ${s.cls}`.trim() }, s.withReason && reason ? t`${s.label}：${tx(reason)}` : (tx(reason) ?? s.label));
}

function docProgress(board) {
  const stats = new Map(board.stats.docs.map((d) => [d.docId, d]));
  // 没有任务的 ADR 只是决策记录，放进进度栏只会刷出几十行「无任务」，这里不列；它们仍在任务树里可见。
  const docs = board.docs.filter((d) => !d.archived && !(d.kind === 'adr' && !d.tasks.length));
  if (!docs.length) return h('div', { class: 'muted' }, t('没有规划文档'));
  return docs.map((doc) => {
    const st = stats.get(doc.docId);
    return h('div', { class: 'dp' },
      h('div', { class: 'dh' },
        h('span', { title: doc.title }, doc.docId),
        h('span', { class: 'muted' }, st.total ? `${st.counts.done}/${st.total} · ${pct(st.ratio)}` : (DOC_STATE[doc.parse.state]?.label ?? t('无任务')))),
      st.total ? stackBar(st) : null);
  });
}

// ---------------- 关系图（任务 2.7） ----------------

/**
 * 关系图（需求 4.7、4.9；UI 稿 renderGraph）：一次画一份文档，画法在 svg.mjs。
 * 所选文档与两个开关记在 state 上，只重画本视图：graphDoc（缺省 = 第一份）、
 * graphOpenOnly「只看未完成」、graphFade「淡化已完成」——两个开关默认都开，第一次渲染时补上默认值。
 */
export function renderGraph(board, state) {
  state.graphOpenOnly ??= true;
  state.graphFade ??= true;
  const box = h('section', { id: 'v-graph' });
  const redraw = () => box.replaceChildren(graphCard(board, state, redraw));
  redraw();
  return box;
}

function graphCard(board, state, redraw) {
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const docs = board.docs.filter((d) => !d.archived && d.tasks.some((t) => !t.void));
  const doc = docs.find((d) => d.docId === state.graphDoc) ?? docs[0];
  // 作废任务不画；「只看未完成」隐藏已完成节点，指向它们的线随之省略（graphNode 只保留图内的两端）
  const tasks = (doc?.tasks ?? []).filter((t) => !t.void && !(state.graphOpenOnly && views.get(t.key).status === 'done'));
  const inGraph = new Set(tasks.map((t) => t.key));
  const sourceOf = new Map((board.sessions ?? []).map((s) => [s.id, s.source]));
  const nodes = tasks.map((t) => graphNode(t, views.get(t.key), state.graphFade, inGraph, sourceOf));
  const toggle = (k) => (e) => { state[k] = e.currentTarget.checked; redraw(); };
  const open = (key) => { location.hash = hashFor(state.view, state.project, key, state.line, state); };

  return h('div', { class: 'card' },
    h('div', { class: 'legend' },
      // 选项只写 docId（同总览任务树）：真实文档标题常是「Implementation Plan — <docId>」这类长句，撑宽下拉挤掉图例；标题放悬停提示
      dropdown(state, { label: t('文档'), value: doc?.docId, options: docs.map((d) => ({ value: d.docId, text: d.docId, title: d.title })),
        onChange: (v) => { state.graphDoc = v; redraw(); } }),
      h('span', {}, legendIcon('dep'), t(' 依赖（先后顺序）')),
      h('span', {}, legendIcon('par'), t(' 可并行')),
      h('span', {}, legendIcon('blocked'), t(' 被阻塞 / 无法排期')),
      h('span', {}, legendIcon('cycle'), t(' 依赖成环')),
      h('span', { class: 'spacer' }),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: state.graphOpenOnly, onchange: toggle('graphOpenOnly') }), t(' 只看未完成')),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: state.graphFade, onchange: toggle('graphFade') }), t(' 淡化已完成'))),
    h('div', { class: 'note' }, t('从左往右读：越往右越晚才能做。同一列里的任务互相不依赖，前置满足后可以一起做。鼠标移到任务上高亮它的前置（蓝）、后续（灰）和可并行任务（绿），点任务看详情。')),
    h('div', { class: 'gwrap' }, nodes.length ? graphSvg(nodes, { onOpen: open })
      : h('div', { class: 'empty' }, doc ? t('这份文档的任务都已完成；取消勾选「只看未完成」可查看全部。') : t('没有可画关系图的规划文档。'))));
}

/**
 * TaskView → 关系图节点（svg.mjs graphSvg 的入参）。第二行附加信息按 UI 稿优先级：
 * 未解除的外部阻塞（红字）→ 关联 PR 号 → AI 会话运行中 / 停滞 → 状态文字。
 * 「被阻塞」框 = 外部阻塞未解除或甘特判定无法排期（同 UI 稿；仅前置未完成不算，否则大半张图都是红框）。
 * 依赖与并行只保留两端都在图里的：跨文档依赖、已隐藏的已完成任务不画线（抽屉里仍能看到）。
 */
function graphNode(task, view, fade, inGraph, sourceOf) {
  const st = STATUS_UI[view.status];
  const blockers = view.deps.external.filter((e) => !e.resolved).map((e) => e.id);
  const closed = new Set(view.excludedPrs.map((x) => x.pr));
  const prs = [...new Set(view.prs.map((l) => l.pr))].filter((n) => !closed.has(n));
  // 来源名取最近活动那个会话（同 sessionTagger）
  const word = { running: t('运行中'), stale: t('停滞') }[view.activity];
  const src = word && view.sessions.length ? sourceOf.get(latestLink(view.sessions).sessionId) : null;
  const ai = word && `● ${SESSION_SHORT[src] ?? src ?? 'AI'} ${word}`;
  const title = mdText(task.title);
  const chars = Array.from(title);
  return {
    id: task.key, label: task.number, icon: st.icon, st: st.cls,
    title: chars.length > 11 ? `${chars.slice(0, 11).join('')}…` : title,
    tip: `${task.number} ${title} · ${st.text}`,
    extra: blockers.length ? `⛔ ${blockers.join(t('、'))}` : prs.length ? prs.map((n) => `#${n}`).join(' ') : ai ?? st.text,
    extraRed: blockers.length > 0,
    cls: [fade && view.status === 'done' && 'done', (blockers.length > 0 || !!view.gantt?.unschedulable) && 'blocked',
      view.deps.inCycle && 'cyc'].filter(Boolean),
    dep: view.deps.on.filter((k) => inGraph.has(k)),
    par: view.parallelWith.filter((k) => inGraph.has(k)),
  };
}

// ---------------- 下一步（任务 2.6） ----------------

/**
 * 下一步（需求 12；UI 稿 renderNext）：四栏——▶ 可开工（每批一个虚线框）、⏳ 即将可开工、⛔ 被阻塞、🙋 等我处理。
 * 分类全部来自 engine.classifyNext（TaskView.next / batch / deps.unmet / deps.waitingFor），这里只负责展示、不触发任何动作（需求 12.7）；
 * next 为 confirm（悬空 / 成环）的任务归「需要确认」视图，不在这里。归档文档不参与（需求 2.10）。点卡片开任务抽屉。
 * 「等我处理」：Board.waiting 里的 PR 卡片（3.6）、停滞会话卡片（5.5）+ 未解除的外部前置。
 */
export function renderNext(board, state) {
  const live = board.docs.filter((d) => !d.archived);
  const tasks = new Map(live.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  const views = board.tasks.filter((v) => tasks.has(v.key));
  const byKey = new Map(board.tasks.map((v) => [v.key, v]));
  const of = (next) => views.filter((v) => v.next === next);
  const open = (key) => () => { location.hash = hashFor(state.view, state.project, key, state.line, state); };
  const why = (text, red) => h('div', { class: `why${red ? ' red' : ''}` }, text);
  const card = (v, ...whys) => {
    const t = tasks.get(v.key);
    return h('div', { class: 'tk', onclick: open(v.key) },
      h('div', { class: 'top' }, badge(v.status), h('span', {}, `${t.docId} · ${t.number}`)),
      h('div', { class: 'tt', title: mdText(t.title) }, mdInline(t.title)), whys);
  };
  // 在等的前置：编号 + 状态文字 + PR 号；已合并但本地没 pull 的写「已合并·待同步本地」和那几个已合并 PR
  const waitText = (docId, w) => {
    const pending = w.syncPending?.length > 0;
    const prs = (pending ? w.syncPending : w.prs ?? []).map((n) => ` #${n}`).join('');
    return `${refLabel(w.on, docId)} ${pending ? t('已合并·待同步本地') : STATUS_UI[w.status].text}${prs}`;
  };

  // 引擎的批号在全部文档（含归档）上编，这里按显示顺序重新从 1 编
  const batches = new Map();
  for (const v of of('ready')) (batches.get(v.batch) ?? batches.set(v.batch, []).get(v.batch)).push(v);
  const ready = [...batches.values()].map((list, i) => h('div', { class: 'batch' },
    h('div', { class: 'bl' }, list.length > 1 ? t`第 ${i + 1} 批 · 可并行` : t`第 ${i + 1} 批`),
    list.map((v) => card(v, why(v.deps.on.length
      ? t`依赖已满足：${shortList(v.deps.on.map((k) => refLabel(k, tasks.get(v.key).docId)))}` : t('没有前置依赖'))))));

  const soon = of('soon').map((v) => {
    const docId = tasks.get(v.key).docId;
    return card(v, why(t`在等：${v.deps.waitingFor.map((w) => waitText(docId, w)).join(t('；'))}`));
  });

  // 被阻塞：未解除的外部前置红字；卡住的前置（未满足的依赖）另起一行列出各自状态
  const blocked = of('blocked').map((v) => {
    const docId = tasks.get(v.key).docId;
    const ext = v.deps.external.filter((e) => !e.resolved).map((e) => e.id);
    const unmet = v.deps.unmet.map((k) => { const d = byKey.get(k); return { on: k, status: d.status, prs: [], syncPending: d.syncPending }; });
    return card(v,
      ext.length > 0 && why(t`外部前置：${ext.join(t('、'))}`, true),
      unmet.length > 0 && why(t`在等：${shortList(unmet.map((w) => waitText(docId, w)), t('；'))}`));
  });

  // 顺序同 UI 稿：PR（待同步 / 等合并 / 等 review，任务 3.6）、停滞会话（任务 5.5）、外部前置
  const mine = [...waitingCards(board, state, views), ...staleCards(board, state, views), ...prereqCards(live, views, tasks, open)];

  const col = (title, n, hint, cards, warn) => h('div', { class: 'card col' },
    h('h2', {}, title, h('span', { class: `count${warn && n ? ' warn' : ''}` }, n)),
    h('div', { class: 'hint' }, hint),
    cards.length ? cards : h('div', { class: 'muted' }, t('暂无')));
  return h('section', { id: 'v-next' }, h('div', { class: 'cols' },
    col(t('▶ 可开工'), of('ready').length, t('前置任务均已确认完成。同一个框里的任务可以并行做。'), ready),
    col(t('⏳ 即将可开工'), soon.length, t('前置任务已经在做或有 PR 了，全部确认完成后才能开工。'), soon),
    col(t('⛔ 被阻塞'), blocked.length, t('外部条件或前置任务还没开始。'), blocked),
    col(t('🙋 等我处理'), mine.length, board.freshness.github?.state === 'off' ? t('只有你能推进的事。本项目未接 GitHub，这里不含 PR。') : t('只有你能推进的事。'), mine, true)));
}

// 长列表只列前 8 个，其余写「等 N 个」（依赖范围展开到叶子后可能有几十个）
function shortList(items, sep = t('、')) {
  return items.length > 8 ? t`${items.slice(0, 8).join(sep)} 等 ${items.length} 个` : items.join(sep);
}

/**
 * 「等我处理」里的外部前置卡片（UI 稿：⛔ P1 + 事项 + 「卡住 X，并连带 Y」）：每份文档每个未解除、仍卡着未完成任务的前置一张。
 * 直接卡住 = 外部阻塞里有它的任务（含继承自父任务的）；连带 = 顺着依赖往下游走到的其余未完成任务。
 * 父子都在列表里时只写父任务，避免「13、13.1、13.2」刷屏。点卡片开第一个直接卡住的任务，抽屉里能看到前置表原文。
 */
function prereqCards(docs, views, tasks, open) {
  const openTask = (v) => v.status && v.status !== 'done';
  const after = new Map();
  for (const v of views) for (const k of v.deps.on) (after.get(k) ?? after.set(k, []).get(k)).push(v);
  const cards = [];
  for (const doc of docs) {
    for (const p of doc.prerequisites ?? []) {
      if (p.resolved) continue;
      const direct = views.filter((v) => openTask(v) && tasks.get(v.key).docId === doc.docId
        && v.deps.external.some((e) => e.id === p.id && !e.resolved));
      if (!direct.length) continue;
      const seen = new Set(direct.map((v) => v.key));
      const down = [];
      for (let i = 0; i < direct.length + down.length; i++) {
        const cur = i < direct.length ? direct[i] : down[i - direct.length];
        for (const v of after.get(cur.key) ?? []) if (!seen.has(v.key) && openTask(v)) { seen.add(v.key); down.push(v); }
      }
      const names = (list) => {
        const keys = new Set(list.map((v) => v.key));
        return shortList(list.filter((v) => !keys.has(tasks.get(v.key).parentKey)).map((v) => refLabel(v.key, doc.docId)));
      };
      const item = prereqItem(p);
      cards.push(h('div', { class: 'tk', onclick: open(direct[0].key) },
        h('div', { class: 'top' }, h('span', { class: 'blk' }, `⛔ ${p.id}`), h('span', {}, doc.docId)),
        h('div', { class: 'tt', title: item.full }, item.short),
        h('div', { class: 'why' }, t`卡住 ${names(direct)}${down.length ? t`，并连带 ${names(down)}` : ''}`)));
    }
  }
  return cards;
}

// 前置表的「事项」列 = 表格行第二格。ponytail: 从 source.text（已截到 160 字）里切，长事项会被截断；
// 要完整文字时让 relations.mjs 的 Prerequisite 带上 title 字段。短标题取第一个括号 / 冒号之前。
function prereqItem(p) {
  const cell = (p.source?.text ?? '').split('|')[2]?.replace(/\*\*|~~|`/g, '').trim();
  if (!cell) return { short: t`外部前置 ${p.id}`, full: null };
  const short = cell.split(/[（(：:]/)[0].trim() || cell;
  return { short: short.length > 40 ? `${short.slice(0, 40)}…` : short, full: cell };
}

// ---------------- PR 标签、PR 详情、分支线、数字卡、降级横幅（任务 3.6） ----------------

/** PR 标签五种状态的文字，与 UI 稿 prLabel 逐项一致（测试比对）；键名即 class。 */
export const PR_UI = { draft: t('draft·等 review'), ready: t('ready·等合并'), merged: t('已合并'), unsynced: t('已合并·待同步本地'), closed: t('已关闭') };

/** PR → 标签状态。GitHub 上已合并、本地还没这个合并提交（localSync pending）的单列 unsynced（虚线），关联任务仍算等待合并。 */
export function prKind(p) {
  if (p.state === 'OPEN') return p.isDraft ? 'draft' : 'ready';
  if (p.state === 'MERGED') return p.localSync === 'pending' ? 'unsynced' : 'merged';
  return 'closed';
}

const lineName = (lines, id) => lines.find((l) => l.id === id)?.name ?? t('未归类分支线');

/**
 * 文档属于哪条分支线：先按 docFilter（与 engine 给 PR 挑候选文档的口径一致），再看文档是否从某分支线的独立工作区读出；都不中为 null。
 * lines = /api/projects 给的 [{id, name, docFilter}]。
 */
export function docLine(doc, lines) {
  return lines.find((l) => l.docFilter && new RegExp(l.docFilter).test(doc.docId))?.id
    ?? lines.find((l) => l.id === doc.workspaceId)?.id ?? null;
}

// 本地时间 MM-DD / MM-DD HH:mm（时间线、横幅、卡片说明）；绝对时间放悬停提示
const two = (n) => String(n).padStart(2, '0');
const day = (iso) => { const d = new Date(iso); return `${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const clock = (iso) => { const d = new Date(iso); return `${day(iso)} ${two(d.getHours())}:${two(d.getMinutes())}`; };
function waited(ms) {
  const m = Math.max(0, Math.floor(ms / 6e4));
  return m < 60 ? t`${m} 分钟` : m < 1440 ? t`${Math.floor(m / 60)} 小时` : t`${Math.floor(m / 1440)} 天`;
}

/**
 * PR 标签（需求 11.1、5.5；UI 稿 prTag）：`#号 状态文字`，class 随状态。withLine 为真时前面加分支线名；
 * 悬停提示总写完整标题与分支线。点标签 = 地址 focus=#号 → PR 详情抽屉；阻止冒泡，免得任务行 / 卡片再打开别的。
 */
function prTag(p, state, withLine) {
  const kind = prKind(p);
  const name = lineName(state.lines, p.branchLine);
  return h('a', {
    class: `pr ${kind}`, href: hashFor(state.view, state.project, `#${p.number}`, state.line, state),
    title: t`${p.title}\n分支线：${name}`, onclick: (e) => e.stopPropagation(),
  }, withLine ? `${name} ` : null, `#${p.number} ${PR_UI[kind]}`);
}

/**
 * 任务行尾的 PR 标签生成器：(TaskView, Task) → 标签[]。一个关联 PR 一个标签（多对多，需求 6.5），已手动解除的不显示；
 * PR 分支线与任务所属文档的分支线相同则省略分支线名（需求 5.5 的例外），不同才加前缀。
 */
function prTagger(board, state) {
  const byNum = new Map(board.prs.map((p) => [p.number, p]));
  const docs = new Map(board.docs.map((d) => [d.docId, d]));
  return (view, task) => {
    const line = docLine(docs.get(task.docId), state.lines);
    return linkedPrs(view, byNum).map((p) => prTag(p, state, p.branchLine !== line));
  };
}
const linkedPrs = (view, byNum) =>
  [...new Set(view.prs.filter((l) => !l.removedManually).map((l) => l.pr))].map((n) => byNum.get(n)).filter(Boolean);

const LINK_SOURCE = { title: t('PR 标题'), body: t('PR 描述'), branch: t('分支名'), manual: t('手动关联') };
const groupCodes = (board) => new Set(board.docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)));

/**
 * 关联来源一句话（UI 稿任务抽屉 PR 框）：「来源：PR 标题里的『M0-c』（里程碑代号，展开为该里程碑全部任务）」。
 * evidence 是命中的引用片段（多段以「、」相连）；其中有分组代号时补一句会展开成整组。
 */
function linkSourceText(link, codes, was = false) {
  const parts = link.evidence?.split(/、/) ?? []; // 服务端用「、」拼的片段：按它切开判断，显示时换成当前语言的分隔符
  const from = LINK_SOURCE[link.source] ?? link.source;
  const ev = link.evidence ? t`里的「${parts.join(t('、'))}」` : '';
  const code = parts.some((x) => codes.has(x)) ? t('（里程碑代号，展开为该里程碑全部任务）') : '';
  // was：已手动解除的那条写「原来源」
  return (was ? t`原来源：${from}${ev}${code}` : t`来源：${from}${ev}${code}`)
    + (link.partial ? t(' · 部分：这个 PR 只做了一部分，合并后不算完成') : '');
}

/** 任务抽屉「PR」区（UI 稿 openTask）：每个关联 PR 一个框——带分支线的标签（点开 PR 详情）、PR 标题、关联来源。 */
function taskPrSection(board, state, view) {
  const byNum = new Map(board.prs.map((p) => [p.number, p]));
  const codes = groupCodes(board);
  const boxes = view.prs.filter((l) => !l.removedManually && byNum.has(l.pr)).map((l) => {
    const p = byNum.get(l.pr);
    return h('div', { class: 'box' }, prTag(p, state, true), h('div', { class: 'prt' }, p.title),
      h('div', { class: 'src' }, linkSourceText(l, codes), linkAction(board, state, l))); // 任务 4.2：解除 / 撤销
  });
  return [h('h3', {}, 'PR'), boxes.length ? boxes : h('div', { class: 'muted' }, t('还没有 PR。')),
    unlinkedBoxes(board, state, view, codes), addPrPicker(board, state, view)]; // 任务 4.2
}

// 本地同步结果的人话（需求 5.6）；只对已合并 PR 有意义
function syncText(p, board) {
  if (p.state !== 'MERGED') return null;
  if (p.localSync === 'synced') return t('本地已包含合并提交');
  if (!['pending', 'unknown'].includes(p.localSync)) return t('未核对（没有关联任务的 PR 不检查）');
  const tasks = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  // 按真实复选框和任务状态说明；部分关联不报冲突 a，不能拿冲突代替勾选。
  const linked = board.tasks.filter((v) => v.status && v.prs.some((l) => l.pr === p.number && !l.removedManually));
  const conditions = linked.map((v) => {
    const name = t`任务 ${v.key}`;
    const otherPrs = v.rule === '8.2-1' || v.syncPending?.some((n) => n !== p.number);
    if (tasks.get(v.key).checkbox !== 'done') return t`${name} 文档尚未勾选，仍须确认完整交付${otherPrs ? t('；仍有其他未合并或待同步 PR') : ''}`;
    if (v.status === 'done') return t`${name} 文档已勾选，已按完成计`;
    if (v.rule === '8.2-2' && v.syncPending?.length && v.syncPending.every((n) => n === p.number)) {
      return t`${name} 文档已勾选，本地同步后即完成`;
    }
    return t`${name} 文档已勾选，仍有其他未合并或待同步 PR`;
  });
  return [p.localSync === 'pending' ? t`本地 ${p.baseRefName} 还没有这个合并提交`
    : t`本地同步未核对${p.localSyncReason ? t`（${tx(p.localSyncReason)}）` : ''}`, ...conditions].join(t('；'));
}

/**
 * PR 详情抽屉（需求 11.3、11.4；design §3.13；P4：沿用任务抽屉版式）：state.focus = `#号`，看板里没有这个 PR 就不画。
 * 头部 #号 · 分支线、标题、标签；键值区 head → base、状态、时间线、本地同步、GitHub 链接；
 * 关联任务按「来源 + 命中片段」分框，框里写来源与原文（PR 标题 / 分支名），列出任务（点开任务抽屉 = PR → 任务定位）。
 * 引用有歧义 / 不存在的问题（refIssues）列在最后。手动关联 / 解除入口由 4.2 加。
 */
function renderPrDrawer(board, state, onClose) {
  const p = board.prs.find((x) => `#${x.number}` === state.focus);
  if (!p) return [];
  const tasks = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  const codes = groupCodes(board);
  const groups = new Map();
  for (const v of board.tasks) {
    for (const l of v.prs) {
      if (l.pr !== p.number || l.removedManually) continue;
      const k = `${l.source}|${l.evidence}`;
      (groups.get(k) ?? groups.set(k, { link: l, keys: [] }).get(k)).keys.push(v.key);
    }
  }
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const original = { title: p.title, branch: p.headRefName };
  const taskLine = (k) => {
    const t = tasks.get(k);
    return h('div', { class: 'prtask' },
      h('a', { href: hashFor(state.view, state.project, k, state.line, state) }, t ? `${t.docId} · ${t.number}` : k), ' ',
      badge(views.get(k)?.status), ' ', mdInline(t?.title ?? ''));
  };
  const time = (label, iso) => iso && h('span', { title: iso }, `${label} ${clock(iso)}`);
  const sync = syncText(p, board);
  return [
    h('div', { class: 'scrim open', onclick: onClose }),
    h('aside', { class: 'drawer open', 'aria-label': t('PR 详情') },
      h('div', { class: 'hd' },
        h('div', { class: 'hmain' },
          h('div', { class: 'muted crumb' }, `#${p.number} · ${lineName(state.lines, p.branchLine)}`),
          h('h2', {}, p.title),
          h('div', { class: 'hdtags' }, prTag(p, state, false))),
        h('button', { class: 'btn', title: t('关闭（Esc）'), onclick: onClose }, '✕')),
      h('div', { class: 'bd' },
        h('dl', { class: 'kv' },
          h('dt', {}, t('分支')), h('dd', {}, h('code', {}, p.headRefName), ' → ', h('code', {}, p.baseRefName)),
          h('dt', {}, t('状态')), h('dd', {}, PR_UI[prKind(p)]),
          h('dt', {}, t('时间线')), h('dd', { class: 'rels' }, time(t('创建'), p.createdAt), time(t('转 ready'), p.readyAt),
            time(t('合并'), p.mergedAt), p.state === 'CLOSED' && time(t('关闭'), p.closedAt)),
          sync && [h('dt', {}, t('本地同步')), h('dd', { class: p.localSync === 'pending' ? 'warntext' : null }, sync)],
          h('dt', {}, 'GitHub'), h('dd', {}, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, p.url) : h('span', { class: 'muted' }, t('无链接')))),
        h('h3', {}, t('关联任务')),
        groups.size ? [...groups.values()].map(({ link, keys }) => h('div', { class: 'box rel' },
          h('div', { class: 'src' }, linkSourceText(link, codes)),
          original[link.source] && h('div', { class: 'quote' }, t`「${original[link.source]}」`),
          keys.map((k) => h('div', { class: 'prrow' }, taskLine(k), linkAction(board, state, { ...link, taskKey: k }))))) // 任务 4.2
          : h('div', { class: 'muted' }, t('没有关联任务：标题、描述、分支名里都没认出任务号或里程碑代号。')),
        (p.refIssues ?? []).map((x) => h('div', { class: 'flag' }, `⚠ ${tx(x)}`)),
        prManualExtras(board, state, p, taskLine))), // 任务 4.2：已手动解除、失效记录、任务选择器
  ];
}

/**
 * 「等我处理」里的 PR 卡片（需求 12.6；UI 稿 renderNext）：来自 Board.waiting（engine 已按分支线、已等时长排好），
 * 待同步 → 「本地 pull 一下 <分支>」并说明还需确认文档与下游依赖；ready → 「合并 #号」；draft → 「review #号」。
 * 停滞会话（kind 'stale'）由 5.5 接。卡片顶部写分支线（需求 5.5）；点卡片开 PR 详情。views = 未归档任务的 TaskView。
 */
function waitingCards(board, state, views) {
  const byNum = new Map(board.prs.map((p) => [p.number, p]));
  const tasks = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  return (board.waiting ?? []).filter((w) => w.kind !== 'stale' && byNum.has(w.pr)).map((w) => {
    const p = byNum.get(w.pr);
    const docId = tasks.get(w.tasks[0])?.docId;
    const names = (keys) => shortList(keys.map((k) => refLabel(k, docId)));
    const task = w.tasks.length === 1 ? tasks.get(w.tasks[0]) : null;
    const subject = task ? mdInline(task.title) : p.title;
    let tt;
    let why;
    let tip = null;
    if (w.kind === 'sync') {
      const branch = w.workspace?.branch ?? p.baseRefName;
      const down = views.filter((v) => v.next === 'soon' && v.deps.unmet.some((k) => w.tasks.includes(k))).map((v) => v.key);
      const ref = w.workspace?.fetchRef;
      tt = ref ? t`本地 fetch 一下 ${ref}` : t`本地 pull 一下 ${branch}`;
      tip = !w.workspace?.path ? null
        : ref ? t`在 ${w.workspace.path} 运行 git fetch，更新 ${ref}（看板从这个 ref 读文档，不用切分支或 pull）` : t`在 ${w.workspace.path} 拉取 ${branch}`;
      why = t`GitHub ${day(p.mergedAt)} 已合并；${syncText(p, board)}${down.length ? t`；${names(down)} 须全部前置完成才会解锁` : ''}。`;
    } else {
      tt = withNode(w.kind === 'merge' ? t`合并 #${p.number}（${SLOT}）` : t`review #${p.number}（${SLOT}）`, subject);
      why = t`${w.kind === 'merge' ? 'ready' : 'draft'} 已等 ${waited(w.waitedMs)}`;
    }
    return h('div', { class: 'tk', onclick: () => { location.hash = hashFor(state.view, state.project, `#${p.number}`, state.line, state); } },
      // 未关联任务的 PR 不进总览数字卡（那里数的是任务），标出来免得两边看着对不上
      h('div', { class: 'top' }, prTag(p, state, false), h('span', {}, lineName(state.lines, w.branchLine)),
        !w.tasks.length && h('span', { class: 'flag' }, t('未关联任务'))),
      h('div', { class: 'tt', title: tip }, tt),
      h('div', { class: 'why' }, why));
  });
}

/** 分支线分段按钮（UI 稿 #lineSeg）：全部 + 各分支线，选中写进地址 line=（保留 focus=）；没配分支线不显示。 */
function lineSeg(lines, projectId, state) {
  if (!lines.length) return null;
  const btn = (id, text) => h('button', {
    'data-line': id ?? 'all', class: state.line === id ? 'on' : null,
    onclick: () => { location.hash = hashFor(state.view, projectId, state.focus, id, state); },
  }, text);
  return h('div', { class: 'seg', role: 'group', 'aria-label': t('分支线') }, btn(null, t('全部')), lines.map((l) => btn(l.id, l.name)));
}

/**
 * 按分支线筛选（需求 10.4）：只留该分支线的文档与「在等我处理」条目；数字卡由 overallStats 按留下的文档重算。
 * 返回浅拷贝，不改原看板。
 */
function lineBoard(board, state) {
  if (!state.line) return board;
  return { ...board, docs: board.docs.filter((d) => docLine(d, state.lines) === state.line),
    waiting: (board.waiting ?? []).filter((w) => w.branchLine === state.line) };
}

/** 全局统计，口径同 engine summarize 的 all（未归档、未作废任务；父子各算一条），但按传入看板的文档算，分支线筛选后随之变。 */
function overallStats(board) {
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const live = board.docs.filter((d) => !d.archived).flatMap((d) => d.tasks).map((t) => views.get(t.key)).filter((v) => v?.status);
  const counts = Object.fromEntries(Object.keys(STATUS_UI).map((s) => [s, 0]));
  for (const v of live) counts[v.status]++;
  const doing = live.filter((v) => v.status === 'in_progress');
  return {
    counts, total: live.length, ratio: live.length ? counts.done / live.length : null,
    ready: live.filter((v) => v.next === 'ready').length,
    running: doing.filter((v) => v.activity === 'running').length,
    stale: doing.filter((v) => v.activity === 'stale').length,
    syncPending: live.filter((v) => v.syncPending?.length).length,
  };
}

/** 总览六张数字卡，标题与说明同 UI 稿（需求 10.1）。「整体进度」点进甘特图（需求 10.1），「可开工」「已合并·待同步到本地」点进下一步。 */
function statCards(board, state) {
  const all = overallStats(board);
  const go = () => { location.hash = hashFor('next', state.project, null, state.line, state); };
  const card = (label, n, cls, sub, onclick) => h('div', { class: `card stat${onclick ? '' : ' nolink'}`, onclick },
    h('div', { class: 'l' }, label), h('div', { class: `n ${cls}` }, n), h('div', { class: 'sub' }, sub));
  const icon = (s) => STATUS_UI[s].icon;
  return [
    h('div', { class: 'card stat big', onclick: () => { location.hash = hashFor('gantt', state.project, null, state.line, state); } },
      h('div', { class: 'l' }, t('整体进度')),
      h('div', { class: 'n' }, pct(all.ratio)),
      h('div', { class: 'sub' }, t`${all.counts.done} / ${all.total} 个任务已合并完成`),
      stackBar(all)),
    card(t('可开工'), all.ready, 'done', t('依赖都满足了'), go),
    card(t`${icon('in_progress')} 进行中`, all.counts.in_progress, 'doing', t`${all.running} 运行中 · ${all.stale} 停滞`),
    card(t`${icon('in_review')} 等待 review`, all.counts.in_review, 'review', 'draft PR'),
    card(t`${icon('awaiting_merge')} 等待合并`, all.counts.awaiting_merge, 'merge', t`ready PR · 含 ${all.syncPending} 个已合并待同步`),
    card(t('已合并·待同步到本地'), all.syncPending, 'warn', t('GitHub 已合并，本地没 pull'), go),
  ];
}

/** 顶栏 GitHub 最后成功拉取时间（需求 13.1）与「正在刷新」（任一来源刷新中）。未接 GitHub（N11）显示中性的「未接 GitHub」。 */
function githubMeta(freshness, now) {
  const g = freshness.github ?? {};
  const busy = Object.values(freshness.refreshing ?? {}).some(Boolean);
  return [
    g.state === 'off'
      ? h('span', { class: 'muted', title: t('配置里没有 repo.github：只按文档与 AI 会话推算') }, t('未接 GitHub'))
      : h('span', { title: g.lastSuccessAt ?? t('还没成功拉取过') }, `GitHub ${ago(g.lastSuccessAt, now)}`),
    busy && h('span', { class: 'busy' }, t('正在刷新…')),
  ];
}

/**
 * 降级横幅（需求 13.5、13.6、14.9）：未包含 PR 信息 / 未包含 AI 会话信息（任务 5.5）/ 来自缓存 / 额度将尽与恢复时间。
 * 非回环监听等配置警告来自 /api/projects 的 warnings、令牌权限提示见 scopeBanner，renderPage 另行显示。
 */
export function degradedBanners(board, now) {
  const g = board.freshness.github ?? {};
  const why = g.message ? t`（${tx(g.message)}）` : board.freshness.refreshing?.github ? t('（正在拉取）') : '';
  return [
    board.degraded.noPrData && g.state !== 'off' && t`未包含 PR 信息：还没成功拉到过 GitHub 数据，状态只按文档与 AI 会话推算${why}`,
    board.degraded.noSessionData && noSessionBanner(board), // 任务 5.5
    board.degraded.prFromCache && t`GitHub 数据来自 ${clock(g.lastSuccessAt)} 的缓存${why}`,
    g.pausedUntil && Date.parse(g.pausedUntil) > now && t`GitHub 额度将尽，自动刷新已暂停，预计 ${clock(g.pausedUntil)} 恢复；期间使用缓存数据`,
  ].filter(Boolean);
}

/**
 * 令牌权限提示横幅（需求 16.3；N4 owner 2026-10-08 定）：点「知道了」后本浏览器不再显示同一文案（存 localStorage，不分项目）；
 * 令牌权限变了、文案不同就重新出现。诊断页 GitHub 一节始终显示，不受影响。
 */
const SCOPE_DISMISS_KEY = 'devboard:scope-hint-dismissed';
export function scopeBanner(board) {
  const hint = board.freshness.github?.scopeHint;
  if (!hint) return null;
  try { if (globalThis.localStorage?.getItem(SCOPE_DISMISS_KEY) === hint) return null; } catch { /* 读不了就照常显示 */ }
  const box = h('div', { class: 'banner' }, t`令牌权限提示：${tx(hint)} `,
    h('button', { class: 'linkbtn', title: t('本浏览器不再显示；令牌权限变化后会重新出现，诊断页仍可查看'), onclick: () => {
      try { globalThis.localStorage?.setItem(SCOPE_DISMISS_KEY, hint); } catch { /* 存不了：只关掉本页这一次 */ }
      box.setAttribute('hidden', '');
    } }, t('知道了')));
  return box;
}

// ---------------- AI 会话标记、抽屉会话区、停滞卡（任务 5.5） ----------------

// 行尾标记用短名（UI 稿「Claude 运行中」），抽屉里写全名（SESSION_SOURCE_TEXT，诊断页同用）；没登记的来源直接显示来源 id
const SESSION_SHORT = { 'claude-code': 'Claude', codex: 'Codex' };
const DAY_MS = 864e5;
const latestLink = (links) => links.reduce((a, b) => (Date.parse(b.lastAt) > Date.parse(a.lastAt) ? b : a));

/**
 * 会话标记（需求 8.3；UI 稿 aiTag）：圆点 + 「<来源> 运行中」（脉冲）/「最近活跃」/「停滞 N 天」（警示色）。
 * activity 取 engine 的 running / recent / stale；N = 距最近一次活动的整天数（与冲突 o 的口径一致）。
 */
function aiTag(activity, source, lastAt, now) {
  const text = activity === 'stale' ? t`停滞 ${Math.floor((now - Date.parse(lastAt)) / DAY_MS)} 天`
    : activity === 'running' ? t('运行中') : t('最近活跃');
  return h('span', { class: `ai ${activity === 'stale' ? 'stalled' : activity}`, title: t`最近活动 ${clock(lastAt)}` },
    h('span', { class: 'dot' }), `${SESSION_SHORT[source] ?? source} ${text}`);
}

/**
 * 任务行尾的会话标记生成器：TaskView → 标记或 null。
 * 靠会话判为进行中的任务（TaskView.activity 非空）照 activity 标；已有 PR / 已勾选的任务只在关联会话正「运行中」时标，
 * 免得早就交了 PR 的任务一直挂着「最近活跃」。来源名取最近活动那个会话的来源。
 */
function sessionTagger(board, state) {
  const source = new Map((board.sessions ?? []).map((s) => [s.id, s.source]));
  return (view) => {
    const links = view.activity ? view.sessions : view.sessions.filter((l) => l.activity === 'running');
    if (!links.length) return null;
    const last = latestLink(links);
    return aiTag(view.activity ?? 'running', source.get(last.sessionId), last.lastAt, state.now);
  };
}

// 会话侧最近活动：一天内写相对时间（UI 稿「2 分钟前」），更早写日期时刻再补相对时间（「09-22 18:40（4 天前）」）
const recentText = (iso, now) => (now - Date.parse(iso) < DAY_MS ? ago(iso, now) : t`${clock(iso)}（${ago(iso, now)}）`);
const EVIDENCE_SHOWN = 3;

/**
 * 任务抽屉「AI 会话」区（需求 14.6、14.8、18.1；UI 稿 openTask）：每个关联会话一个框，字段顺序同 UI 稿——
 * 标记 + 会话标题、「<来源> · 开始 … · 最近活动 …」、「最后一条：『…』」、「判定依据：…」。
 * 时间取该任务在会话里的焦点段（SessionLink.firstAt / lastAt），与标记口径一致；长会话里早先做的任务不会显示成刚刚活动。
 * 摘要与证据片段在 5.2 扫描时已遮蔽、截断，这里原样以文本显示，不展示完整对话。证据多时只列前几条。
 */
function taskSessionSection(board, state, view) {
  const byId = new Map((board.sessions ?? []).map((s) => [s.id, s]));
  const boxes = view.sessions.map((l) => {
    const s = byId.get(l.sessionId) ?? { source: '?', title: null, lastSummary: null };
    const ev = l.evidence ?? [];
    return h('div', { class: 'box sess' },
      h('div', { class: 'shd' }, aiTag(l.activity, s.source, l.lastAt, state.now), h('b', {}, s.title ?? t`会话 ${l.sessionId}`)),
      h('div', { class: 'src' }, t`${SESSION_SOURCE_TEXT[s.source] ?? s.source} · 开始 ${clock(l.firstAt)} · 最近活动 ${recentText(l.lastAt, state.now)}`),
      s.lastSummary && h('div', { class: 'last' }, t`最后一条：「${s.lastSummary}」`),
      ev.length > 0 && h('div', { class: 'src' }, t('判定依据：'),
        ev.slice(0, EVIDENCE_SHOWN).map((e) => h('div', { class: 'sev', title: e.pos.at }, t`${tx(e.note)} · ${e.pos.file} 第 ${e.pos.line} 行`)),
        ev.length > EVIDENCE_SHOWN && h('div', { class: 'sev' }, t`… 另有 ${ev.length - EVIDENCE_SHOWN} 条`)));
  });
  return [h('h3', {}, t('AI 会话')), boxes.length ? boxes : h('div', { class: 'muted' }, t('没有关联的 AI 会话。'))];
}

/**
 * 「等我处理」里的停滞会话卡片（需求 12.6；UI 稿 renderNext）：Board.waiting 里 kind 'stale' 的条目（engine 已排序），
 * 标记 +「<编号> <标题>：会话停了」+「最后一条：『…』。要不要接着做？」；点卡片开任务抽屉。views = 未归档任务的 TaskView。
 */
function staleCards(board, state, views) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  const tasks = new Map(board.docs.flatMap((d) => d.tasks).map((t) => [t.key, t]));
  const byId = new Map((board.sessions ?? []).map((s) => [s.id, s]));
  return (board.waiting ?? []).filter((w) => w.kind === 'stale' && byKey.has(w.taskKey) && tasks.has(w.taskKey)).map((w) => {
    const task = tasks.get(w.taskKey);
    const last = latestLink(byKey.get(w.taskKey).sessions);
    const s = byId.get(last.sessionId);
    return h('div', { class: 'tk', onclick: () => { location.hash = hashFor(state.view, state.project, task.key, state.line, state); } },
      h('div', { class: 'top' }, aiTag('stale', s?.source, last.lastAt, state.now)),
      h('div', { class: 'tt', title: `${task.docId} · ${mdText(task.title)}` }, withNode(t`${task.number} ${SLOT}：会话停了`, mdInline(task.title))),
      h('div', { class: 'why' }, s?.lastSummary ? t`最后一条：「${s.lastSummary}」。要不要接着做？` : t('要不要接着做？')));
  });
}

// 需求 14.9：会话来源全部不可用（或没配）时，「进行中」只看文档标记；原因取第一个不可用来源的错误
function noSessionBanner(board) {
  const why = tx((board.diagnostics?.sessionSources ?? []).find((s) => !s.available)?.error) ?? t('没有配置会话来源');
  return t`未包含 AI 会话信息：「进行中」只按文档里的 [~] 标记判定（${why}）`;
}

// ---------------- 未关联 PR 列表与手动关联（任务 4.2） ----------------

// 手动关联文件读不了（degraded.manualBroken）时只读：关联 / 解除 / 撤销按钮一律禁用（需求 7.6）
const manualOff = (board) => Boolean(board.degraded?.manualBroken);
// replaceChildren 不认嵌套数组与 false：先摊平、去空
const kids = (...list) => list.flat(Infinity).filter((x) => x != null && x !== false);

/**
 * 未关联 PR（需求 11.2、6.7）：一条关联任务都没有的 PR——含只有歧义 / 不存在引用的，以及关联全被手动解除的。
 * 选了分支线只列该线；open 全列，已合并 / 关闭的只在开关 state.unlRecent 打开时列近 N 天（N = board.recentClosedPrDays，
 * 来自配置 defaults.recentClosedPrDays）。排序：分支线按配置顺序（未归类最后）→ open 在前 → 号大（新）在前。
 */
export function unlinkedPrs(board, state) {
  const since = state.now - (board.recentClosedPrDays ?? 14) * 86_400_000;
  const rank = (p) => { const i = state.lines.findIndex((l) => l.id === p.branchLine); return i < 0 ? state.lines.length : i; };
  return board.prs.filter((p) => !p.tasks?.length && (!state.line || p.branchLine === state.line)
    && (p.state === 'OPEN' || (state.unlRecent !== false && Date.parse(p.mergedAt ?? p.closedAt) >= since)))
    .sort((a, b) => rank(a) - rank(b) || (b.state === 'OPEN') - (a.state === 'OPEN') || b.number - a.number);
}

/**
 * 总览右栏「未关联任务的 PR」（UI 稿 UNLINKED 区）：标题 + 计数、说明语、「近 N 天已合并 / 关闭」开关（默认开：UI 稿列出了已合并的 #369），
 * 每行 = PR 标签（点开 PR 详情）+ 标题 +「关联」（打开 PR 详情并直接展开任务选择器）。开关只重画本区块。
 * 标签同 UI 稿不带分支线名（右栏窄，留给标题）；「全部」分支线下每条线前加一行分支线小标题（design §3.13「#号 · 分支线」）。
 */
function unlinkedSection(board, state) {
  state.unlRecent ??= true;
  const sec = h('div', { class: 'sec' });
  const off = manualOff(board);
  const grouped = state.lines.length > 0 && !state.line; // 「全部」时按分支线分小标题；选了某条线就不需要
  const redraw = () => {
    const list = board.degraded.noPrData ? [] : unlinkedPrs(board, state);
    const pick = (p) => () => { state.picker = { id: `tasks-for:${p.number}`, q: '' }; location.hash = hashFor(state.view, state.project, `#${p.number}`, state.line, state); };
    sec.replaceChildren(...kids(
      h('h2', {}, t('未关联任务的 PR '), h('span', { class: 'count' }, list.length)),
      h('div', { class: 'muted unlnote' }, t('标题里认不出任务号或里程碑代号。点「关联」挑一个任务。')),
      h('label', { class: 'muted unlsw' },
        h('input', { type: 'checkbox', checked: state.unlRecent, onchange: (e) => { state.unlRecent = e.currentTarget.checked; redraw(); } }),
        t` 近 ${board.recentClosedPrDays ?? 14} 天已合并 / 关闭`),
      board.degraded.noPrData ? h('div', { class: 'muted' }, t('未包含 PR 信息（还没成功读到 GitHub）'))
        : !list.length && h('div', { class: 'muted' }, t('没有未关联的 PR')),
      list.map((p, i) => [
        grouped && p.branchLine !== list[i - 1]?.branchLine && h('div', { class: 'muted unlgrp' }, lineName(state.lines, p.branchLine)),
        h('div', { class: 'unl' },
          prTag(p, state, false),
          h('span', { class: 'tt', title: p.title }, p.title),
          h('button', { class: 'btn sm', disabled: off, title: off ? t('手动关联文件读不了，暂不能关联') : null, onclick: pick(p) }, t('关联')))])));
  };
  redraw();
  return sec;
}

/**
 * 手动关联动作按钮（链接样式）。change 不带 action = 撤销（删掉那条手动记录）。
 * state.manual 由 main 换成真正的写请求；结果经看板新版本回来，这里不改本地数据。
 */
function manualBtn(board, state, text, change, title = null) {
  return h('button', { class: 'linkbtn', title, disabled: manualOff(board), onclick: () => state.manual?.(change) }, text);
}

/** 已关联的一对（任务, PR）后面的动作：手动关联的 →「撤销」（删记录）；自动关联的 →「解除关联」（记一条 unlink，刷新也不会回来）。 */
function linkAction(board, state, l) {
  return [' · ', l.source === 'manual'
    ? manualBtn(board, state, t('撤销'), { taskKey: l.taskKey, pr: l.pr }, l.at ? t`手动关联于 ${clock(l.at)}，撤销即删除这条记录` : null)
    : manualBtn(board, state, t('解除关联'), { taskKey: l.taskKey, pr: l.pr, action: 'unlink' })];
}

/** 任务抽屉：被手动解除的自动关联照样列出（「已手动解除」+ 原来源 + 撤销），只是不再挂标签、不参与推算（需求 7.2）。 */
function unlinkedBoxes(board, state, view, codes) {
  const byNum = new Map(board.prs.map((p) => [p.number, p]));
  return view.excludedPrs.filter((x) => x.reason === 'unlinked' && byNum.has(x.pr)).map((x) => {
    const p = byNum.get(x.pr);
    return h('div', { class: 'box off' },
      h('div', {}, h('b', {}, t('已手动解除')), ' ', h('a', { href: hashFor(state.view, state.project, `#${p.number}`, state.line, state) }, `#${p.number}`), ` ${p.title}`),
      h('div', { class: 'src' }, linkSourceText(x, codes, true), ' · ', manualBtn(board, state, t('撤销'), { taskKey: view.key, pr: p.number })));
  });
}

/** 任务抽屉「＋ 手动关联 PR」：按 PR 号 / 标题搜索；已关联的不列；open 在前、号大在前。 */
function addPrPicker(board, state, view) {
  const linked = new Set(view.prs.map((l) => l.pr));
  const items = board.prs.filter((p) => !linked.has(p.number))
    .sort((a, b) => (b.state === 'OPEN') - (a.state === 'OPEN') || b.number - a.number)
    .map((p) => ({ value: p.number, label: `#${p.number}`, hint: `${PR_UI[prKind(p)]} · ${p.title}`,
      hit: (q) => String(p.number).startsWith(q.replace(/^#/, '')) || p.title.toLowerCase().includes(q) }));
  return picker(board, state, { id: `prs-for:${view.key}`, text: t('＋ 手动关联 PR'), placeholder: t('搜索 PR 号 / 标题'), items,
    onPick: (pr) => state.manual?.({ taskKey: view.key, pr, action: 'link' }) });
}

/**
 * PR 详情抽屉的手动部分（需求 7.1、7.2、7.5、11.3）：被手动解除的任务（可撤销）、指向不存在任务的失效记录（冲突 j，可删除）、
 * 「＋ 手动关联任务」选择器。从总览「关联」进来时选择器已是展开的（state.picker 指向本 PR）。
 */
function prManualExtras(board, state, p, taskLine) {
  const undo = (k) => manualBtn(board, state, t('撤销'), { taskKey: k, pr: p.number });
  const stale = (board.conflicts ?? []).filter((c) => c.type === 'j' && c.pr === p.number);
  const linked = new Set(p.tasks ?? []);
  // 候选 = 未归档文档里未作废、还没关联本 PR 的任务；本 PR 分支线的文档排前面
  const own = (d) => (docLine(d, state.lines) === p.branchLine ? 0 : 1);
  const items = board.docs.filter((d) => !d.archived).sort((a, b) => own(a) - own(b))
    .flatMap((d) => d.tasks.filter((t) => !t.void && !linked.has(t.key)).map((t) => ({
      value: t.key, label: `${d.docId} · ${t.number}`, hint: mdText(t.title),
      hit: (q) => t.number.toLowerCase().startsWith(q) || t.key.toLowerCase().startsWith(q) || t.title.toLowerCase().includes(q),
    })));
  return [
    p.unlinked?.length > 0 && h('div', { class: 'box off' },
      h('div', { class: 'src' }, t('已手动解除（刷新后也不会自动关联回来）')),
      p.unlinked.map((k) => h('div', { class: 'prrow' }, taskLine(k), ' · ', undo(k)))),
    stale.map((c) => h('div', { class: 'flag' }, `⚠ ${tx(c.detail)} · `, manualBtn(board, state, t('删除这条记录'), { taskKey: c.taskKey, pr: p.number }))),
    picker(board, state, { id: `tasks-for:${p.number}`, text: t('＋ 手动关联任务'), placeholder: t('搜索编号 / 标题'), items,
      onPick: (taskKey) => state.manual?.({ taskKey, pr: p.number, action: 'link' }) }),
  ];
}

const PICK_MAX = 30;
/**
 * 可搜索选择器（任务选择器 / PR 选择器共用）：收起时是一个按钮，点开变成搜索框 + 候选列表；输入只重画列表，搜索框不丢焦点。
 * items = [{value, label, hint, hit(q)}]，q 已去空白转小写；最多列 PICK_MAX 条，多的提示缩小范围。手动关联只读时按钮禁用。
 * 展开状态与搜索词记在 state.picker = {id, q, autofocused?}（同一时刻只展开一个）：autofocused 表示本次展开已安排首次自动聚焦，
 * 关闭时整个 picker 清掉，再打开会重新聚焦；会话 / GitHub 变化触发整页重画时选择器不会被收起，
 * 搜索词与焦点照旧；总览「关联」按钮也靠预先写入它让 PR 详情里的选择器一打开就是展开的。
 */
function picker(board, state, { id, text, placeholder, items, onPick }) {
  const box = h('div', { class: 'picker' });
  const off = manualOff(board);
  const collapse = () => {
    if (state.picker?.id === id) state.picker = null;
    box.replaceChildren(h('button', { class: 'btn', disabled: off, onclick: expand }, text));
  };
  function expand() {
    if (state.picker?.id !== id) state.picker = { id, q: '' };
    const list = h('div', { class: 'plist' });
    const fill = () => {
      const q = state.picker.q.trim().toLowerCase();
      const hits = q ? items.filter((it) => it.hit(q)) : items;
      list.replaceChildren(...kids(
        hits.slice(0, PICK_MAX).map((it) => h('button', { class: 'pitem', onclick: () => { collapse(); onPick(it.value); } },
          h('b', {}, it.label), ' ', h('span', { class: 'muted' }, it.hint))),
        hits.length > PICK_MAX && h('div', { class: 'muted pmore' }, t`还有 ${hits.length - PICK_MAX} 条，输入更多字缩小范围`),
        !hits.length && h('div', { class: 'muted pmore' }, t('没有匹配的'))));
    };
    const { q } = state.picker;
    const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder, value: q || null,
      oninput: (e) => { state.picker.q = e.currentTarget.value; fill(); } });
    box.replaceChildren(h('div', { class: 'phead' }, input, h('button', { class: 'linkbtn', onclick: collapse }, t('取消'))), list);
    fill();
    // 每次展开只自动聚焦一次；整页和抽屉局部重画交给 keepFocus 恢复，不能在微任务里再覆盖。
    if (!state.picker.autofocused) {
      state.picker.autofocused = true;
      queueMicrotask(() => { input.focus?.(); input.setSelectionRange?.(q.length, q.length); });
    }
  }
  if (state.picker?.id === id && !off) expand();
  else collapse();
  return box;
}

/** 红色横幅（需求 7.6）：手动关联文件读不了（只用自动关联、按钮禁用、文件不会被覆盖）；上一次手动关联没保存成功的原因。 */
function manualBanners(board, state) {
  return [
    board?.degraded?.manualBroken && t`手动关联文件读不了：${tx(board.degraded.manualBroken)}。现在只用自动关联，关联按钮已禁用；devboard 不会覆盖这个文件，改好后自动恢复。`,
    state.linkError && t`手动关联没保存：${tx(state.linkError)}`,
  ].filter(Boolean).map((m) => h('div', { class: 'banner err' }, m));
}

// ---------------- 需要确认（任务 6.4） ----------------

/** 冲突 a–o 的中文类型名（需求 9.1），顺序即页面分组顺序。 */
export const CONFLICT_TEXT = {
  a: t('PR 已合并、文档未勾'), b: t('文档已勾、PR 未合并'), c: t('仅文档确认'), d: t('PR 全部关闭未合并'), e: t('编号重复'),
  f: t('悬空依赖'), g: t('循环依赖'), h: t('引用有歧义 / 不存在'), i: t('关联来源不一致'), j: t('失效的手动关联'),
  k: t('父子状态不一致'), l: t('提前开工'), m: t('作废任务仍关联 PR'), n: t('分支线约定不一致'), o: t('进行中停滞'),
};

/**
 * 本视图要列的冲突；导航计数 = 全部条数，含 c，与「全部类型（N）」一致（owner 2026-10-10，N20）。
 * c 仅文档确认在任务行不算「⚠ 不一致」，视图里默认收起。board 是按分支线筛过的看板（lineBoard）：
 * 任务类只留当前可见、未归档文档里的任务；PR 类（h / i / n，以及任务键已不存在的 j）按 PR 所属分支线；
 * 会话类（会话里的 h）归不到分支线，只在「全部」时列出。
 */
export function checkItems(board, state) {
  const live = new Set(board.docs.filter((d) => !d.archived).flatMap((d) => d.tasks.map((t) => t.key)));
  const prLine = new Map(board.prs.map((p) => [p.number, p.branchLine]));
  return (board.conflicts ?? []).filter((c) => (c.taskKey && c.type !== 'j' ? live.has(c.taskKey)
    : c.pr != null ? !state.line || prLine.get(c.pr) === state.line
      : !state.line));
}

/**
 * 需要确认（需求 9.3、12.5；UI 稿 renderCheck 上半部分）：只列提示，不改任何状态。
 * 按类型分组，组内一条一个框「类型 · 对象」+ 说明原文；点框打开任务 / PR 抽屉（地址加 focus=，停在本视图）。
 * 冲突 c（仅文档确认）实物有几十条，默认收起，免得淹没其它提示；按类型筛选选中 c 时展开（P4）。
 * 展开 / 收起与默认相反的组记在 state.toggled（键 check:<类型>）；所选类型记在 state.checkType（null = 全部）。
 */
export function renderCheck(board, state) {
  const box = h('section', { id: 'v-check' });
  const redraw = () => box.replaceChildren(checkCard(board, state, redraw));
  redraw();
  return box;
}

function checkCard(board, state, redraw) {
  const all = checkItems(board, state);
  const types = Object.keys(CONFLICT_TEXT).filter((t) => all.some((c) => c.type === t));
  if (!types.includes(state.checkType)) state.checkType = null; // 看板新版本里该类没了，回到全部
  const shown = state.checkType ? [state.checkType] : types;
  return h('div', { class: 'card check' },
    h('h2', {}, t('需要确认 '), h('span', { class: 'muted' }, t('· 这些只是提示，不会改动任务状态'))),
    all.length === 0 ? h('div', { class: 'empty' }, t('没有需要确认的事项。')) : [
      dropdown(state, { label: t('类型'), value: state.checkType ?? '', cls: 'ctype',
        options: [{ value: '', text: t`全部类型（${all.length}）` },
          ...types.map((type) => ({ value: type, text: t`${CONFLICT_TEXT[type]}（${all.filter((c) => c.type === type).length}）` }))],
        onChange: (v) => { state.checkType = v || null; redraw(); syncHash(state); } }),
      shown.map((t) => checkGroup(board, state, t, all.filter((c) => c.type === t))),
    ]);
}

function checkGroup(board, state, type, items) {
  const key = `check:${type}`;
  const byDefault = type !== 'c' || state.checkType === 'c';
  return h('details', {
    class: 'cgrp', 'data-type': type, open: byDefault !== state.toggled.has(key),
    ontoggle: (e) => { if (e.currentTarget.open === byDefault) state.toggled.delete(key); else state.toggled.add(key); },
  }, h('summary', {}, t`${CONFLICT_TEXT[type]}（${items.length}）`), items.map((c) => checkBox(board, state, c)));
}

// 一条冲突一个框；对象优先是任务，其次 PR，再次会话。会话没有详情页，框不可点，只写出记录文件与行号。
function checkBox(board, state, c) {
  const task = c.type !== 'j' && c.taskKey ? board.docs.flatMap((d) => d.tasks).find((t) => t.key === c.taskKey) : null;
  const pr = c.pr != null ? board.prs.find((p) => p.number === c.pr) : null;
  const target = task ? task.key : pr ? `#${pr.number}` : null;
  const session = c.sessionId && board.sessions.find((s) => s.id === c.sessionId);
  const [obj, tip] = task ? [`${task.docId} ${task.number}`, mdText(task.title)]
    : c.pr != null ? [`#${c.pr}`, pr?.title] : [t`会话 ${session?.title ?? c.sessionId}`, c.sessionId];
  return h('div', {
    class: target ? 'box go' : 'box', 'data-type': c.type, title: tip,
    onclick: target && (() => { location.hash = hashFor(state.view, state.project, target, state.line, state); }),
  },
  h('b', {}, CONFLICT_TEXT[c.type]), ` · ${obj}`,
  h('div', { class: 'src' }, tx(c.detail)),
  c.source && h('div', { class: 'src' }, t`${c.source.file} 第 ${c.source.line} 行：${c.source.text}`),
  // 失效的手动关联可直接删记录（同 PR 详情里的入口）；按钮不触发框的跳转
  c.type === 'j' && h('span', { onclick: (e) => e.stopPropagation() }, manualBtn(board, state, t('删除这条记录'), { taskKey: c.taskKey, pr: c.pr })));
}

// ---------------- 诊断（任务 6.5） ----------------

// design §8 最低约定的条目号 → 名称（engine 的 diagnostics.convention[].rule 用条目号）
const RULE_TEXT = { 1: t('任务行写法'), 3: t('依赖 / 并行写法'), 5: t('预计耗时写法'), 7: t('PR 标题写法') };
const SESSION_SOURCE_TEXT = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * 诊断（需求 18.2、14.9、3.5；UI 稿 renderCheck 的 v-diag）：一张卡片、一个键值区，依次是
 * 配置、工作区、文档、不满足约定、未关联 PR、AI 会话、GitHub。长列表（各文档明细、约定问题、未关联 PR、
 * 读不懂的会话文件）收进原生 <details>，默认收起。只读 Board，不发请求。
 */
export function renderDiag(board, state) {
  const d = board.diagnostics;
  // 展开状态记进 state.toggled（键 diag:<项>），整页重画（切视图回来、看板新版本）后保持展开
  const fold = (key) => ({
    open: state.toggled.has(`diag:${key}`),
    ontoggle: (e) => { if (e.currentTarget.open) state.toggled.add(`diag:${key}`); else state.toggled.delete(`diag:${key}`); },
  });
  const rows = [
    [t('配置'), diagConfig(d.config)],
    [t('工作区'), board.workspaces.length ? board.workspaces.map(diagWorkspace) : t('未读取')],
    [t('文档'), diagDocs(board.docs, d.sources ?? [], fold('docs'))],
    [t('不满足约定'), diagConvention(d.convention ?? [], fold('convention'))],
    [t('未关联 PR'), diagUnlinked(board, fold('prs'))],
    [t('AI 会话'), diagSessions(board, fold('sessions'))],
    ['GitHub', diagGithub(board.freshness.github, d.github, state.now)],
  ];
  return h('section', { id: 'v-diag' }, h('div', { class: 'card diag' },
    h('h2', {}, t('诊断')),
    h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))));
}

// 可展开列表：没有条目时只显示概要文字
function more(summary, items, fold) {
  if (!items.length) return summary;
  return h('details', fold, h('summary', {}, summary), h('ul', {}, items.map((x) => h('li', {}, x))));
}
const lineList = (lines) => t`第 ${lines.join(t('、'))} 行`;

function diagConfig(c) {
  if (!c) return t('未知');
  return [
    h('span', { title: c.path }, t`${c.path.split(/[\\/]/).pop()} 已加载 · 项目 ${c.projects} 个`),
    c.warnings.map((w) => h('div', { class: 'flag' }, t`警告：${tx(w)}`)),
  ];
}

function diagWorkspace(w) {
  const name = w.path.split(/[\\/]/).filter(Boolean).pop();
  const branch = w.detached ? t('（分离 HEAD）') : (w.branch ?? t('未知分支'));
  return h('div', { title: w.path },
    `${name} · ${branch} @ ${w.commit ? w.commit.slice(0, 8) : t('未知')}`,
    w.error && h('span', { class: 'flag' }, t` · 读取失败：${tx(w.error)}`));
}

// 一份文档有没有要看的问题：解析不完整 / 失败，或有任何未识别写法与解析诊断（规划中不算问题）
const docHasIssues = (p) => !['ok', 'planning'].includes(p.state)
  || p.unrecognizedLines.length + p.unknownRelations.length + p.unknownEstimates.length + p.diagnostics.length > 0;

function diagDocs(docs, sources, fold) {
  const specs = docs.filter((x) => x.kind !== 'adr');
  const bad = specs.filter((x) => docHasIssues(x.parse)).length;
  const adrBad = docs.filter((x) => x.kind === 'adr' && docHasIssues(x.parse)).length;
  const summary = [
    t`${specs.length} 份规划文档${bad ? t`（${bad} 份有解析问题，可展开看行号）` : ''}`,
    t`${docs.length - specs.length} 篇 ADR${adrBad ? t`（${adrBad} 篇有诊断）` : ''}`,
    t`Mermaid 依赖图已启用 ${docs.filter((x) => x.parse.mermaidUsed).length} 份`,
  ].join(' · ');
  return [
    more(summary, docs.map(diagDocItem), fold),
    sources.map((s) => h('div', { class: 'flag' }, tx(s.message))), // 来源目录读不了等不属于单份文档的问题
  ];
}

// 一份文档一项：docId · 来源 · 解析状态 · 任务数 · Mermaid；有问题的另起行写出行号
function diagDocItem(doc) {
  const p = doc.parse;
  const head = [
    doc.docId, t`${doc.sourceLabel}（${doc.sourceType}）`, DOC_STATE[p.state]?.label ?? t('解析正常'),
    t`${doc.tasks.length} 个任务`, p.mermaidUsed && t('Mermaid 依赖图已启用'), doc.archived && t('已归档'),
  ].filter(Boolean).join(' · ');
  const issue = (text) => h('div', { class: 'flag' }, text);
  return [
    h('span', { title: doc.path }, head),
    // 解析不完整的原因就是下面的未识别行号、规划中的原因同状态文字，这两种不重复写
    ['no-tasks', 'error'].includes(p.state) && p.reason && h('div', { class: 'muted' }, tx(p.reason)),
    p.unrecognizedLines.length > 0 && issue(t`未识别的疑似任务行：${lineList(p.unrecognizedLines)}`),
    p.unknownRelations.length > 0 && issue(t`未识别的依赖说法：${lineList(p.unknownRelations.map((r) => r.line))}`),
    p.unknownEstimates.length > 0 && issue(t`无法识别的耗时写法：${lineList(p.unknownEstimates.map((r) => r.line))}`),
    p.diagnostics.map((x) => issue(t`第 ${x.source.line} 行：${tx(x.message)}`)),
  ];
}

function diagConvention(list, fold) {
  if (!list.length) return t('没有发现');
  const counts = Object.entries(RULE_TEXT).map(([r, t]) => [t, list.filter((x) => String(x.rule) === r).length])
    .filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(' · ');
  return more(t`${list.length} 处（${counts}），可展开看哪一行 / 哪个 PR`, list.map((x) =>
    t`第 ${x.rule} 条 ${RULE_TEXT[x.rule]} · ${x.pr != null ? `PR #${x.pr}` : t`${x.docId} 第 ${x.line} 行`}：${tx(x.detail)}`), fold);
}

function diagUnlinked(board, fold) {
  if (board.degraded.noPrData) return t('未包含 PR 信息（还没成功读到 GitHub）');
  const list = board.prs.filter((p) => !p.tasks?.length);
  if (!list.length) return t('没有');
  return more(t`${list.length} 个 PR 没关联到任务，可展开`, list.map((p) =>
    `#${p.number} ${PR_UI[prKind(p)]} · ${p.title}${p.refIssues?.length ? t`（${tx(p.refIssues[0])}）` : ''}`), fold);
}

function diagSessions(board, fold) {
  const d = board.diagnostics;
  const sources = d.sessionSources ?? [];
  if (!sources.length) return board.degraded.noSessionData ? t('没有配置会话来源（页面不含 AI 会话信息）') : t('正在读取…');
  const n = d.sessions;
  const bad = sources.flatMap((s) => [
    ...s.unreadableFiles.map((f) => t`${f.file}：读取失败（${tx(f.error)}）`),
    ...s.brokenLines.map((f) => t`${f.file}：${f.count} 行读不懂，已跳过`),
  ]);
  return [
    sources.map((s) => h('div', {},
      t`${SESSION_SOURCE_TEXT[s.source] ?? s.source}：${s.dir ?? t('未知目录')} · `,
      s.available ? t`${s.sessions} 个会话` : h('span', { class: 'flag' }, t`不可用：${tx(s.error)}`),
      s.messages.map((m) => h('div', { class: 'flag' }, tx(m))))),
    h('div', {}, t`识别出任务的会话 ${n.linked} 个 · 识别不出任务的 ${n.unlinked} 个 · 只在 AI 回复里被提到的 ${n.aiOnlyMentions} 次（不计）`),
    bad.length > 0 && more(t`读不懂的文件 ${bad.length} 个，可展开`, bad, fold),
    board.degraded.noSessionData && h('div', { class: 'flag' }, t('会话来源全部不可用：「进行中」只按文档标记判定')),
  ];
}

// GitHub：登录 / 出错状态、最近一轮请求、剩余额度、暂停、令牌权限提示（需求 13.5–13.7、16.3）
function diagGithub(g, run, now) {
  if (g.state === 'off') return [h('span', { class: 'muted' }, t('未配置：本项目没有 repo.github，不读取 PR'))]; // N11
  const line = [
    g.error ? tx(g.message) : g.lastSuccessAt ? t('gh 已登录') : t('还没有成功读取过'),
    run ? t`最近请求 ${ago(run.at, now)} · 本轮 ${run.requests} 次请求` : t('本次启动后还没请求过'),
    g.rate ? t`剩余额度 ${g.rate.remaining} / ${g.rate.limit}` : t('剩余额度未知'),
    g.error && g.lastSuccessAt && t`最近成功 ${ago(g.lastSuccessAt, now)}`,
    g.pausedUntil && t`暂停到 ${new Date(g.pausedUntil).toLocaleString(HTML_LANG[getLang()])}`,
  ].filter(Boolean).join(' · ');
  return [
    h('span', { class: g.error ? 'flag' : null }, line),
    g.detail && h('div', { class: 'muted' }, tx(g.detail)),
    g.scopeHint && h('div', { class: 'flag' }, t`权限提示：${tx(g.scopeHint)}`),
  ];
}

// ---------------- 甘特图（任务 6.2） ----------------

const GANTT_ZOOMS = [['week', t('周')], ['day', t('天')], ['month', t('月')]];
const NO_TIME_TEXT = t('已完成但没有关联 PR 或会话，没有事实时间，不画在时间轴上');

/**
 * 甘特图（需求 15；UI 稿 renderGantt / hl）：图例 + 缩放 + 「显示全部依赖线」、说明条、全局汇总，
 * 左侧 HTML 标签列（文档行 → 分组行 → 任务行，文档与分组可折叠）+ 右侧 SVG 时间轴（svg.mjs ganttSvg）。
 * 时间全部来自 engine 的 TaskView.gantt（6.1），这里只换算像素；汇总按传入看板（分支线筛选后）的任务在前端重算。
 * 视图内状态记在 state：ganttZoom（缺省「天」）、ganttAllLinks、ganttScroll（横向滚动位置，横轴变了就作废 → 回到今天）、
 * ganttFold（折叠，同时存 localStorage）。点横条或任务行开任务抽屉。
 */
export function renderGantt(board, state) {
  state.ganttZoom ??= 'day';
  state.ganttAllLinks ??= false;
  const box = h('section', { id: 'v-gantt' });
  const redraw = () => box.replaceChildren(ganttCard(board, state, redraw));
  redraw();
  return box;
}

function ganttCard(board, state, redraw) {
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const docs = board.docs.filter((d) => !d.archived && d.tasks.some((t) => !t.void));
  const fold = ganttFold(state);
  const open = (key) => { location.hash = hashFor(state.view, state.project, key, state.line, state); };
  let hl = () => {};
  const hover = (key) => hl(key);
  const toggle = (key, isOpen) => () => { fold[key] = !isOpen; saveFold(state); redraw(); };
  const caret = (o) => h('span', { class: 'caret' }, o ? '▾' : '▸');
  const labels = [];
  const rows = [];
  const add = (label, row) => { labels.push(label); rows.push(row); };
  const taskRows = (list) => list.forEach((t) => add(ganttLabel(t, views.get(t.key), open, hover), ganttRow(t, views.get(t.key))));
  // 一段任务（分组内 / 文档下无分组的）：作废不画；无时间的收进段末「无时间（N）」，默认收起（需求 15.8）
  const section = (keyBase, list) => {
    const live = list.filter((t) => !t.void);
    const nt = live.filter((t) => views.get(t.key).gantt?.noTime);
    taskRows(live.filter((t) => !views.get(t.key).gantt?.noTime));
    if (!nt.length) return;
    const k = `nt:${keyBase}`;
    const o = fold[k] ?? false;
    add(h('div', { class: 'gl nt', title: NO_TIME_TEXT, onclick: toggle(k, o) }, caret(o), t`无时间（${nt.length}）`), { kind: 'nt' });
    if (o) taskRows(nt);
  };
  // 全部完成的文档 / 分组默认折叠（需求 15.1、10.5）；点过的以 fold 为准
  for (const doc of docs) {
    const dsum = ganttSum(doc.tasks, views);
    const dk = `doc:${doc.docId}`;
    const dopen = fold[dk] ?? (taskFiltered(state) || dsum.done < dsum.total);
    add(h('div', { class: 'gl g1', onclick: toggle(dk, dopen) }, caret(dopen),
      h('span', { class: 'tt', title: doc.title ?? doc.docId }, doc.docId), ganttProg(dsum)), { kind: 'doc' });
    if (!dopen) continue;
    section(`${doc.docId}/`, doc.tasks.filter((t) => !t.groupId));
    for (const g of doc.groups) {
      const list = doc.tasks.filter((t) => t.groupId === g.id);
      if (!list.some((t) => !t.void)) continue;
      const sum = ganttSum(list, views);
      const gk = `grp:${doc.docId}/${g.id}`;
      const gopen = fold[gk] ?? (taskFiltered(state) || sum.done < sum.total);
      add(h('div', { class: 'gl g2', onclick: toggle(gk, gopen) }, caret(gopen), h('span', { class: 'tt', title: g.title }, g.title), ganttProg(sum)),
        { kind: 'grp', span: spanOf(list, views), tipSpan: t`分组范围（事实与预估的并集）` });
      if (gopen) section(`${doc.docId}/${g.id}`, list);
    }
  }

  // 时间范围：[今天 − 30 天, max(预估完成, 今天 + 14 天)]（design §3.10.4），再放宽到能容下全部横条；按本地日对齐。
  // 用全部任务而不是展开的行算，折叠 / 展开时横轴不跳。
  const now = state.now;
  const times = docs.flatMap((d) => d.tasks).map((t) => views.get(t.key)?.gantt).filter(Boolean)
    .flatMap((g) => [g.fact, g.est].filter(Boolean).flat());
  const from = startOfDay(Math.min(now - 30 * DAY_MS, ...times));
  const to = startOfDay(Math.max(now + 14 * DAY_MS, ...times)) + DAY_MS;
  const px = GANTT_ZOOM[state.ganttZoom] ?? GANTT_ZOOM.day;
  const g = ganttSvg(rows, { from, to, now, px, allLinks: state.ganttAllLinks, onOpen: open, onHover: hover });
  // 滚动位置连同横轴起点与缩放一起记：切分支线 / 换缩放后横轴变了，旧位置作废，回到今天
  const axis = `${from}|${px}`;
  const scroll = h('div', { class: 'gscroll', onscroll: (e) => { state.ganttScroll = { axis, left: e.currentTarget.scrollLeft }; } }, g.svg);
  const grid = h('div', { class: 'gantt' }, h('div', { class: 'glabels' }, h('div', { class: 'gh' }, t('任务（点分组可折叠）')), labels), scroll);
  hl = (key) => g.hl(grid, key);
  // 打开时把「今天」滚到可视区 70% 处（过去和未来都看得到）；之后的重画保持用户滚到的位置。节点挂上页面后才量得到宽度。
  globalThis.requestAnimationFrame?.(() => {
    scroll.scrollLeft = state.ganttScroll?.axis === axis ? state.ganttScroll.left : Math.max(0, ((now - from) / DAY_MS) * px - scroll.clientWidth * 0.7);
  });

  const all = ganttSum(docs.flatMap((d) => d.tasks), views);
  return h('div', { class: 'card' },
    h('div', { class: 'legend' },
      Object.values(STATUS_UI).map((s) => h('span', {}, h('span', { class: `sw ${s.cls}` }), `${s.icon} ${s.text}`)),
      h('span', {}, h('span', { class: 'sw lgest' }), t('预估（非事实）')),
      h('span', { class: 'lgtoday' }, t('┃ 今天')),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': t('缩放') }, GANTT_ZOOMS.map(([z, text]) => h('button', {
        'data-zoom': z, class: z === state.ganttZoom ? 'on' : null,
        onclick: () => { state.ganttZoom = z; redraw(); },
      }, text))),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: state.ganttAllLinks,
        onchange: (e) => { state.ganttAllLinks = e.currentTarget.checked; redraw(); } }), t(' 显示全部依赖线'))),
    // 数字来自 Board.defaults（= 配置 defaults，任务 6.6 由 server 放入）；缺省同 gantt.mjs 的 8 小时 / 1 天
    h('div', { class: 'note' }, t`实色 = 真实发生（开始取 AI 会话或 PR 创建，结束取 PR 合并）。斜纹 = 预估：只按依赖先后排，不考虑人力与并发；工期按每日 ${board.defaults?.hoursPerDay ?? 8} 小时换算后连续排布，没写预计耗时的按默认工期 ${board.defaults?.defaultDurationDays ?? 1} 天。鼠标移到任务上会显示它的前置和后续。`),
    h('div', { class: 'note gall' }, t`全部 ${all.done}/${all.total}（${pct(all.total ? all.done / all.total : null)}）· 预估完成 ${all.estEnd ? day(all.estEnd) : '—'}${all.unsched ? t`（不含 ${all.unsched} 个无法排期任务）` : ' '}· 无法排期（${all.unsched}）· 无时间（${all.noTime}）`),
    docs.length ? grid : h('div', { class: 'empty' }, t('没有可画甘特图的规划文档。')));
}

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** 折叠状态（非业务数据）：{ 键: true 展开 / false 折叠 }，存 localStorage；读写不了（隐私模式、Node 测试）就只留在内存。 */
function ganttFold(state) {
  if (!state.ganttFold) {
    let saved = {};
    try { saved = JSON.parse(globalThis.localStorage?.getItem(`devboard:gantt-fold:${state.project}`) ?? '{}') ?? {}; } catch { /* 坏数据当没记过 */ }
    state.ganttFold = saved;
  }
  return state.ganttFold;
}
function saveFold(state) {
  try { globalThis.localStorage?.setItem(`devboard:gantt-fold:${state.project}`, JSON.stringify(state.ganttFold)); } catch { /* 存不了只影响下次打开 */ }
}

/** 范围汇总，口径同 engine summarizeGantt（未作废任务、父子各一条）；筛选后按传入的任务重算（需求 15.9）。 */
function ganttSum(tasks, views) {
  const out = { done: 0, total: 0, estEnd: null, unsched: 0, noTime: 0 };
  for (const t of tasks) {
    const v = views.get(t.key);
    if (!v?.status) continue;
    out.total++;
    if (v.status === 'done') out.done++;
    if (v.gantt?.est) out.estEnd = Math.max(out.estEnd ?? -Infinity, v.gantt.est[1]);
    if (v.gantt?.unschedulable) out.unsched++;
    if (v.gantt?.noTime) out.noTime++;
  }
  return out;
}

/** 文档 / 分组行右侧进度：完成数 · 百分比 · 预估完成日（红字注明不含无法排期）· 无时间（N）；完整句子放悬停。 */
function ganttProg(s) {
  const est = s.estEnd ? day(s.estEnd) : '—';
  return h('span', { class: 'prog', title: t`完成 ${s.done}/${s.total}；预估完成日 ${est}${s.unsched ? t`（不含 ${s.unsched} 个无法排期任务）` : ''}；无时间 ${s.noTime} 个` },
    t`${s.done}/${s.total} · ${pct(s.total ? s.done / s.total : null)} · 预估 ${est}`,
    s.unsched > 0 && h('span', { class: 'red' }, t`（不含 ${s.unsched} 个无法排期）`),
    s.noTime > 0 && t` · 无时间（${s.noTime}）`);
}

// 一组任务的事实 / 预估范围并集（分组汇总细括号条）；都没有时间为 null
function spanOf(tasks, views) {
  const ts = tasks.map((t) => views.get(t.key)?.gantt).filter(Boolean).flatMap((g) => [g.fact, g.est].filter(Boolean).flat());
  return ts.length ? [Math.min(...ts), Math.max(...ts)] : null;
}

/** 任务标签行（UI 稿 .gl.t）：状态图标、编号、标题；可键盘聚焦，Enter / 点击开抽屉，悬停高亮关系。 */
function ganttLabel(t, v, open, hover) {
  const st = STATUS_UI[v.status];
  return h('div', {
    class: `gl t${t.parentKey ? ' child' : ''}`, 'data-key': t.key, tabindex: 0, title: `${t.number} ${mdText(t.title)} · ${st.text}`,
    onclick: () => open(t.key), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(t.key); },
    onmouseenter: () => hover(t.key), onmouseleave: () => hover(null),
  }, h('span', { class: `st ${st.cls}` }, h('span', { class: 'ic' }, st.icon)), h('span', { class: 'id' }, t.number), h('span', { class: 'tt' }, mdInline(t.title)));
}

/**
 * TaskView.gantt → 时间轴一行（svg.mjs ganttSvg 的入参）。条后小字：待同步、结束取自会话、「预估 · 默认工期」、⚠ 超出预计；
 * 无法排期写原因（红字，放在今天线右侧，轴上不画预估）；无时间写在行首。依赖只给本文档可见行用，跨不到的线由 svg 跳过。
 */
function ganttRow(task, v) {
  const g = v.gantt ?? {};
  const parts = [
    v.syncPending?.length > 0 && { text: t('⤓ 待同步'), cls: 'merge' },
    g.endFromSession && { text: t('结束取自会话（无 PR）') },
    g.est && { text: g.defaultDuration ? t('预估 · 默认工期') : t('预估') },
    g.overdue && { text: t('⚠ 超出预计'), cls: 'warn' },
    g.unschedulable && { text: t`无法排期：${g.unschedulable.map(tx).join(t('；'))}`, cls: 'red' },
    g.noTime && { text: t('无时间（仅文档确认、无 PR 无会话）') },
  ].filter(Boolean);
  const label = parts.flatMap((p, i) => (i ? [{ text: ' · ' }, p] : [p]));
  return {
    kind: 'task', key: task.key, st: STATUS_UI[v.status].cls,
    fact: g.fact, est: g.est, span: g.span, tipSpan: g.span && t`汇总范围：${day(g.span[0])} → ${day(g.span[1])}（子任务的并集）`,
    tipFact: g.fact && t`事实：${factText(v)}`, tipEst: g.est && t`预估：${estText(task, v)}`,
    label, at: g.noTime ? 'left' : 'today', dep: v.deps.on, par: v.parallelWith,
  };
}

// 事实段措辞：「开始 / 合并于 + 来源」，不出现「预估」（需求 15.7）
function factText(v) {
  const { fact: [a, b], endFromSession } = v.gantt;
  const [fa, fb] = v.gantt.factFrom.map(tx); // 「PR #360」「会话 <id>」由 gantt.mjs 拼
  const start = t`开始 ${clock(a)}（${fa}）`;
  if (!fb) return t`${start}· 至今（尚未完成）`;
  if (endFromSession) return t`${start}· 结束 ${clock(b)}（${fb}）· 结束取自会话（无 PR）`;
  return t`${start}· 合并于 ${clock(b)}（${fb}）${v.syncPending?.length ? t('· ⤓ 已合并·待同步到本地') : ''}`;
}

// 预估段措辞：「预估开始 / 预估结束 + 工期来源」
function estText(task, v) {
  const [a, b] = v.gantt.est;
  const dur = v.gantt.defaultDuration ? t('默认工期') : t`文档预计耗时 ${task.estimateHours} 小时`;
  return t`预估开始 ${clock(a)} → 预估结束 ${clock(b)}（工期：${dur}；只按依赖先后排）`;
}

/** 任务抽屉「甘特时间」区（需求 15.4–15.8）：事实 / 预估 / 超出预计 / 无法排期 / 无时间及来源；父任务写汇总范围。 */
function taskGanttSection(task, view) {
  const g = view.gantt;
  const items = !g ? [[t('排期'), t('作废任务不排期')]] : [
    g.span && [t('汇总范围'), t`${clock(g.span[0])} → ${clock(g.span[1])}（子任务事实与预估的并集）`],
    g.fact && [t('事实'), factText(view)],
    g.est && [t('预估'), estText(task, view)],
    g.overdue && [t('超出预计'), t('⚠ 开始时间加预计工期已早于今天，仍未完成；不再向后编造预估')],
    g.unschedulable && [t('无法排期'), g.unschedulable.map(tx).join(t('；'))],
    g.noTime && [t('无时间'), NO_TIME_TEXT],
  ].filter(Boolean);
  return [h('h3', {}, t('甘特时间')), items.length
    ? h('dl', { class: 'kv gtime' }, items.map(([k, x]) => [h('dt', {}, k), h('dd', {}, x)]))
    : h('div', { class: 'muted' }, t('还没有事实时间，也没有排出预估。'))];
}

// ---------------- 组合筛选（任务 6.6） ----------------

// 里程碑筛选的值：有代号用代号（M0-c，跨文档同代号一起筛），没有就用分组标题
const msOf = (doc, groupId) => { const g = doc.groups.find((x) => x.id === groupId); return g ? (g.code ?? g.title) : null; };
const FILTER_FIELDS = ['doc', 'src', 'ms', 'status', 'conflict', 'archived', 'hideVoid'];
// 任务级筛选（隐藏作废除外）：此时要看的就是筛出来的任务，任务树与甘特不再按「全部完成」默认折叠
const taskFiltered = (state) => Boolean(state.ms || state.status || state.conflict);

/**
 * 组合筛选（需求 10.4、2.10、14.8、15.10）：在分支线（lineBoard）之上按 规划文档 / 来源类型 / 已归档（文档级）与
 * 里程碑 / 状态 / 有冲突 / 隐藏作废（任务级）收窄，返回浅拷贝看板。各视图照常渲染它，统计数字、甘特汇总、关系图、下一步、
 * 需要确认就都落在同一筛选范围里；全部在内存完成，不重拉数据（需求 17.3）。
 * - 已归档文档默认不进；勾「显示已归档文档」后当普通文档参与各视图与统计（archived 置 false，shownArchived 给任务树标注）。
 * - 有任务级筛选时，没剩任务的文档整份不显示；stats.docs 按留下的任务重算（口径同 engine：未作废任务、父子各一条）。
 * - 「在等我处理」：有文档 / 任务级筛选时只留关联到可见任务的条目。
 * - base = 只做了分支线与归档处理的看板，筛选下拉的选项从它取（选了某文档后下拉里仍能看到其它文档）。
 * 地址里写了本项目没有的文档 / 来源 / 里程碑时当没选（同 renderPage 对 line= 的处理）。
 */
export function filterBoard(board, state) {
  const lined = lineBoard(board, state);
  const base = { ...lined, docs: lined.docs.filter((d) => state.archived || !d.archived).map((d) => (d.archived ? { ...d, archived: false, shownArchived: true } : d)) };
  if (!base.docs.some((d) => d.docId === state.doc)) state.doc = null;
  if (!base.docs.some((d) => d.sourceType === state.src)) state.src = null;
  if (!base.docs.some((d) => d.groups.some((g) => (g.code ?? g.title) === state.ms))) state.ms = null;

  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const conflicted = new Set((board.conflicts ?? []).filter((c) => c.taskKey && c.type !== 'c').map((c) => c.taskKey)); // c 同任务行，不算「不一致」
  const taskLevel = taskFiltered(state);
  const keep = (doc) => (t) => (!state.hideVoid || !t.void) && (!state.ms || msOf(doc, t.groupId) === state.ms)
    && (!state.status || views.get(t.key)?.status === state.status) && (!state.conflict || conflicted.has(t.key));
  const docs = base.docs.filter((d) => (!state.doc || d.docId === state.doc) && (!state.src || d.sourceType === state.src))
    .map((d) => (taskLevel || state.hideVoid ? { ...d, tasks: d.tasks.filter(keep(d)) } : d))
    .filter((d) => !taskLevel || d.tasks.length);
  const shown = new Set(docs.flatMap((d) => d.tasks.map((t) => t.key)));
  return {
    ...base, base, docs,
    waiting: taskLevel || state.doc || state.src ? (base.waiting ?? []).filter((w) => w.tasks?.some((k) => shown.has(k))) : base.waiting,
    stats: { ...board.stats, docs: docs.map((d) => docStats(d, views)) },
  };
}

// 一份文档及其各分组的状态计数，结构同 engine Board.stats.docs[i]
function docStats(doc, views) {
  const sum = (tasks) => {
    const counts = Object.fromEntries(Object.keys(STATUS_UI).map((s) => [s, 0]));
    let total = 0;
    for (const t of tasks) { const s = views.get(t.key)?.status; if (s) { counts[s]++; total++; } }
    return { counts, total, ratio: total ? counts.done / total : null };
  };
  return { docId: doc.docId, ...sum(doc.tasks), groups: doc.groups.map((g) => ({ groupId: g.id, ...sum(doc.tasks.filter((t) => t.groupId === g.id)) })) };
}

/**
 * 总览任务工具栏的「筛选」下拉（P4 最小形态：原生 details + 下拉 / 勾选）。改任一项写地址 → 路由整页重画
 * （统计、甘特等都要跟着变）；面板开合记在 state.filterOpen，重画后保持展开。选项来自 board.base（见 filterBoard）；
 * 里程碑只列所选文档 / 来源范围内有任务的分组。
 */
function filterMenu(board, state) {
  const base = board.base ?? board;
  const go = (patch) => { Object.assign(state, patch); location.hash = hashFor(state.view, state.project, state.focus, state.line, state); };
  const scoped = base.docs.filter((d) => (!state.doc || d.docId === state.doc) && (!state.src || d.sourceType === state.src));
  const srcs = new Map();
  for (const d of base.docs) if (!srcs.has(d.sourceType)) srcs.set(d.sourceType, d.sourceLabel ?? d.sourceType);
  const ms = new Map();
  for (const d of scoped) for (const g of d.groups) if (d.tasks.some((t) => t.groupId === g.id) && !ms.has(g.code ?? g.title)) ms.set(g.code ?? g.title, g.title);
  const sel = (label, field, items) => h('label', { 'data-f': field }, label,
    dropdown(state, { label: t`筛选：${label}`, value: state[field] ?? '', onChange: (v) => go({ [field]: v || null }),
      options: [{ value: '', text: t('全部') }, ...items.map(([v, text, tip]) => ({ value: v, text, title: tip }))] }));
  const chk = (text, field) => h('label', {},
    h('input', { type: 'checkbox', 'aria-label': t`筛选：${text}`, 'data-f': field, checked: state[field], onchange: (e) => go({ [field]: e.currentTarget.checked }) }), ` ${text}`);
  const n = FILTER_FIELDS.filter((k) => state[k]).length;
  return h('details', { class: 'fdrop', open: state.filterOpen, ontoggle: (e) => { state.filterOpen = e.currentTarget.open; } },
    h('summary', { class: n ? 'on' : null }, n ? t`筛选（${n}）` : t('筛选')),
    h('div', { class: 'fpanel' },
      sel(t('规划文档'), 'doc', base.docs.map((d) => [d.docId, d.docId, d.title])),
      sel(t('来源类型'), 'src', [...srcs].map(([v, text]) => [v, text, v])),
      sel(t('里程碑'), 'ms', [...ms].map(([v, title]) => [v, v, title])),
      sel(t('状态'), 'status', Object.entries(STATUS_UI).map(([v, s]) => [v, `${s.icon} ${s.text}`])),
      chk(t('只看有冲突的任务'), 'conflict'),
      chk(t('显示已归档文档'), 'archived'),
      chk(t('隐藏作废任务'), 'hideVoid'),
      n > 0 && h('button', { class: 'linkbtn', onclick: () => go(Object.fromEntries(FILTER_FIELDS.map((k) => [k, null]))) }, t('清除筛选'))));
}

// ---------------- 整页 ----------------

/** 错误页：全局配置错误、单项目配置错误、看板读取失败都用它，写明原因，不显示空看板（需求 1.6）。 */
export function renderErrorPage(title, messages) {
  return h('section', { class: 'card errpage' },
    h('h2', {}, title),
    h('ul', {}, messages.map((m) => h('li', {}, m))));
}

/**
 * 整页 = 顶栏 + 导航 + 主区。list 为 GET /api/projects 的结果；error 为看板读取失败时的 {title, messages}。
 * 优先级：全局配置错误 → 本项目配置错误 → 读取失败 → 读取中 → 视图。
 */
export function renderPage({ list, projectId, board = null, error = null, state }) {
  const entry = list.projects.find((p) => p.id === projectId);
  // 分支线来自 /api/projects；地址里的 line= 不是本项目的分支线就当「全部」
  state.lines = entry?.branchLines ?? [];
  if (!state.lines.some((l) => l.id === state.line)) state.line = null;
  let body;
  let drawer = [];
  const shown = board && filterBoard(board, state);
  if (list.errors.length) body = renderErrorPage(t('配置文件有误，devboard 无法加载项目'), [...list.errors.map((e) => tx(e.message)), t('改好配置后重启 devboard。')]);
  else if (!entry) body = renderErrorPage(t('配置里没有项目'), [t('在 devboard.config.json 的 projects 里至少配置一个项目，然后重启 devboard。')]);
  else if (entry.errors.length) body = renderErrorPage(t`项目 ${entry.name ?? entry.id} 的配置有问题，已停用`, [...entry.errors.map((e) => tx(e.message)), t('其它项目不受影响；改好配置后重启 devboard。')]);
  else if (error) body = renderErrorPage(error.title, error.messages.map(tx));
  else if (!board) body = h('p', { class: 'muted' }, t('正在读取看板…'));
  else {
    // 视图只看所选分支线与组合筛选（任务 6.6）；抽屉用完整看板，跨分支线的关联任务也能打开
    body = state.view === 'next' ? renderNext(shown, state)
      : state.view === 'gantt' ? renderGantt(shown, state)
      : state.view === 'graph' ? renderGraph(shown, state)
      : state.view === 'check' ? renderCheck(shown, state)
      : state.view === 'diag' ? renderDiag(board, state) // 诊断看整个项目，不按分支线筛
      : renderOverview(shown, state);

    // 地址带 focus= 时叠加任务详情抽屉；关闭 = 去掉 focus=
    if (state.focus) drawer = renderDrawer(board, state, () => { location.hash = hashFor(state.view, state.project, null, state.line, state); });
  }

  // 非回环监听等配置警告、最近一次刷新失败（此时仍显示上一版看板）、GitHub 降级放在主区顶部
  const banners = [...list.warnings.map((w) => t`警告：${tx(w)}`), board && tx(entry?.refreshError), ...(board ? degradedBanners(board, state.now) : [])].filter(Boolean);
  return [
    renderHeader(list.projects, projectId, board, state),
    // owner 2026-10-10：导航计数改为本视图全部条数（含仅文档确认），与视图里「全部类型（N）」一致，免得两个数字对不上
    renderNav(state.view, projectId, state.line, board ? checkItems(shown, state).length : 0, state),
    h('main', {}, banners.map((m) => h('div', { class: 'banner' }, m)), board && scopeBanner(board), manualBanners(board, state), body),
    ...drawer,
  ];
}

// ---------------- 浏览器入口 ----------------

// style.css 里自带滚动条的区域（overflow: auto / scroll）
const SCROLLERS = ['.drawer', '.gscroll', '.gwrap', '.srcview', '.evlist', '.plist', '.ddlist'];

// 替换节点前保存；卸载聚焦节点后 activeElement 会退回 body，不能等到重画完成再读选区。
function keepFocus(root, draw) {
  const a = document.activeElement;
  const label = root.contains(a) && a?.getAttribute?.('aria-label');
  const caret = [a?.selectionStart, a?.selectionEnd];
  draw();
  const b = label && [...root.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label') === label);
  if (!b) return;
  b.focus({ preventScroll: true });
  try { if (caret[0] != null) b.setSelectionRange(...caret); } catch { /* date / checkbox 等没有光标 */ }
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** POST 只确认请求是否被接收；真正的看板更新仍由 SSE 推送。仅最新一次点击能改提示。 */
export function refreshRequest(projectId, isCurrent, show) {
  let latest = 0;
  return async () => {
    const request = ++latest;
    show(t('正在发送刷新请求…'));
    let message = t('刷新请求失败，请稍后重试');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/refresh`, { method: 'POST' });
      const body = await response.json();
      if (response.status === 202 && typeof body?.merged === 'boolean') {
        if (isCurrent() && request === latest) show(body.merged ? t('刷新请求已合并') : t('刷新请求已接受，等待看板更新'), true);
        return;
      }
    } catch { /* 网络、非 JSON 响应都只显示安全的通用提示。 */ }
    if (isCurrent() && request === latest) show(message);
  };
}

export async function main() {
  document.documentElement.lang = HTML_LANG[getLang()];
  const paintError = (title, e) => document.body.replaceChildren(h('main', {}, renderErrorPage(title, [e.message])));
  let list;
  try {
    ({ body: list } = await getJson('/api/projects'));
  } catch (e) {
    return paintError(t('连不上 devboard 服务'), e);
  }
  let state = newState();
  let cur = { projectId: undefined, board: null, error: null };
  // 整页重画（SSE 推来新版本、切筛选）会换掉全部节点：按 aria-label 找回原来有焦点的控件，恢复焦点与光标位置，
  // 搜索框打字途中来了新版本也不丢焦点（任务 6.6）
  // 各滚动区（抽屉、甘特、右栏列表、原文、选择器）的滚动位置也随整页重画丢失：同一视图、同一抽屉内按选择器 + 序号还原，
  // 否则抽屉往下翻到一半、后台推来新版本就跳回顶部；换视图 / 换抽屉照常从头开始
  let lastPlace = null;
  const paint = () => keepFocus(document, () => {
    state.now = Date.now();
    const place = `${state.view}|${state.focus}`;
    const scrolls = place === lastPlace ? SCROLLERS.map((s) => [...document.querySelectorAll(s)].map((e) => [e.scrollTop, e.scrollLeft])) : null;
    lastPlace = place;
    document.body.replaceChildren(...renderPage({ list, ...cur, state }));
    scrolls?.forEach((pos, k) => document.querySelectorAll(SCROLLERS[k]).forEach((e, i) => { if (pos[i]) [e.scrollTop, e.scrollLeft] = pos[i]; }));
    scrollToTarget(document, state);
  });

  // 原文按整份文档读一次，存进该项目的 state；换项目时 state 整个换掉，旧请求的结果落在旧对象上、不再重画。
  // 看板出了新版本时原文只标过期（stale）不清掉：先照旧显示、后台重读，读到再换——
  // 清掉的话正文会闪成「正在读取原文…」，抽屉一下变短，滚动位置和底部都跟着乱。
  const textLoader = (s, projectId) => (docId) => {
    const t = s.texts.get(docId);
    if (t !== undefined && !t?.stale) return;
    s.texts.set(docId, t ? { ...t, stale: false } : null); // 标成读取中，重画时不重复发请求
    getJson(`/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(docId)}`)
      .then(({ status, body }) => s.texts.set(docId, status === 200 ? { lines: body.lines } : { error: body?.messages?.[0] ?? `HTTP ${status}` }),
        (e) => s.texts.set(docId, { error: e.message }))
      .then(() => { if (s === state) paintWhenIdle(); });
  };

  async function route() {
    const { view, project, focus, line } = parseHash(location.hash);
    const filters = parseFilters(location.hash); // 任务 6.6：筛选、搜索词、起始日、确认类型都从地址还原
    const projectId = list.projects.some((p) => p.id === project) ? project : list.projects[0]?.id;
    if (view !== state.view) state.dd = state.dp = null; // 切视图收起下拉 / 日历
    state.view = view;
    if (projectId === cur.projectId) {
      if (focus !== state.focus) state.viewer = null; // 换了任务或关了抽屉，原文查看器收起
      // 关了抽屉：手动关联选择器一并收起（总览「关联」是先设 picker 再改地址打开抽屉，所以只在关闭时清）
      if (!focus) state.picker = null;
      Object.assign(state, filters);
      state.focus = focus;
      state.line = line;
      return paint();
    }
    // 换项目：筛选与折叠状态各项目独立
    state = { ...newState(), ...filters, view, project: projectId, focus, line };
    state.need = textLoader(state, projectId);
    // 只改已有的播报节点：立即反馈且不替换按钮、抽屉或滚动中的内容。
    const refreshState = state;
    const requestRefresh = refreshRequest(projectId, () => refreshState === state, (message, accepted = false) => {
      if (accepted && cur.board?.version !== refreshState.refreshVersion) message = '';
      refreshState.refreshAwaiting = accepted && Boolean(message);
      refreshState.refreshFeedback = message;
      const feedback = document.querySelector('.refresh-feedback');
      if (feedback) feedback.textContent = message;
    });
    state.refresh = () => {
      refreshState.refreshVersion = cur.board?.version;
      return requestRefresh();
    };
    state.manual = (change) => writeManual(projectId, change); // 任务 4.2
    cur = { projectId, board: null, error: null };
    events?.close();
    paint();
    const entry = list.projects.find((p) => p.id === projectId);
    if (!entry || entry.errors.length || list.errors.length) return;
    await loadBoard(projectId);
    if (cur.projectId !== projectId) return;
    paint();
    subscribe(projectId);
  }

  // 读看板。已有看板时读取失败不换成错误页（继续显示旧看板，失败原因看 /api/projects 的 refreshError 横幅）。
  async function loadBoard(projectId) {
    let error;
    try {
      const { status, body } = await getJson(`/api/projects/${encodeURIComponent(projectId)}/board`);
      if (cur.projectId !== projectId) return; // 读取期间又切了项目
      if (status === 200) return Object.assign(cur, { board: body, error: null });
      error = { title: status === 409 ? t('项目配置有问题，已停用') : t('看板读取失败'), messages: body?.messages ?? [`HTTP ${status}`] };
    } catch (e) {
      error = { title: t('连不上 devboard 服务'), messages: [e.message] };
    }
    if (cur.projectId === projectId && !cur.board) cur.error = error;
  }

  // 任务 3.6：订阅 SSE，服务端推来的版本号与手上看板不同才重拉 /board 与 /api/projects（需求 13.3、17.3），原文缓存随之作废。
  // 用「不同」而不是「更大」：服务重启后版本号从 1 重数。
  let events = null;
  let latest = null;
  let pulling = false;
  // 滚动途中整页重画会换掉正在滚的抽屉 / 列表，触控板的惯性滚动随即落到主面板上：推来的新版本等滚动停下
  // （最近 800ms 没有滚轮 / 触摸，惯性滚动期间滚轮事件持续不断）再画。用户自己的操作（切视图、筛选）照常立刻画。
  let lastScrollInput = 0;
  let idleTimer = null;
  for (const type of ['wheel', 'touchmove']) addEventListener(type, () => { lastScrollInput = Date.now(); }, { passive: true, capture: true });
  const paintWhenIdle = () => {
    clearTimeout(idleTimer);
    const wait = lastScrollInput + 800 - Date.now();
    if (wait > 0) idleTimer = setTimeout(paintWhenIdle, wait);
    else paint();
  };
  function subscribe(projectId) {
    events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    events.onmessage = (e) => { latest = JSON.parse(e.data).version; pull(projectId); };
  }
  async function pull(projectId) {
    if (pulling || cur.projectId !== projectId || cur.board?.version === latest) return;
    pulling = true;
    let ok;
    try {
      const r = await getJson('/api/projects').catch(() => null);
      if (r?.status === 200) list = r.body;
      ok = await loadBoard(projectId);
    } finally {
      pulling = false;
    }
    if (cur.projectId !== projectId) return;
    if (ok) for (const [k, t] of state.texts) { if (t) state.texts.set(k, { ...t, stale: true }); else state.texts.delete(k); }
    if (ok && state.refreshAwaiting && cur.board.version !== state.refreshVersion) {
      state.refreshAwaiting = false;
      state.refreshFeedback = '';
    }
    paintWhenIdle();
    // 拉取期间又来了新版本就再拉一次；读取失败则等下一条推送再试，不在这里空转
    if (ok && cur.board.version !== latest) pull(projectId);
  }

  // ---- 任务 4.2 ----
  // 手动关联 / 解除（POST）与撤销（DELETE，change 不带 action）。浏览器对同源 POST / DELETE 自动带 Origin，服务端据此放行。
  // 成功后按返回的版本号立刻拉新看板（不干等 SSE）；失败把原因记进 state.linkError，显示为红色横幅，下次成功时清掉。
  async function writeManual(projectId, { taskKey, pr, action }) {
    const s = state;
    let msg = null;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/manual-links`, {
        method: action ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action ? { taskKey, pr, action } : { taskKey, pr }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok) { latest = body?.version ?? latest; pull(projectId); } else msg = body?.messages?.[0] ?? `HTTP ${r.status}`;
    } catch (e) {
      msg = e.message;
    }
    if (s !== state || (!msg && !s.linkError)) return;
    s.linkError = msg;
    paint();
  }

  addEventListener('hashchange', route);
  // 自绘下拉 / 日历：在弹层外按下指针就收起（只改弹层自己的节点，不整页重画，免得吞掉这次点击）
  addEventListener('pointerdown', (e) => { for (const el of document.querySelectorAll('.pop.open')) if (!el.contains(e.target)) el.popClose(); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.focus) location.hash = hashFor(state.view, state.project, null, state.line, state); });
  return route();
}

if (typeof window !== 'undefined') main();
