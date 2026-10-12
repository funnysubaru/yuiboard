// N25 Claude Code mod 的纯逻辑（design §4）：输入纯数据、输出纯数据，不 import claude-code。
// mod 环境没有 Node：这里只可 import web/ 与 src/ 里不依赖 Node 内置模块的纯 JS。

import { t, tx, getLang } from '../web/i18n.mjs';
import {
  STATUS_UI, CONFLICT_TEXT, RULE_TEXT, SESSION_SOURCE_TEXT, HTML_LANG,
  hashFor, refLabel, overallStats, checkItems, statusWhy, docLine, degradedBanners, docHasIssues, ago,
} from '../web/app.mjs';
import { mdText } from '../web/md.mjs'; // 一行显示的标题去掉 Markdown 记号，与网页悬停 / SVG 同一解析（N12）

// Claude 设置的 language 是自由文本（japanese / 日本語 / Simplified Chinese / zh-CN …），区域是 ja-JP、zh-Hans-CN、ja_JP.UTF-8 这类。
// 名称写在正则里：i18n 扫描器跳过正则字面量，不会把「日本語」「中文」当成漏包的界面文案。
const LANG_NAMES = [[/japanese|日本語/, 'ja'], [/chinese|中文|汉语|漢語/, 'zh'], [/english/, 'en']];
const langCode = (s) => {
  const v = String(s ?? '').trim().toLowerCase();
  // 语言代码要后跟分隔符或结尾：javanese 不算 ja
  return LANG_NAMES.find(([re]) => re.test(v))?.[1] ?? /^(zh|ja|en)(?:[-_.]|$)/.exec(v)?.[1] ?? null;
};

/** 界面语言（owner 已定 2）：Claude 设置的 language 优先，其次系统区域，都认不出用英文。 */
export const langOf = (setting, locale) => langCode(setting) ?? langCode(locale) ?? 'en';

// 去掉末尾斜杠后按路径段比：/a/b 不中 /a/bc
const trim = (p) => p.replace(/\/+$/, '');
const within = (cwd, dir) => cwd === dir || cwd.startsWith(`${dir}/`);

/**
 * 认当前会话所在的项目（需求 2.1 的前两条；手动选的项目由调用方处理）。
 * entries = [{ id, summary }]，summary 为 null（还没拉到 / 出错）的项目跳过。命中返回项目 id，否则 null。
 */
export function pickProject(entries, sessionId, cwd) {
  const ok = entries.filter((e) => e.summary);
  const bySession = ok.find((e) => e.summary.sessions?.some((s) => s.id === sessionId));
  if (bySession) return bySession.id;
  if (!cwd) return null;
  const here = trim(cwd);
  return ok.find((e) => e.summary.workspaces?.some((w) => w.path && within(here, trim(w.path))))?.id ?? null;
}

/**
 * 当前会话的聚焦任务（需求 5.2，owner 2026-10-12 改）：只认 devboard 的关联结果，只算未归档文档里的任务。
 * 关联里有运行中的 → 全部运行中，按 lastAt 从晚到早（同一时刻按文档顺序），keys[0] 是卡片上展开的主任务；
 * 否则取该会话关联 lastAt 最晚的一个，recent: true。at = 主任务的 lastAt。
 */
export function focusOf(summary, sessionId) {
  const links = new Map();
  for (const v of summary.tasks) {
    const l = v.sessions?.find((s) => s.sessionId === sessionId);
    if (l) links.set(v.key, l);
  }
  const tasks = summary.docs.filter((d) => !d.archived).flatMap((d) => d.tasks);
  const parents = new Set(tasks.map((t) => t.parentKey).filter(Boolean));
  const linked = tasks.filter((t) => links.has(t.key)).map((t) => ({ key: t.key, checkbox: t.checkbox, ...links.get(t.key) }));
  // 时间写法不统一（有无毫秒），按时间比。同一时刻（一个 PR 连上的几十个任务时间都一样）依次看：点到过的（named）在前、
  // 没勾选的在前、没有子任务的在前（具体的那一步比笼统的父任务有用），再按文档顺序（owner 2026-10-12 定；
  // 原先只按文档顺序，开发 PR 的会话总是落到第一个、早已完成的任务）
  const rank = (l, i) => [-(Date.parse(l.lastAt) || 0), l.named ? 0 : 1, l.checkbox === 'open' ? 0 : 1, parents.has(l.key) ? 1 : 0, i];
  const byRank = (a, b) => a[0].reduce((d, x, j) => d || x - b[0][j], 0);
  const latest = (list) => list.map((l, i) => [rank(l, i), l]).sort(byRank).map((r) => r[1]);
  const running = latest(linked.filter((l) => l.activity === 'running'));
  if (running.length) return { keys: running.map((l) => l.key), recent: false, at: running[0].lastAt ?? null };
  if (!linked.length) return { keys: [], recent: false, at: null };
  const [last] = latest(linked);
  return { keys: [last.key], recent: true, at: last.lastAt ?? null };
}

