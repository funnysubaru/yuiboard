#!/usr/bin/env node
// devboard 运维脚本（N11，design §4）：给 AI skill 用的确定性操作，判断类工作留给 skill。
//   check [配置路径]     校验配置（只读）
//   find <仓库路径>      按规范化路径找已有项目（只读），skill 据此决定新增还是更新、沿用原 id
//   up [--no-launchd]    保证服务在跑且已加载最新配置（Task 5、6）；macOS 用 LaunchAgent，Linux 用 systemd 用户服务（N22 任务 22.4），
//                        --no-launchd（别名 --no-service）只起后台进程
//   save --new           从 stdin 读一个项目对象追加；save --update <id> 从 stdin 读补丁（只许 name / docSources / repo.github）
//   remove <id>          删除该项目
//   revert <revision>    撤销 save / remove 返回的那次写入（配置之后又被改过就拒绝）
// save / remove 是 skill 写配置的唯一入口：持锁 → 备份 .bak → 原子写 → check，目标项目或全局有错（含校验抛异常）就恢复备份。
// 每个子命令往 stdout 打一行 JSON，ok 为 false 时退出码 1。
// 写盘范围（AGENTS 硬约束的例外，服务本身仍只写 cache/ data/）：devboard.config.json（及 .bak、.rev、.lock、写入时的同目录临时文件）、cache/devboard.pid、
// cache/devboard.log、~/Library/LaunchAgents 下本次新建的 plist、~/Library/Logs 目录、~/.config/systemd/user 下本次新建的 unit。
import { readFile, writeFile, readdir, mkdir, rm, open, rename, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolvePath } from '../src/config.mjs';

export const DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 读 JSON（去 BOM：手改配置可能带）。 */
export const readJson = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));

/** 写 JSON（两格缩进 + 换行，无 BOM）：先写同目录临时文件再 rename，写到一半崩掉也不会留下半截配置。 */
export async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** 用服务同一套 loadConfig 校验；errors 里 projectId 为 null 的是全局错误（如 JSON 语法错）。 */
export async function check(configPath) {
  const cfg = await loadConfig(configPath);
  return { ok: cfg.errors.length === 0, errors: cfg.errors, warnings: cfg.warnings };
}

// 同一仓库的判定：展开 ~ 与相对路径（基准为配置文件目录）→ realpath（软链、/var → /private/var）→ NFC。
// 路径不存在时退回展开后的结果，仍可按字符串比较。
function canonical(p, baseDir) {
  const abs = resolvePath(p, baseDir);
  try { return realpathSync(abs).normalize('NFC'); } catch { return abs; }
}

/**
 * 配置（原始 JSON）里与 repoPath 是同一仓库的项目：先比 repo.path，再比各项目 branchLines[].workspace
 * （分支线的独立检出，如协作版另开一个目录）；没有为 null。命中时 skill 沿用它的 id 与既有字段。
 * 返回 { project, matchedBy }，matchedBy 为 'repo' 或 `workspace:<分支线 id>`；repo 匹配优先于别的项目的 workspace 匹配。
 */
export function findProject(config, repoPath, configDir) {
  const want = canonical(repoPath, configDir);
  const projects = config?.projects ?? [];
  const byRepo = projects.find((p) => typeof p?.repo?.path === 'string' && canonical(p.repo.path, configDir) === want);
  if (byRepo) return { project: byRepo, matchedBy: 'repo' };
  for (const p of projects) {
    const line = (p?.branchLines ?? []).find((l) => typeof l?.workspace === 'string' && canonical(l.workspace, configDir) === want);
    if (line) return { project: p, matchedBy: `workspace:${line.id}` };
  }
  return null;
}

/** 从 start 起找第一个 isFree(port) 为真的端口；最多试 100 个。 */
export async function pickPort(start, isFree) {
  for (let p = start; p < start + 100 && p <= 65535; p++) if (await isFree(p)) return p;
  throw new Error(`从 ${start} 起 100 个端口都被占用`);
}

/** 端口能不能在 127.0.0.1 上绑定。 */
export function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * 端口上是不是 devboard：/api/projects 返回含 projects 数组的 JSON。
 * ponytail: 只探 127.0.0.1；server.host 改成 ::1 等其它地址时认不出，需要时按配置的 host 探。
 */
export async function isDevboard(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(1000) });
    return Array.isArray((await res.json())?.projects);
  } catch {
    return false;
  }
}

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const XML_UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m, k) => XML_UNESC[k]);

/** 按模板填 {{名字}}；值做 XML 转义；模板里有而 values 没给的占位符直接报错，免得写出半成品 plist。 */
export function renderPlist(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (values[k] === undefined) throw new Error(`plist 模板缺少值：${k}`);
    return String(values[k]).replace(/[&<>"']/g, (c) => XML_ESC[c]);
  });
}

