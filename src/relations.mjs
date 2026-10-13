// 关系语法与前置条件表（design §3.4.1–§3.4.2、§3.3「前置条件表 → 外部阻塞」）。
// 纯函数：输入已切好的行与 parseTasksDoc 的任务 / 分组，输出关系、前置条件与未识别说法。
// 引用在这里只解析到「本文档里被点名的任务」，不展开后代、不继承父任务依赖、不判环——那些归 engine（design §3.8.1）。

import { compareTaskNumbers } from './parse.mjs';

const NUM = 'T?\\d+[a-z]?(?:\\.\\d+[a-z]?)*';
const DEFAULT_PREREQ_ID = '^~*P\\d+~*$';
// 版本号形态（2.0.6、1.15.706）不是任务编号（design §3.4.2）。
const VERSION = /^\d+\.\d+\.\d+/;
const RE_KEY = new RegExp(`([A-Za-z0-9][\\w.-]*)#(${NUM})(?![A-Za-z0-9])`, 'y');
const RE_CHILDREN = new RegExp(`(${NUM})\\.x(?![A-Za-z0-9])`, 'y');
// 范围横线另认日文的波浪线 〜（U+301C）；N9 起也认 ~ 与全角 ～（「依赖 1~3」「依赖 1～3」）：这里两侧都得是编号，
// 版本号形态照旧不算（1.15.526~529）。
const RE_RANGE = new RegExp(`(${NUM})\\s*[–—〜～~-]\\s*(${NUM})(?![A-Za-z0-9])`, 'y');
const RE_NUM = new RegExp(`(${NUM})(?![A-Za-z0-9])`, 'y');
// 英文 and / &（含牛津逗号「1, 2, and 3」）、日文「と」、N9 起的 +（「依赖 1.1 + 1.2」）也是列表分隔；
// 分隔符后面不是 Ref 时不吞，所以「4 と並行」的「と」照样留给并行模式。
const RE_SEP = /\s*(?:、|，|,\s*and(?![A-Za-z])|,|\/|和|及|与|&|\+|(?<![A-Za-z])and(?![A-Za-z])|と)\s*/y;
const RE_ARROW = /\s*→\s*/y;
// 编号前口语化的「任务」二字或 task / tasks / タスク（「依赖任务 1、2」「与任务 3/4 并行」「任务 1、任务 3」「依赖 task 16」）。
const RE_TASK_WORD = /(?:任务|タスク|[Tt]asks?)\s*/y;
// 这些词出现、又带着引用、却一条模式都没命中 → 记「未识别的依赖说法」。
// 不含「需要」「之后」：「需要确认」「在 S1 之后」这类普通叙述太常见，误报比漏报更烦人。
// 英文 / 日文同理不含 after、requires、needs、in order（「in order to」）、前提（中文叙述也用）。
const KEYWORD = /依赖|前置|并行|依次|串行|顺序|完成后|之前|最后|→|\b(?:depends?|dependenc(?:y|ies)|blocked by|parallel|sequentially)\b|依存|並行|直列|順に|順序|完了後/i;
const BODY_LEAD = /^(?:依赖|前置|并行|顺序|(?:depends?|dependenc(?:y|ies)|requires?|after|blocked by|parallel|order|sequence)\b|依存|前提タスク|並行|順序|順番)/i;
// 平假名 / 片假名：句子里有假名才按日文的「、」切子句（中文的「、」只是列表分隔，行为不变）。
const KANA = /[\u3040-\u30ff]/;
// 日文「、」只在两侧各自带关系词时才当子句分界（「1 に依存、3 と並行」）；一侧没有关系词时它只是列举
// （「需要 P1 アカウント、P2 key」「P1 のキー、P2 のアカウントが必要」），切开会丢掉后面 / 前面的条件。
const CLAUSE_KEY = new RegExp(`${KEYWORD.source}|需要|が必要|\\b(?:needs?|requires?|after)\\b|前提タスク|以降`, 'i');
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * 从一份 tasks.md 取关系、前置条件表与未识别的关系说法。
 * @param {string[]} lines 已去 BOM、按 \r?\n 切好的行
 * @param {{ docId: string, file: string, tasks: object[], groups: object[], prerequisiteIdPattern?: string }} doc
 * @returns {{ relations: RawRelation[], prerequisites: Prerequisite[], unknownRelations: SourceRef[], mermaidUsed: boolean }}
 *
 * Ref = { raw, type, keys, dangling, id? }
 *   type: 'task' | 'range' | 'children'(2.x) | 'group'(代号 / 别名 / 分组说明段的「本组」) | 'from'(X 起)
 *       | 'key'(跨文档任务键) | 'prereq'(前置条件编号，id = 'P1'，keys 为空)
 *   keys: 本文档内解析到的任务键（重复编号取第一条）；跨文档键原样放一个、由 engine 按全部文档判断是否悬空。
 *   dangling: 本文档内找不到（引用了不存在的编号 / 前置表里没有的 P 编号）。
 * RawRelation = { kind: 'dep' | 'parallel' | 'none', subjects: Ref[], objects: Ref[], via, source }
 *   dep：subjects 依赖 objects；objects 里的 prereq 即外部阻塞。
 *   parallel：subjects 的每个任务与 objects 的每个任务两两可并行（「18.1–18.5 可并行」两侧是同一列表，engine 跳过自身）。
 *   none：文档明写「依赖：无」，subjects 为该任务，objects 为空。
 */
