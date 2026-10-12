// 本机 HTTP 服务（design §3.12）：静态白名单、只读接口、SSE 推送与每项目的刷新调度（任务 1.5、3.5）。
// 调度：启动先回放 cache/ 里的上次结果当首屏，再按「文档 → GitHub」顺序刷新；之后每 5 秒轮询本地文档与分支、
// 每 N 分钟 GitHub 增量；同一项目的刷新经 Promise 串行锁排队，项目之间互不影响（需求 1.4、13）。
// 本模块不直接写任何文件：缓存经 store.mjs 落盘（需求 16.1，测试有静态检查）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig, SPACE_ROOT, DEFAULT_CONFIG_PATH } from './config.mjs';
import { loadProjectDocs, readBranchCommits, checkLocalSync, gitRead } from './docs.mjs';
import { computeBoard, linkPrs } from './engine.mjs';
import { fetchPrs, checkScopes } from './github.mjs';
import { readCache, writeCache, readManual, manualStamp, changeManual } from './store.mjs';
import { mask } from './mask.mjs';
import { claudeCode } from './sessions/claude-code.mjs';
import { codex } from './sessions/codex.mjs';
import { msg } from './msg.mjs';
import { say } from './say.mjs';
import { summarize } from './summary.mjs';

// 固定白名单：URL → web/ 下的文件名与类型。不做任何路径拼接，`/../`、`/src/…` 之类的 URL 根本碰不到文件系统。
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/svg.mjs': ['svg.mjs', 'text/javascript; charset=utf-8'],
  '/i18n.mjs': ['i18n.mjs', 'text/javascript; charset=utf-8'],
  '/i18n-ja.mjs': ['i18n-ja.mjs', 'text/javascript; charset=utf-8'],
  '/i18n-en.mjs': ['i18n-en.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/yuiboard-logo.png': ['yuiboard-logo.png', 'image/png'],
  '/yuiboard-icon.png': ['yuiboard-icon.png', 'image/png'],
};

// 每个响应都带；从不回 CORS 头，跨站页面读不到任何接口结果（需求 16.7、16.8）。
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 读配置、监听端口，然后在后台为每个可用项目读文档并推算看板。
 * @param {object} [opts]
 * @param {string} [opts.configPath] 缺省 `<空间根>/devboard.config.json`
 * @param {number} [opts.port]       覆盖 server.port；测试传 0 取随机端口
 * @param {string} [opts.webDir]     静态文件目录，缺省 `<空间根>/web`
 * @param {() => Date} [opts.now]    时钟；测试传固定值。只用于数据里的时间戳，间隔节流一律用单调时钟
 * @param {(line: string) => void} [opts.log]
 * @param {string} [opts.cacheDir]   缓存根目录，缺省 `<空间根>/cache`；每项目一个子目录
 * @param {{ pollMs?: number, githubMs?: number, manualGapMs?: number, boardWriteMs?: number, heartbeatMs?: number }} [opts.timing]
 *   测试用的间隔覆盖；缺省 5 秒 / githubRefreshMinutes / 30 秒 / 10 秒 / 30 秒
 * @param {typeof loadProjectDocs} [opts.loadDocs] 测试注入（模拟刷新抛错）
 * @param {string} [opts.dataDir]    手动关联根目录，缺省 `<空间根>/data`；每项目一个子目录（任务 4.1）
 * @returns {Promise<{server: http.Server, port: number, url: string, config: object,
 *   runtimes: Map<string, object>, close: () => Promise<void>}>}
 *   端口被占用时 reject，message 为「端口 N 已被占用，改 server.port」、code 为 EADDRINUSE。
 */
