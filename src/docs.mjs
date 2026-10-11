// 规划文档（design §3.2、§3.3）：parseTasksDoc 是纯函数（输入文本、输出结构，不读时钟）；
// 文件后半部分是文档发现、只读 git 封装与本地同步检查，会读文件与跑白名单内的只读 git。
// 关系语法与前置条件表在 relations.mjs。
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { parseRelations } from './relations.mjs';
import { discoverAdrs, parseAdrDoc } from './adr.mjs';
import { msg, joinList } from './msg.mjs';
import { gitEnv } from './config.mjs';

const DEFAULT_MILESTONE_CODE = '(?:里程碑|[Mm]ilestone|マイルストーン)\\s*([A-Za-z]+\\d+(?:-[A-Za-z0-9]+)?)';
// 分组别名只供文档内依赖引用（「依赖 阶段 1」「depends on Phase 1」「フェーズ 1 に依存」），不参与 PR / 会话匹配。
const GROUP_ALIAS = /(?:阶段|[Pp]hase|[Ss]tage|フェーズ|PR)\s*\d+[a-z]?/;
const NUM = 'T?\\d+[a-z]?(?:\\.\\d+[a-z]?)*';
// design §3.3 的任务行正则；复选框放宽成任意单字符，空格 / x / X / ~ 以外的按未勾处理并记诊断。
// 分组：1 复选框 2 开头删除线 3 开头加粗 4 编号原文(label) 5 编号 6 标题剩余部分
const TASK_LINE = new RegExp(`^\\s*[-*]\\s+\\[(.)\\]\\s+(~~)?(\\*\\*)?((?:Task\\s*|タスク\\s*)?(${NUM})\\.?)[\\s:：](.*)$`);
const CHECKBOX_LINE = /^\s*[-*]\s+\[(.)\](?:\s+(.*))?$/;
// 复选框后以数字 / T数字 / **数字 开头却没通过任务行正则 = 疑似任务行（写法有误），要让 owner 看到。
const SUSPECT = /^(?:~~)?(?:\*\*)?(?:Task\s*|タスク\s*)?T?\d/;
// 标题式任务必须带 Task / T，避免把「## 0. 需要 owner 提供的前置条件」认成任务。
const TITLE_TASK = /^(?:Task\s*|タスク\s*|T)(\d+[a-z]?(?:\.\d+)*)\s*(✅)?\s*[:：—-]\s*(.*)$/;
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
 *            unknownRelations: object[], unknownEstimates: SourceRef[], mermaidUsed: boolean,
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
  if (titleMode) {
    for (const it of items) {
      const t = it.kind === 'heading' && it.level >= 2 && it.level <= 4 && TITLE_TASK.exec(it.text);
      if (t) Object.assign(it, { kind: 'title-task', t });
    }
  }

  const groups = [];
  const tasks = [];
  const unknownEstimates = [];
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
  const parse = { state: 'ok', unrecognizedLines, unknownRelations: rel.unknownRelations, unknownEstimates, mermaidUsed: rel.mermaidUsed, diagnostics, uncheckedBoxes };
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
    alias: code ? null : (GROUP_ALIAS.exec(h.text)?.[0] ?? null),
    line: h.i + 1,
  };
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

// ---- 文档发现与工作区（design §3.2，任务 1.3）----
// 以下部分会读文件、调只读 git；上面的解析函数仍是纯函数。只用 readdir / readFile，从不写、从不 checkout。

/**
 * 只读 git 封装：不经 shell；关闭可选锁（不刷索引、不抢 index.lock，需求 16.1）与交互提示；
 * 中文路径不转义；10 秒超时。只放行白名单里的子命令，后续任务要用新命令时把前缀加进 GIT_ALLOWED。
 * @param {string} ws 工作区绝对路径
 * @param {string[]} args 例如 ['rev-parse', 'HEAD']
 * @param {{ raw?: boolean }} [opts] raw = 读文件内容：不去首尾空白（首部空行影响行号），输出上限放到 64 MiB
 * @returns {Promise<string>} stdout（默认去掉首尾空白）；git 失败或超时时抛出 execFile 的错误
 */