export function parseRelations(lines, doc) {
  const ctx = makeContext(lines, doc);
  const relations = [];
  const unknownRelations = [];
  const src = (i) => ({ file: doc.file, line: i + 1, text: lines[i].trim().slice(0, 160) });
  const run = (text, i, subjects, via, subjectLead) => {
    for (const r of scanText(text, subjects, ctx, subjectLead)) {
      if (r.unknown) unknownRelations.push({ file: doc.file, line: i + 1, text: r.unknown.slice(0, 160) });
      else relations.push({ ...r, via, source: src(i) });
    }
  };

  // ① 任务标题（含括号）与 ② 以「依赖 / 前置 / 并行 / 顺序」开头的正文行：主语都是该任务。
  for (const t of doc.tasks) {
    const self = [{ raw: t.number, type: 'task', keys: [t.key], dangling: false }];
    run(t.title, t.line - 1, self, 'title', false);
    for (let i = t.bodyRange[0]; i < t.bodyRange[1]; i++) {
      if (ctx.inFence[i]) continue;
      const s = stripLead(lines[i]);
      if (BODY_LEAD.test(s)) run(s, i, self, 'body', false);
    }
  }

  // ③ 分组说明段：分组标题到本组第一个任务行之间；主语 = 本组全部任务，句首是引用列表时主语 = 该列表。
  // 只看有任务的分组，所以「执行约定」「前置条件」这类不含任务的章节正文一律不参与。
  for (const g of doc.groups) {
    const members = doc.tasks.filter((t) => t.groupId === g.id);
    const whole = [{ raw: g.title, type: 'group', keys: members.map((t) => t.key), dangling: false }];
    for (let i = g.line; i < members[0].line - 1; i++) {
      if (ctx.inFence[i] || /^\s*#/.test(lines[i])) continue;
      run(stripLead(lines[i]), i, whole, 'group-note', { members });
    }
  }

  const prerequisites = parsePrereqTable(lines, ctx, doc.prerequisiteIdPattern);
  for (const p of prerequisites) {
    if (!p.blocks.length) continue;
    relations.push({
      kind: 'dep', subjects: p.blocks,
      objects: [{ raw: p.id, type: 'prereq', id: p.id, keys: [], dangling: false }],
      via: 'prereq-table', source: p.source,
    });
  }
  // ④ Mermaid 任务依赖图：与文字关系取并集（design §3.4.3）。
  const mermaid = parseMermaid(lines, ctx);
  relations.push(...mermaid.relations);
  return { relations, prerequisites: prerequisites.map(({ blocks, ...p }) => p), unknownRelations, mermaidUsed: mermaid.used };
}

// 去掉引用块、列表符与加粗，便于判断「以 依赖 开头」与「句首是引用列表」。
function stripLead(line) {
  return line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/, '').replace(/\*\*/g, '');
}

