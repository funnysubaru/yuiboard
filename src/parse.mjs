// 纯解析（N27 design §2）：tasks.md / ADR 的解析、编号比较、docId 通配。不 import 任何 node: 模块，
// Claude Code mod 的钩子也能用（mod 只能 import 插件内的纯 ES 模块）；服务端照旧经 docs.mjs / adr.mjs 取用。
// 输入文本、输出结构，不读文件、不读时钟。关系语法与前置条件表在 relations.mjs。

import { parseRelations } from './relations.mjs';
import { msg, joinList } from './msg.mjs';
import { mdUnrenderedLines } from '../web/md.mjs';


/** archived / excluded 的 docId 通配：* 任意串、? 单字符，整串匹配。 */
export function globMatcher(patterns = []) {
  const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
  return (docId) => res.some((re) => re.test(docId));
}


const DEFAULT_MILESTONE_CODE = '(?:里程碑|[Mm]ilestone|マイルストーン)\\s*([A-Za-z]+\\d+(?:-[A-Za-z0-9]+)?)';
// 分组别名只供文档内依赖引用（「依赖 阶段 1」「depends on Phase 1」「フェーズ 1 に依存」），不参与 PR / 会话匹配。
const GROUP_ALIAS = /(?:阶段|[Pp]hase|[Ss]tage|フェーズ|PR)\s*\d+[a-z]?/;
// N9：中文数字的阶段标题「## 阶段一」「## 第一阶段」「## 第 2 阶段」归一成「阶段 1」，与「阶段 1」同一别名。
// 数词类里带上百千万，整个数词一起取，超出上限时整体不认（「阶段一百」不能被截成「阶段一」）。
const CN_STAGE = /阶段\s*([〇零一二两三四五六七八九十百千万]+)|第\s*(\d+|[〇零一二两三四五六七八九十百千万]+)\s*阶段/;
const NUM = 'T?\\d+[a-z]?(?:\\.\\d+[a-z]?)*';
// design §3.3 的任务行正则；复选框放宽成任意单字符，空格 / x / X / ~ 以外的按未勾处理并记诊断。
// 分组：1 复选框 2 开头删除线 3 开头加粗 4 编号原文(label) 5 编号 6 标题剩余部分
const TASK_LINE = new RegExp(`^\\s*[-*]\\s+\\[(.)\\]\\s+(~~)?(\\*\\*)?((?:Task\\s*|タスク\\s*)?(${NUM})\\.?)[\\s:：](.*)$`);
const CHECKBOX_LINE = /^\s*[-*]\s+\[(.)\](?:\s+(.*))?$/;
// 复选框后以数字 / T数字 / **数字 开头却没通过任务行正则 = 疑似任务行（写法有误），要让 owner 看到。
// N9：小写 task、全角数字（「- [ ] task 2」「- [ ] １ 搭骨架」）也算疑似，不再静默当成无编号复选框。
const SUSPECT = /^(?:~~)?(?:\*\*)?(?:(?:task|タスク)\s*)?t?[\d０-９]/i;
// 标题式任务必须带 Task / T，避免把「## 0. 需要 owner 提供的前置条件」认成任务。
const TITLE_TASK = /^(?:Task\s*|タスク\s*|T)(\d+[a-z]?(?:\.\d+)*)\s*(✅)?\s*[:：—-]\s*(.*)$/;
// N9：已有任务行时，像标题式任务的标题（含「### 任务 1：」）不会被认成任务，记诊断提示改写。
const TITLE_TASK_LIKE = /^(?:Task|タスク|任务|T)\s*(\d+[a-z]?(?:\.\d+)*)\s*(?:✅)?\s*[:：—-]\s*(.*)$/i;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
// 英文 / 日文：Estimate(d)、Estimated time / effort、見積もり / 見積り / 見積、所要時間（前面紧贴字母的 re-estimate 不算）。
const ESTIMATE = /(?:预计耗时|(?<![A-Za-z-])estimated?(?:\s+(?:time|effort))?|見積もり|見積り|見積|所要時間)\**\s*[:：]\s*(.+)/i;
// 作废标记：中文【作废 /（作废 / [作废]（原有写法，不变）；日文、英文要完整的括号标记，括号里只许再带日期——
// 【廃止 2026-09-01】、[void]、(obsolete 2026-09-01)；「(void return type)」「（廃止予定の API）」是普通说明。
const VOID_MARK = /【作废|（作废|\[作废\]|[[(（【]\s*(?:void|obsolete|廃止)(?:[\s:：,，]*\d{4}-\d{2}-\d{2})?\s*[\])）】]/i;
// 整体删除线：从复选框后开始、闭合在行尾，中间不能再出现 ~~（否则只是局部删除线）。
const WHOLE_STRIKE = /^(?:\*\*)?~~(?:(?!~~).)+~~(?:\*\*)?\s*$/;

