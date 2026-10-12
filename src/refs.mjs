// 引用识别与消歧（design §3.5）。PR 标题 / 描述 / 分支名与会话文本共用一套口径。
// 纯函数：不读文件、不读时钟。只认「有标记」的写法（design K6）：完整任务键、`任务 N` / `Task N`、
// 文档里真实存在的里程碑代号；裸数字一律不认——实物 PR 标题里的裸数字几乎都是版本号 / 章节号（需求 6.4）。

import { compareTaskNumbers } from './docs.mjs';

const NUM = 'T?\\d+[a-z]?(?:\\.\\d+[a-z]?)*';
const DASH = '[–—〜-]';
// 英文 and / &（含「, and」）、日文「と」也是列表分隔（「Tasks 3 and 4」「タスク 3 と 4」）。
const SEP = '(?:、|，|,\\s*and(?![A-Za-z])|,|/|和|及|与|&|(?<![A-Za-z])and(?![A-Za-z])|と)';
// 列表里的一项：编号或范围（4.1–4.3）。
const ITEM = `${NUM}(?:\\s*${DASH}\\s*${NUM})?`;
// 带前缀编号：任务 15.2 / Task: 3 / Tasks 3 and 4 / タスク 3 / 任务 4.1–4.3、4.5。前面不能紧贴字母（subtask 3 不算）；
// 编号后不能紧跟字母数字或「.数字」，免得半截匹配。
// 「部分」标记的全部写法只在这里定义（N9）：紧跟在引用后面，括号里写 部分 / 部分完成 / 一部 / partial / part，
// 或不带括号的「部分」「部分完成」（可隔一个逗号：「任务 99，部分」），后面不能再接文字（「部分页面」是普通叙述）。
// 修饰紧挨着的那一处引用：带前缀的编号列表整条算部分（「任务 13、14（部分）」）；任务键、里程碑代号只修饰它自己，
// 代号带标记 = 这个代号展开的整组任务都算部分交付（owner 2026-10-12）。
const PARTIAL = '\\s*(?:[（(]\\s*(?:部分(?:完成)?|一部|[Pp]art(?:ial)?)\\s*[)）]|[，,]?\\s*部分(?:完成)?(?![\\u3040-\\u30ff\\u3400-\\u9fffA-Za-z0-9]))';
const PREFIXED = new RegExp(
  `(?<![A-Za-z])(?:任务|タスク|[Tt]asks?)\\s*[:：#]?\\s*(${ITEM}(?:\\s*${SEP}\\s*${ITEM})*)(?![A-Za-z0-9]|\\.\\d)(${PARTIAL})?`, 'g');
const ITEM_RE = new RegExp(`(${NUM})(?:\\s*${DASH}\\s*(${NUM}))?`, 'g');
// PR 标题末尾的版本括号「(collab 2.0.4)」「(1.15.743–744)」：识别前先遮掉，作第二道保险。
const VERSION_PAREN = /\(\s*[a-z]*\s*\d+\.\d+\.\d+(?:\s*[–-]\s*\d+)?\s*\)/gi;
// conventional-commit 头：「[V2] docs+fix(collab):」→ scope collab；多 scope 用 , / 分隔。
const CC_SCOPE = /^\s*(?:\[[^\]]*\]\s*)?[A-Za-z]+(?:[+/][A-Za-z]+)*\(([^)]+)\)!?\s*[:：]/;
// 遮盖已识别片段用的字符：不是空白、不是 [A-Za-z0-9-]，所以既不会拼出新词，也不会破坏词边界判断。
const MASK = '\u0001';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripT = (n) => n.replace(/^T/, '');
const lower = (s) => s.toLowerCase();