/** 展开该任务要打开的折叠键，从外到内：doc:、grp:（有分组时）、沿 parentKey 的各级祖先 task:（不含自身）。任务不存在 → []。 */
export function focusPath(summary, key) {
  for (const d of summary.docs) {
    const byKey = new Map(d.tasks.map((t) => [t.key, t]));
    const task = byKey.get(key);
    if (!task) continue;
    const ancestors = [];
    // 解析器只让 parentKey 指向前面出现过的任务，不会成环；seen 只是兜底防死循环（也保证不含自身、去重）
    const seen = new Set([key]);
    for (let p = byKey.get(task.parentKey); p && !seen.has(p.key); p = byKey.get(p.parentKey)) { seen.add(p.key); ancestors.unshift(p.key); }
    return [`doc:${d.docId}`, ...(task.groupId ? [`grp:${d.docId}/${task.groupId}`] : []), ...ancestors.map((k) => `task:${k}`)];
  }
  return [];
}

// ---------------- 面板内容（design §4、§6、§7） ----------------

/** 每次绘制的字符总量上限（需求 3.6：引擎只画前 100,000 字符，留一成余量）；按 rowCost 计，含 key 与链接地址。 */
export const TEXT_BUDGET = 90000;
const TITLE_MAX = 200; // 任务、文档、分组、会话、项目的标题
const NOTE_MAX = 500; // 状态原因、在等、冲突说明与出处、横幅、诊断行
const MORE_RESERVE = 200; // 末尾「其余 N 项」提示行先从预算里预留（另加它的链接地址长度）
const BANNERS_MAX = 5;
const FOCUS_MAX = 10;
const CHECK_MAX = 30;
const START_CMD = 'node ops/devboard-ctl.mjs up';

// 超长文字截成「前 N 字…（省略 M 字）」；键、编号、状态、href 不经过这里
const clip = (s, max) => (s == null || s.length <= max ? s : t`${s.slice(0, max)}…（省略 ${s.length - max} 字）`);
// STATUS_UI / CONFLICT_TEXT / RULE_TEXT 在 mod 环境里按中文求值（无 window），显示时再套 t() 得到当前语言
// 状态只画图标（owner 2026-10-12 定的面板稿）：颜色由渲染端按 status 上
const icon = (s) => (s ? STATUS_UI[s].icon : '⊘');
const BAR = 10; // 进度条格数
// 行的状态色调（owner 2026-10-12 定的面板稿 v2）：进行中按会话活动分运行中 / 停滞，等待合并里已合并未 pull 的单列待同步。
// 渲染端按它取前景色（主题键）与行底色
const TONE = { not_started: 'todo', in_review: 'review', awaiting_merge: 'merge', done: 'done' };
// 铺底色的行：竖条与底色的色调（band ?? tone）不是未开始、作废
const tinted = (r) => !['todo', 'void', undefined].includes(r.band ?? r.tone);
const toneOf = (v) => (!v?.status ? 'void'
  : v.status === 'in_progress' ? (v.activity === 'stale' ? 'stale' : 'run')
  : v.status === 'awaiting_merge' && v.syncPending?.length ? 'sync' : TONE[v.status]);
const size = (rows) => rows.reduce((n, r) => n + rowCost(r), 0);

/**
 * 一行画出来后计入引擎 100,000 字上限的字符数（design §4.2），hooks/register.tsx 照此渲染：
 * 文字（每段另加 1，抵段间空格）+ 行尾文字 end + 行 Box 的 key + 折叠按钮（key 即折叠键，标签 ▾ / ▸ 一字）
 * + 视图按钮 `go:<view>` / 项目按钮 `use:<id>` 的 key + 链接地址与标签符号（整行链接加「 ↗」、行尾链接「↗」；
 * 渲染端把 127.0.0.1 / [::1] 改写成 localhost，地址最多长 4 字，一并算进固定的 6）。
 * @param {{ key: string, texts: string[], toggle?: string, view?: string, pick?: string, href?: string }} row
 * @returns {number}
 */
export const rowCost = (row) => row.texts.reduce((n, s) => n + (s?.length ?? 0) + 1, 0) + row.key.length
  + (row.end ? row.end.length + 1 : 0)
  + (row.toggle ? row.toggle.length + 1 : 0)
  + (row.view ? `go:${row.view}`.length : 0)
  + (row.pick ? `use:${row.pick}`.length : 0)
  + (row.href ? row.href.length + 6 : 0);

/**
 * `/yuiboard` 命令执行后回给用户的一行字（已翻译）。
 * @returns {string}
 */
export const commandText = () => t('已打开 YUIBoard 面板');

