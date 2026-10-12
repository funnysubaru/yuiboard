// Claude Code 会话来源（design §3.7）：定位记录目录、判定会话是否属于本项目、按字节偏移增量读。
// 只读：只用 readdir / stat / 只读打开，不写、不加锁、不在会话目录里建文件（需求 16.6）。
// 产出会话的元数据（文件、cwd、首末时间、标题、坏行数）与证据信号（design §3.7.4：prompt / dispatch / edit / touch /
// pr-link / branch / agent，子 agent 的信号带 lane）。只存元数据与遮蔽后的短片段，缓存与 SessionRecord 都不含对话正文（需求 14.6、16.6）。
import { readdir, stat, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listWorktrees, parseTasksDoc } from '../docs.mjs';
import { extractRefs } from '../refs.mjs';
import { mask } from '../mask.mjs';
import { msg } from '../msg.mjs';

const CACHE_VERSION = 4;
const TITLE_MAX = 60;
const SNIPPET_MAX = 60; // 信号片段
const SUMMARY_MAX = 120; // 最后一条消息摘要（design §3.7.4）
// macOS / Windows 文件系统默认不分大小写：比较路径前统一小写（design §6；实物有 Projects / projects 两种目录名）。
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** @type {{ id: string, label: string, resolveScanScope: typeof resolveScanScope, scan: typeof scan }} design §3.7.1 SessionSource */
export const claudeCode = { id: 'claude-code', label: 'Claude Code', resolveScanScope, scan };

/** 记录根缺省值：`$CLAUDE_CONFIG_DIR/projects`，否则 `~/.claude/projects`。 */
export function defaultRecordsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/**
 * 由会话来源配置与项目工作区算出 scan 的范围（design §3.7.2 第 1、2 步）。
 * includeRoots = 各工作区 + 它们 `git worktree list` 出的全部 worktree（可在仓库外）；includeExact = extraCwds。
 * @param {{ dir?: string, extraCwds?: string[] }} sessionCfg loadConfig 后的 sessions[i]（路径已是 NFC 绝对路径）
 * @param {string[]} workspacePaths
 * @returns {Promise<{ dir: string, includeRoots: string[], includeExact: string[], diagnostics: { message: string }[] }>}
 */
export async function resolveScanScope(sessionCfg, workspacePaths, env = process.env) {
  const roots = new Set(workspacePaths);
  const diagnostics = [];
  for (const ws of workspacePaths) {
    try {
      for (const p of await listWorktrees(ws)) roots.add(p);
    } catch (e) {
      // 列不出 worktree 只会少认会话，不影响主工作区本身的会话。
      diagnostics.push({ message: msg`工作区 ${ws} 的 worktree 列表读取失败：${(e.stderr || e.message || '').trim().split('\n')[0]}` });
    }
  }
  return { dir: sessionCfg.dir ?? defaultRecordsDir(env), includeRoots: [...roots], includeExact: sessionCfg.extraCwds ?? [], diagnostics };
}

/**
 * 扫描一次记录目录。prev 为上次返回的 cache：文件没变就跳过，变大只读新增部分，变小 / inode 变 / 同大小但 mtime 变则整个会话重读。
 * cache 只含文件偏移与元数据，不含任何对话正文；不属于本项目的会话在 cache 里只留文件偏移，不留 cwd、时间、标题。
 * @param {{ dir: string, includeRoots: string[], includeExact: string[], knownDocIds?: string[], knownCodes?: string[],
 *   docs?: { docId: string, path: string, sourceType: string, kind: string }[], repo?: string|null, prev?: object|null }} opts
 *   knownDocIds / knownCodes 交给 extractRefs；docs（PlanDoc 即可）用于认出改 / 碰规划文档（edit / touch）；
 *   repo 为项目 GitHub 仓库 owner/name，pr-link 只认这个仓库的 PR。这几项变了，缓存里的信号不再可信，整份重读。
 * @returns {Promise<{ sessions: object[], cache: object, diagnostics: {
 *   dir: string, available: boolean, error: string|null, sessions: number,
 *   unreadableFiles: { file: string, error: string }[], brokenLines: { file: string, count: number }[] } }>}
 *   sessions 为 design §4 SessionRecord（只含属于本项目、至少有一条带时间记录的会话），按 id 排序。
 */
