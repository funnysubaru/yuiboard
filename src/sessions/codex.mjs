// Codex 会话来源（N10，spec：.claude/specs/devboard-codex-sessions/）：发现 rollout 记录、按会话起点 cwd 判归属、
// 子 agent 并入父会话、按字节偏移增量读，产出与 claude-code 相同的 SessionRecord。
// 只读：只用 readdir / stat / 只读打开，不写、不加锁（需求 16.6）。缓存与 SessionRecord 不含对话正文，
// 可显示文本先 mask() 再截断；reasoning、developer 消息、工具参数原文与工具输出一律不读入缓存。
import { readdir, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveScanScope as workspaceScope } from './claude-code.mjs';
import { extractRefs } from '../refs.mjs';
import { mask } from '../mask.mjs';
import { msg } from '../msg.mjs';

const CACHE_VERSION = 1;
// 单行上限：本机实测最大约 16.24 MB，4 / 8 MiB 会跳过真实记录（requirements「本机只读观察」）。
const LINE_MAX = 20 * 1024 * 1024;
const TITLE_MAX = 60;
const SNIPPET_MAX = 60; // 信号片段
const SUMMARY_MAX = 120; // 最后一条消息摘要
// AI 文字只取开头这么多字做摘要：先遮蔽再截断，余量保证跨截断点的令牌也整段被遮。
const AI_TEXT_PEEK = 2000;
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
// 文件名 = rollout-<起始时刻>-<会话 ID>[_<段 ID>].jsonl；续段的首行 ID 仍是会话 ID（history_base 指向上一段）。
// 格式写死：路径里只有时间与 UUID，不会混进任意文字，诊断可以直接给相对路径（mask 会把这种长串整段遮掉）。
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(_${UUID})?\\.jsonl$`);
// 外层字段顺序为 timestamp, ordinal, type, payload（实物）；对不上时退回整行解析。
const HEAD = /^\{"timestamp":"((?:[^"\\]|\\.)*)","ordinal":(\d+),"type":"([a-z_]+)"/;

/** @type {{ id: string, label: string, resolveScanScope: typeof resolveScanScope, scan: typeof scan }} design §3.7.1 SessionSource */
export const codex = { id: 'codex', label: 'Codex', resolveScanScope, scan };

/** 记录根缺省值：`$CODEX_HOME/sessions`，否则 `~/.codex/sessions`。 */
export function defaultRecordsDir(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

/** 扫描范围：工作区 + worktree + extraCwds 与 Claude 同口径，只有记录根不同。 */
export async function resolveScanScope(sessionCfg, workspacePaths, env = process.env) {
  return { ...await workspaceScope(sessionCfg, workspacePaths, env), dir: sessionCfg.dir ?? defaultRecordsDir(env) };
}

/**
 * 扫描一次记录根。入参与返回同 claude-code 的 scan；diagnostics 额外带 messages（父会话缺失等）。
 * 缓存：files[rel] = {own:false} | {own:false, bad} | {own:true, 起点元数据 + 读取偏移}；groups[根 ID] = {members, state}。
 * 起点只判一次（owner 2026-10-03 定）：未归属文件之后不再 stat、不再打开。
 * @param {{ dir: string, includeRoots: string[], includeExact: string[], knownDocIds?: string[], knownCodes?: string[],
 *   prev?: object|null, lineMax?: number }} opts lineMax 仅供测试
 */
export async function scan({ dir, includeRoots, includeExact, knownDocIds = [], knownCodes = [], prev = null, lineMax = LINE_MAX }) {
  const scope = JSON.stringify([dir, includeRoots, includeExact, [...knownDocIds].sort(), [...knownCodes].sort()]);
  const valid = prev?.v === CACHE_VERSION && prev.scope === scope;
  const prevFiles = valid ? prev.files : {};
  const prevGroups = valid ? prev.groups : {};
  const cache = { v: CACHE_VERSION, scope, files: {}, groups: {} };
  const diag = { dir, available: true, error: null, sessions: 0, unreadableFiles: [], brokenLines: [], messages: [] };
  const ctx = { roots: includeRoots.map(norm), exact: new Set(includeExact.map(norm)), lineMax, refOpts: { knownDocIds, knownCodes } };

  let rels;
  try {
    rels = await listRollouts(dir, diag);
  } catch (e) {
    return { sessions: [], cache, diagnostics: masked({ ...diag, available: false, error: e.code === 'ENOENT' ? msg`会话目录不存在：${dir}` : msg`会话目录读不了：${e.message}` }) };
  }

  // 1. 起点元数据与归属
  const stats = {};
  for (const rel of rels) {
    const p = prevFiles[rel];
    if (p && !p.own) { cache.files[rel] = p; continue; }
    let st;
    try {
      st = await stat(path.join(dir, rel));
    } catch (e) {
      diag.unreadableFiles.push({ file: rel, error: e.message });
      continue;
    }
    if (p && !rewritten(p, st)) { cache.files[rel] = { ...p }; stats[rel] = st; continue; }
    const m = await readMeta(path.join(dir, rel), path.posix.basename(rel).match(ROLLOUT)[1], lineMax).catch((e) => ({ error: e.message }));
    if (m.pending) continue; // 首行或起点 cwd 还没写完：不缓存，下轮再判
    if (m.error) { diag.unreadableFiles.push({ file: rel, error: m.error }); continue; }
    if (m.bad) { cache.files[rel] = { own: false, bad: m.bad }; continue; }
    if (!owns(m.cwd, ctx)) { cache.files[rel] = { own: false }; continue; }
    cache.files[rel] = { own: true, id: m.id, parent: m.parent, start: m.start, ...unread(st) };
    stats[rel] = st;
  }
  for (const [rel, f] of Object.entries(cache.files)) if (f.bad) diag.unreadableFiles.push({ file: rel, error: f.bad });

  // 2. 归组：子 agent 沿 parent_thread_id 并入同样归属本项目的父会话（owner 2026-10-03 定）
  const groups = groupMembers(rels, cache.files, diag);

  // 3. 逐组增量读
  const sessions = [];
  for (const [rootId, members] of groups) {
    const g = await readGroup(dir, rootId, members, prevGroups[rootId], prevFiles, cache.files, stats, ctx, diag);
    cache.groups[rootId] = g;
    const rec = toRecord(rootId, g, cache.files);
    if (rec) sessions.push(rec);
  }
  for (const [rel, f] of Object.entries(cache.files)) if (f.broken) diag.brokenLines.push({ file: rel, count: f.broken });
  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  diag.sessions = sessions.length;
  return { sessions, cache, diagnostics: masked(diag) };
}

// 诊断会进页面：系统给的错误文本先遮蔽。文件位置与 messages 只含按 ROLLOUT 限定的相对路径和固定文案，不遮（遮了就定位不了）。
function masked(diag) {
  return { ...diag, error: diag.error && mask(diag.error), unreadableFiles: diag.unreadableFiles.map((f) => ({ ...f, error: mask(f.error) })) };
}

// ---- 发现 ----

// 只走 YYYY/MM/DD/rollout-*.jsonl；Dirent 对符号链接的 isDirectory / isFile 都为假，自然不跟随。
// ponytail: 每轮 readdir 全部日期目录（一年约 365 个），慢了再按目录 mtime 跳过。
async function listRollouts(dir, diag) {
  const out = [];
  const sub = async (rel, re) => {
    try {
      return (await readdir(path.join(dir, rel), { withFileTypes: true })).filter((d) => re.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch (e) {
      diag.unreadableFiles.push({ file: rel, error: e.message });
      return [];
    }
  };
  const years = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const y of years) {
    for (const m of await sub(y.name, /^\d{2}$/)) {
      if (!m.isDirectory()) continue;
      for (const d of await sub(`${y.name}/${m.name}`, /^\d{2}$/)) {
        if (!d.isDirectory()) continue;
        const day = `${y.name}/${m.name}/${d.name}`;
        for (const f of await sub(day, ROLLOUT)) if (f.isFile()) out.push(`${day}/${f.name}`);
      }
    }
  }
  return out;
}

// ---- 起点元数据 ----

/**
 * 读首行 session_meta（ID 须与文件名一致），取起点 cwd；缺失时找首个 turn_context.cwd。
 * 只看这几个字段，不解释其它项目的消息内容。
 * @returns {Promise<{ pending: true } | { bad: string } | { id: string, cwd: string, parent: string|null, start: number|null }>}
 */
async function readMeta(abs, fileId, lineMax) {
  let res = null;
  let first = true;
  await readLinesBounded(abs, 0, Infinity, false, lineMax, (line) => {
    if (first) {
      first = false;
      const o = line === null ? null : parse(line);
      const p = o?.type === 'session_meta' ? o.payload : null;
      if (!p || typeof p !== 'object') { res = { bad: msg('首行不是有效的 session_meta') }; return true; }
      if (p.id !== fileId) { res = { bad: msg('首行会话 ID 与文件名不符') }; return true; }
      res = { id: p.id, cwd: str(p.cwd), parent: str(p.parent_thread_id), start: Number.isInteger(p.subagent_history_start_ordinal) ? p.subagent_history_start_ordinal : null };
      return res.cwd !== null;
    }
    if (line === null || !line.includes('"type":"turn_context"')) return false;
    const c = str(parse(line)?.payload?.cwd);
    if (c) res.cwd = c;
    return c !== null;
  });
  if (!res || (!res.bad && res.cwd === null)) return { pending: true };
  return res;
}

// ---- 子 agent 归组 ----

/**
 * 已归属文件按会话 ID 与父子链分组：根 → [根会话的文件（主文件、续段）, 其余成员按路径排序]。链上每一环都须归属本项目才合并；
 * 链顶的父缺失、不可读或属外项目时，链顶自成根并记诊断（不带入外项目父的任何内容）。成环则各自单独显示。
 * forked_from_id 只表示 fork，不参与归组。同一会话 ID 有两份主文件（无段后缀）时只取路径靠前的一份，其余忽略并诊断
 * （各自成组会产生相同的 codex:<ID>，engine 按会话 ID 索引）。
 */
function groupMembers(rels, files, diag) {
  const byId = new Map(); // 会话 ID → 已归属的文件（主文件在前，续段按路径）
  const known = new Map(); // 会话 ID → 任一文件（判断父会话是否存在）
  for (const rel of rels) {
    const [, id, seg] = path.posix.basename(rel).match(ROLLOUT);
    if (!known.has(id) || (!seg && ROLLOUT.exec(path.posix.basename(known.get(id)))[2])) known.set(id, rel);
    if (!files[rel]?.own) continue;
    if (!byId.has(id)) byId.set(id, []);
    const list = byId.get(id);
    if (seg) list.push(rel);
    else if (list[0] && !ROLLOUT.exec(path.posix.basename(list[0]))[2]) diag.messages.push(msg`${rel}：会话 ID 与 ${list[0]} 重复，已忽略`);
    else list.unshift(rel);
  }
  const parentOf = (id) => byId.get(id).map((rel) => files[rel].parent).find(Boolean) ?? null;
  const groups = new Map();
  const noted = new Set();
  const note = (rel, problem) => {
    if (!noted.has(rel)) diag.messages.push(msg`${rel}：${problem}，单独显示`);
    noted.add(rel);
  };
  for (const [id, own] of byId) {
    let root = id;
    const seen = new Set([id]);
    for (let parent; (parent = parentOf(root));) {
      if (seen.has(parent)) { root = id; note(own[0], msg('父子链成环')); break; }
      if (byId.has(parent)) { seen.add(parent); root = parent; continue; }
      const p = known.has(parent) ? files[known.get(parent)] : null;
      note(byId.get(root)[0], !known.has(parent) ? msg('父会话记录不存在') : !p || p.bad ? msg('父会话记录不可读') : msg('父会话不属于本项目'));
      break;
    }
    if (!groups.has(root)) groups.set(root, []);
    if (root !== id) groups.get(root).push(...own);
  }
  for (const [root, members] of groups) groups.set(root, [...byId.get(root), ...members.sort()]);
  return groups;
}

// ---- 逐组读取 ----

// 组状态：可继续累加的提取结果（只有遮蔽后的短片段与元数据）。
function fresh() {
  return { cwds: [], firstAt: null, lastAt: null, signals: [], firstPrompt: null, lastMsg: null, aiOnlyMentions: 0 };
}

// 成员集合不变、成员都只是追加 → 沿用组状态只读新增行；否则整组从头读。
// 子 agent 文件排在父文件之后读，但时间穿插在中间：信号与 until 依赖时间顺序，先把各成员的记录收成事件，
// 读完按时间回放，焦点段才能在嵌套派活处切开（PR #14 review）。增量时若本轮有新信号早于已读到的最晚记录
// （某成员写入滞后），已记到前一条信号上的更晚时间挪不回来，改为整组从头按时间重放；
// 不产生信号的晚到记录（回复、工具输出）回放时自然归到对应焦点段，不触发重读。
async function readGroup(dir, rootId, members, prevGroup, prevFiles, files, stats, ctx, diag) {
  const same = prevGroup && prevGroup.members.length === members.length && prevGroup.members.every((m, i) => m === members[i]);
  const appendOnly = same && members.every((rel) => prevFiles[rel]?.own && !rewritten(prevFiles[rel], stats[rel]));
  if (appendOnly && members.every((rel) => !changed(prevFiles[rel], stats[rel]))) return prevGroup;
  const state = appendOnly ? structuredClone(prevGroup.state) : fresh();
  const events = [];
  for (const rel of members) {
    const f = files[rel];
    if (!appendOnly) Object.assign(f, unread(stats[rel]));
    const st = stats[rel];
    if (f.offset === st.size && f.ino === st.ino) { Object.assign(f, { size: st.size, mtimeMs: st.mtimeMs }); continue; }
    const pos = { file: rel, isRoot: f.id === rootId, start: f.start };
    try {
      const r = await readLinesBounded(path.join(dir, rel), f.offset, st.size, f.skipping, ctx.lineMax, (line) => {
        f.lines++;
        if (!applyLine(state, line, { ...pos, line: f.lines }, ctx, events)) f.broken++;
      });
      Object.assign(f, { offset: r.offset, skipping: r.skipping, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    } catch (e) {
      diag.unreadableFiles.push({ file: rel, error: e.message });
    }
  }
  if (appendOnly && events.some((e) => e.adds && e.t < Date.parse(prevGroup.state.lastAt))) {
    return readGroup(dir, rootId, members, null, prevFiles, files, stats, ctx, diag);
  }
  events.sort((a, b) => a.t - b.t); // 稳定排序：同一时刻保持成员、行号顺序
  for (const e of events) {
    e.signal?.();
    extendUntil(state, e.at);
  }
  return { members, state };
}

// 一行记录 → 当场累加与顺序无关的时间范围、cwd；信号与 until 收进 events 由 readGroup 按时间回放。
// 返回 false 表示坏行（跳过、计数）。null = 超长被丢弃的行。
// 只对需要的行 JSON.parse：先用外层字段与字符串探测筛，工具输出、reasoning 等大行只取时间。
function applyLine(state, raw, pos, ctx, events) {
  if (raw === null) return false;
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (!line.trim()) return true;
  if (!line.startsWith('{') || !line.endsWith('}')) return false;
  let head = HEAD.exec(line);
  let obj = null;
  if (!head) {
    obj = parse(line);
    if (!obj) return false;
    head = [null, obj.timestamp, obj.ordinal, obj.type];
  }
  const [, tsRaw, ordRaw, type] = head;
  // fork 出的子 agent 开头复制了父会话历史（时间戳为 fork 时刻），不计时间、不出信号。
  if (pos.start !== null && Number(ordRaw) < pos.start) return true;
  // 重新解析成独立字符串：正则切出的子串会引用整行（工具输出行可达十几 MB），事件留着它就放不掉整行。
  const ts = obj ? tsRaw : parse(`"${tsRaw}"`);
  const at = typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? ts : null;
  if (at) {
    if (state.firstAt === null || Date.parse(at) < Date.parse(state.firstAt)) state.firstAt = at;
    if (state.lastAt === null || Date.parse(at) > Date.parse(state.lastAt)) state.lastAt = at;
  }
  if (type === 'session_meta' || type === 'turn_context') {
    obj ??= parse(line);
    if (!obj) return false;
    const c = str(obj.payload?.cwd);
    if (c && !state.cwds.includes(c.normalize('NFC'))) state.cwds.push(c.normalize('NFC'));
  }
  const human = pos.isRoot && type === 'event_msg' && line.includes('"type":"UserMessage"');
  const reply = pos.isRoot && type === 'response_item' && line.includes('"role":"assistant"');
  const dispatch = type === 'response_item' && DISPATCH_TOOLS.some((n) => line.includes(`"name":"${n}"`));
  if (!at) return true;
  let signal = null;
  let adds = false; // 会不会新增 prompt / dispatch 信号（readGroup 据此判断要不要整组重放）
  if (human || reply || dispatch) {
    obj ??= parse(line);
    if (!obj) return false;
    const p = obj.payload ?? {};
    const sp = { at, file: pos.file, line: pos.line };
    if (human && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      const flat = flatten(humanText(p.item));
      const refs = extractRefs(flat, ctx.refOpts);
      adds = hasRefs(refs);
      signal = () => noteHuman(state, flat, refs, sp);
    } else if (reply && p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
      const { content } = p;
      signal = () => noteReply(state, content, sp, ctx.refOpts);
    } else if (dispatch && p.type === 'function_call' && DISPATCH_TOOLS.includes(p.name)) {
      const flat = dispatchText(p.arguments);
      const refs = extractRefs(flat, ctx.refOpts);
      adds = hasRefs(refs);
      if (adds) signal = () => addSignal(state, { kind: 'dispatch', ...sp, refs, snippet: around(mask(flat), refs, SNIPPET_MAX) });
    }
  }
  events.push({ t: Date.parse(at), at, signal, adds });
  return true;
}

// ---- 信号（design §3.7.4 的 prompt / dispatch；Codex 首版不出 edit / touch / pr-link / branch）----

// 父会话（含嵌套子 agent）明确派活的工具。send_message 只是给已有 agent 传话，同 Claude 的 SendMessage 不计。
const DISPATCH_TOOLS = ['spawn_agent', 'followup_task'];
// 人发正文 = Codex 标为 UserMessage 的条目（系统注入的 AGENTS / 环境 / 插件推荐从不在其中，见 plan.md 复核记录）。
// 其中自动化心跳、回答 Codex 提问整条排除（后者同 Claude 回答提问记为工具结果）；桌面端附带上下文时真实请求在「## My request:」之后。
const NOT_HUMAN = /^<(heartbeat|send_user_message_question_reply)>[\s\S]*<\/\1>$/;
const MY_REQUEST = '\n## My request:';

function humanText(item) {
  const t = (Array.isArray(item.content) ? item.content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
  if (!t || NOT_HUMAN.test(t)) return null;
  const i = t.lastIndexOf(MY_REQUEST);
  return i === -1 ? t : t.slice(i + MY_REQUEST.length);
}

const flatten = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

function noteHuman(state, flat, refs, pos) {
  if (!flat) return;
  const masked = mask(flat);
  state.firstPrompt ??= clip(masked, TITLE_MAX);
  noteLastMsg(state, pos.at, masked);
  if (hasRefs(refs)) addSignal(state, { kind: 'prompt', ...pos, refs, snippet: around(masked, refs, SNIPPET_MAX) });
}

// AI 回复里的任务号不产生信号（owner 已定：顺带提到不算），只计数供诊断页展示。
function noteReply(state, content, pos, refOpts) {
  const text = content.filter((b) => b?.type === 'output_text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (!text) return;
  const r = extractRefs(text, refOpts);
  if (r.keys.length || r.nums.length || r.codes.length) state.aiOnlyMentions++;
  const flat = text.slice(0, AI_TEXT_PEEK).replace(/\s+/g, ' ').trim();
  if (flat) noteLastMsg(state, pos.at, mask(flat));
}

// 派活文本：只取能解析的 arguments.message 与 task_name；完整参数不进缓存。
function dispatchText(args) {
  const a = typeof args === 'string' ? parse(args) : args;
  if (!a || typeof a !== 'object') return '';
  return flatten([a.task_name, a.message].filter((x) => typeof x === 'string').join(' '));
}

function noteLastMsg(state, at, masked) {
  if (!state.lastMsg || Date.parse(at) >= Date.parse(state.lastMsg.at)) state.lastMsg = { at, text: clip(masked, SUMMARY_MAX) };
}

const hasRefs = (r) => r.keys.length > 0 || r.nums.length > 0 || r.codes.length > 0 || r.docIds.length > 0;

// 以下三个与 claude-code 同语义（照抄而不抽公共模块：Claude 路径已验证，不动它）。
// 信号按时间有序；until = 从本信号起、到下一条信号之前最后一条记录的时间（engine 焦点段，design §3.8.3 第 6 步）。
function addSignal(state, sig) {
  const t = Date.parse(sig.at);
  let i = state.signals.length;
  while (i > 0 && Date.parse(state.signals[i - 1].at) > t) i--;
  state.signals.splice(i, 0, { ...sig, until: sig.at });
}

// readGroup 保证按时间回放（跨轮晚到的新信号会触发整组重放），这里只需向后延长。
function extendUntil(state, at) {
  const t = Date.parse(at);
  for (let i = state.signals.length - 1; i >= 0; i--) {
    const s = state.signals[i];
    if (Date.parse(s.at) > t) continue;
    if (Date.parse(s.until) < t) s.until = at;
    return;
  }
}

// 片段取文中最靠前的引用前后。
function around(masked, refs, n) {
  const hits = refs.spans.map((sp) => masked.indexOf(sp.text)).filter((i) => i >= 0);
  const hit = hits.length ? Math.min(...hits) : 0;
  let start = hit > 15 ? hit - 15 : 0;
  if (/[\uDC00-\uDFFF]/.test(masked[start] ?? '')) start++;
  return clip(masked.slice(start), n);
}

// 截到 n 个字符（按码点，不切坏代理对）。
function clip(s, n) {
  const cs = [...s];
  return cs.length <= n ? s : cs.slice(0, n).join('');
}

/**
 * 只读打开，从 start 读到 end，逐行回调；只消费到最后一个换行，半行留到下次。
 * 单行超过 lineMax 进入丢弃状态：不再累积、offset 照常前进，跨轮保持，遇到换行时回调一次 null。
 * onLine 返回 true 时提前结束。返回 {offset, skipping}。
 */
async function readLinesBounded(abs, start, end, skipping, lineMax, onLine) {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = start;
    let consumed = start;
    let carry = [];
    let carryLen = 0;
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let from = 0;
      for (let nl; (nl = chunk.indexOf(10, from)) !== -1; from = nl + 1) {
        let stop;
        if (skipping) {
          skipping = false;
          stop = onLine(null);
        } else {
          const part = chunk.subarray(from, nl);
          stop = onLine(carryLen ? Buffer.concat([...carry, part]).toString('utf8') : part.toString('utf8'));
        }
        carry = [];
        carryLen = 0;
        consumed = pos + nl + 1;
        if (stop) return { offset: consumed, skipping };
      }
      pos += bytesRead;
      if (skipping) { consumed = pos; continue; }
      const rest = chunk.subarray(from);
      if (carryLen + rest.length > lineMax) {
        skipping = true;
        carry = [];
        carryLen = 0;
        consumed = pos;
      } else if (rest.length) {
        carry.push(Buffer.from(rest)); // buf 下一轮复用，半行要拷出来
        carryLen += rest.length;
      }
    }
    return { offset: consumed, skipping };
  } finally {
    await fh.close();
  }
}

// ---- 小工具 ----

const unread = (st) => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, offset: 0, lines: 0, broken: 0, skipping: false });
const changed = (p, st) => p.size !== st.size || p.mtimeMs !== st.mtimeMs || p.ino !== st.ino;
// 截短、换了文件（inode 变）或同大小但 mtime 变：已读内容不再可信，从头读。
const rewritten = (p, st) => p.ino !== st.ino || st.size < p.size || (st.size === p.size && p.mtimeMs !== st.mtimeMs);
const str = (v) => (typeof v === 'string' && v ? v : null);

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 属于本项目：起点 cwd 落在某 root 子树内，或与某 exact 相等（整段路径比较，/repo-other 不命中 /repo）。
function owns(cwd, { roots, exact }) {
  const n = norm(cwd);
  return exact.has(n) || roots.some((r) => n === r || n.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function norm(p) {
  const n = p.normalize('NFC').replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

function toRecord(rootId, { members, state: s }, files) {
  if (s.firstAt === null) return null; // 没有任何带时间的记录：无从判断活动，不出会话
  return {
    source: codex.id,
    id: `codex:${rootId}`,
    files: members,
    cwds: s.cwds,
    branches: [], // session_meta.git 只是起点信息，首版不出 branch 信号（design 字段映射）
    title: s.firstPrompt,
    firstAt: s.firstAt,
    lastAt: s.lastAt,
    lastSummary: s.lastMsg?.text ?? null,
    signals: s.signals,
    aiOnlyMentions: s.aiOnlyMentions,
    brokenLines: members.reduce((n, rel) => n + files[rel].broken, 0),
  };
}