/**
 * 整个面板的内容（design §4、§6）：纯数据进、纯数据出，文字都已翻译、已截断，总量已按 TEXT_BUDGET 裁剪。
 * 调用方先 setLang()。分支线固定「全部」。
 *
 * @param {object} input
 * @param {object|null} input.summary   当前项目的摘要（GET /api/projects/:id/summary），还没拿到为 null
 * @param {object|null} input.projects  GET /api/projects 的响应 { errors, warnings, projects:[{ id, name, branchLines, errors, refreshError }] }
 * @param {string|null} input.projectId 认出 / 手动选的项目
 * @param {'overview'|'check'|'diag'} input.view
 * @param {string[]} input.toggled      与默认相反的折叠键（doc:<docId>、grp:<docId>/<分组>、task:<任务键>、check:<类型>）
 * @param {{keys:string[], recent:boolean}|null} input.focus  focusOf 的结果
 * @param {string} input.url            服务地址，如 http://127.0.0.1:4317
 * @param {number} input.now            毫秒时间戳
 * @param {Array<{kind:'offline',url:string,message:string}|{kind:'http',status:number,messages:string[]}|{kind:'oversize'}>} input.problems
 *
 * @returns {{ header: Row[], banners: Row[], focus: Row[], body: Row[], more: Row|null }}
 *   Row = { key, kind, level, texts, tones?, end?, endTone?, status?, tone?, band?, gap?, sep?, toggle?, open?, href?, warn?, error?, highlight?, view?, active?, pick? }
 *   - key：稳定唯一。任务行 `task:<任务键>`（滚动目标）；可折叠行的 key 就是它的折叠键（doc: / grp: / task: / check:）
 *   - level：缩进层级（0 起）；texts：已翻译、已截断的字符串，按顺序排开（渲染端自定间隔），整行一行显示、放不下截断；
 *     任务标题已去掉 Markdown 记号。tones：与 texts 对位的主题色键（success / warning / inactive / subtle …），缺省按行色
 *   - end：靠右的短文字（进度、计数）；endTone：它的主题色键
 *   - status：not_started / in_progress / in_review / awaiting_merge / done / void；
 *     tone：状态色调 run / stale / review / merge / sync / done / todo / void，渲染端据此给图标、竖条上色并铺行底色
 *     band：任务树里子孙行的竖条与底色色调（= 最外层父任务的 tone），缺省用 tone；gap：与上一块之间空一行；sep：块内与上一行之间的细缝
 *   - toggle：点了要切换的折叠键（切换 = 在 toggled 里加 / 删）；open：当前是否展开
 *   - href：浏览器链接；warn：警告色；error：错误（诊断里服务端的错误行，画 ✕）；highlight：聚焦的主任务
 *   kind：
 *   - header：title（YUIBoard，项目名不同才跟在后面）、nav（视图按钮：view = 'overview'|'check'|'diag'，active = 当前视图；
 *     需要确认的 texts[1] 是计数，诊断的 texts[1] 是「⚠ 有问题的项数」）、link（在浏览器打开）、stat（总览数字，一行排开，只在总览）
 *   - banners：banner（warn；超过 5 条时第 6 行合成「另有 N 条错误，见诊断」）
 *   - focus（只在总览）：focusHead（标题行：本会话正在做 / 最近做的 · 文档 [· 多久前]）| empty（本会话还没关联到任务）、
 *     focus（主任务：图标、编号、标题，href 常显）、focusLine（状态原因 · 在等）、
 *     focusToggle（另有 N 个关联任务，toggle = 'focus:others'，默认收起）、focusItem（展开后的其余任务，一行一个）、more（另有 N 个）
 *   - body：总览 doc / group / task（href 画在编号上，owner 2026-10-12 晚）；需要确认 checkGroup / checkItem / more（另有 N 条）/ empty；
 *     诊断 diag（level 0 是七项与服务端错误，texts[0] 是项名；level 1 是有问题那项的明细行）；认不出项目时 empty + pick（pick = 项目 id）；读取中 empty
 *   - more：预算放不下时的「其余 N 项在浏览器里看」（kind 'more'，带 href），否则 null
 */