export async function startServer({
  configPath = DEFAULT_CONFIG_PATH, port, webDir = path.join(SPACE_ROOT, 'web'), now = () => new Date(), log = console.log,
  cacheDir = path.join(SPACE_ROOT, 'cache'), timing = {}, loadDocs = loadProjectDocs, dataDir = path.join(SPACE_ROOT, 'data'),
} = {}) {
  const config = await loadConfig(configPath);
  for (const w of config.warnings) log(say(msg`警告：${w}`));
  for (const e of config.errors) log(say(msg`配置错误：${e.message}`));

  // 每项目一个 ProjectRuntime，互不影响（需求 1.4）。有配置错误的项目只登记错误，不读文档、不出空看板（需求 1.6）。
  const runtimes = new Map(config.projects.map((project) => [project.id, {
    project,
    errors: config.errors.filter((e) => e.projectId === project.id),
    version: 0,
    payload: null,      // { board, json, gzip, etag, summary: { json, gzip, etag } }：推算一次、序列化一次，请求直接复用
    refreshError: null,
    ready: Promise.resolve(),
    // ---- 任务 3.5 的调度状态 ----
    cacheDir: path.join(cacheDir, project.id),
    lock: Promise.resolve(), busy: 0,        // 串行锁与排队数（轮询在忙时跳过，不堆积）
    docs: null, workspaces: [], sourceDiag: [], parsedCache: null, docsReadAt: null,
    refsSig: null, sync: {},                 // 工作区 HEAD + 本地 base 分支的签名；变了就清空本地同步结果重查
    gh: null, scopesChecked: false,          // github.json 的内容（fetchPrs 返回去掉 requests）
    refreshing: { docs: true, sessions: Boolean(project.sessions?.length), github: Boolean(project.repo?.github) },
    // ---- 任务 5.4 的会话状态 ----
    sessions: [], sessionsCache: null, sessionsSig: null, sessionDiag: [], sessionsReadAt: null,
    activityDue: Infinity,                   // 下一次「运行中 / 停滞」会因时间流逝而变的时刻（毫秒）
    clients: new Set(),                      // SSE 连接
    manualAt: -Infinity,                     // 上次手动刷新（单调时钟毫秒）
    boardTimer: null, boardWrittenAt: -Infinity,
    // ---- 任务 4.1：手动关联（manual = null 表示文件读不了，只用自动关联） ----
    manualDir: path.join(dataDir, project.id), manual: [], manualError: null, manualStamp: undefined,
  }]));
  const T = {
    pollMs: 5_000, githubMs: config.defaults.githubRefreshMinutes * 60_000, manualGapMs: 30_000,
    boardWriteMs: 10_000, heartbeatMs: 30_000, ...timing,
  };
  const timers = [];
  let closed = false;

  const allowedHosts = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(say(msg`请求处理失败：${req.method} ${req.url}：${e.message}`));
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', msg('服务内部错误'));
      else res.destroy();
    });
  });

  async function handle(req, res) {
    // 防 DNS rebinding：恶意域名解析到 127.0.0.1 时浏览器带的是那个域名的 Host。
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, 'text/plain; charset=utf-8', msg('Host 不被允许'));
    const pathname = req.url.split('?')[0];
    if (req.method === 'POST' && REFRESH_PATH.test(pathname)) return handleRefresh(req, res, pathname);
    if ((req.method === 'POST' || req.method === 'DELETE') && MANUAL_PATH.test(pathname)) return handleManual(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', msg('不支持的方法'));

    if (Object.hasOwn(STATIC, pathname)) return serveStatic(res, STATIC[pathname]);
    if (pathname === '/api/projects') return sendJson(res, 200, projectList());
    const ev = /^\/api\/projects\/([^/]+)\/events$/.exec(pathname);
    if (ev) return serveEvents(req, res, runtimes.get(safeDecode(ev[1])));
    // /summary：给 Claude Code mod 的摘要（N25 design §3.1），错误码与 /board 同口径
    const m = /^\/api\/projects\/([^/]+)\/(board|summary)$/.exec(pathname);
    const rt = m && runtimes.get(safeDecode(m[1]));
    if (rt) return serveBoard(req, res, rt, m[2] === 'summary');
    if (m) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这个项目')] });
    const d = /^\/api\/projects\/([^/]+)\/docs\/([^/]+)$/.exec(pathname);
    if (d) {
      const drt = runtimes.get(safeDecode(d[1]));
      if (!drt) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这个项目')] });
      return serveDoc(req, res, drt, safeDecode(d[2]));
    }
    return send(res, 404, 'text/plain; charset=utf-8', msg('未找到'));
  }

  /**
   * 文档原文片段（design §3.12，页内原文查看器用）：`?from=&to=` 为 1 起的闭区间行号，缺省整份。
   * 只认看板里已发现的 docId，文件路径取自发现结果，请求里的任何内容都不参与拼路径（需求 16.8），
   * 所以 `..%2F..`、绝对路径之类的参数只会是「没有这份文档」。
   * 返回 { docId, path, from, to, total, lines }；切行规则同解析器（去 BOM、`\r?\n`），行号与看板里的对得上。
   */
  async function serveDoc(req, res, rt, docId) {
    if (rt.errors.length) return sendJson(res, 409, { error: 'config', messages: rt.errors.map((e) => e.message) });
    await rt.ready;
    const board = rt.payload?.board;
    // 规划中的文档对应的是目录，没有单个文件可看
    const doc = board?.docs.find((x) => x.docId === docId && x.kind !== 'planning');
    if (!doc) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这份文档')] });
    const ws = board.workspaces.find((w) => w.id === doc.workspaceId);
    // ponytail: 用 NFC 的显示路径重拼文件路径；macOS 文件系统不区分 NFC / NFD，Linux 上 NFD 目录名会读不到，届时让 docs.mjs 带出原始路径
    let text;
    try {
      // N17：从 git ref 读的文档按顶栏显示的那个提交取，行号与看板一致
      text = doc.ref ? await gitRead(ws.path, ['cat-file', 'blob', `${ws.commit}:${doc.path}`], { raw: true })
        : await readFile(path.join(ws.path, ...doc.path.split('/')), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || (doc.ref && e.code === 128)) return sendJson(res, 404, { error: 'not-found', messages: [msg`文档 ${doc.path} 已不存在`] });
      throw e;
    }
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // 末尾换行不算一行
    const q = new URLSearchParams(req.url.split('?')[1] ?? '');
    const num = (k, dflt) => (q.has(k) ? (/^\d{1,9}$/.test(q.get(k)) ? Number(q.get(k)) : NaN) : dflt);
    const from = num('from', 1);
    const to = Math.min(num('to', lines.length), lines.length);
    if (!(from >= 1) || Number.isNaN(to) || num('to', from) < from) {
      return sendJson(res, 400, { error: 'bad-request', messages: [msg('from / to 须是从 1 起的行号，且 from ≤ to')] });
    }
    sendJson(res, 200, { docId, path: doc.path, from, to, total: lines.length, lines: lines.slice(from - 1, to) });
  }

  async function serveStatic(res, [file, type]) {
    let body;
    try {
      body = await readFile(path.join(webDir, file));
    } catch (e) {
      if (e.code === 'ENOENT') return send(res, 404, 'text/plain; charset=utf-8', msg('未找到'));
      throw e;
    }
    send(res, 200, type, body, { 'Cache-Control': 'no-cache' });
  }

  function projectList() {
    return {
      errors: config.errors.filter((e) => e.projectId === null), // 全局错误（如 JSON 语法错）→ 前端显示全局错误页
      warnings: config.warnings,
      projects: [...runtimes.values()].map((rt) => ({
        id: rt.project.id,
        name: rt.project.name,
        // 顶栏分支线分段按钮与前端「文档归哪条分支线」用（任务 3.6）；不含工作区路径等其余配置
        branchLines: (rt.project.branchLines ?? []).map((b) => ({ id: b.id, name: b.name, docFilter: b.docFilter ?? null })),
        errors: rt.errors,
        refreshError: rt.refreshError,
        freshness: rt.payload?.board.freshness ?? null,
      })),
    };
  }

  async function serveBoard(req, res, rt, summary = false) {
    // 配置有错的项目返回明确错误而不是空看板（需求 1.6）；409 表示「当前配置下不可用」。
    if (rt.errors.length) return sendJson(res, 409, { error: 'config', messages: rt.errors.map((e) => e.message) });
    await rt.ready; // 启动时的首次推算还没完成就等它，不先回空结果
    if (!rt.payload) return sendJson(res, 500, { error: 'refresh', messages: [rt.refreshError ?? msg('看板尚未生成')] });
    const p = summary ? rt.payload.summary : rt.payload;
    const headers = { ETag: p.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === p.etag) return send(res, 304, null, null, headers);
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    send(res, 200, 'application/json; charset=utf-8', gzip ? p.gzip : p.json, gzip ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
  }

  // ---------------- 刷新调度（任务 3.5，design §2.3、§3.12） ----------------

  /**
   * 启动一个项目：先回放缓存当首屏（需求 17.2），再排队「文档 → GitHub」两步刷新，最后挂上定时器。
   * 返回的 Promise 在「有看板可给」时完成：有 board.json 就是回放之后，否则是首次文档推算之后。
   */
  async function startRuntime(rt) {
    const [board, gh, docsCache, sessCache] = await Promise.all(['board', 'github', 'docs', 'sessions'].map((n) => readCache(rt.cacheDir, n)));
    if (closed) return; // 读缓存期间服务已关闭：别再挂定时器（否则进程退不出）
    // N11：未接 GitHub 的项目不用旧的 PR 缓存，也不回放旧看板（里面有按旧 PR 算的状态）；首屏等第一次本地刷新。缓存文件不删。
    const ghOn = Boolean(rt.project.repo.github);
    rt.gh = ghOn ? gh : null;
    rt.sessionsCache = sessCache;
    // 解析结果还取决于这几项配置；配置改了就整份重解析
    rt.parsedCache = docsCache?.optsKey === docsOptsKey(rt.project, config.defaults.hoursPerDay) ? docsCache.docs : null;
    const replay = ghOn && board;
    if (replay) publish(rt, board); // refreshing 此时仍是 docs + github，页面标「正在刷新」
    serial(rt, () => refreshManual(rt)); // 先读手动关联，首次推算就带上
    const first = serial(rt, () => refresh(rt));
    serial(rt, () => refreshSessions(rt)); // 排在文档之后、首屏之外：首屏不等会话扫描
    if (ghOn) serial(rt, () => refreshGithub(rt));
    // 轮询在忙时跳过：GitHub 慢请求期间不堆积一串待执行的轮询
    timers.push(setInterval(() => { if (!rt.busy) { serial(rt, () => refreshManual(rt)); serial(rt, () => refresh(rt)); serial(rt, () => refreshSessions(rt)); } }, T.pollMs));
    if (ghOn) timers.push(setInterval(() => serial(rt, () => refreshGithub(rt)), T.githubMs));
    return replay ? undefined : first;
  }

  // Promise 串行锁：同一项目同一时刻只跑一个刷新步骤；关闭后排队中的不再执行。
  function serial(rt, fn) {
    rt.busy++;
    const p = rt.lock.then(() => (closed ? undefined : fn())).finally(() => rt.busy--);
    rt.lock = p.catch(() => {});
    return p;
  }

  /**
   * 本地一步（每 5 秒）：重新发现文档、只重解析文件戳变了的，读各工作区 HEAD 与本地 base 分支。
   * 什么都没变就到此为止——不重算、不升版本、不写日志，空闲时几乎不占 CPU（需求 17.3）。不碰网络（需求 13.3）。
   */
  async function refresh(rt) {
    const started = performance.now();
    try {
      const r = await loadDocs(rt.project, { hoursPerDay: config.defaults.hoursPerDay, prev: rt.parsedCache });
      const refs = await branchRefs(rt, r.workspaces);
      rt.docsReadAt = now().toISOString();
      // 变化 = 有文档重解析、文档增删，或来源目录的读取问题变了（如目录被删）
      const docsChanged = !rt.docs || r.reparsed.length > 0 || String(r.docs.map((d) => d.docId)) !== String(rt.docs.map((d) => d.docId))
        || JSON.stringify(r.diagnostics) !== JSON.stringify(rt.sourceDiag);
      const refsSig = JSON.stringify([r.workspaces.map((w) => [w.id, w.branch, w.commit]), refs]);
      if (!docsChanged && refsSig === rt.refsSig) return;
      Object.assign(rt, { docs: r.docs, workspaces: r.workspaces, sourceDiag: r.diagnostics, parsedCache: r.parsedCache });
      if (refsSig !== rt.refsSig) Object.assign(rt, { refsSig, sync: {} }); // HEAD 或 base 动了：本地同步全部重查
      if (docsChanged) await saveCache(rt, 'docs', { optsKey: docsOptsKey(rt.project, config.defaults.hoursPerDay), docs: r.parsedCache });
      await updateSync(rt);
      rt.refreshing.docs = false;
      rebuild(rt, msg`文档 ${r.docs.length}（重解析 ${r.reparsed.length}）`, started);
    } catch (e) {
      fail(rt, e);
      if (rt.refreshing.docs) { rt.refreshing.docs = false; republish(rt); }
    }
  }

  // 各工作区本地 base 分支的提交号（只看分支线配置里出现的 base）。读不到记 null，不让轮询失败。
  async function branchRefs(rt, workspaces) {
    const bases = [...new Set((rt.project.branchLines ?? []).map((b) => b.base))];
    return Promise.all(workspaces.map((w) => readBranchCommits(w.path, bases).catch(() => null)));
  }

  /**
   * 会话一步（启动时文档之后、每 5 秒）：按配置的各会话来源增量扫描，写 sessions.json，有变化再重算（任务 5.4）。
   * 会话目录只读（需求 16.6）；来源不可用只记诊断、不报刷新失败，「进行中」退回只看 [~]（需求 14.9）。
   * 记录没变时也要看时间：「运行中 / 停滞」随 now 流逝而变，到了 activityDue 就重算一次（空闲时仍不升版本）。
   */
  async function refreshSessions(rt) {
    const cfgs = rt.project.sessions ?? [];
    if (!cfgs.length || !rt.docs) return; // 没配会话来源：rebuild 里标「未包含 AI 会话信息」；文档还没读成功：下一轮再扫
    const started = performance.now();
    try {
      const opts = {
        knownDocIds: rt.docs.map((d) => d.docId),
        knownCodes: [...new Set(rt.docs.flatMap((d) => (d.groups ?? []).map((g) => g.code).filter(Boolean)))],
        docs: rt.docs.filter((d) => !d.ref), repo: rt.project.repo.github ?? null, // docRef 文档不在磁盘上，会话碰不到（N17）
      };
      const caches = [];
      const diags = [];
      const sessions = [];
      for (const [i, c] of cfgs.entries()) {
        const src = SESSION_SOURCES[c.source];
        if (!src) {
          diags.push({ source: c.source ?? null, dir: c.dir ?? null, available: false, error: msg`不支持的会话来源：${c.source}`, sessions: 0, unreadableFiles: [], brokenLines: [], messages: [] });
          caches.push(null);
          continue;
        }
        // 各来源自定记录根与归属范围；单个来源出错只记它自己的诊断，其它来源照常（N10 需求第 1 条）
        try {
          const scope = await src.resolveScanScope(c, rt.workspaces.map((w) => w.path));
          const r = await src.scan({ ...scope, ...opts, prev: rt.sessionsCache?.[i] ?? null });
          caches.push(r.cache);
          diags.push({ source: src.id, ...r.diagnostics, messages: [...scope.diagnostics.map((d) => d.message), ...(r.diagnostics.messages ?? [])] });
          sessions.push(...r.sessions);
        } catch (e) {
          caches.push(null);
          diags.push({ source: src.id, dir: c.dir ?? null, available: false, error: mask(msg`会话来源出错：${e.message}`), sessions: 0, unreadableFiles: [], brokenLines: [], messages: [] });
        }
      }
      rt.sessionsReadAt = now().toISOString();
      // 缓存（偏移 + 提取结果）与诊断都没变 → 会话数据没变；只在活动标记到点时重算
      const sig = JSON.stringify([caches, diags]);
      const changed = sig !== rt.sessionsSig;
      if (!changed && !(now().getTime() > rt.activityDue)) return;
      if (changed) {
        Object.assign(rt, { sessions, sessionDiag: diags, sessionsSig: sig });
        if (JSON.stringify(caches) !== JSON.stringify(rt.sessionsCache)) await saveCache(rt, 'sessions', caches);
        rt.sessionsCache = caches;
      }
      rt.refreshing.sessions = false;
      rebuild(rt, msg`会话 ${sessions.length}（文件 ${sessions.reduce((n, s) => n + s.files.length, 0)}）`, started);
    } catch (e) {
      fail(rt, e);
      if (rt.refreshing.sessions) { rt.refreshing.sessions = false; republish(rt); }
    }
  }

  /**
   * GitHub 一步（启动时、每 N 分钟、手动刷新）：增量拉 PR → 写 github.json → 补查本地同步 → 重算。
   * fetchPrs 自己处理失败与限流（沿用缓存 PR），这里不因 GitHub 出错而丢看板（需求 13.5–13.7）。
   */
  async function refreshGithub(rt) {
    const started = performance.now();
    if (!rt.refreshing.github) { rt.refreshing.github = true; republish(rt); } // 页面标「正在刷新」
    try {
      // 令牌权限提示只在启动后第一次查（需求 16.3）；之后随 github.json 保留
      const scopeHint = rt.scopesChecked ? rt.gh?.status.scopeHint ?? null : await checkScopes(rt.project);
      rt.scopesChecked = true;
      // 文档还没读成功时不给（undefined = 不按 spec 目录过滤），免得空列表把回溯下限算没
      const specDocIds = rt.docs?.filter((d) => d.sourceType === 'spec-dir' && !d.archived).map((d) => d.docId);
      const { requests, ...cache } = await fetchPrs(rt.project, rt.gh, { now: now(), specDocIds });
      cache.status.scopeHint = scopeHint;
      rt.gh = cache;
      rt.ghLastRun = { at: now().toISOString(), requests }; // 诊断页「最近请求」（任务 6.5）；请求数不进 github.json
      await saveCache(rt, 'github', cache);
      await updateSync(rt);
      rt.refreshing.github = false;
      const s = cache.status;
      const left = s.rate?.remaining ?? msg`未知`;
      rebuild(rt, s.error ? msg`GitHub 请求 ${requests}（剩余 ${left}），${s.message}` : msg`GitHub 请求 ${requests}（剩余 ${left}）`, started);
    } catch (e) {
      fail(rt, e);
      rt.refreshing.github = false;
      republish(rt); // 撤掉「正在刷新」
    }
  }

  /**
   * 已关联任务的已合并 PR 逐个查本地同步（需求 5.6、8.2）；已有结果的不重查（refsSig 变化时 rt.sync 会被清空）。
   * ponytail: 逐个串行跑 git，上百个 PR 首次约 1–2 秒；只在 HEAD / base 变化或新 PR 出现时发生，慢了再加并发池。
   */
  async function updateSync(rt) {
    const prs = rt.gh?.prs ?? [];
    if (!prs.length || !rt.docs) return;
    const { prs: info } = linkPrs(rt.docs, prs, rt.project, rt.manual ?? []);
    for (const p of prs) {
      const i = info.get(p.number);
      if (p.state !== 'MERGED' || !i.tasks.length || rt.sync[p.number]) continue;
      // 与 engine 的 waitingList 一致：分支线配了独立工作区就查那里，否则查主工作区
      const line = rt.project.branchLines?.find((b) => b.id === i.branchLine);
      const ws = line?.workspace ?? rt.project.repo.path;
      // N17：docRef 分支线没有本地检出，看板读的就是 docRef 那一版，「已同步」= 合并提交已在 docRef 上
      rt.sync[p.number] = await checkLocalSync(ws, p.mergeCommit, p.baseRefName, line?.docRef);
    }
  }

  // 用当前全部输入重算看板并发布。
  function rebuild(rt, what, started) {
    const board = computeBoard(rt.docs, rt.gh?.prs ?? [], rt.sessions, rt.manual, rt.sync, rt.project, now(), config.defaults);
    const gh = rt.gh?.status;
    board.workspaces = rt.workspaces;
    board.freshness.docsReadAt = rt.docsReadAt;
    const ghOn = Boolean(rt.project.repo.github);
    if (!ghOn) board.freshness.github = { ...board.freshness.github, state: 'off', message: msg('未接 GitHub') }; // N11：前端按 state 显示中性文案
    else if (gh) board.freshness.github = gh;
    // 从未成功拉到 PR → 「未包含 PR 信息」；成功过但这次失败 / 暂停 → 「来自 <lastSuccessAt> 的缓存」（需求 13.6）。未接 GitHub 不算降级。
    board.degraded.noPrData = ghOn && !gh?.lastSuccessAt;
    board.degraded.prFromCache = Boolean(ghOn && gh?.lastSuccessAt && gh.error);
    // 合并而非覆盖：engine 已给 diagnostics.sessions（会话计数）；sources = 文档来源目录问题，sessionSources = 各会话来源状态
    board.diagnostics = { ...board.diagnostics, sources: rt.sourceDiag, sessionSources: rt.sessionDiag };
    // 任务 6.5：配置加载结果与 GitHub 最近一轮请求（重启后首轮 GitHub 之前为 null）
    board.diagnostics.config = { path: configPath, projects: config.projects.length, warnings: config.warnings };
    board.diagnostics.github = rt.ghLastRun ?? null;
    board.freshness.sessionsReadAt = rt.sessionsReadAt;
    board.degraded.noSessionData = noSessionData(rt);
    board.degraded.manualBroken = rt.manualError; // 页面红色横幅「手动关联文件读不了：原因」、关联按钮禁用（需求 7.6）
    board.recentClosedPrDays = config.defaults.recentClosedPrDays; // 任务 4.2：总览「近 N 天已合并 / 关闭」的 N（需求 11.2）
    board.defaults = config.defaults; // 任务 6.6：甘特说明条显示具体的每日工时与默认工期
    rt.activityDue = nextActivityChange(board, config.defaults, now().getTime());
    publish(rt, board);
    rt.refreshError = null;
    // 一次刷新一行（需求 18.4）：只有数量与耗时，不含令牌、PR 描述或会话正文
    log(`[${board.computedAt}] ${rt.project.id} ${say(what)} / ${Math.round(performance.now() - started)}ms`);
  }

  // 定版本号 → 预先序列化与压缩 → 推给 SSE 订阅者 → 排队写 board.json。
  function publish(rt, board) {
    board.version = ++rt.version;
    board.freshness = { ...board.freshness, refreshing: { ...rt.refreshing } };
    // 摘要与完整看板同一次推算，各自序列化、各带 ETag（N25）
    rt.payload = { board, ...packed(JSON.stringify(board)), summary: packed(JSON.stringify(summarize(board))) };
    for (const c of rt.clients) c.write(`data: ${JSON.stringify({ version: rt.version })}\n\n`);
    scheduleBoardWrite(rt);
  }

  // 只有「正在刷新」标记变了：沿用上一版看板内容，换新版本号发布。
  function republish(rt) {
    if (rt.payload) publish(rt, { ...rt.payload.board });
  }

  // 出错保留上一版看板（design §5「未捕获异常」），顶栏显示「最近一次刷新失败：原因」（已遮蔽）。
  // 同一错误每 5 秒重复出现时只记一次日志。
  function fail(rt, e) {
    const text = msg`最近一次刷新失败：${mask(String(e?.message ?? e))}`;
    if (text !== rt.refreshError) log(`[${now().toISOString()}] ${rt.project.id} ${say(text)}`);
    rt.refreshError = text;
  }

  // board.json 只为首屏回放，10 秒内最多写一次，写的时候取最新一版（design §3.11）。
  function scheduleBoardWrite(rt) {
    if (rt.boardTimer || closed) return;
    const wait = Math.max(0, rt.boardWrittenAt + T.boardWriteMs - performance.now());
    rt.boardTimer = setTimeout(() => {
      rt.boardTimer = null;
      rt.boardWrittenAt = performance.now();
      saveCache(rt, 'board', rt.payload.board);
    }, wait);
  }

  // 缓存写失败（磁盘满、目录无权限）只记日志：缓存丢了只影响下次首屏速度，不影响本次看板。
  async function saveCache(rt, name, value) {
    try {
      await writeCache(rt.cacheDir, name, value);
    } catch (e) {
      log(`[${now().toISOString()}] ${rt.project.id} ${say(msg`写缓存 ${name}.json 失败：${mask(e.message)}`)}`);
    }
  }

  // GET /api/projects/:id/events：SSE，连上先发当前版本，之后每次发布推 {version}；前端收到新版本再拉 /board。
  function serveEvents(req, res, rt) {
    if (!rt) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这个项目')] });
    if (rt.errors.length) return sendJson(res, 409, { error: 'config', messages: rt.errors.map((e) => e.message) });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ version: rt.version })}\n\n`);
    rt.clients.add(res);
    req.on('close', () => rt.clients.delete(res));
  }

  /**
   * POST /api/projects/:id/refresh：立即刷新文档与 GitHub（需求 13.2）。
   * 正在拉 GitHub、或距上次手动刷新不到 30 秒 → 合并为那一次（merged: true），连点也只打一轮 GitHub。
   * 同源校验防跨站页面借用户浏览器消耗 GitHub 额度：跨站 POST 必带 Origin，与本服务不同即拒（design §3.12）。
   */
  function handleRefresh(req, res, pathname) {
    if (req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'origin', messages: [msg('只接受本页面发起的请求')] });
    const rt = runtimes.get(safeDecode(REFRESH_PATH.exec(pathname)[1]));
    if (!rt) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这个项目')] });
    if (rt.errors.length) return sendJson(res, 409, { error: 'config', messages: rt.errors.map((e) => e.message) });
    const merged = rt.refreshing.github || performance.now() - rt.manualAt < T.manualGapMs;
    if (!merged) {
      rt.manualAt = performance.now();
      const ghOn = Boolean(rt.project.repo.github); // N11：未接 GitHub 只刷文档
      if (ghOn) rt.refreshing.github = true;
      republish(rt);
      serial(rt, () => refresh(rt));
      if (ghOn) serial(rt, () => refreshGithub(rt));
    }
    sendJson(res, 202, { merged });
  }

  // ---------------- 手动关联（任务 4.1，design §3.11、§3.12） ----------------

  /**
   * 轮询一步：手动关联文件的戳（mtime + 大小）变了就重读，owner 手改、修好损坏文件都在下一轮生效。
   * 读不了 → manual = null、记原因，看板只用自动关联并亮横幅；文件本身不碰（需求 7.6）。
   */
  async function refreshManual(rt) {
    const started = performance.now();
    if (await manualStamp(rt.manualDir) === rt.manualStamp) return;
    const r = await readManual(rt.manualDir);
    Object.assign(rt, { manual: r.records, manualError: r.error, manualStamp: r.stamp });
    if (r.error) log(`[${now().toISOString()}] ${rt.project.id} ${say(msg`手动关联文件读不了：${mask(r.error)}`)}`);
    if (!rt.docs) return; // 启动时还没读文档：首次推算会带上
    await updateSync(rt); // 新关联上的已合并 PR 要查本地同步
    rebuild(rt, r.records ? msg`手动关联 ${r.records.length}` : msg`手动关联读不了`, started);
  }

  /**
   * POST /api/projects/:id/manual-links `{taskKey, pr, action}` 新增 / 覆盖；DELETE `{taskKey, pr}` 撤销（design §3.12）。
   * 同源 Origin + `Content-Type: application/json`：跨站表单发不出 JSON 类型，跨站 fetch 过不了预检（从不回 CORS 头）。
   * 文件读不了 → 409，store 另有一道：写前重读、损坏即拒，绝不覆盖（需求 7.6）。
   * 写完立刻用内存里的现有输入重算发布（不排在可能很慢的 GitHub 刷新后面），新关联的已合并 PR 的本地同步随后排队补查。
   * 返回 200 `{version}`：已包含这次改动的看板版本。
   */
  async function handleManual(req, res, pathname) {
    if (req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'origin', messages: [msg('只接受本页面发起的请求')] });
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'content-type', messages: [msg('请求体须是 application/json')] });
    }
    const rt = runtimes.get(safeDecode(MANUAL_PATH.exec(pathname)[1]));
    if (!rt) return sendJson(res, 404, { error: 'not-found', messages: [msg('没有这个项目')] });
    if (rt.errors.length) return sendJson(res, 409, { error: 'config', messages: rt.errors.map((e) => e.message) });
    const change = manualChange(req.method, await readJson(req));
    if (!change) {
      return sendJson(res, 400, { error: 'bad-request', messages: [msg('需要 {taskKey, pr, action}（POST，action 为 link / unlink）或 {taskKey, pr}（DELETE）')] });
    }
    const broken = (reason) => sendJson(res, 409, { error: 'manual-broken', messages: [msg`手动关联文件读不了：${mask(reason)}`] });
    if (rt.manualError) return broken(rt.manualError);
    const started = performance.now();
    let r;
    try {
      r = await changeManual(rt.manualDir, rt.project.id, change, now().toISOString());
    } catch (e) {
      if (e.code === 'EMANUAL_BROKEN') return broken(e.message); // 轮询还没发现的损坏：下一轮轮询会亮横幅
      return sendJson(res, 500, { error: 'write', messages: [msg`手动关联写入失败：${mask(e.message)}`] });
    }
    Object.assign(rt, { manual: r.records, manualError: null, manualStamp: r.stamp });
    if (rt.docs) rebuild(rt, msg`手动关联 ${r.records.length}`, started);
    serial(rt, async () => {
      const n = Object.keys(rt.sync).length;
      await updateSync(rt);
      if (Object.keys(rt.sync).length !== n) rebuild(rt, msg`手动关联后补查本地同步`, started);
    });
    sendJson(res, 200, { version: rt.version });
  }

  const { host } = config.server;
  const listenPort = port ?? config.server.port;
  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(Object.assign(new Error(msg`端口 ${listenPort} 已被占用，改 server.port`), { code: e.code }));
      else reject(e);
    });
    server.listen(listenPort, host, resolve);
  });
  const actualPort = server.address().port;
  // 配置的 host 也放行：配成局域网 IP 时（启动已警告）用该 IP 访问仍可用；IP 字面量不会被 DNS rebinding 冒用。
  // devboard.localhost 用浏览器的本机回环语义；只放行这个确切名字与实际端口，不改成 .localhost 后缀匹配。
  for (const h of ['127.0.0.1', 'localhost', 'devboard.localhost', '::1', host]) allowedHosts.add(`${bracket(h)}:${actualPort}`);

  // 先监听再读文档：端口冲突立即暴露，不用等文档读完。
  for (const rt of runtimes.values()) if (!rt.errors.length) rt.ready = startRuntime(rt);
  // SSE 心跳：注释行，防中间层与浏览器把空闲连接当断线
  timers.push(setInterval(() => { for (const rt of runtimes.values()) for (const c of rt.clients) c.write(': 心跳\n\n'); }, T.heartbeatMs));

  return {
    server, port: actualPort, url: `http://${bracket(host)}:${actualPort}/`, config, runtimes,
    // 停定时器、断开连接，并等进行中的刷新收尾（排队中的不再执行），免得关闭后还有 git / gh 子进程与缓存写入
    close: async () => {
      closed = true;
      timers.forEach(clearInterval);
      for (const rt of runtimes.values()) clearTimeout(rt.boardTimer);
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await Promise.all([...runtimes.values()].map((rt) => rt.lock));
    },
  };
}

