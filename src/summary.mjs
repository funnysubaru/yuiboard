// 看板摘要（N25 design §3.1）：给 Claude Code mod 用的 Board 投影。
// mod 的 $.http.fetch 响应体上限 4 MiB，完整看板放不下；摘要只留 mod 用到的字段，字段名与结构不变，
// 所以 web/app.mjs 的口径函数（overallStats、checkItems、statusWhy）直接吃摘要，算出的数字与网页一致。
// ponytail: 字段表写死；mod 要用新字段时同步改这里与 test/summary.test.mjs 的 SPEC。
// 规模上限：实测最大的项目摘要约 1.1 MB，离 4 MiB 约 3.8 倍余量，超了再按分支线 / 文档分页或去掉 c 类冲突说明（design §8）。

// 不留 version、computedAt 与 freshness 的读取时间 / 刷新中标记：它们每轮都变，留着会让摘要 ETag 在任务内容没变时也变，
// mod 每 5 秒白拉一次 1 MB。诊断只用 freshness.github。
const TOP = ['projectId', 'degraded', 'workspaces', 'diagnostics', 'defaults', 'stats'];
// alias、adr 与任务的 duplicate：N27 的 PR 标题拦截按 refs.mjs 的同一口径解析引用（ADR 简称、重复编号）
const DOC = ['docId', 'title', 'path', 'kind', 'archived', 'workspaceId', 'sourceType', 'sourceLabel', 'parse', 'groups', 'alias', 'adr'];
const DOC_TASK = ['key', 'number', 'title', 'checkbox', 'void', 'docId', 'groupId', 'parentKey', 'duplicate'];
const VIEW = ['key', 'status', 'rule', 'docOnly', 'syncPending', 'syncUnchecked', 'inProgressBy', 'activity', 'childSummary', 'next'];
const PR_LINK = ['pr', 'partial', 'removedManually'];
const SESSION_LINK = ['sessionId', 'activity', 'firstAt', 'lastAt', 'evidenceAt'];
const DEPS = ['on', 'unmet', 'external'];
const CONFLICT = ['type', 'taskKey', 'pr', 'sessionId', 'detail', 'source'];
const PR = ['number', 'title', 'branchLine', 'tasks'];
const SESSION = ['id', 'source', 'title'];
// 会话关联里只有人发消息 / 派活点名、改任务行、AI 命令里写了任务号（N32）是点到具体任务的；只靠分支、PR 登记连上的不算
// （mod 选主任务用，owner 2026-10-12 定）
const NAMED = new Set(['prompt', 'dispatch', 'edit', 'command']);
const sessionLink = (l) => ({ ...pick(l, SESSION_LINK), ...(l.evidence?.some((e) => NAMED.has(e.kind)) && { named: true }) });

// 只拷原对象实有的键：缺的字段在摘要里也缺，不凭空补 undefined / null
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
const each = (list, keys) => list?.map((x) => pick(x, keys));

/** Board → 摘要（纯函数，不改动传入的看板）。 */
export function summarize(board) {
  return {
    ...pick(board, TOP),
    ...(board.freshness && { freshness: { github: board.freshness.github } }),
    docs: board.docs.map((d) => ({ ...pick(d, DOC), tasks: each(d.tasks, DOC_TASK) })),
    tasks: board.tasks.map((v) => ({
      ...pick(v, VIEW), prs: each(v.prs, PR_LINK), sessions: v.sessions?.map(sessionLink), deps: v.deps && pick(v.deps, DEPS),
    })),
    conflicts: each(board.conflicts, CONFLICT),
    prs: each(board.prs, PR),
    sessions: each(board.sessions, SESSION),
  };
}