export function paneOf({ summary, projects, projectId, view, toggled = [], focus, url, now, problems = [] }) {
  const entry = projects?.projects?.find((p) => p.id === projectId) ?? null;
  const base = trim(url ?? '');
  const href = (v, key = null, f = null) => `${base}/${hashFor(v, projectId, key, null, f)}`;

  // 项目名与品牌同名（devboard 自己）只写一次
  const name = projectId ? clip(entry?.name ?? projectId, TITLE_MAX) : null;
  const header = [{ key: 'title', kind: 'title', level: 0, texts: name && name.toLowerCase() !== 'yuiboard' ? ['YUIBoard', name] : ['YUIBoard'] }];
  if (projectId) {
    const n = summary ? checkItems(summary, { line: null }).length : null;
    const w = summary ? diagRows(summary, projects, entry, now).filter((r) => r.level === 0 && r.warn).length : 0;
    header.push(
      { key: 'nav:overview', kind: 'nav', level: 0, view: 'overview', active: view === 'overview', texts: [t('总览')] },
      { key: 'nav:check', kind: 'nav', level: 0, view: 'check', active: view === 'check', texts: n == null ? [t('需要确认')] : [t('需要确认'), String(n)], ...(n && { tones: [null, 'warning'] }) },
      { key: 'nav:diag', kind: 'nav', level: 0, view: 'diag', active: view === 'diag', texts: w ? [t('诊断'), `⚠ ${w}`] : [t('诊断')], ...(w && { tones: [null, 'warning'] }) },
    );
  }
  header.push({ key: 'open', kind: 'link', level: 0, texts: [t('在浏览器打开')], href: projectId ? href(view) : `${base}/` });
  if (projectId && summary && view === 'overview') header.push(...statRows(summary));

  const banners = bannerTexts({ summary, projects, entry, problems, now }).map(({ texts, link }, i) =>
    ({ key: `banner:${i}`, kind: 'banner', level: 0, texts: texts.map((s) => clip(s, NOTE_MAX)), warn: true, ...(link && { href: href(view) }) }));

  if (!projectId) {
    const body = projects ? [
      { key: 'pick', kind: 'empty', level: 0, texts: [t('当前目录不在看板的项目里')] },
      ...projects.projects.map((p) => ({ key: `pick:${p.id}`, kind: 'pick', level: 1, pick: p.id, texts: [clip(p.name ?? p.id, TITLE_MAX)] })),
    ] : [];
    return fit({ header, banners, body, href: `${base}/` });
  }
  // 还没有摘要：有问题只出顶栏与横幅，否则显示读取中
  if (!summary) return fit({ header, banners, body: problems.length ? [] : [{ key: 'loading', kind: 'empty', level: 0, texts: [t('正在读取看板…')] }], href: href(view) });

  const ctx = { summary, href, toggled: new Set(toggled), focus: focus ?? { keys: [], recent: false }, lines: entry?.branchLines ?? [] };
  if (view === 'check') return fit({ header, banners, body: checkRows(ctx), href: href('check') });
  if (view === 'diag') return fit({ header, banners, body: diagRows(summary, projects, entry, now), href: href('diag') });
  const { focusHead, focusItems, focusToggle } = focusCard({ ...ctx, now });
  return fit({ header, banners, focusHead, focusItems, focusToggle, body: treeRows(ctx), href: href('overview') });
}

// 总览数字（需求 4.1）：口径即 overallStats，一行排开（owner 2026-10-12 定的面板稿）：进度条、百分比、完成数，
// 再是进行中 / 等待 review / 等待合并 / 停滞 / 待同步（为 0 的不出）与可开工
function statRows(summary) {
  const all = overallStats(summary);
  const filled = all.ratio == null ? 0 : Math.round(all.ratio * BAR);
  const count = (s) => all.counts[s] ? [{ key: `stat:${s}`, kind: 'stat', level: 0, status: s, texts: [`${icon(s)} ${all.counts[s]}`] }] : [];
  return [
    { key: 'stat:progress', kind: 'stat', level: 0, tones: ['success', 'inactive', null, 'subtle'],
      texts: ['▰'.repeat(filled), '▱'.repeat(BAR - filled), all.ratio == null ? '—' : `${Math.floor(all.ratio * 100)}%`, `${all.counts.done}/${all.total}`] },
    ...count('in_progress'), ...count('in_review'), ...count('awaiting_merge'),
    ...(all.stale ? [{ key: 'stat:stale', kind: 'stat', level: 0, warn: true, tones: ['error'], texts: [t`${all.stale} 停滞`] }] : []),
    ...(all.syncPending ? [{ key: 'stat:sync', kind: 'stat', level: 0, warn: true, tones: ['suggestion', 'suggestion'], texts: [t('已合并·待同步到本地'), String(all.syncPending)] }] : []),
    { key: 'stat:ready', kind: 'stat', level: 0, texts: [t('可开工'), String(all.ready)] },
  ];
}

// 横幅（design §7）：本地连接问题 → /api/projects 的错误与警告 → 刷新失败 → 看板降级，与网页 renderPage 同序
function bannerTexts({ summary, projects, entry, problems, now }) {
  const out = problems.flatMap((p) => {
    if (p.kind === 'offline') return [{ texts: [t('连不上 devboard 服务'), p.url, p.message, t`启动命令：${START_CMD}`] }];
    if (p.kind === 'http') return p.messages.length ? p.messages.map((m) => ({ texts: [`HTTP ${p.status}`, tx(m)] })) : [{ texts: [`HTTP ${p.status}`] }];
    return [{ texts: [t('看板摘要超过 4 MiB，mod 读不了，请在浏览器里看')], link: true }];
  });
  const one = (s) => ({ texts: [s] });
  return [...out,
    ...(projects?.errors ?? []).map((e) => one(tx(e.message))),
    ...(entry?.errors ?? []).map((e) => one(tx(e.message))),
    ...(projects?.warnings ?? []).map((w) => one(t`警告：${tx(w)}`)),
    ...(summary && entry?.refreshError ? [one(tx(entry.refreshError))] : []),
    ...(summary ? degradedBanners(summary, now).map(one) : []),
  ];
}