/**
 * @typedef {{ kind: 'key'|'num'|'code'|'docId', text: string, index: number }} RefSpan
 * @typedef {{ keys: string[], nums: string[], codes: string[], docIds: string[], scopes: string[],
 *   partial: string[], unknown: string[], spans: RefSpan[] }} RawRefs
 *   keys   完整任务键 `docId#编号`；
 *   nums   带前缀的编号，范围写成 `A–B`（统一成长横），按文档展开在 resolveRefs 里做；
 *   codes  里程碑代号，取 knownCodes 里的写法；
 *   docIds 文本中出现的已知 docId（含完整任务键里的），用于收窄；
 *   scopes conventional-commit scope（design 签名外新增，收窄用）；
 *   partial 带「部分」标记（见 PARTIAL）的引用，取 keys / nums / codes 里的同一写法；同一段里另有不带标记的同一引用时
 *          仍算部分（保守，owner 2026-10-12）；
 *   unknown 看着像任务键 / 里程碑代号、却对不上 knownDocIds / knownCodes 的原文（大小写写错的 `Devboard-MVP#3`、对不上的 `ADR-0099#3`、`M0-z`），
 *          不参与 resolveRefs，由调用方报出来（N9：看得出意图却认不了的写法不能静默丢掉）；
 *   spans  每处命中的原文与位置（NFC 后文本的下标），给页面展示依据。
 */

/**
 * 从一段文本（PR 标题 / 描述、会话消息）里识别引用。
 * @param {string} text
 * @param {{ knownDocIds?: string[], knownCodes?: string[] }} [opts]
 *   knownCodes 应是候选文档里真实存在的代号（design §3.5 第 3 条）；不在表里的一律不认。
 * @returns {RawRefs}
 */
export function extractRefs(text, { knownDocIds = [], knownCodes = [] } = {}) {
  let s = (text ?? '').normalize('NFC');
  const out = { keys: [], nums: [], codes: [], docIds: [], scopes: [], partial: [], unknown: [], spans: [] };
  const scope = CC_SCOPE.exec(s);
  if (scope) out.scopes = scope[1].split(/[,/]/).map((x) => x.trim()).filter(Boolean);

  const mask = (index, length) => { s = s.slice(0, index) + MASK.repeat(length) + s.slice(index + length); };
  const scan = (re, fn) => { for (const m of [...s.matchAll(re)]) { fn(m); mask(m.index, m[0].length); } };
  const push = (list, v) => { if (!list.includes(v)) list.push(v); };

  scan(VERSION_PAREN, () => {});

  // docId 前后不能是 [A-Za-z0-9_-]，长的先匹配（collab-m0 不会吃掉 collab-m0-space-run 的前半截）。
  const ids = [...new Set(knownDocIds)].sort((a, b) => b.length - a.length);
  if (ids.length) {
    const alt = ids.map(escapeRe).join('|');
    scan(new RegExp(`(?<![A-Za-z0-9_-])(${alt})#(${NUM})(?![A-Za-z0-9]|\\.\\d)(${PARTIAL})?`, 'g'), (m) => {
      const key = `${m[1]}#${stripT(m[2])}`;
      push(out.keys, key); push(out.docIds, m[1]);
      if (m[3]) push(out.partial, key);
      out.spans.push({ kind: 'key', text: m[0], index: m.index });
    });
    scan(new RegExp(`(?<![A-Za-z0-9_-])(${alt})(?![A-Za-z0-9_-])`, 'g'), (m) => {
      push(out.docIds, m[1]);
      out.spans.push({ kind: 'docId', text: m[0], index: m.index });
    });
  }

  scan(PREFIXED, (m) => {
    for (const it of m[1].matchAll(ITEM_RE)) {
      const n = it[2] ? `${stripT(it[1])}–${stripT(it[2])}` : stripT(it[1]);
      push(out.nums, n);
      if (m[2]) push(out.partial, n);
    }
    out.spans.push({ kind: 'num', text: m[0].trim(), index: m.index });
  });

  // 代号整词、忽略大小写：前后不是 [A-Za-z0-9-]（M0-c 不会命中 M0-cd，也不会命中 xM0-c）。
  const codes = [...new Set(knownCodes)].sort((a, b) => b.length - a.length);
  if (codes.length) {
    const byLower = new Map(codes.map((c) => [lower(c), c]));
    scan(new RegExp(`(?<![A-Za-z0-9-])(${codes.map(escapeRe).join('|')})(?![A-Za-z0-9-])(${PARTIAL})?`, 'gi'), (m) => {
      const code = byLower.get(lower(m[1]));
      push(out.codes, code);
      if (m[2]) push(out.partial, code);
      out.spans.push({ kind: 'code', text: m[0], index: m.index });
    });
  }

  // 剩下的文本里，像任务键或像已知代号形态的写法记进 unknown。任务键只认两种：文档名大小写写错（Devboard-MVP#3），
  // 或 ADR 编号对不上（ADR-0099#3）；其余 `词#编号` 多是别的仓库的 issue / PR（other-vendor#127），不报。
  // 代号：同样的字母前缀、同样有没有「-后缀」（已知 M0-c 时 M0-z 算，M2 不算）。
  const lowIds = new Set(ids.map(lower));
  scan(new RegExp(`(?<![A-Za-z0-9_./-])([A-Za-z][\\w.-]*)#${NUM}(?![A-Za-z0-9]|\\.\\d)`, 'g'), (m) => {
    if (lowIds.has(lower(m[1])) || /^ADR-\d+$/i.test(m[1])) push(out.unknown, m[0]);
  });
  const shapes = new Set(codes.map(codeShape).filter(Boolean));
  if (shapes.size) {
    scan(/(?<![A-Za-z0-9-])[A-Za-z]+\d+(?:-[A-Za-z0-9]+)?(?![A-Za-z0-9-])/g, (m) => { if (shapes.has(codeShape(m[0]))) push(out.unknown, m[0]); });
  }
  return out;
}