export async function gitRead(ws, args, { raw = false } = {}) {
  if (!GIT_ALLOWED.some((prefix) => prefix.every((a, k) => args[k] === a))) {
    throw new Error(`只读 git 白名单外的命令：git ${args.join(' ')}`);
  }
  const { stdout } = await runGit('git', ['-C', ws, '-c', 'core.quotepath=false', ...args], {
    timeout: 10_000,
    env: gitEnv(),
    ...(raw ? { maxBuffer: 64 * 1024 * 1024 } : {}),
  });
  return raw ? stdout : stdout.trim();
}
// 按参数前缀匹配。design §3.2 的完整白名单还有 worktree list --porcelain、log --diff-filter=A、merge-base --is-ancestor，由用到的任务加入。
const GIT_ALLOWED = [['rev-parse'], ['merge-base', '--is-ancestor'], ['log', '--diff-filter=A'], ['worktree', 'list', '--porcelain'], ['for-each-ref'], ['cat-file', 'blob']];
const runGit = promisify(execFile);

/**
 * 工作区当前检出的分支与提交。分离 HEAD（含变基中）、有未提交改动都照常返回；git 失败时分支与提交为 null，
 * 页面据此显示「（分离 HEAD）」或「未知」（需求 2.2、16.2）。
 * @returns {Promise<{ branch: string|null, commit: string|null, detached: boolean, error: string|null }>}
 */
export async function readWorkspaceHead(ws) {
  try {
    // 一次调用拿两样：先完整提交号，再 --abbrev-ref 的分支名（分离时输出字面量 HEAD）。
    const [commit, ref] = (await gitRead(ws, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])).split('\n');
    const detached = ref === 'HEAD';
    return { branch: detached ? null : ref, commit, detached, error: null };
  } catch (e) {
    // 空仓库（还没有提交）、目录不再是 git 仓库、找不到 git 都落这里。
    return { branch: null, commit: null, detached: false, error: (e.stderr || e.message || '').trim().split('\n')[0] };
  }
}

/**
 * 本地同步检查（design §3.2、K9、需求 8.2 / D7）：已合并 PR 的合并提交是否已在本地。只读，不 fetch、不 pull（需求 5.6）。
 * 对照 ref = 工作区 HEAD 与本地 refs/heads/<base>（存在才查），任一包含即 synced；docRef 分支线（N17）只对照 docRef。
 * 降级为 unknown（按已合并完成算、标「本地同步未核对」）：无合并提交；本地无 base 分支且 HEAD 不含；git 报其它错。
 * @param {string} ws 分支线工作区（未配则主工作区）绝对路径
 * @param {string|null|undefined} oid PR 的 mergeCommit.oid
 * @param {string} base PR 的 baseRefName
 * @param {string} [docRef] docRef 分支线（N17）传入：只看合并提交是否在这个 ref 上，不看 HEAD——看板正文来自 docRef，HEAD 比它新也不算同步
 * @returns {Promise<{ state: 'synced'|'pending'|'unknown', reason: string|null }>} reason 只在 unknown 时给，供诊断
 */