// 聚焦卡片（需求 5.2–5.4，owner 2026-10-12 改）：主任务（keys[0]）占两行：图标、编号、标题；状态原因 · 在等。
// 其余关联任务收进「另有 N 个关联任务」，默认收起（toggle 'focus:others'），展开后一行一个。不读 view.next（owner 已定 4）
function focusCard({ summary, href, focus, toggled, now }) {
  const tasks = new Map(summary.docs.flatMap((d) => d.tasks).map((x) => [x.key, x]));
  const views = new Map(summary.tasks.map((v) => [v.key, v]));
  const keys = focus.keys.filter((k) => tasks.has(k) && views.has(k));
  if (!keys.length) return { focusHead: [{ key: 'focus', kind: 'empty', level: 0, texts: [t('本会话还没关联到任务')] }], focusItems: [], focusToggle: null };
  // 聚焦路径上的正文行（预算里优先保留）：文档、分组、由近到远的祖先，任务行本身由 fit 单独保证
  const pathOf = (k) => {
    const path = focusPath(summary, k);
    return [...path.filter((p) => !p.startsWith('task:')), ...path.filter((p) => p.startsWith('task:')).reverse()];
  };
  const [first, ...rest] = keys;
  const task = tasks.get(first);
  const v = views.get(first);
  const unmet = v.deps?.unmet ?? [];
  const why = [statusWhy(v, task), unmet.length && t`在等：${unmet.map((u) => refLabel(u, task.docId)).join(t('、'))}`].filter(Boolean).join(' · ');
  const main = { key: first, path: pathOf(first), rows: [
    { key: `focus:${first}`, kind: 'focus', level: 1, status: v.status ?? 'void', tone: toneOf(v), highlight: true, href: href('overview', first),
      texts: [icon(v.status), task.number, clip(mdText(task.title), TITLE_MAX)] },
    { key: `focus:${first}:why`, kind: 'focusLine', level: 2, texts: [clip(why, NOTE_MAX)] },
  ] };
  const head = focus.recent
    ? [t('本会话最近做的'), task.docId, focus.at && ago(focus.at, now)].filter(Boolean)
    : [t('本会话正在做'), task.docId];
  const focusHead = [{ key: 'focus', kind: 'focusHead', level: 0, texts: [head.join(' · ')] }];
  if (!rest.length) return { focusHead, focusItems: [main], focusToggle: null };
  const open = toggled.has('focus:others');
  const focusToggle = { key: 'focus:others', kind: 'focusToggle', level: 1, toggle: 'focus:others', open, texts: [t`另有 ${rest.length} 个关联任务`] };
  const others = open ? rest.map((k) => {
    const x = tasks.get(k);
    const s = views.get(k).status;
    return { key: k, path: [], rows: [{ key: `focus:${k}`, kind: 'focusItem', level: 2, status: s ?? 'void', tone: toneOf(views.get(k)), href: href('overview', k),
      texts: [icon(s), x.number, clip(mdText(x.title), TITLE_MAX)] }] };
  }) : [];
  return { focusHead, focusItems: [main, ...others], focusToggle };
}