// 代号形态：小写字母前缀 + 有没有「-后缀」（M0-c → 'm-'，M1 → 'm'）；不是「字母+数字[-后缀]」的代号不参与。
const codeShape = (c) => { const m = /^([A-Za-z]+)\d+(-[A-Za-z0-9]+)?$/.exec(c); return m && lower(m[1]) + (m[2] ? '-' : ''); };

/**
 * 从 head 分支名识别引用（design §3.5 第 6 条；只在标题与描述都无引用时由调用方启用）。
 * 按 / - _ 切词：`task-<编号>`；词去掉非字母数字后等于某代号（collab-m0d → M0-d）；
 * 带点的编号词（collab-15.2-docs → 15.2）。三段纯数字的词视为版本号（release-2.0.4）不认。
 * @param {string} branch
 * @param {{ knownCodes?: string[] }} [opts]
 * @returns {RawRefs}
 */
export function extractBranchRefs(branch, { knownCodes = [] } = {}) {
  const out = { keys: [], nums: [], codes: [], docIds: [], scopes: [], partial: [], unknown: [], spans: [] };
  const norm = (c) => lower(c).replace(/[^a-z0-9]/g, '');
  const codeOf = new Map(knownCodes.map((c) => [norm(c), c]));
  const b = (branch ?? '').normalize('NFC');
  const words = b.split(/[/_-]/);
  const push = (kind, v, text) => {
    const list = kind === 'code' ? out.codes : out.nums;
    if (!list.includes(v)) list.push(v);
    out.spans.push({ kind, text, index: b.indexOf(text) });
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (lower(w) === 'task' && next && new RegExp(`^${NUM}$`).test(next)) { push('num', stripT(next), next); i++; }
    else if (codeOf.has(norm(w))) push('code', codeOf.get(norm(w)), w);
    else if (/^\d+[a-z]?(?:\.\d+[a-z]?)+$/.test(w) && !/^\d+\.\d+\.\d+/.test(w)) push('num', w, w);
  }
  return out;
}