function makeContext(lines, doc) {
  const inFence = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    inFence[i] = true;
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
    if (f) { fence = f[1]; return; }
    inFence[i] = false;
  });

  const byNum = new Map();
  for (const t of doc.tasks) if (!byNum.has(t.number)) byNum.set(t.number, t);
  // 代号与分组别名：只认本文档真实存在的（「M0-a」「阶段 0」），长的先试，免得 M1 吃掉 M10。
  const named = doc.groups.flatMap((g) => [g.code, g.alias].filter(Boolean).map((name) => ({ name, g })));
  named.sort((a, b) => b.name.length - a.name.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reGroup = named.length
    ? new RegExp(`(${named.map((n) => esc(n.name).replace(/\s+/g, '\\s*')).join('|')})(?![A-Za-z0-9-])`, 'iy')
    : null;
  const prereqIds = new Set();
  const idRe = new RegExp(doc.prerequisiteIdPattern ?? DEFAULT_PREREQ_ID);
  for (const row of tableRows(lines, inFence)) {
    const id = cleanId(row.cells[0]);
    if (idRe.test(row.cells[0].replace(/\*\*/g, '').trim())) prereqIds.add(id);
  }
  // P 编号：前置表里出现过的，外加默认形态 P\d+（写了但表里没有 → 悬空）。
  const reqAlt = [...prereqIds].map(esc).concat('P\\d+').join('|');
  return {
    doc, inFence, byNum, named, reGroup, prereqIds,
    rePrereq: new RegExp(`(${reqAlt})(?![A-Za-z0-9])`, 'y'),
    rePrereqAll: new RegExp(`(?<![A-Za-z0-9])(${reqAlt})(?![A-Za-z0-9])`, 'g'),
  };
}

const cleanId = (cell) => cell.replace(/[~*\s]/g, '');

// ---- 引用 ----

function taskRef(raw, num, ctx) {
  const t = ctx.byNum.get(num);
  return { raw, type: 'task', keys: t ? [t.key] : [], dangling: !t };
}

// 在 s 的第 i 个字符处读一个 Ref；读不到返回 null。顺序：跨文档键 → P 编号 → 代号 / 别名 → 2.x → 范围 → 编号。
function parseRef(s, i, ctx) {
  const at = (re) => { re.lastIndex = i; const m = re.exec(s); return m ? [m, re.lastIndex] : null; };
  let r;
  if ((r = at(RE_TASK_WORD))) {
    const inner = parseRef(s, r[1], ctx);
    return inner && { ref: { ...inner.ref, raw: s.slice(i, inner.end) }, end: inner.end };
  }
  if ((r = at(RE_KEY))) {
    const [m, end] = r;
    const num = m[2].replace(/^T/, '');
    if (m[1] === ctx.doc.docId) return { ref: { ...taskRef(m[0], num, ctx), type: 'key' }, end };
    return { ref: { raw: m[0], type: 'key', keys: [`${m[1]}#${num}`], dangling: false }, end };
  }
  if ((r = at(ctx.rePrereq))) {
    const [m, end] = r;
    return { ref: { raw: m[0], type: 'prereq', id: m[1], keys: [], dangling: !ctx.prereqIds.has(m[1]) }, end };
  }
  if (ctx.reGroup && (r = at(ctx.reGroup))) {
    const [m, end] = r;
    const norm = (x) => x.replace(/\s+/g, '').toLowerCase();
    const { g } = ctx.named.find((n) => norm(n.name) === norm(m[1]));
    return { ref: { raw: m[0], type: 'group', keys: groupKeys(g, ctx), dangling: false }, end };
  }
  if ((r = at(RE_CHILDREN))) {
    const [m, end] = r;
    const parent = m[1].replace(/^T/, '');
    const keys = ctx.doc.tasks.filter((t) => parentOf(t.number) === parent).map((t) => t.key);
    return { ref: { raw: m[0], type: 'children', keys, dangling: !keys.length }, end };
  }
  if ((r = at(RE_RANGE))) {
    const [m, end] = r;
    const [a, b] = [m[1], m[2]].map((x) => x.replace(/^T/, ''));
    if (!VERSION.test(m[1]) && !VERSION.test(m[2])) {
      // 范围只在同父同层内展开，取区间内实际存在的任务（「1–15」不含 1.1，也不会凭空造出 16）。
      const ok = parentOf(a) === parentOf(b) && depth(a) === depth(b);
      const keys = ok ? ctx.doc.tasks.filter((t) => parentOf(t.number) === parentOf(a) && depth(t.number) === depth(a)
        && compareTaskNumbers(t.number, a) >= 0 && compareTaskNumbers(t.number, b) <= 0 && !t.key.includes('~')).map((t) => t.key) : [];
      return { ref: { raw: m[0], type: 'range', keys, dangling: !keys.length }, end };
    }
  }
  if ((r = at(RE_NUM))) {
    const [m, end] = r;
    if (VERSION.test(m[1])) return null;
    return { ref: taskRef(m[0], m[1].replace(/^T/, ''), ctx), end };
  }
  return null;
}