/**
 * 解析一份 tasks.md。
 * @param {string} text 文件全文（可带 BOM、CRLF）
 * @param {string} docId
 * @param {{ milestoneCodePattern?: string, prerequisiteIdPattern?: string, hoursPerDay?: number, file?: string }} [opts]
 *   file 用于 SourceRef.file（仓库内相对路径），缺省用 docId。
 * @returns {{ title: string|null,
 *   parse: { state: 'ok'|'partial'|'no-tasks', reason?: string, unrecognizedLines: number[],
 *            unknownRelations: object[], unknownEstimates: SourceRef[], unrenderedMarkdown: (SourceRef & { kind: string })[], mermaidUsed: boolean,
 *            diagnostics: { message: string, source: SourceRef }[], uncheckedBoxes: number },
 *   groups: { id: string, title: string, code: string|null, alias: string|null, line: number }[],
 *   tasks: object[], prerequisites: object[], relations: object[] }}  relations / prerequisites 见 relations.mjs；tasks 形状见 design §4 Task，数组保持文档顺序；行号一律从 1 起；
 *   bodyRange = [任务行, 正文末行] 闭区间（含任务行本身）；groupId = 分组 id = `L<分组标题行号>`。
 */
export function parseTasksDoc(text, docId, opts = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const file = opts.file ?? docId;
  const hoursPerDay = opts.hoursPerDay ?? 8;
  const codeRe = new RegExp(opts.milestoneCodePattern ?? DEFAULT_MILESTONE_CODE);
  const ref = (i) => ({ file, line: i + 1, text: lines[i].trim().slice(0, 160) });

  // 第一遍：去掉代码围栏内的行（Mermaid 图交给关系解析），收集标题、任务行、其它复选框。
  const items = []; // { i, kind: 'heading', level, text } | { i, kind: 'task', m }
  const unrecognizedLines = [];
  const diagnostics = [];
  let uncheckedBoxes = 0; // 无编号复选框（验收清单等）只计数，用来解释「未解析出任务」
  let title = null;
  let fence = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
    if (f) { fence = f[1]; return; }
    const h = HEADING.exec(line);
    if (h) {
      items.push({ i, kind: 'heading', level: h[1].length, text: h[2] });
      if (h[1].length === 1) title ??= h[2];
      return;
    }
    const m = TASK_LINE.exec(line);
    if (m) { items.push({ i, kind: 'task', m }); return; }
    const c = CHECKBOX_LINE.exec(line);
    if (c) {
      if (SUSPECT.test(c[2] ?? '')) unrecognizedLines.push(i + 1);
      else uncheckedBoxes++;
    }
  });

  // 标题式任务只在一条任务行都没有时兜底启用（design §3.3）。
  const titleMode = !items.some((it) => it.kind === 'task');
  for (const it of items) {
    if (it.kind !== 'heading' || it.level < 2 || it.level > 4) continue;
    const t = titleMode && TITLE_TASK.exec(it.text);
    if (t) Object.assign(it, { kind: 'title-task', t });
    const like = !titleMode && TITLE_TASK_LIKE.exec(it.text);
    if (like) diagnostics.push({ message: msg`标题「${it.text}」像标题式任务，但本文档已有任务行，它不会被当成任务；建议改成「- [ ] ${like[1]} ${like[2]}」`, source: ref(it.i) });
  }

  const groups = [];
  const tasks = [];
  const unknownEstimates = [];
  const unrenderedMarkdown = []; // N12：正文里页面认不了的 Markdown 写法（与 web/md.mjs 同口径）
  const usedGroups = new Set();
  const stack = []; // 当前所在的标题链（非任务标题），用来找分组
  items.forEach((it, idx) => {
    const level = it.kind === 'task' ? 7 : it.level; // 任务行比任何标题都深
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (it.kind === 'heading') { stack.push(it); return; }
    // 分组 = 上方最近的 ##–#### 标题；标题式任务只认比自己浅的（它自己的小标题不算分组）。
    const heading = stack.findLast((h) => h.level >= 2 && h.level <= 4);
    // 正文：到下一个任务，或到下一个会成为分组边界的标题（# 到 ####）为止，更深的小标题仍算正文；
    // 标题式任务则到不深于它自己的标题为止。
    const limit = it.kind === 'title-task' ? it.level : 4;
    const next = items.slice(idx + 1).find((n) => n.kind !== 'heading' || n.level <= limit);
    let end = (next ? next.i : lines.length) - 1;
    while (end > it.i && /^\s*(?:-{3,}|\*{3,}|_{3,})?\s*$/.test(lines[end])) end--; // 去掉尾部空行与分隔线

    if (heading && !usedGroups.has(heading)) {
      usedGroups.add(heading); // 只收有任务的分组，免得任务树里出现空分组
      groups.push(makeGroup(heading, codeRe));
    }
    const task = it.kind === 'task' ? fromTaskLine(it.m) : fromTitleTask(it.t, lines, it.i, end);
    const est = findEstimate(lines, it.i + 1, end, hoursPerDay);
    // 识别不出的写法：estimateHours 为 null，甘特按默认工期兜底，这里记诊断（需求 15.5）。
    if (est && est.hours === null) unknownEstimates.push(ref(est.i));
    for (const x of mdUnrenderedLines(lines.slice(it.i + 1, end + 1))) unrenderedMarkdown.push({ ...ref(it.i + 1 + x.i), kind: x.kind });
    if (task.checkboxIssue) diagnostics.push({ message: msg`复选框「[${task.checkboxIssue}]」不是 [ ] / [x] / [~]，按未勾处理`, source: ref(it.i) });
    delete task.checkboxIssue;
    tasks.push({
      ...task, docId,
      groupId: heading ? `L${heading.i + 1}` : null,
      line: it.i + 1, bodyRange: [it.i + 1, end + 1],
      estimateHours: est ? est.hours : null,
      estimateSource: est ? ref(est.i) : null,
    });
  });

  // 键与父子。重复编号：两条都保留，第二条起键加 ~2、~3（不用行号，编辑文件不会让手动关联失效），并都标 duplicate。
  const seen = new Map();
  for (const t of tasks) seen.set(t.number, (seen.get(t.number) ?? 0) + 1);
  const counter = new Map();
  for (const t of tasks) {
    const n = (counter.get(t.number) ?? 0) + 1;
    counter.set(t.number, n);
    t.key = `${docId}#${t.number}${n > 1 ? `~${n}` : ''}`;
    t.duplicate = seen.get(t.number) > 1;
    // 父 = 去掉最后一段、且本文档存在；看编号不看缩进（2.5b → 2，4a.1 → 4a）。
    const parent = t.number.split('.').slice(0, -1).join('.');
    t.parentKey = parent && seen.has(parent) ? `${docId}#${parent}` : null;
  }

  const rel = parseRelations(lines, { docId, file, tasks, groups, prerequisiteIdPattern: opts.prerequisiteIdPattern });
  const parse = { state: 'ok', unrecognizedLines, unknownRelations: rel.unknownRelations, unknownEstimates, unrenderedMarkdown, mermaidUsed: rel.mermaidUsed, diagnostics, uncheckedBoxes };
  if (tasks.length === 0) {
    parse.state = 'no-tasks';
    parse.reason = unrecognizedLines.length
      ? msg`没有「- [ ] 编号 标题」格式的行；共 ${uncheckedBoxes} 个无编号复选框；第 ${joinList(unrecognizedLines)} 行像任务行但格式不对`
      : msg`没有「- [ ] 编号 标题」格式的行；共 ${uncheckedBoxes} 个无编号复选框`;
  } else if (unrecognizedLines.length) {
    parse.state = 'partial';
    parse.reason = msg`第 ${joinList(unrecognizedLines)} 行像任务行但未能识别`;
  }
  return { title, parse, groups, tasks, prerequisites: rel.prerequisites, relations: rel.relations };
}