/**
 * 把识别结果落到具体任务上。每条引用在收窄后的候选文档里**恰好一处**命中才关联；
 * 多处 → ambiguous（不猜）；零处 → missing（不静默丢弃，需求 6.7）。重复编号任务不参与（需求 2.8）。
 *
 * 收窄顺序（先命中者生效）：
 *   1. 文本里出现了 docId → 只在这些文档里找（严格：候选里没有这些文档则全部 missing，宁缺不猜）；
 *   2. 会话上下文 docId（design §3.8.3）→ 与候选的交集非空才收窄；
 *   3. conventional-commit scope 命中部分 docId（docId 按 - _ . / 切词后含该 scope）→ 非空才收窄。
 * 完整任务键不走收窄，直接在候选里按键查。
 *
 * @param {RawRefs} raw
 * @param {{ docId: string, groups: {id: string, code: string|null}[],
 *   tasks: {key: string, number: string, groupId: string|null, void: boolean, duplicate: boolean}[] }[]} candidates
 *   PR 所属分支线 docFilter 过滤后的文档（会话见 §3.8.3）
 * @param {string[]} [ctxDocIds]
 * @returns {{ tasks: string[], ambiguous: { raw: string, candidates: string[] }[], missing: string[] }}
 *   tasks 为去重后的任务键，按引用出现顺序、同一引用内按文档顺序；
 *   ambiguous.candidates 为每处命中的位置 `docId#引用`（编号即任务键；代号如 `collab-m0-space-run#M0-c`）；
 *   missing 为原样的引用（`15.9`、`4.1–4.3`、`M0-z`、`doc#3`）。
 */
export function resolveRefs(raw, candidates, ctxDocIds = []) {
  const pool = narrow(raw, candidates, ctxDocIds);
  const tasks = [];
  const ambiguous = [];
  const missing = [];
  const add = (keys) => { for (const k of keys) if (!tasks.includes(k)) tasks.push(k); };

  for (const key of raw.keys) {
    const i = key.lastIndexOf('#');
    const doc = candidates.find((d) => d.docId === key.slice(0, i));
    const hit = doc && matchNum(doc, key.slice(i + 1));
    if (hit?.length) add(hit); else missing.push(key);
  }

  const resolveOne = (ref, match) => {
    const hits = pool.map((doc) => ({ doc, keys: match(doc) })).filter((h) => h.keys.length);
    if (hits.length === 1) add(hits[0].keys);
    else if (hits.length > 1) ambiguous.push({ raw: ref, candidates: hits.map((h) => `${h.doc.docId}#${ref}`) });
    else missing.push(ref);
  };
  for (const n of raw.nums) resolveOne(n, (doc) => matchNum(doc, n));
  for (const c of raw.codes) {
    resolveOne(c, (doc) => {
      const groupIds = new Set(doc.groups.filter((g) => g.code && lower(g.code) === lower(c)).map((g) => g.id));
      // 代号 = 该分组全部未作废任务（子任务与父任务同组平铺，按组取即含子任务）。
      return doc.tasks.filter((t) => groupIds.has(t.groupId) && !t.void && !t.duplicate).map((t) => t.key);
    });
  }
  return { tasks, ambiguous, missing };
}

function narrow(raw, candidates, ctxDocIds) {
  if (raw.docIds.length) return candidates.filter((d) => raw.docIds.includes(d.docId));
  const ctx = candidates.filter((d) => ctxDocIds.includes(d.docId));
  if (ctx.length) return ctx;
  const scopes = raw.scopes.map(lower);
  const byScope = candidates.filter((d) => lower(d.docId).split(/[-_./]/).some((w) => scopes.includes(w)));
  return byScope.length ? byScope : candidates;
}

// 单个编号 → 该任务；范围 A–B → 与 A 同父同层、落在区间内的实际存在任务（端点不必存在）。
function matchNum(doc, ref) {
  const usable = doc.tasks.filter((t) => !t.duplicate);
  const [a, b] = ref.split('–');
  if (!b) return usable.filter((t) => t.number === a).map((t) => t.key);
  const parent = (n) => n.split('.').slice(0, -1).join('.');
  const depth = (n) => n.split('.').length;
  if (parent(a) !== parent(b) || depth(a) !== depth(b)) return [];
  return usable
    .filter((t) => depth(t.number) === depth(a) && parent(t.number) === parent(a)
      && compareTaskNumbers(a, t.number) <= 0 && compareTaskNumbers(t.number, b) <= 0)
    .map((t) => t.key);
}