export async function checkLocalSync(ws, oid, base, docRef) {
  const baseRef = docRef ?? `refs/heads/${base}`;
  // oid 来自 GitHub，属于外部输入：只收完整十六进制提交号，防止以 - 开头被 git 当成选项。
  if (!oid) return { state: 'unknown', reason: msg('PR 没有合并提交') };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(oid)) return { state: 'unknown', reason: msg`合并提交号格式不对：${oid}` };
  try {
    const head = await gitRead(ws, ['rev-parse', 'HEAD']);
    const baseCommit = await revParseOrNull(ws, baseRef);
    // ref 没动就用上次结果；每个 (工作区, oid, base) 只留最新一条，缓存大小不超过已合并 PR 数。
    const cacheKey = `${ws}\0${oid}\0${baseRef}`;
    const refsKey = `${head}\0${baseCommit}`;
    const hit = syncCache.get(cacheKey);
    if (hit && hit.refsKey === refsKey) return hit.result;

    let result;
    // 对象不在本地：有本地 base 才能肯定「还没 pull」；没有本地 base 时按 P3 判 unknown，
    // 否则只检出了协作分支、没有本地 main 的工作区里，合到 main 的 PR 在 fetch 前会一直卡在待同步。
    if (!(await revParseOrNull(ws, `${oid}^{commit}`))) {
      result = baseCommit ? { state: 'pending', reason: null } : { state: 'unknown', reason: msg`本地没有 ${docRef ?? msg`${base} 分支`}，合并提交也不在本地` };
    } else if ((!docRef && await isAncestor(ws, oid, head)) || (baseCommit && await isAncestor(ws, oid, baseCommit))) result = { state: 'synced', reason: null };
    else if (baseCommit) result = { state: 'pending', reason: null };
    // P3 默认：没有本地 base（如工作区没有本地 main）又不在 HEAD 上，无从判断，不算待同步。
    else result = { state: 'unknown', reason: docRef ? msg`本地没有 ${docRef}` : msg`本地没有 ${base} 分支，当前检出也不含合并提交` };
    syncCache.set(cacheKey, { refsKey, result });
    return result;
  } catch (e) {
    // 不缓存：git 超时、工作区不见了等多为临时问题，下轮再查。
    return { state: 'unknown', reason: msg`git 出错：${(e.stderr || e.message || '').trim().split('\n')[0]}` };
  }
}
const syncCache = new Map();

/** rev-parse --verify --quiet：对象 / ref 不存在时 git 静默退出码 1 → null；其它错误照常抛出。 */
async function revParseOrNull(ws, rev) {
  try {
    return await gitRead(ws, ['rev-parse', '--verify', '--quiet', rev]);
  } catch (e) {
    if (e.code === 1) return null;
    throw e;
  }
}

/** merge-base --is-ancestor：退出码 0 = 是祖先，1 = 不是，其它 = 出错抛出。 */
async function isAncestor(ws, oid, ref) {
  try {
    await gitRead(ws, ['merge-base', '--is-ancestor', oid, ref]);
    return true;
  } catch (e) {
    if (e.code === 1) return false;
    throw e;
  }
}

/**
 * 发现并解析一个项目的全部规划文档。单个文档读或解析出错只把该文档标 error，不影响其它文档（需求 2.7）。
 * @param {object} project loadConfig 返回的项目（repo.path、branchLines[].workspace 已是绝对路径）
 * @param {{ hoursPerDay?: number, prev?: Object<string, {stamp: string, parsed: object}> }} [opts]
 *   prev = 上一轮返回的 parsedCache；文件戳相同的文档直接沿用，不再读文件、不再解析
 * @returns {Promise<{
 *   workspaces: { id: string, path: string, branch: string|null, commit: string|null, detached: boolean, error: string|null }[],
 *   docs: object[],                       // PlanDoc（design §4），另有 parse 结果里的全部字段
 *   diagnostics: { message: string }[],   // 来源目录读不了等不属于单个文档的问题
 *   reparsed: string[],                   // 本轮真正读文件重解析的 docId（规划中的不算）
 *   parsedCache: Object<string, {stamp: string, parsed: object}> }>}  下一轮的 prev，可直接存 docs.json
 */
