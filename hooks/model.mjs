// N25 Claude Code mod 的纯逻辑（design §4）：输入纯数据、输出纯数据，不 import claude-code。
// mod 环境没有 Node：这里只可 import web/ 与 src/ 里不依赖 Node 内置模块的纯 JS。

import { t, tx, getLang } from '../web/i18n.mjs';
import {
  STATUS_UI, CONFLICT_TEXT, RULE_TEXT, SESSION_SOURCE_TEXT, HTML_LANG,
  hashFor, refLabel, overallStats, checkItems, statusWhy, docLine, degradedBanners, docHasIssues, ago,
  prKind, shortList, lineName, waited, day,
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
 * 关联里有运行中且没完成的 → 全部列出，按下面的 rank 排，keys[0] 是卡片上展开的主任务；
 * 否则取 rank 最前的一个，recent: true；这时关联的任务全都完成或作废，再标 idle: true（N32）。at = 主任务的 lastAt。
 */
export function focusOf(summary, sessionId) {
  const links = new Map();
  for (const v of summary.tasks) {
    const l = v.sessions?.find((s) => s.sessionId === sessionId);
    if (l) links.set(v.key, { ...l, status: v.status });
  }
  const tasks = summary.docs.filter((d) => !d.archived).flatMap((d) => d.tasks);
  const parents = new Set(tasks.map((t) => t.parentKey).filter(Boolean));
  const linked = tasks.filter((t) => links.has(t.key)).map((t) => ({ key: t.key, checkbox: t.checkbox, ...links.get(t.key) }));
  // 先看最近一次直接点到它的时间（evidenceAt，N32）：续活动会让早先点名的任务和后来真正在做的任务 lastAt 一样晚，
  // 只看 lastAt 时早点名的胜出（2026-10-16 实测：全部做完后仍显示 N9）。时间写法不统一（有无毫秒），按时间比。
  // 再看 lastAt；同一时刻（一个 PR 连上的几十个任务时间都一样）依次看：点到过的（named）在前、
  // 没勾选的在前、没有子任务的在前（具体的那一步比笼统的父任务有用），再按文档顺序（owner 2026-10-12 定；
  // 原先只按文档顺序，开发 PR 的会话总是落到第一个、早已完成的任务）
  const time = (x) => Date.parse(x) || 0;
  const rank = (l, i) => [-time(l.evidenceAt ?? l.lastAt), -time(l.lastAt), l.named ? 0 : 1, l.checkbox === 'open' ? 0 : 1, parents.has(l.key) ? 1 : 0, i];
  const byRank = (a, b) => a[0].reduce((d, x, j) => d || x - b[0][j], 0);
  const latest = (list) => list.map((l, i) => [rank(l, i), l]).sort(byRank).map((r) => r[1]);
  // 已完成、作废的任务不算「正在做」（N32）：会话做完以后还在续活动，别一直写「正在做」一个早已完成的任务
  const finished = (l) => !l.status || l.status === 'done';
  const running = latest(linked.filter((l) => l.activity === 'running' && !finished(l)));
  if (running.length) return { keys: running.map((l) => l.key), recent: false, at: running[0].lastAt ?? null };
  if (!linked.length) return { keys: [], recent: false, at: null };
  const [last] = latest(linked);
  return { keys: [last.key], recent: true, at: last.lastAt ?? null, ...(linked.every(finished) && { idle: true }) };
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

/**
 * 当前选中的分支线（N34，owner 已定 22），null = 全部。手动选的优先（choice：{ line: 线 id }，{ line: null } = 全部，null = 没选过；不用字符串当「全部」，线 id 可以就叫 all）；
 * 没选过看会话所在工作区：摘要 workspaces[] 里包含 cwd 的最深一个，id 等于某条线的 id 就选它（配了 workspace 的线）；
 * 主工作区（workspaces[0]，含它下面的 worktree）对应 base 为 main 的线；都不中是全部。不按 id 认主工作区：线 id 也可以叫 repo。
 * 单线项目、还没拿到摘要时不筛选。
 */
export function activeLine(choice, summary, lines, cwd) {
  if (!summary || lines.length < 2 || choice?.line === null) return null;
  if (lines.some((l) => l.id === choice?.line)) return choice.line;
  if (!cwd) return null;
  const here = trim(cwd);
  const list = summary.workspaces ?? [];
  const [ws] = list.filter((w) => w.path && !w.ref && within(here, trim(w.path))).sort((a, b) => b.path.length - a.path.length);
  if (!ws) return null;
  return lines.find(ws === list[0] ? (l) => l.base === 'main' : (l) => l.id === ws.id)?.id ?? null;
}

// 只看一条线的摘要，口径同网页 lineBoard：文档按 docLine，PR 按 branchLine；overallStats、checkItems 吃它就是筛选后的数。
// tasks、conflicts 不动（由 docs 与 checkItems 的 line 筛）。浅拷贝，聚焦卡片仍用原摘要
const lineSummary = (summary, line, lines) => (line
  ? { ...summary, docs: summary.docs.filter((d) => docLine(d, lines) === line), prs: (summary.prs ?? []).filter((p) => p.branchLine === line) }
  : summary);

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
// 状态图标：颜色由渲染端按 status 上
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
// 任务行的状态文字（N31，owner 2026-10-15）：写在圆圈右边、编号前面，按行的色调分档，与颜色一一对应。
// 与 STATUS_UI 同法：模块加载时按中文求值，显示时再套 t()
const WORD = { run: t('进行中'), stale: t('停滞中'), review: t('等待 review'), merge: t('等待合并'), sync: t('待同步'),
  done: t('完成'), todo: t('未开始'), void: t('作废') };
const mark = (v) => `${icon(v?.status)} ${t(WORD[toneOf(v)])}`;
const size = (rows) => rows.reduce((n, r) => n + rowCost(r), 0);
// 分隔（面板稿 v2，owner 2026-10-12 晚）：最外层的行（没有 band）连同它下面带 band 的行算一块。块与块之间空一行（gap），
// 只在前后两块都铺了底色时隔开，否则底色本身就分得开，不多占行；块内各行之间一条比它窄的细缝（sep）
const apart = (list) => list.map((r, i) => (i === 0 ? r
  : r.band ? { ...r, sep: true }
  : tinted(r) && tinted(list[i - 1]) ? { ...r, gap: true } : r));

// ---- PR（N33，owner 已定 21） ----
// 分组口径同网页「等我处理」（engine waitingList）：prKind → 行的色调；关闭未合并的不列
const PR_TONE = { draft: 'review', ready: 'merge', unsynced: 'sync', merged: 'done' };
const PR_STATUS = { review: 'in_review', merge: 'awaiting_merge', sync: 'awaiting_merge', done: 'done' };
const PR_ORDER = ['review', 'merge', 'sync', 'done'];
const PR_DONE_MAX = 3;
const prMark = (tone) => `${STATUS_UI[PR_STATUS[tone]].icon} ${t(WORD[tone])}`;
// 等了多久，起点同 waitingList：draft 看创建，ready 看转 ready，已合并看合并
const prSince = (p, tone) => (tone === 'review' ? p.createdAt : tone === 'merge' ? p.readyAt ?? p.createdAt : p.mergedAt);
function prWait(p, tone, now) {
  const w = waited(now - Date.parse(prSince(p, tone)));
  return tone === 'review' ? t`draft ${w}` : tone === 'merge' ? t`ready ${w}` : tone === 'sync' ? t`已合并 ${w}，本地还没 pull` : t`合并于 ${day(p.mergedAt)}`;
}
/**
 * 摘要里的 PR 分成等待 review、等待合并（含待同步）、完成（最近 recentClosedPrDays 天合并的，默认同网页 14）。
 * 等待的两组按分支线配置顺序、再按等得久的在前（同 waitingList）；完成按合并时间从新到旧。
 */
function prGroups(summary, lines, now) {
  const days = summary.recentClosedPrDays ?? 14;
  const groups = { review: [], merge: [], done: [] };
  for (const p of summary.prs ?? []) {
    const tone = PR_TONE[prKind(p)];
    if (!tone) continue;
    if (tone !== 'done') groups[tone === 'sync' ? 'merge' : tone].push({ p, tone });
    else if (now - Date.parse(p.mergedAt) <= days * 864e5) groups.done.push({ p, tone });
  }
  const rank = (id) => { const i = lines.findIndex((l) => l.id === id); return i < 0 ? lines.length : i; };
  const time = (x) => Date.parse(prSince(x.p, x.tone));
  for (const k of ['review', 'merge']) groups[k].sort((a, b) => rank(a.p.branchLine) - rank(b.p.branchLine) || time(a) - time(b));
  groups.done.sort((a, b) => time(b) - time(a));
  return { groups, days };
}
// 未接 GitHub 的项目（N28）不显示 PR 视图与导航
const hasGithub = (summary) => !!summary && summary.freshness?.github?.state !== 'off';

/**
 * 一行画出来后计入引擎 100,000 字上限的字符数（design §4.2），hooks/register.tsx 照此渲染：
 * 文字（每段另加 1，抵段间空格）+ 行尾文字 end + 行 Box 的 key + 折叠按钮（key 即折叠键，标签 ▾ / ▸ 一字）
 * + 视图按钮 `go:<view>` / 项目按钮 `use:<id>` / 分支线按钮 `line:<id>`（全部是 `line`）的 key + 链接地址与标签符号（整行链接加「 ↗」、行尾链接「↗」；
 * 渲染端把 127.0.0.1 / [::1] 改写成 localhost，地址最多长 4 字，一并算进固定的 6）。
 * @param {{ key: string, texts: string[], toggle?: string, view?: string, pick?: string, choose?: string|null, href?: string }} row
 * @returns {number}
 */
export const lineButton = (id) => (id === null ? 'line' : `line:${id}`);
export const rowCost = (row) => row.texts.reduce((n, s) => n + (s?.length ?? 0) + 1, 0) + row.key.length
  + (row.end ? row.end.length + 1 : 0)
  + (row.toggle ? row.toggle.length + 1 : 0)
  + (row.view ? `go:${row.view}`.length : 0)
  + (row.pick ? `use:${row.pick}`.length : 0)
  + (row.choose === undefined ? 0 : lineButton(row.choose).length)
  + (row.href ? row.href.length + 6 : 0);

/**
 * `/yuiboard` 命令执行后回给用户的一行字（已翻译）。
 * @returns {string}
 */
export const commandText = () => t('已打开 YUIBoard 面板');

/** 各语言的完整约定文件（插件根目录下，AI 可直接读） */
const CONVENTION_FILE = { zh: 'CONVENTION.zh-CN.md', ja: 'CONVENTION.ja.md', en: 'CONVENTION.md' };

/**
 * 注入系统提示的约定摘要（N27 需求 1）：精简到约 1,500 字，内容固定，同一会话内不变（不反复打破提示缓存）。
 * 与 CONVENTION 三语末尾那段可贴进 AGENTS.md 的片段同内容（test/convention.test.mjs 比对）。调用方先 setLang()。
 * @param {{ name: string, docSources?: { type: string, path: string|null, files?: string[] }[] }} project /api/projects 的一项
 * @param {string} root 插件根目录（$.plugin.root）
 * @returns {string}
 */
export function conventionBrief(project, root) {
  const docs = (project.docSources ?? []).flatMap((s) => (s.type === 'task-list' ? s.files ?? []
    : s.type === 'spec-dir' ? [`${s.path}/*/tasks.md`] : s.type === 'adr-dir' || s.type === 'md-dir' ? [`${s.path}/*.md`] : []));
  return [
    t`本项目「${project.name}」已接入 YUIBoard（本机进度看板），它按约定读取任务文档与 PR 标题；不合约定的写入会被 YUIBoard 的钩子拦下。任务文档：${docs.join(', ')}。`,
    ...conventionRules(),
    t`完整约定：${conventionFile(root)}`,
  ].join('\n');
}

/**
 * CONVENTION 三语末尾那段可贴进被看仓库 AGENTS.md / CLAUDE.md 的片段（N27 需求 5.2）：Codex 等没有插件拦截的工具靠它。
 * 与 conventionBrief 同一组要点；test/convention.test.mjs 逐语言比对文档里的代码块与这里的输出。调用方先 setLang()。
 */
export const conventionSnippet = () => [
  t('本仓库的任务文档与 PR 标题由 YUIBoard（本机进度看板）按约定读取，写的时候照下面写：'),
  ...conventionRules(),
  t`完整约定：${`https://github.com/funnysubaru/yuiboard/blob/main/${CONVENTION_FILE[getLang()] ?? CONVENTION_FILE.en}`}`,
].join('\n');

/** 当前界面语言的完整约定文件路径 */
const conventionFile = (root) => `${root.replace(/\/+$/, '')}/${CONVENTION_FILE[getLang()] ?? CONVENTION_FILE.en}`;

/** 拦截说明最多列几条；其余写「另有 N 处」 */
const GUARD_SHOWN = 10;

/**
 * 写任务文档被拦时给 AI 的说明（N27 需求 2.4）：哪一行、什么问题、建议怎么写。调用方先 setLang()。
 * @param {string} file
 * @param {{ line: number, text: string, detail: string }[]} issues guard.mjs docIssues 的结果（detail 是服务端口径的中文原文）
 * @param {string} root 插件根目录
 */
export function guardDocText(file, issues, root) {
  return [
    t`YUIBoard：这次写入会给 ${file} 带进 ${issues.length} 处不合约定的写法，已拦下。按下面的说明改好后再写：`,
    ...issues.slice(0, GUARD_SHOWN).map((x) => t`- 第 ${x.line} 行「${x.text}」：${tx(x.detail)}`),
    ...(issues.length > GUARD_SHOWN ? [t`另有 ${issues.length - GUARD_SHOWN} 处，改完上面的再看`] : []),
    // 原样没动的行也冒出问题：是新写的内容改变了它们的读法，该改的是新写的部分
    ...(issues.some((x) => x.untouched) ? [t('其中有的行这次没改，是新写的内容改变了它们的读法（例如在没有任务行的小节或标题式任务文档里加了「- [ ]」任务行）：请调整新写的部分（放进任务所在的小节、沿用文档原有的写法），不要去改原有的行；拿不准就先问用户。')] : []),
    t`只拦这次新写进去的问题，文档里原有的不拦。约定见 ${conventionFile(root)}`,
  ].join('\n');
}

/**
 * PR 标题被拦时给 AI 的说明（N27 需求 2.4）。
 * @param {string} title
 * @param {string[]} issues guard.mjs titleIssues 的结果
 * @param {string} root 插件根目录
 */
export function guardTitleText(title, issues, root) {
  return [
    t`YUIBoard：PR 标题「${title}」里有认不了的任务引用，命令已拦下。改好标题后再执行：`,
    ...issues.slice(0, GUARD_SHOWN).map((d) => `- ${tx(d)}`),
    t`这个 PR 不对应任何任务时，去掉标题里像任务引用的写法即可。约定见 ${conventionFile(root)}`,
  ].join('\n');
}

/**
 * 提交标题、新建分支名、派活说明里写明文档名或代号却对不上文档时给 AI 的说明（N35）。
 * @param {string} where guard.mjs REF_WHERE 的一项
 * @param {string[]} issues guard.mjs refProblems 的 deny
 * @param {string} root 插件根目录
 */
export function guardRefText(where, issues, root) {
  return [
    t`YUIBoard：这条${tx(where)}里有对不上文档的任务引用，已拦下。先看文档确认真实编号，改好后再执行：`,
    ...issues.slice(0, GUARD_SHOWN).map((d) => `- ${tx(d)}`),
    t`编号确实属于别的项目时换个写法（派活说明里可放进行内代码）。约定见 ${conventionFile(root)}`,
  ].join('\n');
}

/** 裸数字对不上文档时的提示（N35）：不拦，随工具结果一起给 AI。@param {string[]} hints guard.mjs refProblems 的 hint */
export const guardHintText = (hints) => [
  t('YUIBoard：下面的编号在本项目的文档里找不到。如果是本项目的任务，先看文档核对；只用文档里真实存在的编号：'),
  ...hints.slice(0, GUARD_SHOWN).map((d) => `- ${tx(d)}`),
].join('\n');

/** 约定要点，一行一条（conventionBrief 与 CONVENTION 片段共用） */
export const conventionRules = () => [
  t('- 任务行：`- [ ] 编号 标题`；完成写 `[x]`，进行中可写 `[~]`，不用其它复选框；作废写成 `- [x] ~~6 旧方案~~ **【作废 2026-09-01】** 原因`；子任务编号写 `1.1`（父子看编号，不看缩进）。不要用 `### 任务 1：` 这类标题代替任务行。'),
  t('- 分组：`### 里程碑 M1：说明`，代号在文档内唯一。'),
  t('- 依赖：写在任务标题末尾的括号里，如 `（依赖 1、2.1）`、`（依赖 2.1–2.4）`、`（依赖 M1）`、`（依赖 other-spec#3）`。'),
  t('- PR 标题：交付了哪些任务就写进标题，写 `任务 3`、`任务 3.1–3.4` 或里程碑代号；多份文档编号重复时写 `<文档名>#<编号>`；裸数字不算引用。只做了一部分写 `任务 13（部分）`。ADR 简称 `ADR-0033#64` 只在只有一篇 ADR-0033 时可用，否则写完整文档名。'),
  t('- 任务编号：提到任务编号前先看文档，只用文档里真实存在的编号；不确定就先查，不要凭记忆或推测写。'),
  t('- 任务正文的 Markdown 只用列表、复选框、代码块、引用、表格、加粗、斜体、删除线、行内代码、链接；不要用标题、分隔线、图片、脚注、HTML 标签。'),
];

/**
 * 整个面板的内容（design §4、§6）：纯数据进、纯数据出，文字都已翻译、已截断，总量已按 TEXT_BUDGET 裁剪。
 * 调用方先 setLang()。
 *
 * @param {object} input
 * @param {object|null} input.summary   当前项目的摘要（GET /api/projects/:id/summary），还没拿到为 null
 * @param {object|null} input.projects  GET /api/projects 的响应 { errors, warnings, projects:[{ id, name, branchLines, errors, refreshError }] }
 * @param {string|null} input.projectId 认出 / 手动选的项目
 * @param {'overview'|'pr'|'check'|'diag'} input.view   'pr' 在未接 GitHub 的项目（或还没拿到摘要）时按总览画
 * @param {{line:string|null}|null} [input.lineChoice] 本会话手动选的分支线，null = 没选过（见 activeLine）
 * @param {string|null} [input.cwd]     会话当前目录，算默认选中的分支线
 * @param {string[]} input.toggled      与默认相反的折叠键（doc:<docId>、grp:<docId>/<分组>、task:<任务键>、check:<类型>、pr:<review|merge|done>）
 * @param {{keys:string[], recent:boolean, idle?:boolean}|null} input.focus  focusOf 的结果
 * @param {string} input.url            服务地址，如 http://127.0.0.1:4317
 * @param {number} input.now            毫秒时间戳
 * @param {Array<{kind:'offline',url:string,message:string}|{kind:'http',status:number,messages:string[]}|{kind:'oversize'}>} input.problems
 *
 * @returns {{ header: Row[], banners: Row[], focus: Row[], body: Row[], more: Row|null }}
 *   Row = { key, kind, level, texts, tones?, end?, endTone?, status?, tone?, band?, gap?, sep?, toggle?, open?, href?, warn?, error?, highlight?, view?, active?, pick?, choose? }
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
 *   - header：title（YUIBoard，项目名不同才跟在后面）、nav（视图按钮：view = 'overview'|'pr'|'check'|'diag'，active = 当前视图；
 *     texts[0] 是视图名，其后各段是计数：PR 是「◑ 等待 review 数」「◕ 等待合并数」（为 0 的不出，未接 GitHub 不出整个按钮），
 *     需要确认是计数，诊断是「⚠ 有问题的项数」）、link（在浏览器打开）、stat（总览数字，一行排开，只在总览）、
 *     line（分支线切换行，多条线且有摘要时才有：choose = 线 id，「全部」是 null，active = 选中；数字、任务树、PR、需要确认都按选中的线，聚焦卡片、诊断不筛选）
 *   - banners：banner（warn；超过 5 条时第 6 行合成「另有 N 条错误，见诊断」）
 *   - focus（只在总览）：focusHead（标题行：本会话正在做 / 最近做的 / 当前没有进行中的任务 · 最近做的 · 文档 [· 多久前]）| empty（本会话还没关联到任务）、
 *     focus（主任务：图标、编号、标题，href 常显）、focusLine（状态原因 · 在等）、
 *     focusPr（主任务的关联 PR，最多 2 个：texts = [#号, 状态圆圈与文字, 等了多久]，href = GitHub，status / tone 同 PR 行）、
 *     focusToggle（另有 N 个关联任务，toggle = 'focus:others'，默认收起）、focusItem（展开后的其余任务，一行一个）、more（另有 N 个）
 *   - body：总览 doc / group / task（href 画在编号上，owner 2026-10-12 晚）；需要确认 checkGroup / checkItem / more（另有 N 条）/ empty；
 *     PR prGroup（等待 review / 等待合并 / 完成，end 是个数，toggle = pr:<组>）/ prItem（[状态圆圈与文字, #号, 标题]，href = GitHub）/
 *     prLine（灰字：分支线 · 关联任务 · 等了多久，band = 上一行的 tone）/ more / empty；
 *     诊断 diag（level 0 是七项与服务端错误，texts[0] 是项名；level 1 是有问题那项的明细行）；认不出项目时 empty + pick（pick = 项目 id）；读取中 empty
 *   - more：预算放不下时的「其余 N 项在浏览器里看」（kind 'more'，带 href），否则 null
 */
export function paneOf({ summary, projects, projectId, view: wanted, lineChoice = null, cwd = null, toggled = [], focus, url, now, problems = [] }) {
  const entry = projects?.projects?.find((p) => p.id === projectId) ?? null;
  const base = trim(url ?? '');
  const lines = entry?.branchLines ?? [];
  const line = activeLine(lineChoice, summary, lines, cwd);
  const scoped = lineSummary(summary, line, lines);
  // 网页没有 PR 视图：PR 视图的「在浏览器打开」去网页的下一步（「等我处理」在那里）
  const hrefOn = (l) => (v, key = null, f = null) => `${base}/${hashFor(v === 'pr' ? 'next' : v, projectId, key, l, f)}`;
  const href = hrefOn(line);
  const github = hasGithub(summary);
  // 未接 GitHub（或还没拿到摘要）时 PR 视图退回总览
  const view = wanted === 'pr' && !github ? 'overview' : wanted;

  // 项目名与品牌同名（devboard 自己）只写一次
  const name = projectId ? clip(entry?.name ?? projectId, TITLE_MAX) : null;
  const header = [{ key: 'title', kind: 'title', level: 0, texts: name && name.toLowerCase() !== 'yuiboard' ? ['YUIBoard', name] : ['YUIBoard'] }];
  if (projectId) {
    const n = summary ? checkItems(scoped, { line }).length : null;
    const w = summary ? diagRows(summary, projects, entry, now).filter((r) => r.level === 0 && r.warn).length : 0;
    // PR 导航的数字：等待 review、等待合并（含待同步）各一段，为 0 的不写；完成不计（owner 已定 21）
    const pr = github ? prGroups(scoped, lines, now).groups : null;
    const prCounts = pr ? [['review', 'merged'], ['merge', 'planMode']].filter(([k]) => pr[k].length) : [];
    header.push(
      { key: 'nav:overview', kind: 'nav', level: 0, view: 'overview', active: view === 'overview', texts: [t('总览')] },
      ...(pr ? [{ key: 'nav:pr', kind: 'nav', level: 0, view: 'pr', active: view === 'pr',
        texts: ['PR', ...prCounts.map(([k]) => `${STATUS_UI[PR_STATUS[k]].icon} ${pr[k].length}`)],
        ...(prCounts.length && { tones: [null, ...prCounts.map(([, c]) => c)] }) }] : []),
      { key: 'nav:check', kind: 'nav', level: 0, view: 'check', active: view === 'check', texts: n == null ? [t('需要确认')] : [t('需要确认'), String(n)], ...(n && { tones: [null, 'warning'] }) },
      { key: 'nav:diag', kind: 'nav', level: 0, view: 'diag', active: view === 'diag', texts: w ? [t('诊断'), `⚠ ${w}`] : [t('诊断')], ...(w && { tones: [null, 'warning'] }) },
    );
    if (summary && lines.length > 1) {
      const tab = (id, name) => ({ key: id === null ? 'tab' : `tab:${id}`, kind: 'line', level: 0, choose: id, active: line === id, texts: [clip(name, TITLE_MAX)] });
      header.push(tab(null, t('全部')), ...lines.map((l) => tab(l.id, l.name)));
    }
  }
  header.push({ key: 'open', kind: 'link', level: 0, texts: [t('在浏览器打开')], href: projectId ? href(view) : `${base}/` });
  if (projectId && summary && view === 'overview') header.push(...statRows(scoped));

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

  // 选中一条线后一屏都是这条线，不再写线名（lines 传空）
  const ctx = { summary: scoped, href, toggled: new Set(toggled), focus: focus ?? { keys: [], recent: false }, lines: line ? [] : lines, line };
  if (view === 'check') return fit({ header, banners, body: checkRows(ctx), href: href('check') });
  if (view === 'pr') return fit({ header, banners, body: prRows({ ...ctx, now }), href: href('pr') });
  if (view === 'diag') return fit({ header, banners, body: diagRows(summary, projects, entry, now), href: href('diag') });
  const { focusHead, focusItems, focusToggle } = focusCard({ ...ctx, summary, href: hrefOn(null), now }); // 卡片不受筛选影响，链接也不带线
  return fit({ header, banners, focusHead, focusItems, focusToggle, body: treeRows(ctx), href: href('overview') });
}

// 总览数字（需求 4.1）：口径即 overallStats，一行排开（owner 2026-10-12 定的面板稿）：进度条、百分比、完成数，
// 再是进行中 / 等待 review / 等待合并 / 停滞 / 待同步（为 0 的不出）与可开工
function statRows(summary) {
  const all = overallStats(summary);
  const filled = all.ratio == null ? 0 : Math.round(all.ratio * BAR);
  const count = (s) => all.counts[s] ? [{ key: `stat:${s}`, kind: 'stat', level: 0, status: s, texts: [`${icon(s)} ${t(WORD[s === 'in_progress' ? 'run' : TONE[s]])} ${all.counts[s]}`] }] : [];
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
      texts: [mark(v), task.number, clip(mdText(task.title), TITLE_MAX)] },
    { key: `focus:${first}:why`, kind: 'focusLine', level: 2, texts: [clip(why, NOTE_MAX)] },
    ...focusPrs(summary, v, now).map(({ p, tone }) => ({ key: `focus:${first}:pr:${p.number}`, kind: 'focusPr', level: 2,
      status: PR_STATUS[tone], tone, ...(p.url && { href: p.url }), texts: [`#${p.number}`, prMark(tone), prWait(p, tone, now)] })),
  ] };
  const head = focus.idle ? [t('本会话当前没有进行中的任务'), t('最近做的'), task.docId, focus.at && ago(focus.at, now)].filter(Boolean)
    : focus.recent ? [t('本会话最近做的'), task.docId, focus.at && ago(focus.at, now)].filter(Boolean)
    : [t('本会话正在做'), task.docId];
  const focusHead = [{ key: 'focus', kind: 'focusHead', level: 0, texts: [head.join(' · ')] }];
  if (!rest.length) return { focusHead, focusItems: [main], focusToggle: null };
  const open = toggled.has('focus:others');
  const focusToggle = { key: 'focus:others', kind: 'focusToggle', level: 1, toggle: 'focus:others', open, texts: [t`另有 ${rest.length} 个关联任务`] };
  const others = open ? rest.map((k) => {
    const x = tasks.get(k);
    const s = views.get(k).status;
    return { key: k, path: [], rows: [{ key: `focus:${k}`, kind: 'focusItem', level: 2, status: s ?? 'void', tone: toneOf(views.get(k)), href: href('overview', k),
      texts: [mark(views.get(k)), x.number, clip(mdText(x.title), TITLE_MAX)] }] };
  }) : [];
  return { focusHead, focusItems: [main, ...others], focusToggle };
}

