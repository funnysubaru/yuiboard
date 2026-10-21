// GitHub PR 读取与分支线归类（design §3.6，需求 5、13.4–13.7、16.3–16.5）。
// 只经 gh CLI 发只读 GraphQL 查询：令牌由 gh 自己管，本进程里不出现（需求 16.4）；不经 shell。
// 本模块不写文件：fetchPrs 返回下一版缓存，由调用方（3.5 的调度 / store）落到 cache/<项目>/github.json。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { gitRead } from './docs.mjs';
import { mask } from './mask.mjs';
import { msg } from './msg.mjs';

const run = promisify(execFile);

// 每页 100、按更新时间倒序；一次查询 cost=1（2026-09-26 对真实仓库实测字段可用）。
const QUERY = `query($owner:String!,$name:String!,$after:String){
  rateLimit{cost remaining limit resetAt}
  repository(owner:$owner,name:$name){
    pullRequests(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title body url state isDraft baseRefName headRefName
             createdAt updatedAt mergedAt closedAt mergeCommit{oid} labels(first:20){nodes{name}}
             timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{... on ReadyForReviewEvent{createdAt}}} } } } }`;

const BODY_LIMIT = 64 * 1024; // 描述超过 64 KB 截断后再缓存
const LOW_RATE = 0.1;         // 剩余额度低于上限的 10% 即暂停到 resetAt（需求 13.5）

/** 失败类型 → 页面文案（需求 13.6、16.3、16.5）。 */
export const GITHUB_ERROR_TEXT = {
  'gh-missing': msg('未安装 GitHub CLI（安装 gh 并运行 gh auth login 后自动恢复）'),
  auth: msg('凭据失效：运行 gh auth login'),
  'no-access': msg('令牌缺少读取该仓库的权限'),
  unreachable: msg('GitHub 不可达'),
  'rate-limited': msg('GitHub 额度将尽，暂停到额度重置'),
};

/**
 * @typedef {{ lastSuccessAt: string|null, error: null|'gh-missing'|'auth'|'unreachable'|'rate-limited'|'no-access',
 *   message: string|null, detail: string|null, rate: {remaining:number, limit:number, resetAt:string}|null,
 *   pausedUntil: string|null, scopeHint: string|null }} GithubStatus
 *   design §4 的 GithubStatus，另加 message（给页面的文案）与 detail（已遮蔽的 gh 输出首行，给诊断）。
 * @typedef {{ prs: object[], maxUpdatedAt: string|null, since: string|null, status: GithubStatus }} GithubCache
 */

/**
 * 增量拉取一个项目的 PR。失败时一律返回上一版缓存里的 PR（横幅「来自 <lastSuccessAt> 的缓存」由页面按 status 显示），
 * 下次调用自动重试（需求 13.6、13.7）。
 * @param {object} project loadConfig 返回的项目；用 repo.github（owner/name）、repo.path、docSources、github.{ghPath, historySince}
 * @param {GithubCache|null} cache 上一次的返回值（去掉 requests）；首次为 null
 * @param {{ now: Date|string|number, specDocIds?: string[] }} opts now 用于判断暂停是否到期；
 *   specDocIds = 当前未归档的 spec 目录名，只在首次拉取、未配 historySince 时用来算回溯下限
 * @returns {Promise<GithubCache & { requests: number }>} prs 按编号倒序；requests = 本轮 gh 调用次数（日志用）
 */
