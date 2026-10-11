// devboard 自绘 SVG（design K3、§3.10.4）：关系图（任务 2.7）、甘特时间轴（任务 6.2）。
// 同 app.mjs 的 h()：节点只经 createElementNS 创建、属性只经 setAttribute，外部文本只进文本节点（design K2）。
// 本文件不认识 Board / TaskView：调用方把任务整理成画图用的节点数据再传进来，这里只管布局与绘制。

import { t, getLang } from './i18n.mjs';

const NS = 'http://www.w3.org/2000/svg';

/** 建 SVG 节点：attrs 里 `on<事件>` 挂监听，其余 setAttribute（null / false 跳过）；子节点字符串变文本节点。 */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------- 关系图 ----------------

/**
 * 分层 + 列内排序（UI 稿 renderGraph）。nodes 按文档顺序，dep 只含本图内的前置 id。
 * 列 = 最长前置链层级（没有前置的在第 0 列）；成环时正在求值的节点暂记 0，保证有限步结束（成环另有红框提示）。
 * 列内重心法：按前置在前面各列里名次的平均值排序，没有前置的用自己在列内的文档顺序位置，明显减少连线交叉。
 * ponytail: 只做一遍从左到右的重心排序，不做多轮上下扫；单文档节点过百、交叉明显时再引 dagre。
 * @param {{id: string, dep: string[]}[]} nodes
 * @returns {{layer: Map<string, number>, cols: string[][]}}
 */
export function layoutGraph(nodes) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map();
  const depth = (n) => {
    if (layer.has(n.id)) return layer.get(n.id);
    layer.set(n.id, 0);
    const ds = n.dep.map((id) => by.get(id)).filter(Boolean);
    const v = ds.length ? 1 + Math.max(...ds.map(depth)) : 0;
    layer.set(n.id, v);
    return v;
  };
  nodes.forEach(depth);

  const cols = [];
  for (const n of nodes) (cols[layer.get(n.id)] ??= []).push(n);
  const rank = new Map();
  const out = [];
  for (const col of cols) {
    if (!col) { out.push([]); continue; } // 成环可能让某一层空着
    const bc = new Map(col.map((n, j) => {
      const ds = n.dep.filter((id) => rank.has(id));
      return [n.id, ds.length ? ds.reduce((a, id) => a + rank.get(id), 0) / ds.length : j];
    }));
    col.sort((a, b) => bc.get(a.id) - bc.get(b.id)); // sort 稳定：重心相同保持文档顺序
    col.forEach((n, j) => rank.set(n.id, j));
    out.push(col.map((n) => n.id));
  }
  return { layer, cols: out };
}

// 尺寸同 UI 稿：节点宽高、列间距、行间距、边距、列头高度
const NW = 178, NH = 42, CG = 64, RG = 12, PAD = 24, TOP = 28;

/**
 * 画关系图。nodes：{ id, label（编号）, icon, title, tip（悬停全文）, st（状态色 class）, extra（第二行）, extraRed,
 * cls: string[]（done / blocked / cyc）, dep: id[], par: id[] }，按文档顺序。
 * 依赖 = 贝塞尔曲线 + 箭头（前置 → 后续）；可并行 = 绿色虚线无箭头，同列从右侧绕弧、异列直线。
 * 悬停节点调 graphHl 高亮，点节点调 onOpen(id)。
 */