// 各占位符在 unit 里的解析规则不同（systemd load-fragment.c）：三类都展开 % 说明符，所以 % 一律写成 %%；
// cmd = ExecStart 第一个词（可执行文件）：C 转义，但它在变量展开之前就按原样查找，$ 不能写成 $$；
// exec = ExecStart 的其余参数：C 转义，且会做 $ 变量展开 → $ 写成 $$；
// env = Environment="…"，做 C 转义、不展开 $；path = WorkingDirectory / append: 路径，原样取（不去转义）。
// path 字段若以反斜杠结尾会被当成续行，模板里让它们不落在行尾（WorkingDirectory={{DIR}}/.）。
const UNIT_FIELD = { NODE: 'cmd', SERVER: 'exec', PATH: 'env', DIR: 'path', LOG: 'path' };
const quoteEsc = (v) => v.replace(/[\\"]/g, (c) => `\\${c}`);
const UNIT_ESC = {
  cmd: (v) => quoteEsc(v.replace(/%/g, '%%')),
  exec: (v) => quoteEsc(v.replace(/%/g, '%%').replace(/\$/g, '$$$$')),
  env: (v) => quoteEsc(v.replace(/%/g, '%%')),
  path: (v) => v.replace(/%/g, '%%'),
};

/**
 * 按模板填 systemd unit 的 {{名字}}，按 UNIT_FIELD 的字段类别转义；
 * 值里有换行会拼出别的配置项，直接报错。缺值、未登记的占位符同 renderPlist 报错。
 */
export function renderUnit(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (values[k] === undefined || !UNIT_FIELD[k]) throw new Error(`unit 模板缺少值：${k}`);
    const v = String(values[k]);
    if (/[\r\n]/.test(v)) throw new Error(`unit 模板的值不能含换行：${k}`);
    return UNIT_ESC[UNIT_FIELD[k]](v);
  });
}

// renderUnit 的逆：exec 参数先去 C 转义再还原 %% / $$（第一个词 cmd 不还原 $$）；path 只还原 %%。
const unescPath = (s) => s.replace(/%%/g, '%');
const unescCmd = (s) => s.replace(/\\(.)/g, '$1').replace(/%%/g, '%');
const unescExec = (s) => unescCmd(s).replace(/\$\$/g, '$');

/** 在 unit 文本里找 ExecStart 含 serverPath 的那份（管理本目录 devboard 的 systemd 用户服务）。label 是 unit 文件名。 */
export function findUnit(units, serverPath) {
  for (const { file, text } of units) {
    const exec = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
    const args = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m, i) => (i ? unescExec : unescCmd)(m[1] ?? m[2]));
    if (!args.includes(serverPath)) continue;
    const log = /^StandardError=append:(.*)$/m.exec(text)?.[1];
    return { file, label: path.basename(file), errLog: log ? unescPath(log) : null };
  }
  return null;
}

/** 在 plist 文本里找 ProgramArguments 含 serverPath 的那份（即管理本目录 devboard 的 LaunchAgent）。 */
export function findAgent(plists, serverPath) {
  for (const { file, text } of plists) {
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    const strings = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
    if (!label || !strings.includes(serverPath)) continue;
    const errLog = /<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
    return { file, label: unxml(label), errLog: errLog ? unxml(errLog) : null };
  }
  return null;
}

/** 目录下全部 .plist（或 ext 指定的扩展名）的文本；目录不存在为空数组，单个读不了的当空文本。 */
export async function readPlists(dir, ext = '.plist') {
  let names;
  try { names = (await readdir(dir)).filter((n) => n.endsWith(ext)); } catch { return []; }
  return Promise.all(names.map(async (n) => ({ file: path.join(dir, n), text: await readFile(path.join(dir, n), 'utf8').catch(() => '') })));
}