export async function loadProjectDocs(project, opts = {}) {
  const workspaces = projectWorkspaces(project);
  const diagnostics = [];
  const isExcluded = globMatcher(project.excluded);
  const isArchived = globMatcher(project.archived);
  const parseOpts = { milestoneCodePattern: project.milestoneCodePattern, prerequisiteIdPattern: project.prerequisiteIdPattern, hoursPerDay: opts.hoursPerDay };
  const owner = docOwner(project, workspaces);

  const docs = [];
  const reparsed = [];
  const parsedCache = {};
  // N11：md-dir 排在其它来源之后处理，同名时旧来源类型优先，与配置里的来源顺序无关（requirements 7.4）。
  // 现有来源类型之间的同名行为不变（不在这里收口）。
  const sources = project.docSources ?? [];
  const ordered = [...sources.filter((s) => s.type !== 'md-dir'), ...sources.filter((s) => s.type === 'md-dir')];
  const seen = new Set();
  for (const source of ordered) {
    const discover = DISCOVERERS[source.type];
    if (!discover) continue; // 未知来源类型静默跳过
    // 每个工作区各自枚举，但一个 docId 只留在它归属的工作区里，任务键因此不随工作区变化。
    for (const ws of workspaces) {
      let found;
      try {
        found = await discover(source, ws.path);
      } catch (e) {
        diagnostics.push({ message: msg`工作区 ${ws.id} 的来源「${source.label}」读取失败：${e.code === 'ENOENT' ? msg`目录不存在 ${source.path}` : e.message}` });
        continue;
      }
      for (const d of found) {
        if (owner(d.docId) !== ws || isExcluded(d.docId)) continue;
        if (source.type === 'md-dir' && seen.has(d.docId)) {
          diagnostics.push({ message: msg`来源「${source.label}」的 ${d.path} 与已有文档同名（${d.docId}），已跳过` });
          continue;
        }
        seen.add(d.docId);
        const base = { docId: d.docId, sourceType: source.type, sourceLabel: source.label, path: d.path, workspaceId: ws.id, archived: isArchived(d.docId) };
        // 增量（任务 3.5）：文件戳没变就沿用上一轮的解析结果，只重解析变化的文档（需求 13.3、17.3）
        const stamp = await docStamp(d);
        const old = opts.prev?.[d.docId];
        const parsed = old && old.stamp === stamp ? old.parsed : await readDoc(d, parseOpts);
        if (parsed !== old?.parsed && d.kind !== 'planning') reparsed.push(d.docId);
        parsedCache[d.docId] = { stamp, parsed };
        docs.push({ ...base, ...parsed });
      }
    }
  }
  await Promise.all(workspaces.map(async (ws) => Object.assign(ws, await readWorkspaceHead(ws.path))));
  // N17：从 git ref 读文档的分支线（不检出、不建工作区）。docId 加「分支线 id:」前缀，与主工作区的同名文档各算各的。
  for (const line of (project.branchLines ?? []).filter((b) => b.docRef)) {
    const ws = { id: line.id, label: line.name ?? line.id, path: project.repo.path, ref: line.docRef, ...(await readRefHead(project.repo.path, line.docRef)) };
    workspaces.push(ws);
    for (const file of line.docFiles) {
      const d = refDoc(project, line, file);
      if (isExcluded(d.docId)) continue;
      const base = { docId: d.docId, alias: d.alias, sourceType: d.sourceType, sourceLabel: line.name ?? line.id, path: file, workspaceId: line.id, ref: line.docRef, archived: isArchived(d.docId) };
      let blob = null;
      if (ws.commit) blob = await revParseOrNull(project.repo.path, `${ws.commit}:${file}`).catch(() => null);
      // 没有 blob 时戳带上 ref 的提交 / 错误：fetch 之后原因变了（ref 有了但仍无此文件）要重新给出
      const stamp = `ref|${file}|${blob ?? `missing|${ws.commit ?? ws.error}`}`;
      const old = opts.prev?.[d.docId];
      let parsed = old && old.stamp === stamp ? old.parsed : null;
      if (!parsed) {
        const why = ws.error ? msg`读不到 ${line.docRef}：${ws.error}` : msg`${line.docRef} 上没有这个文件`;
        parsed = blob ? await readDoc(d, parseOpts, () => gitRead(project.repo.path, ['cat-file', 'blob', blob], { raw: true }))
          : { kind: d.kind, title: null, parse: emptyParse('error', why), groups: [], tasks: [] };
        reparsed.push(d.docId);
      }
      parsedCache[d.docId] = { stamp, parsed };
      docs.push({ ...base, ...parsed });
    }
  }
  return { workspaces, docs, diagnostics, reparsed, parsedCache };
}