export async function scan({ dir, includeRoots, includeExact, knownDocIds = [], knownCodes = [], docs = [], repo = null, prev = null }) {
  const scope = JSON.stringify([includeRoots, includeExact, [...knownDocIds].sort(), [...knownCodes].sort(),
    docs.map((d) => [d.docId, d.path, d.sourceType, d.kind]), repo]);
  // 配置范围变了，上次「不属于本项目」的判定不再可信，整份缓存作废。
  const prevSessions = prev?.v === CACHE_VERSION && prev.scope === scope ? prev.sessions : {};
  const cache = { v: CACHE_VERSION, scope, sessions: {} };
  const diag = { dir, available: true, error: null, sessions: 0, unreadableFiles: [], brokenLines: [] };

  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return { sessions: [], cache, diagnostics: { ...diag, available: false, error: e.code === 'ENOENT' ? msg`会话目录不存在：${dir}` : msg`会话目录读不了：${e.message}` } };
  }

  const scopeInfo = {
    roots: includeRoots.map(norm),
    exact: new Set(includeExact.map(norm)),
    rootCodes: includeRoots.flatMap(encodeVariants),
    exactCodes: new Set(includeExact.flatMap(encodeVariants)),
    refOpts: { knownDocIds, knownCodes },
    anchors: docAnchors(docs),
    repo: repo ? repo.toLowerCase() : null,
  };
  const sessions = [];
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // 目录名粗筛：不中的目录不打开任何文件（design §3.7.2 第 3 步）。
    if (!d.isDirectory() || !coarseMatch(d.name, scopeInfo)) continue;
    const projDir = path.join(dir, d.name);
    let entries;
    try {
      entries = await readdir(projDir);
    } catch (e) {
      diag.unreadableFiles.push({ file: d.name, error: e.message });
      continue;
    }
    for (const f of entries.filter((n) => n.endsWith('.jsonl')).sort()) {
      const id = f.slice(0, -'.jsonl'.length);
      const key = `${d.name}/${id}`;
      const state = await scanSession(projDir, d.name, id, prevSessions[key], scopeInfo, diag);
      if (!state) continue;
      if (state.stripped) {
        cache.sessions[key] = state; // 没变的未归属会话，原样沿用
      } else if (isOwned(state, scopeInfo)) {
        cache.sessions[key] = state;
        const rec = toRecord(state);
        if (rec) sessions.push(rec);
      } else {
        cache.sessions[key] = strip(state);
      }
    }
  }
  for (const s of Object.values(cache.sessions)) {
    for (const [file, fs] of Object.entries(s.files)) if (fs.broken) diag.brokenLines.push({ file, count: fs.broken });
  }
  sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  diag.sessions = sessions.length;
  return { sessions, cache, diagnostics: diag };
}

// ---- 单个会话 ----

// 会话 = `<id>.jsonl` + `<id>/subagents/agent-*.jsonl`（子 agent 按时间并入父会话，design §3.7.2 第 5 步）；`tool-results/` 不读。
async function scanSession(projDir, dirName, id, prev, scopeInfo, diag) {
  const files = [`${id}.jsonl`];
  try {
    for (const n of (await readdir(path.join(projDir, id, 'subagents'))).sort()) {
      if (n.startsWith('agent-') && n.endsWith('.jsonl')) files.push(`${id}/subagents/${n}`);
    }
  } catch { /* 没有子 agent 目录是常态 */ }

  const stats = {};
  for (const rel of files) {
    try {
      stats[rel] = await stat(path.join(projDir, rel));
    } catch (e) {
      diag.unreadableFiles.push({ file: `${dirName}/${rel}`, error: e.message });
    }
  }
  if (!stats[`${id}.jsonl`]) return null;

  const changed = (rel) => {
    const p = prev?.files[displayRel(dirName, rel)];
    const st = stats[rel];
    return !p || p.size !== st.size || p.mtimeMs !== st.mtimeMs || p.ino !== st.ino;
  };
  // 截短重写、换了文件（inode 变）或同大小但 mtime 变：已累积的首末时间与标题不再可信，整个会话从头读。
  const rewritten = (rel) => {
    const p = prev?.files[displayRel(dirName, rel)];
    const st = stats[rel];
    return p && (p.ino !== st.ino || st.size < p.size || (st.size === p.size && p.mtimeMs !== st.mtimeMs));
  };
  const anyChanged = Object.keys(stats).some(changed);
  if (prev && !anyChanged) return prev;

  let state = prev && !Object.keys(stats).some(rewritten) ? hydrate(prev) : fresh(id);
  await readFiles(state, projDir, dirName, stats, diag, scopeInfo);
  // 之前（上次或本次前半段）还不属于本项目、跳过了内容；现在确认属于本项目 → 从头补读时间、标题与信号。
  if (state.partial && isOwned(state, scopeInfo)) {
    state = { ...fresh(id), owned: true };
    await readFiles(state, projDir, dirName, stats, diag, scopeInfo);
  }
  // 其它项目的会话除了确认 cwd 所需的行，不再多读任何内容（需求 14.2）。
  if (isOwned(state, scopeInfo)) await readTitleFile(state, projDir, id);
  return state;
}