/** 跑一条命令，不抛异常：返回退出码与输出；命令不存在时 code 为 127。测试注入替身代替它。 */
export function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (e, stdout = '', stderr = '') => {
      resolve({ code: e ? (Number.isInteger(e.code) ? e.code : 127) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const CONFIG = path.join(DIR, 'devboard.config.json');

const DEFAULT_PORT = 4317;
const MIN_CONFIG = { server: { host: '127.0.0.1', port: DEFAULT_PORT }, projects: [] };

/** up 用到的路径与可注入项（测试传临时目录、替身 sh、platform）。 */
export function context(o = {}) {
  const dir = path.resolve(o.dir ?? DIR);
  return {
    dir,
    configPath: path.join(dir, 'devboard.config.json'),
    serverEntry: path.join(dir, 'src', 'server.mjs'),
    pidFile: path.join(dir, 'cache', 'devboard.pid'),
    logFile: path.join(dir, 'cache', 'devboard.log'),
    platform: o.platform ?? process.platform,
    useLaunchd: (o.platform ?? process.platform) === 'darwin' && !o.noLaunchd,
    useSystemd: (o.platform ?? process.platform) === 'linux' && !o.noLaunchd,
    nodeVersion: o.nodeVersion ?? process.versions.node,
    execPath: o.execPath ?? process.execPath,
    timeoutMs: o.timeoutMs ?? 15_000,
    uid: o.uid ?? process.getuid?.() ?? 0,
    agentsDir: o.agentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
    logsDir: o.logsDir ?? path.join(os.homedir(), 'Library', 'Logs'),
    unitsDir: o.unitsDir ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user'),
    sh: o.sh ?? sh,
  };
}

const agentLoaded = async (ctx, agent) => (await ctx.sh('launchctl', ['print', `gui/${ctx.uid}/${agent.label}`])).code === 0;
const unitActive = async (ctx, unit) => (await ctx.sh('systemctl', ['--user', 'is-active', '--quiet', unit.label])).code === 0;

async function readPid(ctx) {
  const n = Number((await readFile(ctx.pidFile, 'utf8').catch(() => '')).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 进程的完整命令行；进程不存在或取不到为空串。Windows 没有 ps，用 PowerShell 查 Win32_Process（Win10 起自带）。 */
export async function commandLine(ctx, pid) {
  const r = ctx.platform === 'win32'
    ? await ctx.sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`])
    : await ctx.sh('ps', ['-p', String(pid), '-o', 'args=']);
  return r.code === 0 ? r.stdout.trim() : '';
}

// pidfile 里的进程还是不是本目录起的 devboard：命令行里有一个完整参数正好是本目录 src/server.mjs
// （PID 会被系统复用，只看存活不够；按子串比会把 /mnt/copy<本目录>/src/server.mjs、server.mjs.bak 也认成自己）。
// Windows 的命令行会给带空格的参数加双引号，所以也认 "<路径>"。
async function ownsPid(ctx, pid) {
  const entry = ctx.serverEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)("${entry}"|${entry})(\\s|$)`).test(await commandLine(ctx, pid));
}

/** 配置文件不存在时生成最小配置（requirements 5.2）；已存在不动。 */
export async function ensureConfig(configPath) {
  if (existsSync(configPath)) return false;
  await writeJson(configPath, MIN_CONFIG);
  return true;
}

// 改配置的跨进程互斥：<配置>.lock 以 O_EXCL 创建、内容是持有者 PID；占用时每 100ms 重试，10 秒拿不到 →
// config-busy。原子 rename 只保证单次替换，两个 skill 同时读改写仍会互相覆盖，所以读、备份、写、校验、回滚整段都要在锁内。
// 持有者 PID 已不在（上次崩溃留下的锁）→ stale-lock，不自动删：多个进程同时「读到死 PID → 删锁」时，后删的会删掉
// 先删者刚建的活锁，互斥就破了。由 skill 征得用户同意后手动删锁再重试（崩溃留锁很少见，人工处理够用）。
export async function withConfigLock(configPath, fn, { waitMs = 10_000 } = {}) {
  const lock = `${configPath}.lock`;
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(await readFile(lock, 'utf8').catch(() => '')); // 刚创建、还没写 PID 时为 0，按占用处理
      if (holder && !pidAlive(holder)) return { ok: false, reason: 'stale-lock', lock, pid: holder, error: `配置锁 ${lock} 是已退出的进程 ${holder} 留下的；确认没有别的 devboard-ctl 在运行后删掉它再重试` };
      if (Date.now() > end) return { ok: false, reason: 'config-busy', lock, error: `另一个进程（PID ${holder || '未知'}）正在改配置，${waitMs / 1000} 秒内没等到；稍后重试` };
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await rm(lock, { force: true }); }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PATCH_FIELDS = ['name', 'docSources', 'repo'];

/**
 * 改配置的共同流程：ensureConfig → 现有配置有全局错就不动 → mutate（返回对象表示拒绝，原因并入结果）→
 * 复制 .bak → 原子写 → check（全程持 withConfigLock）。全局错误、校验抛异常或 projectId 为 id 的错误 → 用 .bak 还原并报 check-failed；
 * 别的项目原有的错误不挡保存（MVP 需求 1.6：单个项目有错只停用它），放在 otherErrors 里供汇报。
 */
function editConfig(configPath, id, mutate) {
  return withConfigLock(configPath, () => editLocked(configPath, id, mutate));
}

async function editLocked(configPath, id, mutate) {
  await ensureConfig(configPath);
  const before = await check(configPath);
  if (before.errors.some((e) => e.projectId === null)) return { ok: false, reason: 'config-invalid', error: '配置文件不可用，未改动', errors: before.errors };
  const cfg = await readJson(configPath);
  cfg.projects ??= [];
  const refused = mutate(cfg);
  if (refused) return { ok: false, ...refused };
  const bak = `${configPath}.bak`;
  await rm(`${configPath}.rev`, { force: true }); // 要覆盖 .bak 了：上一次写入的撤销凭据随之作废（含无变化保存、校验失败的尝试）
  await copyFile(configPath, bak);
  let errors, warnings;
  try {
    await writeJson(configPath, cfg);
    ({ errors, warnings } = await check(configPath));
  } catch (e) {
    // 校验本身抛异常（如 repo.path 不是字符串）也算全局错误，走下面的恢复，不能把坏配置留在正式文件里
    errors = [{ projectId: null, field: null, message: `写入后校验出错：${e.message}` }];
    warnings = [];
  }
  const blocking = errors.filter((e) => e.projectId === null || e.projectId === id);
  if (blocking.length) {
    await rename(bak, configPath);
    return { ok: false, reason: 'check-failed', error: '写入后校验不过，已恢复原配置', errors: blocking };
  }
  const revision = randomBytes(8).toString('hex');
  await writeJson(`${configPath}.rev`, { revision, hash: await hashOf(configPath) });
  return { ok: true, id, revision, warnings, otherErrors: errors.filter((e) => !blocking.includes(e)) };
}

const hashOf = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/**
 * 撤销某次 save / remove（skill 在之后的 up 失败时用）。revision 是那次写入随机生成的操作号，和写入后的内容哈希一起记在
 * <配置>.rev；之后任何经 devboard-ctl 的写入尝试都会先删掉它（.bak 跟着换主），所以只认内容哈希不够——配置可能改回同一内容，
 * .bak 却已是别人的。持锁核对：.rev 里的操作号是这次的、正式配置内容也仍是那次写入的结果（up 换端口、手改都会让它变）→
 * 用 .bak 还原并作废凭据；否则 config-changed，什么都不动，免得撤掉别人已经成功的保存。
 */
export function revert(configPath, revision) {
  return withConfigLock(configPath, async () => {
    const rev = await readJson(`${configPath}.rev`).catch(() => null);
    if (rev?.revision !== revision || !existsSync(configPath) || await hashOf(configPath) !== rev.hash) {
      return { ok: false, reason: 'config-changed', error: '这次写入之后配置又被改过，未还原，保留当前配置' };
    }
    if (!existsSync(`${configPath}.bak`)) return { ok: false, reason: 'not-found', error: '没有备份可还原' };
    await rename(`${configPath}.bak`, configPath);
    await rm(`${configPath}.rev`, { force: true });
    return { ok: true };
  });
}

/** 追加新项目：同 id 已存在 → id-exists；同一仓库（repo.path 或某分支线 workspace）已接入 → already-onboarded。 */
export async function saveNew(configPath, project) {
  if (!isObj(project) || typeof project.id !== 'string' || !project.id) return { ok: false, reason: 'bad-input', error: '需要一个含 id 的项目对象' };
  return editConfig(configPath, project.id, (cfg) => {
    if (cfg.projects.some((p) => p?.id === project.id)) return { reason: 'id-exists', id: project.id, error: `已有 id 为 ${project.id} 的项目` };
    const hit = typeof project.repo?.path === 'string' ? findProject(cfg, project.repo.path, path.dirname(configPath)) : null;
    if (hit) return { reason: 'already-onboarded', id: hit.project.id, matchedBy: hit.matchedBy, error: `该仓库已作为项目 ${hit.project.id} 接入，请改用 save --update` };
    cfg.projects.push(project);
  });
}

/**
 * 按补丁改已有项目：只许 name、docSources、repo.github；其余字段（id、repo.path、branchLines、archived、
 * excluded、各类 Pattern、sessions、github、未知字段）原样留在原位置。补丁里有别的字段 → patch-field-not-allowed。
 */
export async function saveUpdate(configPath, id, patch) {
  if (!isObj(patch)) return { ok: false, reason: 'bad-input', error: '补丁必须是 JSON 对象' };
  const fields = [
    ...Object.keys(patch).filter((k) => !PATCH_FIELDS.includes(k)),
    ...(patch.repo === undefined ? [] : isObj(patch.repo) ? Object.keys(patch.repo).filter((k) => k !== 'github').map((k) => `repo.${k}`) : ['repo']),
  ];
  if (fields.length) return { ok: false, reason: 'patch-field-not-allowed', fields, error: `补丁只能改 name、docSources、repo.github，不允许：${fields.join('、')}` };
  return editConfig(configPath, id, (cfg) => {
    const p = cfg.projects.find((x) => x?.id === id);
    if (!p) return { reason: 'not-found', error: `没有 id 为 ${id} 的项目` };
    if ('name' in patch) p.name = patch.name;
    if ('docSources' in patch) p.docSources = patch.docSources;
    if (patch.repo && 'github' in patch.repo) p.repo = { ...p.repo, github: patch.repo.github };
  });
}

/** 删除项目；cache/<id>、data/<id> 不动（手动关联是业务数据）。 */
export async function removeProject(configPath, id) {
  return editConfig(configPath, id, (cfg) => {
    if (!cfg.projects.some((p) => p?.id === id)) return { reason: 'not-found', error: `没有 id 为 ${id} 的项目` };
    cfg.projects = cfg.projects.filter((p) => p?.id !== id);
  });
}

/**
 * 正在跑的 devboard 归谁管：本目录的 LaunchAgent（plist 在且已加载）→ launchd；本目录的 systemd 用户服务（unit 在且 active）→ systemd；
 * devboard-ctl 记下的后台进程 → pidfile；其它（终端里手动启动、别的目录的 devboard）→ unmanaged，up 只报告不动它。
 */
export async function whoManages(ctx) {
  const agent = ctx.useLaunchd ? findAgent(await readPlists(ctx.agentsDir), ctx.serverEntry) : null;
  if (agent && await agentLoaded(ctx, agent)) return { kind: 'launchd', agent };
  const unit = ctx.useSystemd ? findUnit(await readPlists(ctx.unitsDir, '.service'), ctx.serverEntry) : null;
  if (unit && await unitActive(ctx, unit)) return { kind: 'systemd', agent: unit };
  const pid = await readPid(ctx);
  if (pid && await ownsPid(ctx, pid)) return { kind: 'pidfile', pid };
  return { kind: 'unmanaged', agent };
}

// 端口上监听的进程（lsof 取不到时为 null）：只用于报告，不据此杀进程。
async function listener(ctx, port) {
  const r = await ctx.sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  if (r.code !== 0) return null;
  const pid = Number(/^p(\d+)/m.exec(r.stdout)?.[1]) || null;
  return pid ? { pid, command: /^c(.+)$/m.exec(r.stdout)?.[1] ?? null } : null;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 停掉自己起的后台进程：按 PID 是否还在判断退出，不能按端口空不空判断——host 配成 0.0.0.0 时旧进程仍在监听，
// macOS 上另绑 127.0.0.1 同端口有时不报错，isFree() 会把「旧进程还活着」误判成「已经空了」。
// TERM 等 5 秒，不退再 KILL 等 5 秒；进程真退出后再等端口空，一直不空就报错，免得健康检查打到旧进程上误报成功。
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopOwned(pid, port) {
  const dead = () => !pidAlive(pid);
  try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
  if (!(await waitFor(dead, 5000))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    if (!(await waitFor(dead, 5000))) throw new Error(`后台进程 ${pid} 停不下来`);
  }
  if (!(await waitFor(() => isFree(port), 5000))) throw new Error(`后台进程 ${pid} 已退出，但端口 ${port} 仍被占用`);
}

// 后台启动：detached + unref，输出追加到 cache/devboard.log，PID 记 cache/devboard.pid（下次 up 据此重启）。
// spawn 失败（找不到 node、资源不足）是异步的 'error' 事件：没人监听会让 CLI 直接崩掉、不输出 JSON；
// 所以等到 'spawn' 才写 pidfile，失败时删掉旧 pidfile，不留指向失败进程或已停进程的记录。
async function startDetached(ctx) {
  await mkdir(path.dirname(ctx.pidFile), { recursive: true });
  const log = await open(ctx.logFile, 'a');
  try {
    const child = spawn(ctx.execPath, [ctx.serverEntry], { cwd: ctx.dir, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await writeFile(ctx.pidFile, `${child.pid}\n`);
    return child.pid;
  } catch (e) {
    await rm(ctx.pidFile, { force: true });
    throw e;
  } finally {
    await log.close();
  }
}

async function tail(file, n) {
  try { return (await readFile(file, 'utf8')).trimEnd().split('\n').slice(-n).join('\n'); } catch { return null; }
}

/**
 * 保证 devboard 在跑且已加载最新配置（requirements 需求 5）。返回结果对象，不抛异常（main 打成一行 JSON）。
 * 端口：配置的端口上是本目录管理的 devboard → 重启；空闲 → 启动；被别的程序占 → 换下一个空闲端口并写回配置。
 * ok:false 一律带机器可读的 reason（skill 按它分支）：node-version、config-invalid、bad-port、unmanaged、config-busy、stale-lock、
 * stop-failed、no-free-port、start-failed、launchd-failed、systemd-failed、not-ready；error 是给人看的说明。
 * Linux 上 systemd 用户实例不可用（容器、部分 WSL）时退回后台进程并在 warnings 说明。
 */
export async function up(opts = {}) {
  const ctx = context(opts);
  const fail = (reason, error, extra) => ({ ok: false, reason, error, ...extra });
  if (Number(ctx.nodeVersion.split('.')[0]) !== 24) return fail('node-version', `需要 Node 24，当前是 ${ctx.nodeVersion}；未做任何改动`);
  await ensureConfig(ctx.configPath);
  const checked = await check(ctx.configPath);
  if (checked.errors.some((e) => e.projectId === null)) return fail('config-invalid', '配置文件不可用，未启动', { errors: checked.errors });
  const raw = await readJson(ctx.configPath);
  // 手改配置可能把端口写成字符串："4318" 按数字用；不是 1–65535 的整数就不动手（往后加 1 找空闲端口会拼出字符串）
  const configured = Number(raw.server?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(configured) || configured < 1 || configured > 65535) {
    return fail('bad-port', `server.port 应为 1–65535 的整数，当前是 ${JSON.stringify(raw.server?.port)}；未做任何改动`);
  }

  const warnings = [...checked.warnings];
  if ((await ctx.sh('gh', ['auth', 'status'])).code !== 0) warnings.push('gh 不可用或未登录：看板只有文档与会话，没有 PR 数据');
  if (ctx.useSystemd && (await ctx.sh('systemctl', ['--user', 'show-environment'])).code !== 0) {
    ctx.useSystemd = false;
    warnings.push('systemd 用户服务不可用，改为后台进程运行');
  }
  const service = ctx.useLaunchd ? 'launchd' : ctx.useSystemd ? 'systemd' : null;
  let port = configured;
  let occupant = null;
  // 端口被别的程序占：记下占用者，换下一个空闲端口并写回配置
  const movePort = async () => {
    occupant = await listener(ctx, port);
    port = await pickPort(port + 1, isFree);
    // 锁内重读：up 开头读到的 raw 可能已被并发的 save 改过，整份写回会盖掉别人刚加的项目
    const r = await withConfigLock(ctx.configPath, async () => {
      const latest = await readJson(ctx.configPath);
      latest.server = { ...latest.server, port };
      await writeJson(ctx.configPath, latest);
    });
    if (r?.ok === false) throw Object.assign(new Error(r.error), { reason: r.reason });
  };

  // 先认归属，再看端口：本目录自己的旧进程可能正在改端口、启动慢或暂时没应答，这些都不能当成
  // 「端口被别的程序占了」去抢端口或另起一份，否则会留下孤儿进程、pidfile 被覆盖。
  const who = await whoManages(ctx);
  if (who.kind === 'pidfile') {
    try { await stopOwned(who.pid, port); } catch (e) { return fail('stop-failed', e.message); }
  }

  if (who.kind !== 'launchd' && who.kind !== 'systemd') {
    if (await isDevboard(port)) {
      return fail('unmanaged', `端口 ${port} 上已有 devboard 在运行，但不是 devboard-ctl 或本目录的 LaunchAgent 启动的；请先停掉它再运行 up`, { pid: (await listener(ctx, port))?.pid ?? null });
    }
    if (!(await isFree(port))) {
      try { await movePort(); } catch (e) { return fail(e.reason ?? 'no-free-port', e.message); }
    }
  } else if (!(await isDevboard(port)) && !(await isFree(port))) {
    // launchd / systemd 已加载但端口被别的程序占着（例如 agent 在 KeepAlive 下反复崩溃、从未绑定成功）：
    // 和非服务分支一样换端口、写回配置，再走 launchdStart 的 kickstart（systemdStart 的 restart）。
    // ponytail: 不排查「端口上应答的 devboard 其实是手动起的，刚好和本目录的 launchd agent 同端口」——
    // 要分辨需要比较 launchctl print 的 pid 与端口监听 pid，这里偷懒跳过，极端情况下可能误报 ok:true；
    // 需要时按 isDevboard 为真时额外核对 pid 升级。
    try { await movePort(); } catch (e) { return fail(e.reason ?? 'no-free-port', e.message); }
  }
  // launchd：端口上已有本目录的 devboard 应答，或刚好空闲 → launchdStart 发现已加载会 kickstart -k，端口沿用配置

  let started;
  try {
    started = service === 'launchd' ? await launchdStart(ctx) : service === 'systemd' ? await systemdStart(ctx) : { pid: await startDetached(ctx) };
  } catch (e) {
    return fail(service ? `${service}-failed` : 'start-failed', e.message);
  }
  // ponytail: launchd 的 kickstart -k 是同步杀旧进程再拉起，这里不再额外确认「应答的是新进程」；出现误报再按 lsof 的 PID 比对
  if (await waitFor(() => isDevboard(port), ctx.timeoutMs)) {
    if (!started.agent) warnings.push('以后台进程运行：重启电脑后需要再运行一次 up');
    return {
      ok: true, url: `http://devboard.localhost:${port}`, port, portChanged: port !== configured, occupant,
      managedBy: started.agent ? `${service}:${started.agent.label}` : `background:${started.pid}`, warnings,
    };
  }
  const logFile = started.agent ? started.agent.errLog : ctx.logFile;
  if (started.agent) await (service === 'systemd' ? systemdCleanup : launchdCleanup)(ctx, started);
  else {
    try { process.kill(started.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    await rm(ctx.pidFile, { force: true });
  }
  return fail('not-ready', `${ctx.timeoutMs / 1000} 秒内服务没有就绪`, { log: await tail(logFile, 20) });
}

async function must(promise, what) {
  const r = await promise;
  if (r.code !== 0) throw new Error(`${what} 失败：${(r.stderr || r.stdout).trim().split('\n')[0] || `退出码 ${r.code}`}`);
  return r;
}

/**
 * macOS：本目录的 plist 已加载 → kickstart -k 重启；在但未加载（被 bootout 过）→ bootstrap；
 * 没有 → 按 ops/devboard.plist.template 新建并 bootstrap（created = true；bootstrap 失败时删掉新建的文件再抛错）。
 * 新建的 label 是 com.devboard.agent；该文件已被别的目录的 devboard 占用时加目录哈希后缀，不覆盖。
 */
export async function launchdStart(ctx) {
  const domain = `gui/${ctx.uid}`;
  const agent = findAgent(await readPlists(ctx.agentsDir), ctx.serverEntry);
  if (agent && await agentLoaded(ctx, agent)) {
    await must(ctx.sh('launchctl', ['kickstart', '-k', `${domain}/${agent.label}`]), 'launchctl kickstart');
    return { agent, created: false };
  }
  if (agent) {
    await must(ctx.sh('launchctl', ['bootstrap', domain, agent.file]), 'launchctl bootstrap');
    return { agent, created: false };
  }
  let label = 'com.devboard.agent';
  if (existsSync(path.join(ctx.agentsDir, `${label}.plist`))) label += `.${createHash('sha1').update(ctx.dir).digest('hex').slice(0, 6)}`;
  const file = path.join(ctx.agentsDir, `${label}.plist`);
  const errLog = path.join(ctx.logsDir, 'devboard.error.log');
  const gh = (await ctx.sh('/usr/bin/which', ['gh'])).stdout.trim();
  const PATH = [...new Set([path.dirname(process.execPath), gh && path.dirname(gh), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':');
  const template = await readFile(path.join(ctx.dir, 'ops', 'devboard.plist.template'), 'utf8');
  await mkdir(ctx.agentsDir, { recursive: true });
  await mkdir(ctx.logsDir, { recursive: true });
  await writeFile(file, renderPlist(template, {
    LABEL: label, NODE: process.execPath, SERVER: ctx.serverEntry, DIR: ctx.dir, PATH,
    LOG: path.join(ctx.logsDir, 'devboard.log'), ERRLOG: errLog,
  }));
  try {
    await must(ctx.sh('launchctl', ['bootstrap', domain, file]), 'launchctl bootstrap');
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  }
  return { agent: { file, label, errLog }, created: true };
}

/** 启动失败的清理：只撤掉本次新建的 LaunchAgent（免得 KeepAlive 反复拉起）；已有的 plist 不动。 */
export async function launchdCleanup(ctx, { agent, created }) {
  if (!created) return;
  await ctx.sh('launchctl', ['bootout', `gui/${ctx.uid}/${agent.label}`]);
  await rm(agent.file, { force: true });
}

/**
 * Linux：本目录的 unit 已 active → restart；在但没在跑（被 stop / disable 过）→ enable --now；
 * 没有 → 按 ops/devboard.service.template 在 ~/.config/systemd/user 新建，daemon-reload 后 enable --now（created = true；
 * 失败时删掉新建的文件再抛错）。WantedBy=default.target：登录后自启；要开机即起、不登录也跑，需另行 loginctl enable-linger。
 * 新建的 unit 名是 devboard.service；该文件已被别的目录的 devboard 占用时加目录哈希后缀，不覆盖。日志追加到 cache/devboard.log。
 */
export async function systemdStart(ctx) {
  const unit = findUnit(await readPlists(ctx.unitsDir, '.service'), ctx.serverEntry);
  if (unit && await unitActive(ctx, unit)) {
    await must(ctx.sh('systemctl', ['--user', 'restart', unit.label]), 'systemctl restart');
    return { agent: unit, created: false };
  }
  if (unit) {
    await must(ctx.sh('systemctl', ['--user', 'enable', '--now', unit.label]), 'systemctl enable');
    return { agent: unit, created: false };
  }
  let name = 'devboard';
  if (existsSync(path.join(ctx.unitsDir, `${name}.service`))) name += `-${createHash('sha1').update(ctx.dir).digest('hex').slice(0, 6)}`;
  const file = path.join(ctx.unitsDir, `${name}.service`);
  const gh = (await ctx.sh('/usr/bin/which', ['gh'])).stdout.trim();
  const PATH = [...new Set([path.dirname(ctx.execPath), gh && path.dirname(gh), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':');
  const template = await readFile(path.join(ctx.dir, 'ops', 'devboard.service.template'), 'utf8');
  await mkdir(ctx.unitsDir, { recursive: true });
  await mkdir(path.dirname(ctx.logFile), { recursive: true });
  await writeFile(file, renderUnit(template, { NODE: ctx.execPath, SERVER: ctx.serverEntry, DIR: ctx.dir, PATH, LOG: ctx.logFile }));
  const agent = { file, label: `${name}.service`, errLog: ctx.logFile };
  try {
    await must(ctx.sh('systemctl', ['--user', 'daemon-reload']), 'systemctl daemon-reload');
    await must(ctx.sh('systemctl', ['--user', 'enable', '--now', agent.label]), 'systemctl enable');
  } catch (e) {
    // enable --now 先建自启链接再启动：启动失败时链接已在，要 disable 掉，不能只删文件留下悬空链接
    await systemdCleanup(ctx, { agent, created: true });
    throw e;
  }
  return { agent, created: true };
}

/** 启动失败的清理：只撤掉本次新建的 unit（免得 Restart=always 反复拉起）；已有的 unit 不动。 */
export async function systemdCleanup(ctx, { agent, created }) {
  if (!created) return;
  await ctx.sh('systemctl', ['--user', 'disable', '--now', agent.label]);
  await rm(agent.file, { force: true });
  await ctx.sh('systemctl', ['--user', 'daemon-reload']);
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'no-launchd': { type: 'boolean', default: false }, 'no-service': { type: 'boolean', default: false }, new: { type: 'boolean', default: false }, update: { type: 'string' },
  } });
  const stdinJson = () => { try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return undefined; } };
  const [cmd, arg] = positionals;
  let out;
  if (cmd === 'check') out = await check(path.resolve(arg ?? CONFIG));
  else if (cmd === 'find' && arg) {
    const config = existsSync(CONFIG) ? await readJson(CONFIG) : { projects: [] };
    const hit = findProject(config, path.resolve(arg), DIR);
    out = { ok: true, project: hit?.project ?? null, matchedBy: hit?.matchedBy ?? null };
  } else if (cmd === 'up') out = await up({ noLaunchd: values['no-launchd'] || values['no-service'] });
  else if (cmd === 'save' && values.new && values.update === undefined) out = await saveNew(CONFIG, stdinJson());
  else if (cmd === 'save' && values.update && !values.new) out = await saveUpdate(CONFIG, values.update, stdinJson());
  else if (cmd === 'remove' && arg) out = await removeProject(CONFIG, arg);
  else if (cmd === 'revert' && arg) out = await revert(CONFIG, arg);
  else out = { ok: false, error: '用法：devboard-ctl check [配置路径] | find <仓库路径> | up [--no-launchd | --no-service] | save --new < 项目.json | save --update <id> < 补丁.json | remove <id> | revert <revision>' };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.ok ? 0 : 1;
}

// 直接运行判断：用 realpath 比较而不是 pathToFileURL(argv[1])——argv[1] 路径里有符号链接（如 macOS 的
// /var → /private/var）时，Node 的 ESM loader 对入口模块做了 realpath 解析，import.meta.url 会是解析后的
// 路径，不做 realpath 直接比较会误判成「不是被直接运行」，main() 悄悄不跑（退出码 0、零输出）。
function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1])); } catch { return false; }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    process.exitCode = 1;
  });
}