// 任务树（需求 4.2–4.5）：文档 → 分组 → 任务，顺序同网页。文档、分组默认只展开聚焦路径；父任务同网页默认展开
// （owner 2026-10-10 定的「父任务可折叠子任务，默认展开」）。toggled 是与默认相反的键
function treeRows({ summary, href, toggled, focus, lines }) {
  // 只有主任务（keys[0]）的路径默认展开、在树里标出（owner 2026-10-12）
  const primary = focus.keys[0];
  const defaults = new Set(primary ? focusPath(summary, primary) : []);
  const isOpen = (key) => (key.startsWith('task:') || defaults.has(key)) !== toggled.has(key);
  const views = new Map(summary.tasks.map((v) => [v.key, v]));
  const stats = new Map(summary.stats.docs.map((d) => [d.docId, d]));
  const progress = (st) => (st?.total ? `${st.counts.done}/${st.total}` : null);
  const rows = [];
  for (const doc of summary.docs.filter((d) => !d.archived)) {
    const st = stats.get(doc.docId);
    const key = `doc:${doc.docId}`;
    // 分支线名只在项目有多条线时标（owner 2026-10-12）
    const line = lines.length > 1 ? (lines.find((l) => l.id === docLine(doc, lines))?.name ?? t('未归类分支线')) : null;
    // 没有任务的文档（无任务 ADR、规划中）没东西可折叠，同网页不画折叠按钮
    const open = doc.tasks.length > 0 && isOpen(key);
    const done = st?.total && st.counts.done === st.total;
    rows.push({ key, kind: 'doc', level: 0, texts: [doc.docId, line].filter(Boolean), ...(line && { tones: [null, 'subtle'] }),
      ...(progress(st) && { end: progress(st), ...(done && { endTone: 'success' }) }), ...(doc.tasks.length && { toggle: key, open }) });
    if (!open) continue;
    const byKey = new Map(doc.tasks.map((x) => [x.key, x]));
    const parents = new Set(doc.tasks.map((x) => x.parentKey).filter(Boolean));
    // 祖先任务有一个收起，该行就不出现；层级 = 分组层 + 祖先数
    // ponytail: 每行沿 parentKey 往上走一遍，O(任务数 × 深度)；实物深度不超过 3，千级深链才需要按文档顺序缓存祖先状态
    const taskRows = (list, level) => list.flatMap((task) => {
      let depth = 0;
      let root = null;
      for (let p = byKey.get(task.parentKey); p; root = p, p = byKey.get(p.parentKey), depth++) if (!isOpen(`task:${p.key}`)) return [];
      const v = views.get(task.key);
      const tkey = `task:${task.key}`;
      // 展开的子孙沿用最外层父任务的竖条与底色，连成一块（owner 2026-10-12）；图标、标题仍按自己的状态
      return [{ key: tkey, kind: 'task', level: level + depth, status: v?.status ?? 'void', tone: toneOf(v), href: href('overview', task.key),
        ...(root && { band: toneOf(views.get(root.key)) }),
        texts: [icon(v?.status), task.number, clip(mdText(task.title), TITLE_MAX)],
        ...(parents.has(task.key) && { toggle: tkey, open: isOpen(tkey) }), ...(task.key === primary && { highlight: true }) }];
    });
    // 分隔（面板稿 v2，owner 2026-10-12 晚）：最外层任务（没有 band）连同它展开的子孙算一块。块与块之间空一行（gap），
    // 只在前后两块都铺了底色时隔开，否则底色本身就分得开，不多占行；块内各行之间一条比它窄的细缝（sep）
    const apart = (list) => list.map((r, i) => (i === 0 ? r
      : r.band ? { ...r, sep: true }
      : tinted(r) && tinted(list[i - 1]) ? { ...r, gap: true } : r));
    // 第一个分组标题之前的任务不属于任何分组，直接挂在文档下
    rows.push(...apart(taskRows(doc.tasks.filter((x) => !x.groupId), 1)));
    for (const g of doc.groups) {
      const list = doc.tasks.filter((x) => x.groupId === g.id);
      if (!list.length) continue;
      const gkey = `grp:${doc.docId}/${g.id}`;
      const gopen = isOpen(gkey);
      const gp = progress(st?.groups.find((x) => x.groupId === g.id));
      rows.push({ key: gkey, kind: 'group', level: 1, texts: [clip(mdText(g.title), TITLE_MAX)], ...(gp && { end: gp }), toggle: gkey, open: gopen });
      if (gopen) rows.push(...apart(taskRows(list, 2)));
    }
  }
  return rows.length ? rows : [{ key: 'empty', kind: 'empty', level: 0, texts: [t('没有可显示的规划文档')] }];
}

// 需要确认（需求 6）：checkItems 按 CONFLICT_TEXT 顺序分组；c 默认折叠；每组最多 30 条
function checkRows({ summary, href, toggled }) {
  const all = checkItems(summary, { line: null });
  if (!all.length) return [{ key: 'check:empty', kind: 'empty', level: 0, texts: [t('没有需要确认的事项。')] }];
  const tasks = new Map(summary.docs.flatMap((d) => d.tasks).map((x) => [x.key, x]));
  const prs = new Set(summary.prs.map((p) => p.number));
  const sessions = new Map((summary.sessions ?? []).map((s) => [s.id, s]));
  const views = new Map(summary.tasks.map((v) => [v.key, v]));
  const rows = [];
  for (const type of Object.keys(CONFLICT_TEXT)) {
    const items = all.filter((c) => c.type === type);
    if (!items.length) continue;
    const key = `check:${type}`;
    const open = (type !== 'c') !== toggled.has(key);
    const name = t(CONFLICT_TEXT[type]);
    rows.push({ key, kind: 'checkGroup', level: 0, texts: [name], end: String(items.length), toggle: key, open });
    if (!open) continue;
    items.slice(0, CHECK_MAX).forEach((c, i) => {
      // 对象优先是任务，其次 PR，再次会话（同网页 checkBox）；会话没有详情页，不给链接
      const task = c.type !== 'j' && c.taskKey ? tasks.get(c.taskKey) : null;
      const target = task ? task.key : c.pr != null && prs.has(c.pr) ? `#${c.pr}` : null;
      // 一行：图标、编号、对象 · 差在哪里（owner 2026-10-12 定的面板稿）；出处文件与行号在浏览器里看
      const detail = clip(tx(c.detail), NOTE_MAX);
      const s = task ? views.get(task.key)?.status : null;
      const texts = task ? [icon(s), task.number, `${clip(mdText(task.title), TITLE_MAX)} · ${detail}`]
        : c.pr != null ? ['#', String(c.pr), detail]
        : ['◇', `${t`会话 ${clip(sessions.get(c.sessionId)?.title ?? c.sessionId, TITLE_MAX)}`} · ${detail}`];
      rows.push({ key: `${key}:${i}`, kind: 'checkItem', level: 1, ...(target && { href: href('check', target) }),
        ...(task ? { status: s ?? 'void', tone: toneOf(views.get(task.key)) } : { tones: ['subtle'] }), texts });
    });
    if (items.length > CHECK_MAX) {
      rows.push({ key: `${key}:more`, kind: 'more', level: 1, texts: [t`另有 ${items.length - CHECK_MAX} 条，在浏览器里看`], href: href('check', null, { checkType: type }) });
    }
  }
  return rows;
}

