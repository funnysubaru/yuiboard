// 规划文档（design §3.2、§3.3）：文档发现、只读 git 封装与本地同步检查，会读文件与跑白名单内的只读 git。
// 纯解析函数（parseTasksDoc 等）在 parse.mjs（N27：Claude Code mod 也要用，不能沾 node: 模块），这里转出，调用方不变。
// 关系语法与前置条件表在 relations.mjs。
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { discoverAdrs } from './adr.mjs';
import { msg, joinList } from './msg.mjs';
import { gitEnv } from './config.mjs';
import { globMatcher, parseTasksDoc, parseAdrDoc } from './parse.mjs';

export { parseTasksDoc, parseEstimate, compareTaskNumbers } from './parse.mjs';
// ---- 文档发现与工作区（design §3.2，任务 1.3）----
// 只用 readdir / readFile，从不写、从不 checkout。

/**
 * 只读 git 封装：不经 shell；关闭可选锁（不刷索引、不抢 index.lock，需求 16.1）与交互提示；
 * 中文路径不转义；10 秒超时，到了超时的那一次不论成败都重试一次。只放行白名单里的子命令，后续任务要用新命令时把前缀加进 GIT_ALLOWED。
 * @param {string} ws 工作区绝对路径
 * @param {string[]} args 例如 ['rev-parse', 'HEAD']
 * @param {{ raw?: boolean }} [opts] raw = 读文件内容：不去首尾空白（首部空行影响行号），输出上限放到 64 MiB
 * @returns {Promise<string>} stdout（默认去掉首尾空白）；git 失败或超时时抛出 execFile 的错误
 */
export async function gitRead(ws, args, { raw = false } = {}) {
  if (!GIT_ALLOWED.some((prefix) => prefix.every((a, k) => args[k] === a))) {
    throw new Error(`只读 git 白名单外的命令：git ${args.join(' ')}`);
  }
  const run = () => runGit('git', ['-C', ws, '-c', 'core.quotepath=false', ...args], {
    timeout: GIT_TIMEOUT,
    env: gitEnv(),
    ...(raw ? { maxBuffer: 64 * 1024 * 1024 } : {}),
  });
  const started = performance.now();
  // 被超时杀掉（killed 且没有退出码；超出 maxBuffer 时 code 是字符串）算没读到，其它失败照常抛出
  const first = await run().catch((e) => {
    if (e.killed && e.code == null) return null;
    throw e;
  });
  // 到了超时的那一次不可信，重试一次（N30）：机器睡眠 / DarkWake 期间进程冻结，醒来时 10 秒超时先于读管道执行。
  // git 还在写 → 被杀掉报错；git 已正常退出 → execFile 先销毁 stdout 再杀，「成功」返回截断（常为空）的输出，
  // 所以按耗时判断、不看成败。再超时就照常抛出。
  const { stdout } = first && performance.now() - started < GIT_TIMEOUT ? first : await run();
  return raw ? stdout : stdout.trim();
}
// 按参数前缀匹配。design §3.2 的完整白名单还有 worktree list --porcelain、log --diff-filter=A、merge-base --is-ancestor，由用到的任务加入。
const GIT_ALLOWED = [['rev-parse'], ['merge-base', '--is-ancestor'], ['log', '--diff-filter=A'], ['worktree', 'list', '--porcelain'], ['for-each-ref'], ['cat-file', 'blob']];
const runGit = promisify(execFile);
const GIT_TIMEOUT = 10_000;

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
    if (!discover) { // N9：未知来源类型（如把 md-dir 写成 md_dir）跳过并记诊断，不再静默
      diagnostics.push({ message: msg`来源「${source.label}」的类型「${source.type}」不认识，已跳过；可用的类型：${joinList(Object.keys(DISCOVERERS))}` });
      continue;
    }
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
        const parsed = await cachedRead(old, stamp, () => readDoc(d, parseOpts));
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
      const why = ws.error ? msg`读不到 ${line.docRef}：${ws.error}` : msg`${line.docRef} 上没有这个文件`;
      const parsed = await cachedRead(old, stamp, async () => (blob ? readDoc(d, parseOpts, () => gitRead(project.repo.path, ['cat-file', 'blob', blob], { raw: true }))
        : { kind: d.kind, title: null, parse: emptyParse('error', why), groups: [], tasks: [] }));
      if (parsed !== old?.parsed) reparsed.push(d.docId);
      parsedCache[d.docId] = { stamp, parsed };
      docs.push({ ...base, ...parsed });
    }
  }
  return { workspaces, docs, diagnostics, reparsed, parsedCache };
}

// 文件戳没变就沿用上一轮结果；但 error 的不沿用、每轮重读：读失败可能只是一时的（N30：机器睡眠 / DarkWake 期间进程冻结超过 10 秒，醒来时
// git cat-file 子进程被 gitRead 的超时杀掉），否则这份错误会连同 docs.json 一直留到文件变动。
// 重读仍是同一错误（文件不存在等）就沿用旧对象，调用方据此不算重解析，不会每轮触发重算。
async function cachedRead(old, stamp, read) {
  if (old?.stamp === stamp && old.parsed.parse.state !== 'error') return old.parsed;
  const parsed = await read();
  const same = old?.stamp === stamp && parsed.parse.state === 'error' && parsed.parse.reason === old.parsed.parse.reason;
  return same ? old.parsed : parsed;
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

/**
 * 仓库的全部 worktree 绝对路径（含主工作区；可在仓库目录之外），供会话归属判定（design §3.7.2）。
 * git 失败时抛出，由调用方记诊断。
 * @returns {Promise<string[]>}
 */
export async function listWorktrees(ws) {
  const out = await gitRead(ws, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length)).normalize('NFC'));
}