function makeGroup(h, codeRe) {
  const code = codeRe.exec(h.text)?.[1] ?? null;
  return {
    id: `L${h.i + 1}`, // 用标题行号：文档内唯一；分组不参与手动关联，行号变了无妨
    title: h.text, code,
    alias: code ? null : (GROUP_ALIAS.exec(h.text)?.[0] ?? cnStage(h.text)),
    line: h.i + 1,
  };
}

// 分组别名不显示在页面上，只供文档内依赖引用匹配
function cnStage(text) {
  const m = CN_STAGE.exec(text);
  if (!m) return null;
  const v = (m[1] ?? m[2]).replace(/零/g, '〇').replace(/两/g, '二');
  const d = (c) => '〇一二三四五六七八九'.indexOf(c);
  // ponytail: 只认到九十九（「十」「十二」「二十」「二十三」），够分组用；超出的（一百、两千）不当别名，免得映射成别的阶段
  if (!/^\d+$/.test(v) && !/^(?:[一二三四五六七八九]?十[一二三四五六七八九]?|[〇一二三四五六七八九])$/.test(v)) return null;
  const [a, b] = v.split(/十/);
  const n = /^\d+$/.test(v) ? Number(v) : b !== undefined ? (a ? d(a) : 1) * 10 + (b ? d(b) : 0) : d(v);
  return `阶段 ${n}`;
}