const REFRESH_PATH = /^\/api\/projects\/([^/]+)\/refresh$/;
const MANUAL_PATH = /^\/api\/projects\/([^/]+)\/manual-links$/;

// 写接口的请求体：最多 16KB，超长或不是 JSON → undefined。读完整个请求体再判断（中途断开会连响应一起断掉）。
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size <= 16_384) chunks.push(c);
  }
  if (size > 16_384) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

// 校验并规整手动关联请求；不合法 → null。任务键存不存在不在这里判：失效记录照存，由 engine 报冲突 j（需求 7.5）。
function manualChange(method, body) {
  const { taskKey, pr, action } = body ?? {};
  if (typeof taskKey !== 'string' || !taskKey || taskKey.length > 300 || !Number.isSafeInteger(pr) || pr <= 0) return null;
  if (method === 'DELETE') return { taskKey, pr };
  return action === 'link' || action === 'unlink' ? { taskKey, pr, action } : null;
}

// 预先压缩；ETag 取内容哈希而非版本号：版本号重启后从 1 重数，用它会让浏览器拿到过期的 304。
function packed(json) {
  return { json, gzip: gzipSync(json), etag: `"${createHash('sha1').update(json).digest('base64url')}"` };
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...(type ? { 'Content-Type': type } : {}), ...headers });
  res.end(body ?? undefined);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-cache' });
}