const parentOf = (n) => n.split('.').slice(0, -1).join('.');
const depth = (n) => n.split('.').length;
const groupKeys = (g, ctx) => ctx.doc.tasks.filter((t) => t.groupId === g.id).map((t) => t.key);

// RefList = Ref ((、|，|,|/|和|及|与) Ref)*；分隔符后面不是 Ref 就停，分隔符不吞。
function parseRefList(s, i, ctx) {
  const refs = [];
  let pos = i;
  for (;;) {
    const r = parseRef(s, pos, ctx);
    if (!r) break;
    refs.push(r.ref);
    pos = r.end;
    RE_SEP.lastIndex = pos;
    if (!RE_SEP.exec(s) || !parseRef(s, RE_SEP.lastIndex, ctx)) break;
    pos = RE_SEP.lastIndex;
  }
  return { refs, end: pos };
}

// 链：RefList (→ RefList)*，每段是一个 RefList。
function parseChain(s, i, ctx) {
  const segments = [];
  let pos = i;
  for (;;) {
    const l = parseRefList(s, pos, ctx);
    if (!l.refs.length) break;
    segments.push(l.refs);
    pos = l.end;
    RE_ARROW.lastIndex = pos;
    if (!RE_ARROW.exec(s) || !parseRef(s, RE_ARROW.lastIndex, ctx)) break;
    pos = RE_ARROW.lastIndex;
  }
  return { segments, end: pos };
}