function fromTaskLine(m) {
  const [, box, strike, bold, label, rawNum, rest] = m;
  const after = m[0].replace(/^\s*[-*]\s+\[.\]\s+/, '');
  // 去掉包在编号前的加粗 / 删除线的闭合标记（「**1.1 标题**」「~~6.6 标题~~」），其余原样保留，
  // 标题里的局部删除线要让页面看得出来。
  let title = rest;
  if (bold) title = title.replace('**', '');
  if (strike) title = title.replace('~~', '');
  return {
    number: rawNum.replace(/^T/, ''), label, title: title.trim(),
    checkbox: box === 'x' || box === 'X' ? 'done' : box === '~' ? 'doing' : 'open',
    checkboxIssue: ' xX~'.includes(box) ? null : box,
    void: VOID_MARK.test(after) || WHOLE_STRIKE.test(after),
  };
}

// 标题式任务：✅ 或下属步骤（正文里的复选框）全勾即已勾。
function fromTitleTask(t, lines, start, end) {
  const [whole, num, check, rest] = t;
  const steps = lines.slice(start + 1, end + 1).map((l) => CHECKBOX_LINE.exec(l)).filter(Boolean);
  const allDone = steps.length > 0 && steps.every((s) => s[1] === 'x' || s[1] === 'X');
  return {
    number: num, label: whole.slice(0, whole.length - rest.length).replace(/\s*(?:✅\s*)?[:：—-]\s*$/, ''),
    title: rest.trim(),
    checkbox: check || allDone ? 'done' : 'open',
    checkboxIssue: null,
    void: VOID_MARK.test(rest) || WHOLE_STRIKE.test(rest),
  };
}

function findEstimate(lines, from, to, hoursPerDay) {
  for (let i = from; i <= to; i++) {
    const m = ESTIMATE.exec(lines[i]);
    if (m) return { i, hours: parseEstimate(m[1], hoursPerDay) };
  }
  return null;
}

const CN_NUM = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const QTY = '(\\d+(?:\\.\\d+)?|[半一两二三四五六七八九十])';
// 英文单位后面不能再跟字母（「1 dev」不是 1 天）；日文：営業日 / 日 / 時間 / 分，区间可用 〜。
const EN_UNIT = '(?:(?:working|business|work)\\s*days?|days?|d|hours?|hrs?|h|minutes?|mins?)(?![A-Za-z])';
const AMOUNT = new RegExp(`${QTY}(?:\\s*[–—~～〜-]\\s*${QTY})?\\s*(工作日|営業日|天|日|小时|時間|${EN_UNIT}|分钟|min|分)`, 'gi');

/**
 * 「预计耗时」冒号后的文字 → 小时数；识别不出返回 null（调用方记诊断、甘特用默认工期）。
 * 去括号附注后把所有「数量 + 单位」相加；范围（2–3 天）取上限；结果保留两位小数。
 * ponytail: 中文数字只认单字（半、一…十），「十二天」「一天半」这类要时再扩。
 */
export function parseEstimate(text, hoursPerDay = 8) {
  const s = text.replace(/（[^）]*）|\([^)]*\)/g, '');
  let hours = null;
  for (const m of s.matchAll(AMOUNT)) {
    const n = toNumber(m[2] ?? m[1]);
    const unit = m[3].toLowerCase();
    const h = /天|日|day|^d$/.test(unit) ? n * hoursPerDay : /^(?:小时|時間|h)/.test(unit) ? n : n / 60;
    hours = (hours ?? 0) + h;
  }
  return hours === null ? null : Math.round(hours * 100) / 100;
}

function toNumber(q) {
  return q in CN_NUM ? CN_NUM[q] : Number(q);
}