// 文件内容之外，解析结果还取决于这几项配置；任一项变了，docs.json 里的解析结果整份作废。
function docsOptsKey(project, hoursPerDay) {
  return JSON.stringify([project.milestoneCodePattern ?? null, project.prerequisiteIdPattern ?? null, hoursPerDay]);
}

// 会话来源注册表（design §3.7.1）：配置里 sessions[].source → 适配器（各自带 resolveScanScope 与 scan）。
const SESSION_SOURCES = { [claudeCode.id]: claudeCode, [codex.id]: codex };

// 「未包含 AI 会话信息」（需求 14.9）：没配会话来源，或已扫过且全部来源都不可用。还没扫完时不算（页面标「正在刷新」）。
function noSessionData(rt) {
  if (!rt.project.sessions?.length) return true;
  return rt.sessionDiag.length > 0 && rt.sessionDiag.every((d) => !d.available);
}

/**
 * 看板里任一会话关联的活动标记下一次会变的时刻：lastAt + 运行中阈值（运行中 → 最近活跃）、lastAt + 停滞阈值（→ 停滞）。
 * 取不早于 now 的最小值；没有则 Infinity。阈值缺省与 engine markActivity 一致。
 */
function nextActivityChange(board, defaults, nowMs) {
  const spans = [(defaults.sessionRunningMinutes ?? 10) * 60_000, (defaults.sessionStaleDays ?? 3) * 86_400_000];
  let due = Infinity;
  for (const v of board.tasks) {
    for (const l of v.sessions ?? []) {
      for (const d of spans) {
        const t = Date.parse(l.lastAt) + d;
        if (t >= nowMs && t < due) due = t;
      }
    }
  }
  return due;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

// IPv6 地址在 Host 头与 URL 里要加方括号。
function bracket(host) {
  return host.includes(':') ? `[${host}]` : host;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  try {
    const { url } = await startServer({ configPath: values.config ? path.resolve(values.config) : undefined });
    console.log(say(msg`devboard 已启动：${url}`));
  } catch (e) {
    console.error(say(msg`devboard 启动失败：${e.message}`));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