export function graphSvg(nodes, { onOpen = () => {} } = {}) {
  const { cols } = layoutGraph(nodes);
  const pos = new Map();
  cols.forEach((c, i) => c.forEach((id, j) => pos.set(id, { x: PAD + i * (NW + CG), y: TOP + j * (NH + RG) })));
  const W = PAD * 2 + cols.length * (NW + CG);
  const H = TOP + Math.max(0, ...cols.map((c) => c.length)) * (NH + RG) + PAD;

  const edges = [];
  const pars = [];
  const seen = new Set();
  for (const n of nodes) {
    const b = pos.get(n.id);
    for (const id of n.dep) {
      const a = pos.get(id);
      if (!a) continue;
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
      edges.push(s('path', { class: 'gedge', 'data-a': id, 'data-b': n.id,
        d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 6} ${y2}`, 'marker-end': 'url(#garr)' }));
    }
    for (const id of n.par) {
      const k = [n.id, id].sort().join('|');
      const p = pos.get(id);
      if (seen.has(k) || !p) continue;
      seen.add(k);
      const d = b.x === p.x
        ? `M${b.x + NW} ${b.y + NH / 2} C${b.x + NW + 26} ${b.y + NH / 2} ${p.x + NW + 26} ${p.y + NH / 2} ${p.x + NW} ${p.y + NH / 2}`
        : `M${b.x + NW / 2} ${b.y + NH} L${p.x + NW / 2} ${p.y}`;
      pars.push(s('path', { class: 'gedge par', 'data-a': n.id, 'data-b': id, d }));
    }
  }

  const svg = s('svg', { width: W, height: H, class: 'gsvg' });
  const hl = (id) => () => graphHl(svg, id);
  const boxes = nodes.map((n) => {
    const p = pos.get(n.id);
    return s('g', { class: ['gnode', ...n.cls].join(' '), 'data-id': n.id, transform: `translate(${p.x},${p.y})`,
      onmouseenter: hl(n.id), onmouseleave: hl(null), onclick: () => onOpen(n.id) },
    s('title', {}, n.tip),
    s('rect', { class: 'box', width: NW, height: NH, rx: 6 }),
    s('rect', { class: `sbar ${n.st}`, width: 4, height: NH, rx: 2 }),
    s('text', { x: 12, y: 16 }, s('tspan', { class: 'gid' }, n.label), `  ${n.icon} ${n.title}`),
    s('text', { x: 12, y: 32, class: n.extraRed ? 'gx red' : 'gx' }, n.extra));
  });
  const heads = cols.map((_, i) => s('text', { class: 'laycol', x: PAD + i * (NW + CG), y: 16 },
    i === 0 ? t('第 1 层 · 无前置') : t`第 ${i + 1} 层`));

  svg.append(
    s('defs', {}, s('marker', { id: 'garr', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7,
      orient: 'auto-start-reverse' }, s('path', { class: 'garrh', d: 'M0 0 L10 5 L0 10z' }))),
    ...heads, ...pars, ...edges, ...boxes);
  return svg;
}

/**
 * 悬停高亮（UI 稿 graphHl）：选中节点、前置（蓝）、后续（灰）、可并行（绿），相关连线加粗，其余变淡；id 为 null 清除。
 * 关系直接从图上的连线读：依赖线 data-a = 前置、data-b = 后续；并行线两端对称。
 */
export function graphHl(svg, id) {
  const nodes = svg.querySelectorAll('.gnode');
  const edges = svg.querySelectorAll('.gedge');
  for (const e of [...nodes, ...edges]) for (const c of ['fade', 'sel', 'pre', 'post', 'parhl', 'on']) e.classList.remove(c);
  if (id == null) return;
  const pre = new Set(), post = new Set(), par = new Set();
  for (const e of edges) {
    const a = e.getAttribute('data-a'), b = e.getAttribute('data-b');
    if (e.classList.contains('par')) { if (a === id) par.add(b); if (b === id) par.add(a); }
    else { if (b === id) pre.add(a); if (a === id) post.add(b); }
    e.classList.add(a === id || b === id ? 'on' : 'fade');
  }
  for (const n of nodes) {
    const i = n.getAttribute('data-id');
    n.classList.add(i === id ? 'sel' : pre.has(i) ? 'pre' : post.has(i) ? 'post' : par.has(i) ? 'parhl' : 'fade');
  }
}

/** 图例里的小图标：dep 实线箭头、par 绿色虚线、blocked 红虚框、cycle 红粗框（颜色走 class，亮暗主题都可读）。 */
export function legendIcon(kind) {
  if (kind === 'dep') {
    return s('svg', { width: 34, height: 10, class: 'glegend' },
      s('path', { class: 'gedge', d: 'M2 5 H26' }), s('path', { class: 'garrh', d: 'M32 5 l-6 -3 v6z' }));
  }
  if (kind === 'par') return s('svg', { width: 30, height: 10, class: 'glegend' }, s('path', { class: 'gedge par', d: 'M2 5 H28' }));
  return s('svg', { width: 18, height: 12, class: 'glegend' },
    s('rect', { class: kind === 'cycle' ? 'lg-cyc' : 'lg-blocked', x: 1, y: 1, width: 16, height: 10, rx: 2 }));
}

// ---------------- 甘特图（任务 6.2） ----------------
// 右侧时间轴是一张 SVG（design §3.10.4），左侧标签列是 HTML（app.mjs），两边行高一致、随页面一起纵向滚动。
// 类名一律 g 前缀：UI 稿 HTML 版的 .bar / .day / .today 带 position、height，套到 SVG 元素上会把矩形压扁。

/** 缩放档：周 / 天 / 月，单位 px / 天（天 = UI 稿的 40，周、月 = design §3.10.4）。 */
export const GANTT_ZOOM = { week: 24, day: 40, month: 6 };
/** 行高与表头高（同 UI 稿 .gl / .gh）。 */
export const GROW = 26, GHEAD = 44;
const DAYMS = 864e5;
const PAT = ['todo', 'doing', 'review', 'merge', 'done'];
// 英文用月份缩写（Oct），中日写「10 月」「10月」
const monthLabel = (d) => (getLang() === 'en' ? d.toLocaleString('en', { month: 'short' }) : t`${d.getMonth() + 1} 月`);

/**
 * 画甘特时间轴。rows 与左侧标签列一一对应（同序、同高），每行：
 * { kind: 'doc'|'grp'|'task'|'nt', key?（任务键，可悬停 / 点开）, st?（状态色 class）,
 *   fact?/est?/span?: [开始毫秒, 结束毫秒], tipFact?, tipEst?（悬停 <title>，措辞由调用方保证不混用）,
 *   label?: {text, cls}[]（条后小字）, at?: 'today'|'left'（没有横条时小字的位置）, dep?: 任务键[], par?: 任务键[] }。
 * 事实段 = 实色 gfact；预估段 = 斜纹 <pattern> + 虚线描边 gest，绝不用实色；span = 汇总细括号条（分组 / 父任务）。
 * 返回 { svg, hl }：hl(root, key) 高亮 key 的前置 / 后续 / 并行、画折线箭头、其余变淡（root 里所有 [data-key] 元素都参与，
 * 所以左侧标签行一起变淡）；key 为 null 清除。
 */
export function ganttSvg(rows, { from, to, now, px, allLinks = false, onOpen = () => {}, onHover = () => {} }) {
  const x = (ms) => ((ms - from) / DAYMS) * px;
  const W = x(to), H = GHEAD + rows.length * GROW;
  const top = (i) => GHEAD + i * GROW;

  // 表头与竖线：每天一条（周一深色）；天档每天标日期，周档只标周一，月档不标日期；每月 1 日（及首日）标月份
  const grid = [];
  const head = [];
  const d0 = new Date(from);
  for (let i = 0; ; i++) {
    const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i);
    const at = x(d.getTime());
    if (at > W) break;
    const wk = d.getDay() === 1;
    if (px >= GANTT_ZOOM.week || wk) grid.push(s('line', { class: wk ? 'gday wk' : 'gday', x1: at, x2: at, y1: 0, y2: H }));
    if (px >= GANTT_ZOOM.day || (px >= GANTT_ZOOM.week && wk)) head.push(s('text', { class: 'gdlab', x: at + 3, y: GHEAD - 6 }, d.getDate()));
    if (i === 0 || d.getDate() === 1) head.push(s('text', { class: 'gmlab', x: at + 3, y: 15 }, monthLabel(d)));
  }

  const enter = (key) => key && (() => onHover(key));
  const leave = (key) => key && (() => onHover(null));
  const click = (key) => key && (() => onOpen(key));
  const body = rows.map((r, i) => {
    const y = top(i);
    const ev = { onmouseenter: enter(r.key), onmouseleave: leave(r.key), onclick: click(r.key) };
    const parts = [s('rect', { class: 'grbg', x: 0, y, width: W, height: GROW }),
      s('line', { class: 'grline', x1: 0, x2: W, y1: y + GROW - 0.5, y2: y + GROW - 0.5 })];
    let right = null;
    if (r.span) {
      const [a, b] = [x(r.span[0]), Math.max(x(r.span[1]), x(r.span[0]) + 6)];
      parts.push(s('path', { class: 'gsum', d: `M${a} ${y + 17} V${y + 10} H${b} V${y + 17}` }, s('title', {}, r.tipSpan ?? t('汇总范围'))));
      right = b;
    }
    if (r.fact) {
      const a = x(r.fact[0]);
      const w = Math.max(x(r.fact[1]) - a, 3);
      parts.push(s('rect', { class: `gfact ${r.st}`, x: a, y: y + 6, width: w, height: 14, rx: 3, ...ev }, s('title', {}, r.tipFact)));
      right = Math.max(right ?? 0, a + w);
    }
    if (r.est) {
      const a = x(r.est[0]);
      const w = Math.max(x(r.est[1]) - a, 3);
      parts.push(s('rect', { class: `gest ${r.st}`, x: a, y: y + 6.5, width: w, height: 13, rx: 3, fill: `url(#gpat-${r.st})`, ...ev },
        s('title', {}, r.tipEst)));
      right = Math.max(right ?? 0, a + w);
    }
    if (r.label?.length) {
      const lx = right != null ? right + 4 : r.at === 'today' ? x(now) + 6 : 8;
      parts.push(s('text', { class: 'gblab', x: lx, y: y + 17 }, r.label.map((p) => s('tspan', { class: p.cls ?? null }, p.text))));
    }
    return s('g', { class: `gr ${r.kind}`, 'data-key': r.key ?? null }, parts);
  });

  const tx = x(now);
  const todayText = t('今天');
  const links = s('g', { class: 'glinks' });
  const svg = s('svg', { class: 'gsvg', width: W, height: H },
    s('defs', {}, PAT.map((st) => s('pattern', { id: `gpat-${st}`, class: `gpat ${st}`, width: 8, height: 8,
      patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('rect', { class: 'gpatbg', width: 8, height: 8 }), s('rect', { class: 'gpatfg', width: 4, height: 8 })))),
    grid, head, s('line', { class: 'grline', x1: 0, x2: W, y1: GHEAD - 0.5, y2: GHEAD - 0.5 }),
    body, links,
    s('line', { class: 'gtoday', x1: tx, x2: tx, y1: 0, y2: H }),
    // 底板宽随文字：中日两个字 28px，英文「Today」要宽一些
    s('rect', { class: 'gtodayl', x: tx + 1, y: 2, width: Math.max(28, todayText.length * 6 + 8), height: 14, rx: 3 }),
    s('text', { class: 'gtodayt', x: tx + 5, y: 13 }, todayText));

  // 依赖折线：前置条末端 → 后续条开头，先横、再竖、再横，末端箭头（同 UI 稿 hl）
  const index = new Map(rows.map((r, i) => [r.key, i]).filter(([k]) => k));
  const endX = (r) => (r.est ? x(r.est[1]) : r.fact ? x(r.fact[1]) : null);
  const startX = (r) => (r.fact ? x(r.fact[0]) : r.est ? x(r.est[0]) : null);
  const line = (a, b, cls) => {
    const ia = index.get(a), ib = index.get(b);
    if (ia == null || ib == null) return [];
    const x1 = endX(rows[ia]), x2 = startX(rows[ib]);
    if (x1 == null || x2 == null) return [];
    const y1 = top(ia) + GROW / 2, y2 = top(ib) + GROW / 2;
    return [s('path', { class: `glink ${cls}`, d: `M${x1} ${y1} H${x1 + 8} V${y2} H${x2}` }),
      s('path', { class: `garr ${cls}`, d: `M${x2} ${y2} l-5 -3 v6 z` })];
  };
  const all = () => rows.flatMap((r) => (r.key ? (r.dep ?? []).flatMap((d) => line(d, r.key, 'all')) : []));
  links.replaceChildren(...(allLinks ? all() : []));

  const hl = (root, key) => {
    const marked = root.querySelectorAll('[data-key]');
    for (const e of marked) { e.classList.remove('dim'); e.classList.remove('hl'); }
    if (key == null || !index.has(key)) { links.replaceChildren(...(allLinks ? all() : [])); return; }
    const me = rows[index.get(key)];
    const pre = me.dep ?? [];
    const post = rows.filter((r) => r.key && (r.dep ?? []).includes(key)).map((r) => r.key);
    const par = me.par ?? [];
    const keep = new Set([key, ...pre, ...post, ...par]);
    for (const e of marked) {
      const k = e.getAttribute('data-key');
      if (!keep.has(k)) e.classList.add('dim');
      else if (par.includes(k)) e.classList.add('hl');
    }
    links.replaceChildren(...(allLinks ? all() : []), ...pre.flatMap((p) => line(p, key, 'pre')), ...post.flatMap((p) => line(key, p, 'post')));
  };
  return { svg, hl };
}