// 诊断（需求 7）：服务端错误 + 七项概要，措辞同网页 renderDiag（去掉「可展开」），不列逐条明细
function diagRows(summary, projects, entry, now) {
  const d = summary.diagnostics ?? {};
  const rows = [];
  [...(projects?.errors ?? []).map((e) => tx(e.message)), ...(entry?.errors ?? []).map((e) => tx(e.message)),
    ...(projects?.warnings ?? []).map((w) => t`警告：${tx(w)}`), ...(entry?.refreshError ? [tx(entry.refreshError)] : [])]
    .forEach((s, i) => rows.push({ key: `diag:server:${i}`, kind: 'diag', level: 0, texts: ['', clip(s, NOTE_MAX)], warn: true, error: true }));
  // subs = [文字, 是否警告]；明细有警告时概要行也标警告。每项一行，只列有问题的明细（owner 2026-10-12 定的面板稿），
  // 没警告明细的项把明细并进概要行
  const item = (id, label, texts, subs = [], warn = false) => {
    const bad = subs.filter(([, w]) => w);
    const summaryText = [...texts, ...(bad.length ? [] : subs.map(([s]) => s))].join(' | ');
    rows.push({ key: `diag:${id}`, kind: 'diag', level: 0, texts: [label, clip(summaryText, NOTE_MAX)].filter(Boolean), warn: warn || bad.length > 0 });
    bad.forEach(([s], i) => rows.push({ key: `diag:${id}:${i}`, kind: 'diag', level: 1, texts: [clip(s, NOTE_MAX)], warn: true }));
  };

  const c = d.config;
  item('config', t('配置'), [c ? t`${c.path.split(/[\\/]/).pop()} 已加载 · 项目 ${c.projects} 个` : t('未知')], (c?.warnings ?? []).map((w) => [t`警告：${tx(w)}`, true]));

  const ws = summary.workspaces ?? [];
  item('workspaces', t('工作区'), ws.length ? [] : [t('未读取')], ws.map((w) => {
    const branch = w.detached ? t('（分离 HEAD）') : (w.branch ?? t('未知分支'));
    const head = `${w.path.split(/[\\/]/).filter(Boolean).pop()} · ${branch} @ ${w.commit ? w.commit.slice(0, 8) : t('未知')}`;
    return [w.error ? head + t` · 读取失败：${tx(w.error)}` : head, !!w.error];
  }));

  const specs = summary.docs.filter((x) => x.kind !== 'adr');
  const bad = specs.filter((x) => docHasIssues(x.parse)).length;
  const adrBad = summary.docs.filter((x) => x.kind === 'adr' && docHasIssues(x.parse)).length;
  item('docs', t('文档'), [[
    t`${specs.length} 份规划文档${bad ? t`（${bad} 份有解析问题）` : ''}`,
    t`${summary.docs.length - specs.length} 篇 ADR${adrBad ? t`（${adrBad} 篇有诊断）` : ''}`,
    t`Mermaid 依赖图已启用 ${summary.docs.filter((x) => x.parse.mermaidUsed).length} 份`,
  ].join(' · ')], (d.sources ?? []).map((s) => [tx(s.message), true]), bad + adrBad > 0);

  const conv = d.convention ?? [];
  const counts = Object.entries(RULE_TEXT).map(([r, name]) => [t(name), conv.filter((x) => String(x.rule) === r).length])
    .filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(' · ');
  item('convention', t('不满足约定'), [conv.length ? t`${conv.length} 处（${counts}）` : t('没有发现')], [], conv.length > 0);

  const unlinked = summary.prs.filter((p) => !p.tasks?.length).length;
  item('prs', t('未关联 PR'), [summary.degraded.noPrData ? t('未包含 PR 信息（还没成功读到 GitHub）') : unlinked ? t`${unlinked} 个 PR 没关联到任务` : t('没有')],
    [], summary.degraded.noPrData);

  const sources = d.sessionSources ?? [];
  if (!sources.length) {
    item('sessions', t('AI 会话'), [summary.degraded.noSessionData ? t('没有配置会话来源（页面不含 AI 会话信息）') : t('正在读取…')], [], summary.degraded.noSessionData);
  } else {
    const n = d.sessions;
    const unreadable = sources.reduce((k, s) => k + s.unreadableFiles.length + s.brokenLines.length, 0);
    item('sessions', t('AI 会话'), n ? [t`识别出任务的会话 ${n.linked} 个 · 识别不出任务的 ${n.unlinked} 个 · 只在 AI 回复里被提到的 ${n.aiOnlyMentions} 次（不计）`] : [], [
      ...sources.flatMap((s) => [
        [t`${SESSION_SOURCE_TEXT[s.source] ?? s.source}：${s.dir ?? t('未知目录')} · ` + (s.available ? t`${s.sessions} 个会话` : t`不可用：${tx(s.error)}`), !s.available],
        ...s.messages.map((m) => [tx(m), true]),
      ]),
      ...(unreadable ? [[t`读不懂的文件 ${unreadable} 个`, true]] : []),
      ...(summary.degraded.noSessionData ? [[t('会话来源全部不可用：「进行中」只按文档标记判定'), true]] : []),
    ]);
  }

  const g = summary.freshness?.github ?? {};
  const run = d.github;
  if (g.state === 'off') item('github', 'GitHub', [t('未配置：本项目没有 repo.github，不读取 PR')]);
  else {
    item('github', 'GitHub', [[
      g.error ? tx(g.message) : g.lastSuccessAt ? t('gh 已登录') : t('还没有成功读取过'),
      run ? t`最近请求 ${ago(run.at, now)} · 本轮 ${run.requests} 次请求` : t('本次启动后还没请求过'),
      g.rate ? t`剩余额度 ${g.rate.remaining} / ${g.rate.limit}` : t('剩余额度未知'),
      g.error && g.lastSuccessAt && t`最近成功 ${ago(g.lastSuccessAt, now)}`,
      g.pausedUntil && t`暂停到 ${new Date(g.pausedUntil).toLocaleString(HTML_LANG[getLang()])}`,
    ].filter(Boolean).join(' · ')], [
      ...(g.detail ? [[tx(g.detail), false]] : []),
      ...(g.scopeHint ? [[t`权限提示：${tx(g.scopeHint)}`, true]] : []),
    ], !!g.error);
  }
  return rows;
}