/**
 * 任务编号比较：按 . 分段，每段先比数值再比字母后缀；前缀相同时段少的在前。
 * 2 < 2.1 < 2.5 < 2.5b < 2.6 < 2.9 < 2.10。任务数组本身保持文档顺序（需求 10.2），排序时用这个比较器。
 */
export function compareTaskNumbers(a, b) {
  const sa = a.split('.'), sb = b.split('.');
  for (let k = 0; k < Math.min(sa.length, sb.length); k++) {
    const [, na, la] = /^(\d*)(.*)$/.exec(sa[k]);
    const [, nb, lb] = /^(\d*)(.*)$/.exec(sb[k]);
    if (Number(na) !== Number(nb)) return Number(na) - Number(nb);
    if (la !== lb) return la < lb ? -1 : 1;
  }
  return sa.length - sb.length;
}

// ---- ADR（design §3.3 ADR 段）----

const ADR_NUMBER = /ADR-(\d+)/;
// 状态两种写法：「- **状态**: 已批准」「> 状态:已接受」「**Status**: Accepted」「ステータス：承認済み」这类行内写法优先；
// 否则取「## 状态」标题后的首个非空行。只看前 30 行，免得正文里的「状态」说明被误认。
const STATUS_INLINE = /^[>\-*\s]*\**(?:状态|Status|ステータス|状態)\**\s*[:：]\s*(.+)/;
const STATUS_HEADING = /^#+\s*(?:状态|Status|ステータス|状態)\s*$/;
const STATUS_SCAN_LINES = 30;
const STATUS_MAX = 80;
// H1 常以「ADR-0014: 」「ADR-0022 — 」开头，编号另有字段，标题里去掉免得页面上重复。
const TITLE_PREFIX = /^ADR-\d+\s*(?:[:：—–-]\s*)?/;

export const adrNumber = (docId) => ADR_NUMBER.exec(docId)?.[1] ?? null;

/**
 * 解析一篇 ADR。任务行、分组、关系全部沿用 parseTasksDoc；只额外给出 adr 字段并调整两处：
 * 没有任务行是 ADR 的常态（无编号检查清单静默忽略），不记 no-tasks；编号重复记进 parse.diagnostics。
 * @param {string} text
 * @param {string} docId 文件名去扩展名
 * @param {{ file?: string, duplicates?: string[] } & object} [opts] 其余同 parseTasksDoc 的 opts
 * @returns {object} parseTasksDoc 的结果 + { kind: 'adr', adr: { number: string|null, status: string|null } }；
 *   number 为文件名里的数字原文（如 '0014'），status 为原文、不归一化，超过 80 字截断并加「…」
 */
export function parseAdrDoc(text, docId, opts = {}) {
  // ADR 的检查清单常写「- [ ] **461 个孤儿目录…**」这类加粗数字开头的条目，会被任务行正则误认成编号任务
  // （还会互相撞成重复编号）。ADR 内只认不加粗的编号任务：把这类行的加粗前缀挪开，行数不变，
  // 它们随之按无编号复选框计数、静默忽略。
  text = text.replace(/^(\s*[-*]\s+\[.\]\s+)(\*\*\d)/gm, '$1·$2');
  const doc = parseTasksDoc(text, docId, opts);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const number = adrNumber(docId);
  if (doc.parse.state === 'no-tasks') {
    doc.parse.state = 'ok';
    delete doc.parse.reason;
  }
  if (opts.duplicates?.length) {
    doc.parse.diagnostics.push({
      message: msg`ADR 编号 ${number} 重复：另见 ${joinList(opts.duplicates)}；按文件名区分`,
      source: { file: opts.file ?? docId, line: 1, text: lines[0].trim().slice(0, 160) },
    });
  }
  return {
    ...doc, kind: 'adr',
    title: doc.title?.replace(TITLE_PREFIX, '') || doc.title,
    adr: { number, status: findStatus(lines) },
  };
}

function findStatus(lines) {
  const head = lines.slice(0, STATUS_SCAN_LINES);
  let raw = null;
  for (const l of head) {
    const m = STATUS_INLINE.exec(l);
    if (m) { raw = m[1]; break; }
  }
  if (raw === null) {
    const i = head.findIndex((l) => STATUS_HEADING.test(l));
    if (i >= 0) raw = lines.slice(i + 1).find((l) => l.trim()) ?? null;
  }
  if (raw === null) return null;
  const chars = [...raw.trim()]; // 按码点截，不把 emoji 截成半个
  return chars.length > STATUS_MAX ? `${chars.slice(0, STATUS_MAX).join('')}…` : chars.join('');
}