// owned：已确认属于本项目，之后的行才提取内容信号（其它项目的会话不读内容，需求 14.2）。
// firstPrompt / lastMsg 存的是遮蔽并截断后的片段，不是原文。
function fresh(id) {
  return { id, files: {}, cwds: [], firstCwd: null, firstAt: null, lastAt: null, customTitle: null, agentName: null, fileTitle: null,
    owned: false, signals: [], branches: [], firstPrompt: null, lastMsg: null, aiOnlyMentions: 0 };
}

// 从缓存恢复可继续累加的状态。未归属会话的缓存只有偏移：标 partial，firstCwd 用占位（首个 cwd 已看过且不等于任何 exact）。
function hydrate(prev) {
  if (!prev.stripped) return structuredClone(prev);
  return { ...fresh(prev.id), files: structuredClone(prev.files), firstCwd: prev.sawCwd ? '\0' : null, partial: true };
}

// 不属于本项目的会话：缓存里只留文件大小 / mtime / inode / 偏移 / 行数，不留 cwd、时间、标题（design §3.7.2 第 4 步）。
function strip(state) {
  const files = Object.fromEntries(Object.entries(state.files).map(([k, f]) => [k, { size: f.size, mtimeMs: f.mtimeMs, ino: f.ino, offset: f.offset, lines: f.lines, broken: 0 }]));
  return { stripped: true, id: state.id, files, sawCwd: state.firstCwd !== null };
}