/**
 * 文字预算（design §4.2）。总量 = 全部行 rowCost 之和（文字、key、链接地址），保证 ≤ budget：
 * 1. 顶栏 + 横幅（最多 5 条，其余合成一条）；末尾提示行先预留 200 字加它的链接地址；
 * 2. 聚焦卡片：主任务必放，其后「另有 N 个关联任务」；展开时其余任务最多 9 个（连主任务共 10），连同各自在正文里的任务行
 *    一起放，1–3 合计超过预算三分之二就停，其余写「另有 N 个」；
 * 3. 列出的聚焦任务在正文里的路径行（文档、分组、由近到远的祖先），放得下的都保留；
 * 4. 其余正文按顺序整行放，放不下就停，末尾加「其余 N 项在浏览器里看」（href）。
 * @param {{ header: Row[], banners: Row[], focusHead?: Row[], focusItems?: {key:string, rows: Row[], path: string[]}[], body: Row[], href: string }} parts
 * @param {number} [budget]
 */
export function fit({ header, banners, focusHead = [], focusItems = [], focusToggle = null, body, href }, budget = TEXT_BUDGET) {
  const shownBanners = banners.length > BANNERS_MAX
    ? [...banners.slice(0, BANNERS_MAX), { key: 'banner:more', kind: 'banner', level: 0, warn: true, texts: [t`另有 ${banners.length - BANNERS_MAX} 条错误，见诊断`] }]
    : banners;
  const moreFocus = (n) => ({ key: 'focus:more', kind: 'more', level: 1, texts: [t`另有 ${n} 个`] });
  const cap = (budget * 2) / 3;
  // 「另有 N 个」按最大可能的 N 预留
  let used = MORE_RESERVE + href.length + size(header) + size(shownBanners) + size(focusHead) + (focusToggle ? size([focusToggle]) : 0)
    + (focusItems.length > 1 ? size([moreFocus(focusItems.length)]) : 0);
  const rowOf = new Map(body.map((r) => [r.key, r]));
  const pinned = new Set();
  const listed = [];
  for (const it of focusItems.slice(0, FOCUS_MAX)) {
    const own = rowOf.get(`task:${it.key}`);
    const cost = size(it.rows) + (own ? size([own]) : 0);
    if (listed.length && used + cost > cap) break;
    used += cost;
    listed.push(it);
    if (own) pinned.add(own.key);
  }
  for (const key of listed.flatMap((it) => it.path)) {
    const r = rowOf.get(key);
    if (!r || pinned.has(key) || used + size([r]) > cap) continue;
    used += size([r]);
    pinned.add(key);
  }
  const kept = new Set(pinned);
  let omitted = 0;
  for (const r of body) {
    if (pinned.has(r.key)) continue;
    if (!omitted && used + size([r]) <= budget) { used += size([r]); kept.add(r.key); } else omitted++;
  }
  return {
    header,
    banners: shownBanners,
    focus: [...focusHead, ...listed.slice(0, 1).flatMap((it) => it.rows), ...(focusToggle ? [focusToggle] : []), ...listed.slice(1).flatMap((it) => it.rows),
      ...(focusItems.length > listed.length ? [moreFocus(focusItems.length - listed.length)] : [])],
    body: body.filter((r) => kept.has(r.key)),
    more: omitted ? { key: 'more', kind: 'more', level: 0, texts: [t`其余 ${omitted} 项在浏览器里看`], href } : null,
  };
}