// docRef 分支线里的一个文件：放在某个 adr-dir 来源目录下按 ADR 解析，否则按任务清单；alias = 不带前缀的 docId，
// PR / 会话里写的是这个名字（engine 的 linkPrs 据此认回带前缀的文档）。
function refDoc(project, line, file) {
  const dir = path.posix.dirname(file);
  const adr = (project.docSources ?? []).some((s) => s.type === 'adr-dir' && path.posix.normalize(s.path) === dir);
  const alias = (adr ? path.posix.basename(file) : file).replace(/\.[^./]+$/, '').normalize('NFC');
  return { docId: `${line.id}:${alias}`, alias, kind: adr ? 'adr' : 'tasks', sourceType: adr ? 'adr-dir' : 'task-list', path: file };
}

// ref 的提交号；顶栏把它当一个工作区显示（分支位置写 ref），看得出读的是哪一版。ref 不存在（还没 fetch）记 error。
async function readRefHead(repo, ref) {
  try {
    const commit = await revParseOrNull(repo, `${ref}^{commit}`);
    return { branch: ref, commit, detached: false, error: commit ? null : msg`本地没有 ${ref}（需要先 git fetch）` };
  } catch (e) {
    return { branch: ref, commit: null, detached: false, error: (e.stderr || e.message || '').trim().split('\n')[0] };
  }
}

// 文档的「文件戳」：路径 + 修改时间 + 大小 + inode（原子替换式保存会换 inode）；ADR 另含同编号列表（它影响解析结果）。
// 读不了的文件也给固定戳（错误码），免得每轮轮询都当成「变了」去重算。
async function docStamp(d) {
  if (d.kind === 'planning') return 'planning';
  const extra = d.duplicates ? `|${d.duplicates.join(',')}` : '';
  try {
    const s = await stat(d.abs);
    return `${d.path}|${s.mtimeMs}|${s.size}|${s.ino}${extra}`;
  } catch (e) {
    return `${d.path}|err:${e.code}${extra}`;
  }
}

/**
 * 读本地分支的提交号（任务 3.5 轮询用：base 分支动了就要重查本地同步）。一次 git 调用；不存在的分支不出现在结果里。
 * @param {string} ws 工作区绝对路径
 * @param {string[]} branches 分支名，如 ['main', 'release/2.x']
 * @returns {Promise<Object<string, string>>} 分支名 → 提交号；git 失败时抛出
 */
export async function readBranchCommits(ws, branches) {
  if (!branches.length) return {};
  const out = await gitRead(ws, ['for-each-ref', '--format=%(objectname) %(refname)', ...branches.map((b) => `refs/heads/${b}`)]);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => {
    const [oid, ref] = l.split(' ');
    return [ref.slice('refs/heads/'.length), oid];
  }));
}

// 主工作区 id 固定为 repo；分支线自配的工作区用该分支线 id。同一路径只算一个工作区。
function projectWorkspaces(project) {
  const list = [{ id: 'repo', path: project.repo.path }];
  for (const b of project.branchLines ?? []) {
    if (b.workspace && !list.some((w) => w.path === b.workspace)) list.push({ id: b.id, path: b.workspace });
  }
  return list;
}

// 文档归属：docFilter 命中且配了 workspace 的第一条分支线的工作区，其余归主工作区（design §3.2、D6）。
function docOwner(project, workspaces) {
  const rules = (project.branchLines ?? []).filter((b) => b.workspace && b.docFilter)
    .map((b) => ({ re: new RegExp(b.docFilter), ws: workspaces.find((w) => w.path === b.workspace) }));
  return (docId) => rules.find((r) => r.re.test(docId))?.ws ?? workspaces[0];
}

