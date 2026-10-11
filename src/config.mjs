// 配置加载（design §3.1）。
// 原则：配置坏了也不让服务崩——JSON 语法错记全局错误，单个项目的问题只记在该项目名下，
// 其它项目照常可用（需求 1.4、1.6）。本模块不写任何文件。
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { msg } from './msg.mjs';

const run = promisify(execFile);

// 项目空间根取自本文件位置而非启动 cwd：整个目录搬走后不改代码即可启动（需求 1.3）。
export const SPACE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(SPACE_ROOT, 'devboard.config.json');

const SERVER_DEFAULTS = { host: '127.0.0.1', port: 4317 };
const DEFAULTS = {
  hoursPerDay: 8, defaultDurationDays: 1, sessionRunningMinutes: 10, sessionStaleDays: 3,
  githubRefreshMinutes: 5, recentClosedPrDays: 14, recentChangesDays: 7,
};
// GitHub 刷新间隔下限，防止把 API 额度打光（design §3.1）。
const MIN_GITHUB_REFRESH_MINUTES = 2;

/**
 * 读取并校验配置。
 * @param {string} [configPath] 默认 `<空间根>/devboard.config.json`
 * @returns {Promise<{ server: {host: string, port: number}, defaults: object, projects: object[],
 *   errors: {projectId: string|null, field: string|null, message: string}[], warnings: string[] }>}
 *   errors 里 projectId 为 null 表示全局错误（整份配置不可用）；否则只停用该项目。
 */
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const result = { server: { ...SERVER_DEFAULTS }, defaults: { ...DEFAULTS }, projects: [], errors: [], warnings: [] };
  const globalError = (message) => { result.errors.push({ projectId: null, field: null, message }); return result; };

  let text;
  try {
    text = (await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''); // 去 BOM：Windows 记事本保存的 UTF-8 会带
  } catch (e) {
    if (e.code === 'ENOENT') return globalError(msg`找不到配置文件 ${configPath}（可复制 devboard.config.example.json 后修改）`);
    return globalError(msg`配置文件 ${configPath} 读取失败：${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return globalError(msg`配置文件 ${configPath} 不是合法 JSON（${jsonErrorLine(text, e)}）：${e.message}`);
  }
  if (!isObject(raw)) return globalError(msg('配置文件顶层必须是 JSON 对象'));
  if (raw.projects !== undefined && !Array.isArray(raw.projects)) return globalError(msg('projects 必须是数组'));

  Object.assign(result.server, raw.server);
  Object.assign(result.defaults, raw.defaults);
  if (!isLoopback(result.server.host)) {
    result.warnings.push(msg`server.host 为 ${result.server.host}，不是本机回环地址，局域网内其它机器可能访问到看板`);
  }
  if (!(result.defaults.githubRefreshMinutes >= MIN_GITHUB_REFRESH_MINUTES)) {
    result.warnings.push(msg`defaults.githubRefreshMinutes 为 ${result.defaults.githubRefreshMinutes}，低于下限，按 ${MIN_GITHUB_REFRESH_MINUTES} 分钟执行`);
    result.defaults.githubRefreshMinutes = MIN_GITHUB_REFRESH_MINUTES;
  }

  // 相对路径以配置文件所在目录为基准：配置与空间一起搬走时相对路径仍然成立。
  const baseDir = path.dirname(path.resolve(configPath));
  const seenIds = new Set();
  const checked = await Promise.all((raw.projects ?? []).map((p, i) => loadProject(p, i, baseDir, seenIds)));
  for (const { project, errors } of checked) {
    result.projects.push(project);
    result.errors.push(...errors);
  }
  return result;
}

// 校验单个项目。有错的项目仍放进 projects，由上层按 errors 停用并显示「项目 X 的 Y 项」，
// 而不是悄悄丢掉、让页面看起来像空看板。
async function loadProject(p, index, baseDir, seenIds) {
  const errors = [];
  if (!isObject(p)) {
    return { project: { id: `projects[${index}]` }, errors: [{ projectId: `projects[${index}]`, field: null, message: msg`项目 projects[${index}] 必须是对象` }] };
  }
  const id = typeof p.id === 'string' && p.id ? p.id : `projects[${index}]`;
  const err = (field, message) => errors.push({ projectId: id, field, message: msg`项目 ${id} 的 ${field} 项：${message}` });

  if (id !== p.id) err('id', msg('缺少或不是字符串'));
  // id 会拼进 cache/<id>、data/<id> 路径与接口地址，只允许安全字符，杜绝 ../ 之类越界
  else if (!/^[A-Za-z0-9_-]+$/.test(id)) err('id', msg('只能用字母、数字、- 和 _'))
  else if (seenIds.has(id)) err('id', msg('与其它项目重复'));
  seenIds.add(id); // 同步执行，Promise.all 并发时也不会漏判重复

  const project = { ...p, id, name: p.name || id, repo: { ...p.repo } };
  if (!isObject(p.repo)) err('repo', msg('缺少'));
  // N11：repo.github 可选，没有 GitHub 远端的项目按「仅文档」运行；写了就必须是 owner/name
  else if (p.repo.github !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(String(p.repo.github))) err('repo.github', msg('格式应为 owner/name；没有 GitHub 远端就不写这一项'));

  if (!Array.isArray(p.branchLines) || p.branchLines.length === 0) err('branchLines', msg('至少需要一条分支线'));

  // 这些正则在后续解析时才编译，先在这里挡住写错的，避免运行中抛错。
  for (const [field, value] of [['milestoneCodePattern', p.milestoneCodePattern], ['prerequisiteIdPattern', p.prerequisiteIdPattern],
    ...(Array.isArray(p.branchLines) ? p.branchLines.map((b, i) => [`branchLines[${i}].docFilter`, b?.docFilter]) : [])]) {
    if (value === undefined) continue;
    try { new RegExp(value); } catch (e) { err(field, msg`正则无效：${e.message}`); }
  }

  // N17：docRef 分支线从主仓库的 git ref 读 docFiles，文档 docId 带「<分支线 id>:」前缀。
  // ref 与文件路径会拼进 git 参数，只收安全写法；docFilter 必须认到自己的前缀，且别的分支线不能也认到（否则同名文档串线）。
  for (const [i, b] of (Array.isArray(p.branchLines) ? p.branchLines : []).entries()) {
    if (b?.docRef === undefined) continue;
    const f = `branchLines[${i}]`;
    if (typeof b.docRef !== 'string' || !/^[A-Za-z0-9][\w./-]*$/.test(b.docRef) || b.docRef.includes('..')) err(`${f}.docRef`, msg('应为分支或 ref 名，如 origin/next/v3'));
    if (b.workspace) err(`${f}.docRef`, msg('与 workspace 只能二选一'));
    if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(b.id)) err(`${f}.id`, msg('配了 docRef 时只能用字母、数字、- 和 _（会作为文档名前缀）'));
    if (!Array.isArray(b.docFiles) || !b.docFiles.length
      || b.docFiles.some((x) => typeof x !== 'string' || !/^[^/\-.]/.test(x) || x.includes(':') || x.split('/').some((seg) => seg === '..' || seg === '.' || !seg))) {
      err(`${f}.docFiles`, msg('至少一个仓库内相对路径（用 /，不以 / . - 开头，不含 .. 和 :）'));
    }
    // 探针：通用的 <id>:x，加上 docFiles 推出的真实文档名（别的线 docFilter 可能只认到 next:ADR-0033-… 而认不到 next:x）
    const files = Array.isArray(b.docFiles) ? b.docFiles.filter((x) => typeof x === 'string') : [];
    const probes = [`${b.id}:x`, ...files.flatMap((x) => [`${b.id}:${x.replace(/\.[^./]+$/, '')}`, `${b.id}:${x.split('/').pop().replace(/\.[^./]+$/, '')}`])];
    const own = probes[0];
    let ok = false;
    try { ok = typeof b.docFilter === 'string' && new RegExp(b.docFilter).test(own); } catch { /* 正则无效上面已报 */ }
    if (!ok) err(`${f}.docFilter`, msg`配了 docRef 时必须认到本线文档（以「${b.id}:」开头），如 ^${b.id}:`);
    for (const [j, o] of p.branchLines.entries()) {
      if (j === i || typeof o?.docFilter !== 'string') continue;
      let hit = false;
      try { const re = new RegExp(o.docFilter); hit = probes.some((x) => re.test(x)); } catch { /* 同上 */ }
      if (hit) err(`branchLines[${j}].docFilter`, msg`也会认到分支线 ${b.id} 的文档（${b.id}:…），请排除，如 ^(?!collab-|${b.id}:)`);
    }
  }

  // 路径类字段统一解析；仓库与分支线工作区必须是 git 工作区，会话目录缺失属于运行期降级（design §5），这里只解析不校验。
  const repoChecks = [];
  if (isObject(p.repo)) {
    if (!p.repo.path) err('repo.path', msg('缺少'));
    else {
      project.repo.path = resolvePath(p.repo.path, baseDir);
      repoChecks.push(['repo.path', project.repo.path]);
    }
  }
  if (Array.isArray(p.branchLines)) {
    project.branchLines = p.branchLines.map((b, i) => {
      if (!b?.workspace) return b;
      const workspace = resolvePath(b.workspace, baseDir);
      repoChecks.push([`branchLines[${i}].workspace`, workspace]);
      return { ...b, workspace };
    });
  }
  if (Array.isArray(p.sessions)) {
    project.sessions = p.sessions.map((s) => ({
      ...s,
      ...(s?.dir ? { dir: resolvePath(s.dir, baseDir) } : {}),
      ...(Array.isArray(s?.extraCwds) ? { extraCwds: s.extraCwds.map((c) => resolvePath(c, baseDir)) } : {}),
    }));
  }

  for (const [field, dir] of repoChecks) {
    const problem = await checkGitDir(dir);
    if (problem) err(field, problem);
  }
  return { project, errors };
}

/**
 * 支持 `~/`、绝对路径、相对 baseDir 的路径；结果做 NFC 规范化（macOS 文件名可能是 NFD，
 * 不统一的话同一路径的字符串比较会失败）。
 */
export function resolvePath(p, baseDir) {
  const expanded = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(baseDir, expanded).normalize('NFC');
}

// 返回问题描述，没问题返回 null。只用只读的 rev-parse，并关闭可选锁与交互提示，避免干扰 owner 的 git 操作（需求 16.1）。
async function checkGitDir(dir) {
  try {
    if (!(await stat(dir)).isDirectory()) return msg`${dir} 不是目录`;
  } catch {
    return msg`路径不存在：${dir}`;
  }
  try {
    await run('git', ['-C', dir, 'rev-parse', '--git-dir'], {
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return null;
  } catch (e) {
    return e.code === 'ENOENT' ? msg`${dir} 不是 git 仓库（git rev-parse 失败：找不到 git 命令）` : msg`${dir} 不是 git 仓库（git rev-parse 失败）`;
  }
}

// JSON 语法错的位置。V8 多数报错自带「(line X column Y)」；「Unexpected token」类不带，
// 就逐行增加前缀重解析，第一个报错不再是「输入提前结束」的行即出错行。
// ponytail: O(行数²)，配置文件只有几十行；配置变大再换成手写扫描器。
function jsonErrorLine(text, error) {
  const m = /\(line (\d+) column (\d+)\)/.exec(error.message);
  if (m) return msg`第 ${m[1]} 行第 ${m[2]} 列`;
  const lines = text.split(/\r?\n/);
  for (let n = 1; n <= lines.length; n++) {
    const prefix = lines.slice(0, n).join('\n');
    try { JSON.parse(prefix); } catch (e) {
      const pos = /at position (\d+)/.exec(e.message);
      const atEnd = /end of JSON input/.test(e.message) || (pos && Number(pos[1]) >= prefix.length);
      if (!atEnd) return msg`第 ${n} 行`;
    }
  }
  return msg('位置未知');
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