// 聚焦卡片里主任务的关联 PR（owner 已定 21 的 B）：手动解除的、关闭未合并的不列；等着的在前，同组号大（新）在前，最多 2 个
function focusPrs(summary, v, now) {
  const byNum = new Map((summary.prs ?? []).map((p) => [p.number, p]));
  return (v.prs ?? []).filter((l) => !l.removedManually).map((l) => byNum.get(l.pr)).filter(Boolean)
    .map((p) => ({ p, tone: PR_TONE[prKind(p)] })).filter((x) => x.tone)
    .sort((a, b) => PR_ORDER.indexOf(a.tone) - PR_ORDER.indexOf(b.tone) || b.p.number - a.p.number).slice(0, 2);
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
        texts: [mark(v), task.number, clip(mdText(task.title), TITLE_MAX)],
        ...(parents.has(task.key) && { toggle: tkey, open: isOpen(tkey) }), ...(task.key === primary && { highlight: true }) }];
    });
    // 分隔见 apart：最外层任务连同它展开的子孙算一块
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

// PR 视图（N33，owner 已定 21 的 A；面板稿 ui-mockup-v3-pr.html）：等待 review、等待合并默认展开，完成默认收起、展开最多 3 个。
// 每个 PR 两行：状态圆圈与状态文字、编号（链接到 GitHub）、标题；灰字写分支线（多条时）· 关联任务 · 等了多久
function prRows({ summary, toggled, lines, now }) {
  if (summary.degraded?.noPrData) return [{ key: 'pr:empty', kind: 'empty', level: 0, texts: [t('未包含 PR 信息（还没成功读到 GitHub）')] }];
  const { groups, days } = prGroups(summary, lines, now);
  const tasks = new Map(summary.docs.flatMap((d) => d.tasks).map((x) => [x.key, x]));
  const item = ({ p, tone }) => {
    const docId = tasks.get(p.tasks?.[0])?.docId;
    const info = [
      lines.length > 1 && lineName(lines, p.branchLine),
      p.tasks?.length ? shortList(p.tasks.map((k) => refLabel(k, docId))) : t('未关联任务'),
      prWait(p, tone, now),
    ].filter(Boolean).join(' · ');
    return [
      { key: `pr:#${p.number}`, kind: 'prItem', level: 1, status: PR_STATUS[tone], tone, ...(p.url && { href: p.url }),
        texts: [prMark(tone), `#${p.number}`, clip(p.title, TITLE_MAX)] },
      { key: `pr:#${p.number}:info`, kind: 'prLine', level: 2, band: tone, texts: [clip(info, NOTE_MAX)] },
    ];
  };
  const rows = [];
  for (const [g, name] of [['review', t('等待 review')], ['merge', t('等待合并')], ['done', t`完成（最近 ${days} 天）`]]) {
    const list = groups[g];
    if (!list.length) continue;
    const key = `pr:${g}`;
    const open = (g !== 'done') !== toggled.has(key);
    rows.push({ key, kind: 'prGroup', level: 0, texts: [name], end: String(list.length), toggle: key, open });
    if (!open) continue;
    const shown = g === 'done' ? list.slice(0, PR_DONE_MAX) : list;
    rows.push(...apart(shown.flatMap(item)));
    // 其余的去 GitHub 的已合并列表看（网页没有完整 PR 列表）
    if (list.length > shown.length) {
      rows.push({ key: `${key}:more`, kind: 'more', level: 1, texts: [t`另有 ${list.length - shown.length} 个 · 在浏览器里看全部`],
        ...(list[0].p.url && { href: list[0].p.url.replace(/\/pull\/\d+$/, '/pulls?q=is%3Apr+is%3Amerged') }) });
    }
  }
  return rows.length ? rows : [{ key: 'pr:empty', kind: 'empty', level: 0, texts: [t('没有等待处理或最近合并的 PR')] }];
}

// 需要确认（需求 6）：checkItems 按 CONFLICT_TEXT 顺序分组；c 默认折叠；每组最多 30 条
function checkRows({ summary, href, toggled, line }) {
  const all = checkItems(summary, { line });
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
      const texts = task ? [mark(views.get(task.key)), task.number, `${clip(mdText(task.title), TITLE_MAX)} · ${detail}`]
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