// 每种来源类型：(source, 工作区路径) → [{ docId, path(仓库内相对、用 /), abs, kind }]。新增来源只加一项（需求 14.7）。
const DISCOVERERS = {
  // 每个子目录一份：有 tasks.md 解析；只有其它 .md 记「规划中（暂无任务）」；一个 .md 都没有不算 spec。
  async 'spec-dir'(source, ws) {
    const root = path.resolve(ws, source.path);
    const out = [];
    for (const dir of await readdir(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const names = await readdir(path.join(root, dir.name));
      const kind = names.includes('tasks.md') ? 'tasks' : names.some((n) => n.endsWith('.md')) ? 'planning' : null;
      if (!kind) continue;
      const abs = path.join(root, dir.name, kind === 'tasks' ? 'tasks.md' : '');
      // docId 与显示路径做 NFC（macOS 目录名可能是 NFD）；读文件仍用 readdir 给的原名。
      out.push({ docId: dir.name.normalize('NFC'), kind, abs, path: relPath(ws, abs) });
    }
    return out.sort((a, b) => (a.docId < b.docId ? -1 : 1));
  },
  // 显式列出的文件；docId = 相对路径去扩展名。文件不存在由 readDoc 记为该文档 error。
  async 'task-list'(source, ws) {
    return (source.files ?? []).map((f) => {
      const abs = path.resolve(ws, f);
      const rel = relPath(ws, abs);
      return { docId: rel.replace(/\.[^./]+$/, ''), kind: 'tasks', abs, path: rel };
    });
  },
  // N11：plan / TODO 目录，这一层的每个 .md 一份文档；不递归，与 adr-dir 一致。docId = 文件名去扩展名。
  // 读成功却没有任务行的在 readDoc 里转「规划中」。
  async 'md-dir'(source, ws) {
    const root = path.resolve(ws, source.path);
    const out = [];
    for (const ent of await readdir(root, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const abs = path.join(root, ent.name);
      out.push({ docId: ent.name.slice(0, -3).normalize('NFC'), kind: 'tasks', abs, path: relPath(ws, abs), emptyAsPlanning: true });
    }
    return out.sort((a, b) => (a.docId < b.docId ? -1 : 1));
  },
  'adr-dir': discoverAdrs, // 见 adr.mjs
};

async function readDoc(d, parseOpts, readText = () => readFile(d.abs, 'utf8')) {
  if (d.kind === 'planning') {
    return { kind: 'planning', title: null, parse: emptyParse('planning', msg('规划中（暂无任务）：目录里有文档但还没有 tasks.md')), groups: [], tasks: [] };
  }
  try {
    const text = await readText();
    if (d.kind === 'adr') return parseAdrDoc(text, d.docId, { ...parseOpts, file: d.path, duplicates: d.duplicates });
    const doc = { kind: 'tasks', ...parseTasksDoc(text, d.docId, { ...parseOpts, file: d.path }) };
    // N11 md-dir：读成功、没有任务行、也没有像任务行的写错行 = 还没拆任务的计划，标「规划中」。
    // 有疑似行时保持 no-tasks 警告；读失败走下面的 catch 保留 error（requirements 7.3）。
    if (d.emptyAsPlanning && doc.parse.state === 'no-tasks' && doc.parse.unrecognizedLines.length === 0) {
      doc.parse = { ...doc.parse, state: 'planning', reason: msg('规划中（暂无任务）：文档里没有任务行') };
    }
    return doc;
  } catch (e) {
    return { kind: d.kind, title: null, parse: emptyParse('error', msg`读取或解析失败：${e.message}`), groups: [], tasks: [] };
  }
}

function emptyParse(state, reason) {
  return { state, reason, unrecognizedLines: [], unknownRelations: [], unknownEstimates: [], mermaidUsed: false, diagnostics: [], uncheckedBoxes: 0 };
}

// 对外显示与 SourceRef 一律用 / 分隔（design §6）。
function relPath(ws, abs) {
  return path.relative(ws, abs).split(path.sep).join('/').normalize('NFC');
}

// archived / excluded 的 docId 通配：* 任意串、? 单字符，整串匹配。
function globMatcher(patterns = []) {
  const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
  return (docId) => res.some((re) => re.test(docId));
}

/**
 * 仓库的全部 worktree 绝对路径（含主工作区；可在仓库目录之外），供会话归属判定（design §3.7.2）。
 * git 失败时抛出，由调用方记诊断。
 * @returns {Promise<string[]>}
 */
export async function listWorktrees(ws) {
  const out = await gitRead(ws, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length)).normalize('NFC'));
}