export async function fetchPrs(project, cache, { now, specDocIds } = {}) {
  const nowMs = new Date(now).getTime();
  const prev = cache ?? { prs: [], maxUpdatedAt: null, since: null, status: emptyStatus() };
  const status = { ...emptyStatus(), ...prev.status };

  // 暂停期内不发请求，直接用缓存
  if (status.pausedUntil && nowMs < Date.parse(status.pausedUntil)) {
    return { ...prev, status: withError(status, 'rate-limited', status.detail), requests: 0 };
  }

  // 回溯下限只在首次拉取时有意义；之后靠 maxUpdatedAt 增量
  let since = prev.since ?? null;
  if (!prev.maxUpdatedAt) since = project.github?.historySince ?? since ?? (await historyFloor(project, specDocIds));

  const [owner, name] = String(project.repo?.github ?? '').split('/');
  const ghPath = project.github?.ghPath ?? 'gh';
  const fetched = new Map();
  let rate = status.rate;
  let requests = 0;
  let after = null;
  try {
    for (;;) {
      requests++;
      const data = await ghGraphql(ghPath, owner, name, after);
      rate = data.rateLimit ? pick(data.rateLimit, ['remaining', 'limit', 'resetAt']) : rate;
      const conn = data.repository?.pullRequests;
      if (!conn) throw ghFailure('no-access', msg('查询结果里没有该仓库'));
      let reachedKnown = false;
      for (const node of conn.nodes) {
        // 倒序到达「比缓存最新的还旧」或「早于回溯下限」即停。已关闭且之后没更新的 PR 因此不会重拉（需求 13.4）。
        // 用严格小于：与缓存最新时间相同的 PR 可能是同一秒里新更新的另一个，宁可重拉这一两条。
        const floor = prev.maxUpdatedAt ?? since;
        if (floor && Date.parse(node.updatedAt) < Date.parse(floor)) { reachedKnown = true; break; }
        fetched.set(node.number, normalizePr(node));
      }
      if (reachedKnown || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch (e) {
    // 中途失败整轮作废：已拉到的页不并入，maxUpdatedAt 不前进，否则漏掉的中间段以后再也拉不到
    const kind = e.kind ?? classifyGhError(e);
    try { rate = pick(JSON.parse(e.stdout).data.rateLimit, ['remaining', 'limit', 'resetAt']); } catch { /* 失败响应里没有额度信息 */ }
    const next = withError({ ...status, rate }, kind, ghDetail(e));
    if (kind === 'rate-limited') next.pausedUntil = resetTime(rate, nowMs);
    return { ...prev, since, status: next, requests };
  }

  const byNumber = new Map(prev.prs.map((p) => [p.number, p]));
  let maxUpdatedAt = prev.maxUpdatedAt;
  for (const pr of fetched.values()) {
    byNumber.set(pr.number, pr);
    if (!maxUpdatedAt || Date.parse(pr.updatedAt) > Date.parse(maxUpdatedAt)) maxUpdatedAt = pr.updatedAt;
  }
  const low = rate && rate.remaining < rate.limit * LOW_RATE;
  return {
    prs: [...byNumber.values()].sort((a, b) => b.number - a.number),
    maxUpdatedAt,
    since,
    status: { ...status, lastSuccessAt: new Date(nowMs).toISOString(), error: null, message: null, detail: null,
      rate, pausedUntil: low ? rate.resetAt : null },
    requests,
  };
}

/**
 * GraphQL 节点 → design §4 的 PullRequest。squash 合并（源分支已删）也以 state=MERGED 为准，
 * mergeCommit 是 base 上的合并 / squash 提交，供本地同步检查（需求 5.3）。
 */
export function normalizePr(node) {
  return {
    number: node.number,
    title: node.title,
    body: truncateBody(node.body ?? ''),
    url: node.url,
    state: node.state,
    isDraft: node.isDraft,
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    // 最后一次转 ready 的时间；从没当过 draft 的为 null，视为创建即 ready
    readyAt: node.timelineItems?.nodes?.[0]?.createdAt ?? null,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    mergeCommit: node.mergeCommit?.oid ?? null,
  };
}

/**
 * PR 归分支线（需求 1.5、5.4）：只看 base 分支；都不中为「未归类」（branchLine null），不丢弃。
 * base 与标题前缀 / 标签矛盾时仍以 base 为准，把不一致之处放进 issues（engine 据此记冲突 n）。
 * @param {{ title: string, baseRefName: string, labels: string[] }} pr
 * @param {{ id: string, name: string, base: string, titlePrefix?: string, labels?: string[] }[]} branchLines
 * @returns {{ branchLine: string|null, issues: string[] }}
 */
export function classifyBranchLine(pr, branchLines = []) {
  const line = branchLines.find((b) => b.base === pr.baseRefName);
  if (!line) return { branchLine: null, issues: [] };
  const title = pr.title.trimStart();
  const issues = [];
  if (line.titlePrefix && !title.startsWith(line.titlePrefix)) {
    issues.push(msg`标题缺少分支线「${line.name}」的前缀 ${line.titlePrefix}`);
  }
  if (line.labels?.length && !pr.labels.some((l) => line.labels.includes(l))) {
    issues.push(msg`缺少分支线「${line.name}」的标签（${line.labels.join(' / ')} 任一）`);
  }
  for (const other of branchLines) {
    if (other !== line && other.titlePrefix && other.titlePrefix !== line.titlePrefix && title.startsWith(other.titlePrefix)) {
      issues.push(msg`base 是 ${pr.baseRefName}，标题却带分支线「${other.name}」的前缀 ${other.titlePrefix}`);
    }
  }
  return { branchLine: line.id, issues };
}

/**
 * 首次拉取的默认回溯下限：未归档 spec 目录里文件最早入库的时间（需求 5.2、D5）。
 * 只读 `git log --diff-filter=A`；git 失败或没有 spec 目录时返回 null（不设下限，拉全部历史）。
 * @param {object} project
 * @param {string[]} [specDocIds] 只统计这些 spec 目录（未归档的）；缺省统计 git 历史里出现过的全部目录
 * @returns {Promise<string|null>} UTC ISO 时间
 */
export async function historyFloor(project, specDocIds) {
  const ws = project.repo.path;
  const roots = (project.docSources ?? []).filter((s) => s.type === 'spec-dir')
    .map((s) => path.relative(ws, path.resolve(ws, s.path)).split(path.sep).join('/').normalize('NFC'));
  if (roots.length === 0) return null;
  let out;
  try {
    // --relative：输出路径相对工作区，repo.path 是仓库子目录时也对得上；%x00 分隔每个提交
    out = await gitRead(ws, ['log', '--diff-filter=A', '--relative', '--format=%x00%cI', '--name-only', '--', ...roots]);
  } catch {
    return null;
  }
  const wanted = specDocIds && new Set(specDocIds);
  let min = null;
  for (const chunk of out.split('\0').slice(1)) {
    const [date, ...files] = chunk.split('\n');
    const t = Date.parse(date);
    for (const f of files) {
      const file = f.normalize('NFC');
      const root = roots.find((r) => file.startsWith(`${r}/`));
      if (!root) continue;
      const rest = file.slice(root.length + 1);
      if (!rest.includes('/')) continue; // 直接放在 spec 根下的文件不是某个 spec
      if (wanted && !wanted.has(rest.split('/')[0])) continue;
      if (min === null || t < min) min = t;
    }
  }
  return min === null ? null : new Date(min).toISOString();
}

/**
 * 启动时检查令牌权限范围（需求 16.3）：`gh api -i /rate_limit` 不耗额度，读响应头 X-OAuth-Scopes。
 * @param {object} project 用 github.ghPath
 * @returns {Promise<string|null>} 需要提示的文案；权限合适或 gh 调用失败（失败原因由 fetchPrs 报）时为 null
 */
export async function checkScopes(project) {
  let stdout;
  try {
    ({ stdout } = await run(project.github?.ghPath ?? 'gh', ['api', '-i', '/rate_limit'], ghOptions()));
  } catch {
    return null;
  }
  const head = stdout.split(/\r?\n\r?\n/)[0];
  const m = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(head);
  if (!m) return msg('无法判断令牌权限范围（细粒度令牌不返回 X-OAuth-Scopes）');
  const scopes = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (scopes.some((s) => s === 'repo' || s === 'workflow' || s.startsWith('write:'))) {
    return msg`令牌带写权限（${scopes.join(', ')}），devboard 只读使用；可改用细粒度只读令牌（GH_TOKEN，Pull requests / Contents / Metadata: Read）`;
  }
  return null;
}

// ---- 内部 ----

async function ghGraphql(ghPath, owner, name, after) {
  // -f 传原样字符串：-F 会把 @ 开头的值当文件读、把 true/数字转类型，游标与仓库名都不该被转换
  const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
  if (after) args.push('-f', `after=${after}`);
  const { stdout } = await run(ghPath, args, ghOptions());
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw ghFailure('unreachable', msg('gh 输出不是 JSON'));
  }
  // gh 遇到 GraphQL errors 通常以非零退出（走 catch 分类）；这里兜住以 0 退出的情况
  if (json.errors?.length) throw Object.assign(new Error('GraphQL errors'), { stdout, stderr: json.errors[0].message });
  return json.data;
}

function ghOptions() {
  return {
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    windowsHide: true,
  };
}

// execFile 的错误 → 失败类型。gh 对 GraphQL 错误会把完整 JSON（含 errors[].type）打到 stdout、摘要打到 stderr。
function classifyGhError(e) {
  if (e.code === 'ENOENT') return 'gh-missing';
  let types = [];
  try { types = (JSON.parse(e.stdout).errors ?? []).map((x) => x.type); } catch { /* stdout 不是 JSON */ }
  const stderr = String(e.stderr ?? '');
  if (types.includes('RATE_LIMITED') || /rate limit/i.test(stderr)) return 'rate-limited';
  if (types.includes('NOT_FOUND') || /Could not resolve to a Repository/i.test(stderr)) return 'no-access';
  if (/auth login|HTTP 401|Bad credentials|not logged in/i.test(stderr)) return 'auth';
  return 'unreachable'; // 断网、DNS、超时（killed）等
}

function ghFailure(kind, detail) {
  return Object.assign(new Error(detail), { kind, stderr: detail });
}

// gh 输出里给诊断看的一行：先遮蔽再截断，绝不原样记录（需求 16.4）
function ghDetail(e) {
  const text = String(e.stderr || e.message || '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  return mask(text).slice(0, 300) || null;
}

// 限流时的恢复时间：优先用本轮响应里的 resetAt；拿不到就按一小时（GitHub 额度按小时重置）。
// ponytail: 兜底一小时偏保守，需要更准时改为调 /rate_limit 读 X-RateLimit-Reset。
function resetTime(rate, nowMs) {
  const reset = rate?.resetAt && Date.parse(rate.resetAt);
  return reset && reset > nowMs ? rate.resetAt : new Date(nowMs + 3600_000).toISOString();
}

function withError(status, kind, detail) {
  return { ...status, error: kind, message: GITHUB_ERROR_TEXT[kind], detail: detail ?? null };
}

function emptyStatus() {
  return { lastSuccessAt: null, error: null, message: null, detail: null, rate: null, pausedUntil: null, scopeHint: null };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

// 按 UTF-8 字节截断；切在多字节字符中间产生的替换符去掉
function truncateBody(body) {
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= BODY_LIMIT) return body;
  return `${buf.subarray(0, BODY_LIMIT).toString('utf8').replace(/�+$/, '')}\n…（描述超过 64 KB，已截断）`;
}