// 引用可以开始的位置：前一个字符不是编号的一部分（免得从「8.1–8.5」中间的「1–8.5」读起）。
function* starts(s) {
  for (let i = 0; i < s.length; i++) if (i === 0 || !/[A-Za-z0-9.#\-–—〜～~]/.test(s[i - 1])) yield i;
}

// 找第一个紧跟着 suffix 的引用列表 / 链。
function findBefore(s, suffix, ctx, parse = parseRefList) {
  for (const i of starts(s)) {
    const l = parse(s, i, ctx);
    const n = l.refs ?? l.segments;
    if (n.length && suffix.test(s.slice(l.end))) return l;
  }
  return null;
}

const hasRef = (s, ctx) => [...starts(s)].some((i) => parseRef(s, i, ctx));

// ---- 句与子句 ----

/**
 * 切句（；;。换行）→ 切子句（，,）→ 子句继承本句主语 → 七种模式按序匹配、命中即止。
 * subjectLead 为分组说明段上下文时，句首的引用列表（可带「起」）改作本句主语。
 * @returns {({kind, subjects, objects} | {unknown: string})[]}
 */
function scanText(text, subjects, ctx, subjectLead) {
  // 删除线片段是作废的说法（「~~需要 P2 的 key~~」），不参与。
  const clean = breakParens(text.replace(/~~.*?~~/g, ' ').replace(/\*\*|`/g, ''));
  const out = [];
  // 英文句号：「. 」后接大写字母才算句界（编号里的点、「1. 」列表号都不切）。
  for (const sentence of clean.split(/[；;。\n]|\.\s+(?=[A-Z])/)) {
    let subj = subjects;
    if (subjectLead) {
      const s = sentence.trimStart();
      const l = parseRefList(s, 0, ctx);
      if (l.refs.length) subj = /^\s*(?:起|以降|onwards?\b)/i.test(s.slice(l.end)) ? [fromRef(l.refs[0], subjectLead)] : l.refs;
    }
    for (const clause of splitClauses(sentence, ctx)) {
      const c = clause.trim();
      if (!c) continue;
      const r = matchClause(c, subj, ctx);
      if (r) out.push(...r);
      else if (KEYWORD.test(c) && hasRef(c, ctx)) out.push({ unknown: c });
    }
  }
  return out;
}

// 最外层括号的两端当句界（标题「六（1 → 2 / 3 → 4）」的括号内容自成一句）；
// 嵌套括号当空白，免得「需要 P1 + P2（说明）+ P5」被切散。
function breakParens(s) {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '（' || ch === '(') out += depth++ === 0 ? '\n' : ' ';
    else if ((ch === '）' || ch === ')') && depth > 0) out += --depth === 0 ? '\n' : ' ';
    else out += ch === '）' || ch === ')' ? ' ' : ch;
  }
  return out;
}

// 按逗号切子句；但逗号两侧都是引用时它是列表分隔符（「依赖 0.1, T20」「1.1, 1.2 可并行」），不切。
// 日文句子（含假名）的「、」见 CLAUSE_KEY：两侧都有关系词才切。
function splitClauses(sentence, ctx) {
  const out = [];
  const pieces = KANA.test(sentence) ? sentence.split(/[，,]/).flatMap(splitKanaComma) : sentence.split(/[，,]/);
  for (const piece of pieces) {
    // 英文牛津逗号「1, 2, and 3」：逗号后的 and 也算列表分隔的一部分。
    const lead = piece.length - piece.replace(/^\s*(?:and\s+)?/, '').length;
    if (out.length && /[A-Za-z0-9]\s*$/.test(out.at(-1)) && parseRef(piece, lead, ctx)) out[out.length - 1] += `,${piece}`;
    else out.push(piece);
  }
  return out;
}

function splitKanaComma(piece) {
  const out = [];
  for (const part of piece.split('、')) {
    if (out.length && CLAUSE_KEY.test(out.at(-1)) && CLAUSE_KEY.test(part)) out.push(part);
    else if (out.length) out[out.length - 1] += `、${part}`;
    else out.push(part);
  }
  return out;
}

// 「2.5 起」= 2.5 及本组文档顺序在其后的任务。
function fromRef(ref, { members }) {
  const idx = members.findIndex((t) => ref.keys.includes(t.key));
  const keys = idx < 0 ? [] : members.slice(idx).map((t) => t.key);
  return { raw: `${ref.raw} 起`, type: 'from', keys, dangling: !keys.length };
}

// 各模式的英文 / 日文同义写法（中文原写法放在每个正则最前面，行为不变）。
// 1. 文档声明无依赖 / 不依赖
const NONE_DECL = /依赖\s*[:：]\s*无|依存\s*[:：]\s*なし|\b(?:depends?(?:\s+on)?|dependenc(?:y|ies))\s*[:：]?\s*(?:none|nothing)\b/i;
const NO_DEP = /不依赖|无依赖|依存なし|依存しない|\bno\s+dependenc(?:y|ies)\b|\b(?:does|do)\s*n[o']t\s+depend\b/i;
// 2. 强关键词前缀：后面紧跟引用就算依赖。「前提」中文叙述也用，只认日文的「前提タスク」。
const DEP_LEAD = /(?:依赖|前置|依存(?:関係|先)?|前提(?=\s*タスク)|\b(?:depends?\s+on|depends?|dependenc(?:y|ies)(?:\s+on)?|blocked\s+by)\b)\s*[:：]?\s*/gi;
const DONE_AFTER = /^\s*(?:完成后|に依存|(?:の|が)?\s*完了(?:後|したら|してから))/;
// 弱关键词 requires / after 在英文叙述里太常见（「after 3 retries」「requires 2 GB」），只认三种：
// 带冒号、引用不是裸编号（task 3、M1、P1、other#3、2.x），或引用列表结束子句 / 后接完成动词（after 3 is done）。
const WEAK_LEAD = /\b(?:requires?|after)\b\s*([:：])?\s*/gi;
const WEAK_END = /^\s*[.!?。]?\s*$|^\s+(?:(?:is|are|has\s+been|have\s+been)\s+)?(?:done|complete[ds]?|finish(?:es|ed)?|merged|lands?|landed)\b/i;
const TASK_WORD_AHEAD = /^(?:任务|タスク|[Tt]asks?)/;
// 3. 外部前置：「需要 / needs / requires」之后、或日文「… が必要」整句里的 P 编号
const NEED = /需要|\b(?:needs?|requires?)\b/i;
// 4. 与 X 并行
const PAR_WITH_EN = /\b(?:can\s+(?:run|be\s+done|go)\s+)?(?:in\s+)?parallel\s+(?:with|to)\s+/gi;
const PAR_WITH_JA = /^\s*と\s*(?:は\s*)?並行/;
const PAR_LEAD = /^(?:并行|parallel(?:\s+with)?|並行)\s*[:：]\s*/i;
// 5. 列表内两两并行
const PAR_AMONG = /^\s*(?:可?并行|(?:(?:can|may)\s+(?:run|be\s+done|go)\s+|(?:are|run)\s+)?(?:in\s+)?parallel\b(?!\s+(?:with|to)\b)|(?:は|を|も)?\s*並行)/i;
// 6. 依次 / 串行；「in order to」是普通叙述
const SEQ = /^\s*(?:依次|串行|in\s+(?:order|sequence)\b(?!\s+to\b)|sequentially\b|serially\b|(?:を|の)?\s*(?:順に|順番に|直列))/i;
const SEQ_LEAD = /^(?:顺序|order|sequence|順序|順番)\s*[:：]\s*/i;

function matchClause(c, subjects, ctx) {
  const dep = (objects, subj = subjects) => ({ kind: 'dep', subjects: subj, objects });
  const par = (objects, subj = subjects) => ({ kind: 'parallel', subjects: subj, objects });

  // 1. 不依赖 / 无依赖 / 依赖：无 → 无边；最后一种记成 none，页面可写「文档声明无依赖」。
  if (NONE_DECL.test(c)) return [{ kind: 'none', subjects, objects: [] }];
  if (NO_DEP.test(c)) return [];

  // 2. [主语 [起]] 依赖 / 前置 RefList；或 RefList 完成后；英文弱关键词见 WEAK_LEAD。
  for (const m of c.matchAll(DEP_LEAD)) {
    const l = parseRefList(c, m.index + m[0].length, ctx);
    if (l.refs.length) return [dep(l.refs)];
  }
  const done = findBefore(c, DONE_AFTER, ctx);
  if (done) return [dep(done.refs)];
  for (const m of c.matchAll(WEAK_LEAD)) {
    const at = m.index + m[0].length;
    const l = parseRefList(c, at, ctx);
    if (!l.refs.length || l.refs[0].type === 'prereq') continue; // 「requires P1 …」交给第 3 条收全部 P 编号
    const marked = m[1] || TASK_WORD_AHEAD.test(c.slice(at)) || !['task', 'range'].includes(l.refs[0].type);
    if (marked || WEAK_END.test(c.slice(l.end))) return [dep(l.refs)];
  }

  // 3. 「需要 …」里的前置条件编号 → 外部阻塞（「需要 P1 sandbox + P2（…）+ P5 白名单」）。
  const need = NEED.exec(c)?.index ?? (/が必要/.test(c) ? 0 : -1);
  if (need >= 0) {
    const ids = [...c.slice(need).matchAll(ctx.rePrereqAll)].map((m) => m[1]);
    if (ids.length) return [dep(ids.map((id) => ({ raw: id, type: 'prereq', id, keys: [], dangling: !ctx.prereqIds.has(id) })))];
  }

  // 4. [可]与 RefList [可]并行；parallel with RefList；RefList と並行；正文行「并行：RefList」同义。
  for (const m of c.matchAll(/可?与\s*/g)) {
    const l = parseRefList(c, m.index + m[0].length, ctx);
    if (l.refs.length && /^\s*可?并行/.test(c.slice(l.end))) return [par(tasksOnly(l.refs))];
  }
  for (const m of c.matchAll(PAR_WITH_EN)) {
    const l = parseRefList(c, m.index + m[0].length, ctx);
    if (l.refs.length) return [par(tasksOnly(l.refs))];
  }
  const withJa = findBefore(c, PAR_WITH_JA, ctx);
  if (withJa) return [par(tasksOnly(withJa.refs))];
  const lead = PAR_LEAD.exec(c);
  if (lead) {
    const l = parseRefList(c, lead[0].length, ctx);
    if (l.refs.length) return [par(tasksOnly(l.refs))];
  }

  // 5. RefList 可并行 → 列表内两两并行。
  const among = findBefore(c, PAR_AMONG, ctx);
  if (among) { const r = tasksOnly(among.refs); return [par(r, r)]; }

  // 6. RefList 依次 / 串行，或子句只由 Ref、→、/ 组成（正文行可带「顺序：」前缀）。
  const seq = findBefore(c, SEQ, ctx, parseChain);
  if (seq) return chain(seq.segments.length > 1 ? seq.segments : seq.segments[0].map((r) => [r]));
  const bare = c.replace(SEQ_LEAD, '');
  const whole = parseChain(bare, 0, ctx);
  const count = whole.segments.flat().length;
  if (whole.end === bare.length && count > 1) return chain(whole.segments);

  return null;
}

// 前置条件编号不参与并行。
const tasksOnly = (refs) => refs.filter((r) => r.type !== 'prereq');

// 相邻段之间 dep（后段依赖前段）；同段多项两两 parallel。
function chain(segments) {
  const out = [];
  segments.forEach((seg, k) => {
    if (k > 0) out.push({ kind: 'dep', subjects: seg, objects: segments[k - 1] });
    if (seg.length > 1) out.push({ kind: 'parallel', subjects: seg, objects: seg });
  });
  return out;
}

// ---- 前置条件表（design §3.3，需求 4.6）----

function* tableRows(lines, inFence) {
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFence[i] || !/^\s*\|/.test(line)) { header = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) { header = cells; continue; }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    yield { i, cells, header };
  }
}

// 英文 / 日文的解除标记：只认完整、肯定的写法——状态词出现在单元格开头、括号开头或逗号 / 分号 / 冒号之后，
// 并且后面紧跟的是结尾、右括号、分隔符、日期，或「：说明」（说明不能是 no / false / 未… 这类否定值）；
// 另认整个括号里只有 done / provided（可带日期）。「resolved?」「解決済み？」「解決済みではなく未対応」
// 「resolved: no」「resolved = false」「resolved by ops」都不算（宁可多挡，不提前放行）。
const RESOLVED_WORD = /(?:^|[(（[【,，;；：:])\s*(?:resolved|(?:解決|提供|対応)済み?)(?![A-Za-z])/gi;
const RESOLVED_PAREN = /[(（]\s*(?:done|provided)(?:[\s:：,]*\d{4}-\d{2}-\d{2})?\s*[)）]/i;
function resolvedMark(cell) {
  if (RESOLVED_PAREN.test(cell)) return true;
  for (const m of cell.matchAll(RESOLVED_WORD)) {
    const rest = cell.slice(m.index + m[0].length);
    if (/^\s*(?:$|[)）\]】,，;；。]|[(（]?\s*\d{4}-\d{2}-\d{2})/.test(rest)) return true;
    if (/^\s*[:：=]\s*(?!(?:no|false|not|n|いいえ|未)(?![A-Za-z]))\S/i.test(rest)) return true;
  }
  return false;
}

function parsePrereqTable(lines, ctx, pattern) {
  const idRe = new RegExp(pattern ?? DEFAULT_PREREQ_ID);
  const out = [];
  for (const { i, cells, header } of tableRows(lines, ctx.inFence)) {
    if (!idRe.test(cells[0].replace(/\*\*/g, '').trim())) continue;
    const id = cleanId(cells[0]);
    const struck = (c) => /^(?:\*\*)?~~(?:(?!~~).)+~~(?:\*\*)?$/.test(c);
    // 解除 = 首列或第二列整体被划掉，或这两列写了已决 / 已解决 / 已提供。
    // 英文 / 日文只认明确的解除标记（见 resolvedMark），「not resolved」「to be resolved」「解決済みではない」不算。
    const resolved = cells[0].includes('~~') || struck(cells[1] ?? '')
      || /已决|已解决|已提供/.test(`${cells[0]}${cells[1] ?? ''}`)
      || [cells[0], cells[1] ?? ''].some((c) => resolvedMark(c.replace(/\*\*/g, '').trim()));
    // 「阻塞」列按表头找，找不到按第三列；先删掉划掉的片段（「~~1.1~~（已完成）」）。
    const col = header?.findIndex((h) => /阻塞|\bblock|ブロック/i.test(h)) ?? -1;
    const cell = (cells[col >= 0 ? col : 2] ?? '').replace(/~~.*?~~/g, ' ').replace(/（[^）]*）|\([^)]*\)/g, ' ').replace(/\*\*|`/g, '');
    const blocks = /不阻塞|无阻塞|non-?blocking|not\s+blocking|ブロックしない/i.test(cell) || /^[\s，,、。；;]*(?:无|none|なし)[\s。.]*$/i.test(cell) || !cell.trim()
      ? []
      : scanRefs(cell, ctx).filter((r) => r.type !== 'prereq');
    const blocksNums = blocks.flatMap((r) => (r.keys.length ? r.keys.map((k) => k.split('#')[1]) : [r.raw.replace(/^T/, '')]));
    out.push({
      id, resolved, blocksNums, blocks,
      source: { file: ctx.doc.file, line: i + 1, text: lines[i].trim().slice(0, 160) },
    });
  }
  return out;
}

// 阻塞列不是严格的列表（「1.2、1.7、13、14」「8.5、13」），把能读出的引用都收下。
function scanRefs(s, ctx) {
  const refs = [];
  let skipTo = 0;
  for (const i of starts(s)) {
    if (i < skipTo) continue;
    const r = parseRef(s, i, ctx);
    if (r) { refs.push(r.ref); skipTo = r.end; }
  }
  return refs;
}

// ---- Mermaid 任务依赖图（design §3.4.3）----

// 节点标签开头的首个 token 映射任务号（「UI[18 2.0.6 UI改进轮]」→ 18）；版本号开头的标签对不上任务，自然不映射。
const MERMAID_NODE_TASK = new RegExp(`^(?:任务\\s*|タスク\\s*|Task\\s*)?(${NUM})(?=[\\s:：]|$)`);
// 三种箭头 `-->`（含 `--->`）、`-.->`、`==>`，箭头后可带 `|说明|`。`---` 这类无箭头连线不是依赖。
const MERMAID_ARROW = /\s*(?:-\.+->|={2,}>|-{2,}>)\s*(?:\|[^|]*\|)?\s*/;
const MERMAID_SKIP = /^(?:subgraph|end|style|classDef|class|click|linkStyle|direction)\b/;

/**
 * 只看 ```mermaid 围栏里以 flowchart / graph 开头的图；每张图单独判定是否启用：
 * ≥ 一半节点能映射到本文档任务才采信，否则整图忽略（架构图、`PR1 --> PR2` 这类图）。
 * 边 `A --> B` 读作「B 依赖 A」，链式 `A --> B --> C` 拆成相邻两两；两端都映射到任务的边才产出。
 * @returns {{ relations: RawRelation[], used: boolean }} relations 的 via 为 'mermaid'，source 指向边所在行。
 */
function parseMermaid(lines, ctx) {
  const out = { relations: [], used: false };
  let fence = null;
  let body = null; // 当前 mermaid 围栏内的行号（0 起）；非 mermaid 围栏为 null
  lines.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
        if (body) {
          const rels = mermaidGraph(body, lines, ctx);
          if (rels) { out.used = true; out.relations.push(...rels); }
        }
        fence = null;
        body = null;
      } else body?.push(i);
      return;
    }
    if (f) { fence = f[1]; body = /^\s*mermaid\s*$/i.test(line.slice(f[0].length)) ? [] : null; }
  });
  return out;
}