async function readFiles(state, projDir, dirName, stats, diag, scopeInfo) {
  for (const [rel, st] of Object.entries(stats)) {
    const key = displayRel(dirName, rel);
    const f = state.files[key] ?? { size: 0, mtimeMs: 0, ino: st.ino, offset: 0, lines: 0, broken: 0 };
    if (f.offset === st.size && f.ino === st.ino) {
      Object.assign(f, { size: st.size, mtimeMs: st.mtimeMs });
      state.files[key] = f;
      continue;
    }
    const isMain = !rel.includes('/');
    // 子 agent 各算各的：旁边的 agent-*.meta.json 记着派它的那次 Agent 调用（toolUseId），它的记录只续这次派活的焦点。
    // ponytail: meta 晚于记录写出时，之前读过的记录仍按旧规则并入主线；meta 一出现，之后的记录就各算各的。
    if (!isMain && typeof f.lane !== 'string') f.lane = await laneOf(path.join(projDir, rel));
    try {
      f.offset = await readLines(path.join(projDir, rel), f.offset, st.size, (line) => {
        f.lines++;
        if (!applyLine(state, line, { file: key, line: f.lines, isMain, f }, scopeInfo)) f.broken++;
      });
      Object.assign(f, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    } catch (e) {
      // 打不开 / 读失败：该文件偏移不前进，下轮重试（读到一半才失败时行数可能重复计，极少见，不处理）。
      diag.unreadableFiles.push({ file: key, error: e.message });
    }
    state.files[key] = f;
  }
  // 已消失的子 agent 文件不再列出。
  for (const key of Object.keys(state.files)) if (!(key.slice(dirName.length + 1) in stats)) delete state.files[key];
}

async function laneOf(jsonlPath) {
  try {
    const id = JSON.parse(await readFile(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.toolUseId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

// 一行记录 → 累加元数据与信号。返回 false 表示坏行（跳过、计数，需求 14.9）。
// 按 design §3.7.3 只对需要字段的类型 JSON.parse，其余行只做形状检查并用字符串定位取 timestamp / cwd / gitBranch。
// user / assistant / pr-link 行只在会话已确认属于本项目后才解析；它们自带 cwd，所以归属在解析前就能定。
function applyLine(state, raw, pos, scopeInfo) {
  const { isMain } = pos;
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (!line.trim()) return true;
  if (!line.startsWith('{') || !line.endsWith('}')) return false;
  const meta = line.includes('"type":"custom-title"') || line.includes('"type":"agent-name"');
  // user 行里的工具结果（最大的一类行）不是人发的消息，不解析。
  const content = !meta && (line.includes('"type":"assistant"') || line.includes('"type":"pr-link"')
    || (isMain && line.includes('"type":"user"') && !line.includes('"type":"tool_result"')));
  let obj = null;
  if (meta) {
    try {
      obj = JSON.parse(line);
    } catch {
      return false;
    }
    // 子 agent 文件里的标题记录不代表父会话标题。标题会进缓存与页面，存之前先遮蔽。
    if (isMain && obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) state.customTitle = mask(obj.customTitle.trim());
    if (isMain && obj.type === 'agent-name' && typeof obj.agentName === 'string' && obj.agentName.trim()) state.agentName = mask(obj.agentName.trim());
  }
  const ts = obj ? obj.timestamp : topField(line, 'timestamp');
  const at = typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? ts : null;
  if (at) {
    if (state.firstAt === null || Date.parse(at) < Date.parse(state.firstAt)) state.firstAt = at;
    if (state.lastAt === null || Date.parse(at) > Date.parse(state.lastAt)) state.lastAt = at;
  }
  const cwd = obj ? obj.cwd : topField(line, 'cwd');
  if (typeof cwd === 'string' && cwd) {
    const c = cwd.normalize('NFC');
    if (isMain && state.firstCwd === null) state.firstCwd = c;
    if (!state.cwds.includes(c)) state.cwds.push(c);
  }
  const branch = content || meta ? null : topField(line, 'gitBranch');
  if (!content && !branch && !at) return true;
  if (!state.owned) state.owned = isOwned(state, scopeInfo);
  if (!state.owned) {
    // 暂不属于本项目：内容不读。若之后 cd 进仓库变成本项目会话，由 scanSession 从头补读。
    if (content || branch) state.partial = true;
    return true;
  }
  const lane = pos.f?.lane ?? null;
  // 认得出派活的子 agent：第一条带时间的记录记一个 agent 信号，它之后的记录都续在这一路上，不再续主线的焦点段
  if (lane && at && !pos.f.started) {
    pos.f.started = true;
    addSignal(state, { kind: 'agent', at, file: pos.file, line: pos.line, lane });
  }
  if (content) {
    try {
      obj = JSON.parse(line);
    } catch {
      return false;
    }
    if (at) extractSignals(state, obj, { at, file: pos.file, line: pos.line, ...(lane && { lane }) }, isMain, scopeInfo);
  }
  if (at) {
    noteBranch(state, content ? obj.gitBranch : branch, { at, file: pos.file, line: pos.line }, pos.f);
    extendUntil(state, at, lane);
  }
  return true;
}

// ---- 信号（design §3.7.4）----

// 人发消息里要去掉的注入块：系统提醒、本地命令输出；斜杠命令只去标签、保留参数（参数是人写的）。
const INJECTED = /<(system-reminder|local-command-[a-z]+|bash-std(?:out|err))>[\s\S]*?<\/\1>/g;
const COMMAND_TAG = /<\/?command-[a-z]+>/g;
// AI 文字只取开头这么多字做摘要：先遮蔽再截断，余量保证跨截断点的令牌也整段被遮。
const AI_TEXT_PEEK = 2000;

function extractSignals(state, obj, pos, isMain, { refOpts, anchors, repo }) {
  if (obj.type === 'pr-link') {
    const pr = obj.prNumber;
    if (isMain && repo && typeof obj.prRepository === 'string' && obj.prRepository.toLowerCase() === repo
      && Number.isInteger(pr) && !state.signals.some((s) => s.kind === 'pr-link' && s.pr === pr)) addSignal(state, { kind: 'pr-link', ...pos, pr });
    return;
  }
  const blocks = obj.message?.content;
  if (obj.type === 'user') {
    const text = humanText(obj);
    if (text === null) return;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return;
    const masked = mask(flat);
    state.firstPrompt ??= clip(masked, TITLE_MAX);
    noteLastMsg(state, pos.at, masked);
    const refs = extractRefs(flat, refOpts);
    if (hasRefs(refs)) addSignal(state, { kind: 'prompt', ...pos, refs, snippet: around(masked, refs, SNIPPET_MAX) });
    return;
  }
  if (obj.type !== 'assistant' || !Array.isArray(blocks)) return;
  const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  if (isMain && texts.length) {
    const text = texts.join('\n');
    // AI 回复里的任务号不产生信号（owner 已定：顺带提到不算），只计数供诊断页展示。
    const r = extractRefs(text, refOpts);
    if (r.keys.length || r.nums.length || r.codes.length) state.aiOnlyMentions++;
    const flat = text.slice(0, AI_TEXT_PEEK).replace(/\s+/g, ' ').trim();
    if (flat) noteLastMsg(state, pos.at, mask(flat));
  }
  for (const b of blocks) if (b?.type === 'tool_use' && b.input && typeof b.input === 'object') toolSignals(state, b, pos, refOpts, anchors);
}

// 人发的消息：非 isMeta、非压缩摘要、origin 缺省或 human（排除任务通知、子 agent 回报）；字符串或 text 块。
function humanText(obj) {
  if (obj.isMeta || obj.isCompactSummary || (obj.origin != null && obj.origin.kind !== 'human')) return null;
  const c = obj.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  else return null;
  return text.replace(INJECTED, ' ').replace(COMMAND_TAG, ' ');
}

function toolSignals(state, { id, name, input }, pos, refOpts, anchors) {
  if (name === 'Agent' || name === 'Task') {
    const flat = [input.description, input.prompt].filter((x) => typeof x === 'string').join(' ').replace(/\s+/g, ' ').trim();
    const refs = extractRefs(flat, refOpts);
    // toolUseId 对得上子 agent 的 meta.json：engine 据此把派活的任务交给那一路子 agent。
    // 没写任务的派活也要留（带 toolUseId 才留）：engine 在派活时刻冻结主线焦点给那一路，不能等它干活时再取当时的焦点
    const named = hasRefs(refs);
    if (named || typeof id === 'string') {
      addSignal(state, { kind: 'dispatch', ...pos, refs, ...(named && { snippet: around(mask(flat), refs, SNIPPET_MAX) }), ...(typeof id === 'string' && { toolUseId: id }) });
    }
    return;
  }
  const target = name === 'Bash' ? input.command : ['Edit', 'MultiEdit', 'Write'].includes(name) ? input.file_path : null;
  if (typeof target !== 'string') return;
  const t = target.replace(/\\/g, '/').normalize('NFC');
  for (const a of anchors) {
    if (!a.re.test(t)) continue;
    // touch 只用于会话上下文 docId：每份文档记第一次即可。
    if (!state.signals.some((s) => s.kind === 'touch' && s.docPath === a.docPath)) addSignal(state, { kind: 'touch', ...pos, docPath: a.docPath });
    // edit 精确到被改的任务行。Write 整份重写看不出改了哪几行（新建 tasks.md 会把全部任务点亮），只算 touch。
    if (a.tasksFile && (name === 'Edit' || name === 'MultiEdit') && (t === a.docPath || t.endsWith(`/${a.docPath}`))) {
      const edits = name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : [];
      const taskNums = changedTaskNums(edits, a.docId);
      if (taskNums.length) addSignal(state, { kind: 'edit', ...pos, docPath: a.docPath, taskNums });
    }
  }
}

// 新内容里「新增或改过」的任务行的编号。原样带进 new_string 当上下文的任务行不算。
// ponytail: 不看工具调用是否成功（被拒 / 失败的 Edit 也算），失败的改动极少，需要时再对 tool_result 的 is_error。
function changedTaskNums(edits, docId) {
  const changed = [];
  for (const e of edits) {
    if (typeof e?.new_string !== 'string') continue;
    const old = new Set(typeof e.old_string === 'string' ? e.old_string.split('\n') : []);
    changed.push(...e.new_string.split('\n').filter((l) => !old.has(l)));
  }
  if (!changed.length) return [];
  return [...new Set(parseTasksDoc(changed.join('\n'), docId).tasks.map((x) => x.number))];
}

// 规划文档在路径 / 命令里的锚点：spec 目录型认 `<specs 根>/<docId>` 整个目录，其余来源认文件本身。
// 前后不能紧挨文件名字符（collab-m0 不命中 collab-m0-space-run）；前面可以是 /（绝对路径、worktree 路径都认）。
function docAnchors(docs) {
  return docs.map((d) => {
    const home = d.sourceType === 'spec-dir' ? (d.kind === 'planning' ? d.path : path.posix.dirname(d.path)) : d.path;
    const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { docId: d.docId, docPath: d.path, tasksFile: d.kind === 'tasks', re: new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_.-])`) };
  });
}

// gitBranch 每一路（主线、各认得出的子 agent）每个分支只记第一次出现；HEAD（分离状态）丢弃。
// 子 agent 的分支信号带 lane：它在别的 worktree / 分支上干活，不改主线的分支关联。
function noteBranch(state, branch, pos, f) {
  if (typeof branch !== 'string' || !branch || branch === 'HEAD') return;
  const lane = f?.lane ?? null;
  const seen = lane ? (f.branches ??= []) : state.branches;
  if (seen.includes(branch)) return;
  seen.push(branch);
  addSignal(state, { kind: 'branch', ...pos, branch, ...(lane && { lane }) });
}

function noteLastMsg(state, at, masked) {
  if (!state.lastMsg || Date.parse(at) >= Date.parse(state.lastMsg.at)) state.lastMsg = { at, text: clip(masked, SUMMARY_MAX) };
}

const hasRefs = (r) => r.keys.length > 0 || r.nums.length > 0 || r.codes.length > 0 || r.docIds.length > 0;

// 信号按时间有序（子 agent 文件晚于主文件读，但时间穿插在中间）。
// until = 从本信号起、到下一条信号之前最后一条记录的时间：engine 据此算每个焦点段的最后活动（design §3.8.3 第 6 步）。
function addSignal(state, sig) {
  const t = Date.parse(sig.at);
  let i = state.signals.length;
  while (i > 0 && Date.parse(state.signals[i - 1].at) > t) i--;
  state.signals.splice(i, 0, { ...sig, until: sig.at });
}

// 只续同一路（主线 lane = null，各子 agent 一路）的最近一条信号。
// ponytail: 晚到的信号插进中间时，之前已记到前一条信号上的更晚记录不会挪过来（认不出派活的子 agent 文件里的信号才会这样，
// 且前后两条通常同属一个焦点段）；要精确就得存每条记录的时间。
function extendUntil(state, at, lane = null) {
  const t = Date.parse(at);
  for (let i = state.signals.length - 1; i >= 0; i--) {
    const s = state.signals[i];
    if (Date.parse(s.at) > t || (s.lane ?? null) !== lane) continue;
    if (Date.parse(s.until) < t) s.until = at;
    return;
  }
}

// 截到 n 个字符（按码点，不切坏代理对）。
function clip(s, n) {
  const cs = [...s];
  return cs.length <= n ? s : cs.slice(0, n).join('');
}

// 片段取文中最靠前的引用前后：前面留一点上下文，便于页面写「你在会话里说『继续做 … 任务 2.5b』」。
function around(masked, refs, n) {
  const hits = refs.spans.map((sp) => masked.indexOf(sp.text)).filter((i) => i >= 0);
  const hit = hits.length ? Math.min(...hits) : 0;
  let start = hit > 15 ? hit - 15 : 0;
  if (/[\uDC00-\uDFFF]/.test(masked[start] ?? '')) start++;
  return clip(masked.slice(start), n);
}

// 取一行 JSON 里某个字符串字段而不整行解析。取最后一次出现：顶层的 timestamp / cwd 排在 message、attachment
// 等嵌套对象之后（实物字段顺序），而嵌在字符串内容里的同名键因为引号被转义不会被匹配。
function topField(line, key) {
  const at = line.lastIndexOf(`"${key}":"`);
  if (at === -1) return null;
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(line.slice(at + key.length + 3));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

// custom-title.json 只在会话有变化时顺带读（标题改名时 jsonl 里也会追加 custom-title 记录）。
async function readTitleFile(state, projDir, id) {
  try {
    const t = JSON.parse(await readFile(path.join(projDir, id, 'custom-title.json'), 'utf8'))?.customTitle;
    state.fileTitle = typeof t === 'string' && t.trim() ? mask(t.trim()) : null;
  } catch {
    state.fileTitle = null;
  }
}

/**
 * 只读打开，从 start 读到 end（调用前 stat 到的大小），逐行回调；只消费到最后一个换行，半行留到下次。
 * 按字节切行，多字节字符不会被块边界切坏。返回新的偏移。
 */
async function readLines(abs, start, end, onLine) {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = start;
    let consumed = start;
    let carry = Buffer.alloc(0);
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let from = 0;
      for (let nl; (nl = chunk.indexOf(10, from)) !== -1; from = nl + 1) onLine(chunk.toString('utf8', from, nl));
      consumed = pos - (chunk.length - from);
      carry = Buffer.from(chunk.subarray(from)); // buf 下一轮复用，半行要拷出来
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

// ---- 归属 ----

// 目录名 = 起始 cwd 把每个非 [A-Za-z0-9] 字符换成 -（有损）。roots 前缀匹配（含子目录），exact 相等；忽略大小写。
// 会误中 `<root>-other` 这类兄弟目录，由记录里的 cwd 精确确认排除。
function coarseMatch(name, { rootCodes, exactCodes }) {
  const n = name.toLowerCase();
  return exactCodes.has(n) || rootCodes.some((c) => n === c || n.startsWith(`${c}-`));
}

// 非 ASCII 字符按 UTF-16 码元逐个换成 -，NFC / NFD 的横线数不同（如带浊点的假名），两种都认。
function encodeVariants(p) {
  return [...new Set(['NFC', 'NFD'].map((f) => p.normalize(f).replace(/[^A-Za-z0-9]/g, '-').toLowerCase()))];
}

// 属于本项目：任一 cwd 落在某 root 子树内，或首个 cwd 与某 exact 相等（design §3.7.2 第 4 步）。
function isOwned(state, { roots, exact }) {
  if (state.firstCwd !== null && exact.has(norm(state.firstCwd))) return true;
  return state.cwds.some((c) => {
    const n = norm(c);
    return roots.some((r) => n === r || n.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  });
}

function norm(p) {
  const n = p.normalize('NFC').replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

// 证据里的文件位置：相对记录根、用 / 分隔（design §6）。
function displayRel(dirName, rel) {
  return `${dirName}/${rel}`;
}

function toRecord(s) {
  if (s.firstAt === null) return null; // 没有任何带时间的记录：无从判断活动，不出会话
  // 标题：custom-title → agent-name → custom-title.json → 首条人发消息（均已遮蔽）。
  const title = s.customTitle ?? s.agentName ?? s.fileTitle;
  return {
    source: claudeCode.id,
    id: s.id,
    files: Object.keys(s.files),
    cwds: s.cwds,
    branches: [...new Set([...s.branches, ...Object.values(s.files).flatMap((f) => f.branches ?? [])])],
    title: title ? clip(title, TITLE_MAX) : s.firstPrompt,
    firstAt: s.firstAt,
    lastAt: s.lastAt,
    lastSummary: s.lastMsg?.text ?? null,
    signals: s.signals,
    aiOnlyMentions: s.aiOnlyMentions,
    brokenLines: Object.values(s.files).reduce((n, f) => n + f.broken, 0),
  };
}