// 一张图 → 关系列表；不是 flowchart / graph 或映射不足一半 → null。
function mermaidGraph(idxs, lines, ctx) {
  const stmts = idxs.map((i) => ({ i, s: lines[i].replace(/%%.*$/, '').trim() })).filter((x) => x.s);
  if (!stmts.length || !/^(?:flowchart|graph)\b/.test(stmts[0].s)) return null;
  const labels = new Map(); // 节点 id → 标签（没写形状的节点标签为 null，按 id 本身映射）
  const chains = []; // { i, ids: 按箭头切开的节点 id 序列 }
  for (const { i, s } of stmts.slice(1)) {
    if (MERMAID_SKIP.test(s)) continue;
    const ids = s.split(MERMAID_ARROW).map((part) => {
      // 节点 = id + 可选形状（[..] (..) {..} ((..)) [[..]] >..] 等）+ 可选 :::class
      const m = /^([\p{L}\p{N}_.]+)\s*(.*)$/u.exec(part.replace(/:::[\w-]+/g, '').trim());
      if (!m) return null;
      const label = /^[[({>]/.test(m[2]) ? m[2].replace(/^[[({>/\\]+|[\])}/\\]+$/g, '').trim().replace(/^"(.*)"$/, '$1') : null;
      if (label !== null || !labels.has(m[1])) labels.set(m[1], label);
      return m[1];
    });
    if (ids.length > 1) chains.push({ i, ids });
  }
  const refs = new Map(); // 节点 id → 任务 Ref；映射不上的不在表里
  for (const [id, label] of labels) {
    const m = MERMAID_NODE_TASK.exec(label ?? id);
    const t = m && ctx.byNum.get(m[1].replace(/^T/, ''));
    if (t) refs.set(id, { raw: m[1], type: 'task', keys: [t.key], dangling: false });
  }
  if (!labels.size || refs.size * 2 < labels.size) return null;

  const rels = [];
  for (const { i, ids } of chains) {
    for (let k = 1; k < ids.length; k++) {
      const [from, to] = [refs.get(ids[k - 1]), refs.get(ids[k])];
      if (!from || !to) continue;
      rels.push({
        kind: 'dep', subjects: [to], objects: [from], via: 'mermaid',
        source: { file: ctx.doc.file, line: i + 1, text: lines[i].trim().slice(0, 160) },
      });
    }
  }
  return rels;
}
