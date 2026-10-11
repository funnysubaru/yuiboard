// 看板推算：输入全部来源的当前数据，输出一份 Board（design §3.8、§3.9、§4）。
// 纯函数：不读时钟（now 由调用方给）、不读写文件、不写回任何来源（需求 8.9）。
// 已接：文档信号（任务 1.4）、依赖 / 下一步 / 文档侧冲突（任务 2.4）、PR 关联与五态（任务 3.4）、会话关联（任务 5.3）、
// 手动关联（任务 4.1，叠加在 linkPrs 里）。

import { extractRefs, extractBranchRefs, resolveRefs } from './refs.mjs';
import { classifyBranchLine } from './github.mjs';
import { layoutGantt, summarizeGantt } from './gantt.mjs';
import { msg, joinList } from './msg.mjs';

export { layoutGantt, summarizeGantt };

/** 五态，数组顺序即阶段先后（design §3.8.4），统计的 counts 也按此顺序。 */
export const STATUSES = ['not_started', 'in_progress', 'in_review', 'awaiting_merge', 'done'];

/**
 * @param {object[]} docs     PlanDoc[]（design §4）；每份至少有 docId、groups、tasks、archived
 * @param {object[]} prs      PullRequest[]（design §4，即 github.mjs normalizePr 的结果）
 * @param {object[]} sessions SessionRecord[]（design §4，会话来源 scan 的结果）
 * @param {object[]|null} manual ManualRecord[]（design §4）；null（文件读不了）同空数组，只用自动关联
 * @param {Object<number, {state: 'synced'|'pending'|'unknown', reason: string|null}>} sync
 *   PR 号 → checkLocalSync 的结果；只需覆盖已关联的已合并 PR（用 linkPrs 得出是哪些），缺项按「未核对」算
 * @param {object}   config   ProjectConfig（取 id 作 projectId；branchLines 用于 PR 归分支线与候选文档）
 * @param {Date|string|number} now 固定的当前时间；相同输入 + 相同 now → 相同结果
 * @param {{sessionRunningMinutes?: number, sessionStaleDays?: number, hoursPerDay?: number, defaultDurationDays?: number}} [defaults]
 *   DevboardConfig.defaults；缺项按 10 分钟 / 3 天 / 每天 8 小时 / 默认工期 1 天
 * @returns {object} Board（design §4），另加 `stats`（见 summarize）、`waiting`（见 waitingList）、`gantt`（见 gantt.mjs summarizeGantt）
 *   与 `recent`（见 recentChanges）；
 *   prs[] 另加 `tasks`（关联任务键，空 = 未关联）与 `localSyncReason`
 */
export function computeBoard(docs, prs, sessions, manual, sync, config, now, defaults = {}) {
  prs ??= [];
  sync ??= {};
  sessions ??= [];
  const tasks = docs.flatMap((d) => d.tasks ?? []);
  const linked = linkPrs(docs, prs, config, manual ?? []);
  const prByNum = new Map(prs.map((p) => [p.number, p]));
  const linksOf = new Map();
  for (const l of linked.links) (linksOf.get(l.taskKey) ?? linksOf.set(l.taskKey, []).get(l.taskKey)).push(l);
  const sess = linkSessions(docs, sessions, prs, linked.prs, config);
  const sessOf = new Map();
  for (const l of sess.links) (sessOf.get(l.taskKey) ?? sessOf.set(l.taskKey, []).get(l.taskKey)).push(l);
  const views = tasks.map((t) => {
    const links = (linksOf.get(t.key) ?? []).sort((a, b) => a.pr - b.pr);
    const sl = sessOf.get(t.key) ?? [];
    // 部分标记保留为进展依据；全部关联 PR 都检查本地同步，完成还必须由文档勾选确认。
    const partialMerged = links.filter((l) => l.partial && prByNum.get(l.pr)?.state === 'MERGED').map((l) => l.pr);
    const counted = links.map((l) => prByNum.get(l.pr));
    return Object.assign(taskView(t, deriveStatus(t, counted, sync, sl, partialMerged), links, prByNum), { sessions: sl });
  });
  markActivity(views, new Date(now).getTime(), defaults);

  // 父任务的子任务汇总：只数直接子任务，作废的子任务不进分母（需求 8.7）
  const byKey = new Map(views.map((v) => [v.key, v]));
  // 任务 4.1：被手动解除的自动关联不参与推算，只在任务上留「已手动解除」（带原来源，可撤销）
  for (const { pr, taskKey, source, evidence } of linked.removed) byKey.get(taskKey).excludedPrs.push({ pr, reason: 'unlinked', source, evidence });
  tasks.forEach((t, i) => {
    if (!t.parentKey || !byKey.has(t.parentKey)) return;
    const sum = (byKey.get(t.parentKey).childSummary ??= { done: 0, total: 0 });
    if (t.void) return;
    sum.total++;
    if (views[i].status === 'done') sum.done++;
  });

  // 任务 2.4：依赖展开 → 下一步分类 → 文档侧冲突（design §3.8.1、§3.9）。
  // 下一步要用 childSummary 判断叶子，所以放在子任务汇总之后。
  const expanded = expandDeps(docs);
  for (const v of views) Object.assign(v, expanded.get(v.key));
  classifyNext(views);
  annotateSoon(views, prByNum);
  layoutGantt(docs, views, prByNum, defaults, new Date(now).getTime()); // 任务 6.1
  const conflicts = [...detectConflicts(tasks, views), ...detectPrConflicts(tasks, views, prByNum), ...linked.conflicts,
    ...detectSessionConflicts(tasks, views, new Date(now).getTime()), ...sess.conflicts];

  const board = {
    version: 0, // 由 server 每次重算后递增
    computedAt: new Date(now).toISOString(),
    projectId: config?.id ?? null,
    // freshness / degraded / workspaces 由 server 与各来源填写，engine 只给空值
    freshness: {
      docsReadAt: null, sessionsReadAt: null,
      github: { lastSuccessAt: null, error: null, rate: null, pausedUntil: null, scopeHint: null },
      refreshing: { docs: false, sessions: false, github: false },
    },
    degraded: { noPrData: false, prFromCache: false, noSessionData: false, manualBroken: null },
    workspaces: [],
    docs: docs.map(({ relations, ...d }) => d),
    tasks: views,
    prs: prs.map((p) => {
      const s = p.state === 'MERGED' ? sync[p.number] : null;
      return { ...p, ...linked.prs.get(p.number), localSync: s?.state ?? null, localSyncReason: s?.reason ?? null };
    }),
    // 只含已关联会话的元数据；信号里有片段与位置，页面用 TaskView.sessions[].evidence 即可
    sessions: sessions.filter((s) => sess.linkedIds.has(s.id)).map(({ signals, ...s }) => s),
    conflicts,
    // 需求 14.4 / design §3.8.3：识别不出任务的会话、仅在 AI 回复里提到任务号的次数，只在诊断页计数
    diagnostics: { sessions: { total: sessions.length, linked: sess.linkedIds.size, unlinked: sessions.length - sess.linkedIds.size,
      aiOnlyMentions: sessions.reduce((n, s) => n + (s.aiOnlyMentions ?? 0), 0) },
      convention: conventionIssues(docs, conflicts) }, // 任务 6.5
    stats: summarize(docs, views),
    gantt: summarizeGantt(docs, views),
    waiting: waitingList(prs, linked.prs, sync, config, new Date(now).getTime(), staleWaiting(views, config)),
  };
  // 任务 6.3：最近变化不设下限（页面起始日可改成任意日期，前端按起始日筛），上限 = now；days = 页面默认窗口
  board.recent = { days: defaults.recentChangesDays ?? 7, events: recentChanges(board, { to: new Date(now).getTime() }) };
  return board;
}

/**
 * 需求 8.2：open / 待同步 PR 优先；完成必须已勾选，合并关联本身只作为进展证据。
 * 作废任务不给状态（需求 8.1 只约束未作废任务），status / rule 为 null，统计里也不计。
 * @param {object} task
 * @param {object[]} prs 该任务的关联 PR（PullRequest）；关闭未合并的不参与，全关闭时自然落到文档规则（需求 8.5）
 * @param {object} sync PR 号 → {state, reason}
 * @param {object[]} sessions 该任务的 SessionLink[]；有即满足「进行中」(a)（D7）
 * @param {number[]} partialMerged 标了「任务 N（部分）」且已合并的 PR 号：未勾选时满足「进行中」(c)
 */
function deriveStatus(task, prs = [], sync = {}, sessions = [], partialMerged = []) {
  if (task.void) return { status: null, rule: null, docOnly: false, inProgressBy: [] };
  // 8.2-1：有 open PR 就取最落后的——任一 draft 即「等待 review」，否则「等待合并」（需求 8.4）。
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.length) {
    const drafts = open.filter((p) => p.isDraft);
    const since = drafts.length ? drafts.map((p) => p.createdAt) : open.map((p) => p.readyAt ?? p.createdAt);
    return { status: drafts.length ? 'in_review' : 'awaiting_merge', rule: '8.2-1', docOnly: false, inProgressBy: [],
      statusSince: since.sort()[0] };
  }
  // 8.2-2：有一个 pending 就等待同步；没有 pending 且文档已勾选才完成。
  // unknown 沿用 P3 的降级口径，但不能替代文档确认；部分 PR 也不能绕过待同步检查。
  const merged = prs.filter((p) => p.state === 'MERGED');
  if (merged.length) {
    const state = (p) => sync[p.number]?.state ?? 'unknown';
    const pending = merged.filter((p) => state(p) === 'pending').map((p) => p.number);
    if (pending.length || task.checkbox === 'done') return { status: pending.length ? 'awaiting_merge' : 'done', rule: '8.2-2', docOnly: false, inProgressBy: [],
      syncPending: pending.length ? pending : null,
      syncUnchecked: !pending.length && merged.some((p) => state(p) === 'unknown'),
      statusSince: merged.map((p) => p.mergedAt).sort().at(-1) };
  }
  if (task.checkbox === 'done') return { status: 'done', rule: '8.2-3', docOnly: true, inProgressBy: [] };
  // 8.2-4：会话、[~]、部分或普通 PR 已合并均可证明进展，但不能证明完整交付。
  const by = [...(sessions.length ? ['session'] : []), ...(task.checkbox === 'doing' ? ['marker'] : []),
    ...(partialMerged.length ? ['partial'] : []), ...(merged.some((p) => !partialMerged.includes(p.number)) ? ['merged'] : [])];
  if (by.length) return { status: 'in_progress', rule: '8.2-4', docOnly: false, inProgressBy: by,
    statusSince: sessions.length ? sessions.map((s) => s.firstAt).sort()[0] : null };
  return { status: 'not_started', rule: '8.2-5', docOnly: false, inProgressBy: [] };
}

/** TaskView（design §4）；尚未推算的字段给空值。links = 该任务的 PrLink[]（含关闭未合并的，页面要显示「已关闭」标签）。 */
function taskView(task, { status, rule, docOnly, inProgressBy, syncPending = null, syncUnchecked = false, statusSince = null },
  links = [], prByNum = new Map()) {
  return {
    key: task.key, status, rule, docOnly,
    syncPending, syncUnchecked,
    statusSince, // 8.2-3 / 8.2-5 按 design 为空；仅靠 [~] 标记的 8.2-4 也没有时间来源
    inProgressBy, activity: null,
    prs: links,
    excludedPrs: links.filter((l) => prByNum.get(l.pr)?.state === 'CLOSED').map((l) => ({ pr: l.pr, reason: 'closed' })),
    sessions: [],
    deps: { on: [], unmet: [], dangling: [], external: [], inCycle: false },
    parallelWith: [], childSummary: null,
    next: null, batch: null, conflicts: [],
    gantt: { fact: null, factFrom: [], est: null, defaultDuration: false, overdue: false, noTime: false, unschedulable: null },
  };
}

/**
 * 按「文档 → 分组」与全局统计各状态任务数和完成比例（需求 10.1）。
 * 分母 = 未作废任务数（父任务与子任务都算一条）；ratio = done / 分母，分母为 0 时为 null，
 * 避免把没解析出任务的文档显示成「0 个任务、已完成」。
 * 全局 all 不含已归档文档（需求 2.10：归档文档默认不出现在主视图）；分组里没有 groupId 的任务只计入文档。
 * 按分支线 / 筛选重算归前端（需求 10.4）。
 */
function summarize(docs, views) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  const tally = (tasks) => {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const t of tasks) {
      const s = byKey.get(t.key).status;
      if (s) counts[s]++;
    }
    const total = STATUSES.reduce((n, s) => n + counts[s], 0);
    return { counts, total, ratio: total ? counts.done / total : null };
  };

  const liveKeys = new Set(docs.filter((d) => !d.archived).flatMap((d) => (d.tasks ?? []).map((t) => t.key)));
  const live = views.filter((v) => liveKeys.has(v.key));
  return {
    all: {
      ...tally(live),
      ready: live.filter((v) => v.next === 'ready').length,
      inProgressStale: live.filter((v) => v.status === 'in_progress' && v.activity === 'stale').length,
      syncPending: live.filter((v) => v.syncPending?.length).length,
    },
    docs: docs.map((d) => ({
      docId: d.docId,
      ...tally(d.tasks ?? []),
      groups: (d.groups ?? []).map((g) => ({ groupId: g.id, ...tally(d.tasks.filter((t) => t.groupId === g.id)) })),
    })),
  };
}

// ---- 任务 2.4：依赖展开、成环、下一步、文档侧冲突 ----

/**
 * 依赖展开（design §3.8.1）。只看文档结构，不看状态；状态相关的 unmet 由 classifyNext 填。
 * 关系来自各 PlanDoc.relations（2.1 的文字关系、2.2 的 Mermaid 关系、前置表，形状都是 RawRelation）。
 *
 * - 引用 → 叶子：点名的任务若有未作废子任务，就换成它全部未作废的叶子后代；作废任务原样保留（算已满足）。
 * - 子任务继承全部祖先的依赖与外部阻塞（「4 依赖 3」写在父任务上，4.1 也要等 3）；并行不继承。
 * - 排除依赖方自己、祖先与后代：既相对原始主语排除，也相对继承者排除（「18 依赖 18.2」这类不会让 18.1 等 18.2）。
 * - 同一对「叶 → 叶」只留一条边，多处来源（标题 + Mermaid、直接 + 继承）合并进 sources。
 * - 悬空（本文档找不到的编号、跨文档键指向不存在的任务、前置表里没有的 P 编号）进 dangling，视为未满足。
 *
 * @param {object[]} docs PlanDoc[]
 * @returns {Map<string, { deps: object, parallelWith: string[], parallelEdges: object[] }>} 任务键 → TaskView 的 deps 与并行
 *   parallelEdges: [{ with, sources: [{ via, source }] }]，与 parallelWith 一一对应（并行不继承，没有 inheritedFrom）
 *   deps = { on, unmet: [], dangling, external, inCycle, edges }
 *     on: 依赖的叶子任务键（文档顺序）；edges: [{ on, sources: [{ via, source, inheritedFrom }] }]，与 on 一一对应，
 *     inheritedFrom = 继承自哪个祖先任务键（自己写的为 null），页面据此写「继承自 4」；
 *     dangling: SourceRef[]，每条另带 raw（悬空的引用原文）；external: [{ id, resolved }]；
 *     cycleWith: 同一个环上的其它任务键（不在环上为空）。
 */
function expandDeps(docs) {
  const tasks = docs.flatMap((d) => d.tasks ?? []);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const order = new Map(tasks.map((t, i) => [t.key, i]));
  const kids = new Map();
  for (const t of tasks) {
    if (t.parentKey && byKey.has(t.parentKey)) (kids.get(t.parentKey) ?? kids.set(t.parentKey, []).get(t.parentKey)).push(t.key);
  }
  const leaves = (key) => {
    const live = byKey.get(key).void ? [] : (kids.get(key) ?? []).filter((k) => !byKey.get(k).void);
    return live.length ? live.flatMap(leaves) : [key];
  };
  const ancestors = (key) => {
    const out = [];
    for (let p = byKey.get(key).parentKey; p && byKey.has(p); p = byKey.get(p).parentKey) out.push(p);
    return out;
  };
  const related = (a, b) => a === b || ancestors(a).includes(b) || ancestors(b).includes(a);

  // 第一步：每个任务「自己写的」依赖（还没继承），边按叶子记。
  const own = new Map(tasks.map((t) => [t.key, { edges: [], dangling: [], external: [] }]));
  // 任务键 → (并行对象 → 来源[])：两端都记来源，抽屉里每条并行关系可看文件、行号、原文（需求 4.10）。
  const parallel = new Map(tasks.map((t) => [t.key, new Map()]));
  const addParallel = (a, b, r) => {
    const list = parallel.get(a).get(b) ?? parallel.get(a).set(b, []).get(b);
    if (!list.some((x) => x.via === r.via && x.source.line === r.source.line)) list.push({ via: r.via, source: r.source });
  };
  for (const d of docs) {
    const prereq = new Map((d.prerequisites ?? []).map((p) => [p.id, p.resolved]));
    for (const r of d.relations ?? []) {
      const subjects = r.subjects.flatMap((x) => x.keys).filter((k) => byKey.has(k));
      if (r.kind === 'parallel') {
        // 并行在两端都可见；「18.1–18.5 可并行」两侧是同一列表，跳过自身配对。
        const objs = r.objects.flatMap((x) => x.keys).filter((k) => byKey.has(k));
        for (const a of subjects) for (const b of objs) if (a !== b) { addParallel(a, b, r); addParallel(b, a, r); }
        continue;
      }
      if (r.kind !== 'dep') continue; // 'none'（依赖：无）不产生边
      for (const s of subjects) {
        const o = own.get(s);
        for (const ref of r.objects) {
          if (ref.type === 'prereq') {
            if (prereq.has(ref.id)) o.external.push({ id: ref.id, resolved: prereq.get(ref.id) });
            else o.dangling.push({ ...r.source, raw: ref.raw });
            continue;
          }
          if (ref.dangling || !ref.keys.length || ref.keys.some((k) => !byKey.has(k))) o.dangling.push({ ...r.source, raw: ref.raw });
          for (const k of ref.keys.filter((x) => byKey.has(x))) {
            for (const leaf of leaves(k)) if (!related(s, leaf)) o.edges.push({ on: leaf, via: r.via, source: r.source });
          }
        }
      }
    }
  }

  // 第二步：叠加祖先的依赖（继承），相对继承者再排除一次，按叶子去重合并来源。
  const out = new Map();
  for (const t of tasks) {
    const edges = new Map();
    const dangling = new Map();
    const external = new Map();
    for (const from of [t.key, ...ancestors(t.key)]) {
      const o = own.get(from);
      const inheritedFrom = from === t.key ? null : from;
      for (const e of o.edges) {
        if (related(t.key, e.on)) continue;
        const edge = edges.get(e.on) ?? edges.set(e.on, { on: e.on, sources: [] }).get(e.on);
        const dup = edge.sources.some((x) => x.via === e.via && x.source.file === e.source.file && x.source.line === e.source.line
          && x.inheritedFrom === inheritedFrom);
        if (!dup) edge.sources.push({ via: e.via, source: e.source, inheritedFrom });
      }
      for (const x of o.dangling) dangling.set(`${x.file}\0${x.line}\0${x.raw}`, x);
      for (const x of o.external) if (!external.has(x.id)) external.set(x.id, x);
    }
    const sorted = [...edges.values()].sort((a, b) => order.get(a.on) - order.get(b.on));
    const par = [...parallel.get(t.key).keys()].sort((a, b) => order.get(a) - order.get(b));
    out.set(t.key, {
      deps: {
        on: sorted.map((e) => e.on), unmet: [], dangling: [...dangling.values()], external: [...external.values()],
        inCycle: false, cycleWith: [], edges: sorted,
      },
      parallelWith: par,
      parallelEdges: par.map((k) => ({ with: k, sources: parallel.get(t.key).get(k) })),
    });
  }

  // 第三步：成环（需求 4.7）。只看未作废任务之间的边：依赖作废任务算已满足，经过它的「环」不卡任何人。
  const graph = new Map(tasks.filter((t) => !t.void).map((t) => [t.key, out.get(t.key).deps.on.filter((k) => !byKey.get(k).void)]));
  for (const [k, scc] of cycles(graph)) Object.assign(out.get(k).deps, { inCycle: true, cycleWith: scc.filter((x) => x !== k) });
  return out;
}

/**
 * Tarjan 强连通分量：大小 > 1 或自环的分量上的每个节点 → 该分量（需求 4.7，线性时间、不死循环）。
 * ponytail: 递归实现，深度 = 最长依赖链；几千个任务的链也远低于 Node 默认栈深，真遇到再改显式栈。
 * @param {Map<string, string[]>} graph 节点 → 它依赖的节点（都须是 graph 的键）
 * @returns {Map<string, string[]>}
 */
function cycles(graph) {
  let n = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const out = new Map();
  const visit = (v) => {
    idx.set(v, n); low.set(v, n++); stack.push(v); onStack.add(v);
    for (const w of graph.get(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) !== idx.get(v)) return;
    const scc = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
    if (scc.length > 1 || graph.get(v).includes(v)) for (const k of scc) out.set(k, scc);
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

// 「即将可开工」只等这两种状态：前置已经发了 PR（design §3.9、需求 12.4）；前置还在「进行中」算被阻塞。
// UI 稿「即将可开工」= 前置已经在做或有 PR（UI 稿优先于 design / 需求 12.4 的「只认有 PR」）。
const SOON = new Set(['in_progress', 'in_review', 'awaiting_merge']);

/**
 * 下一步分类（design §3.9、需求 12）：填每个 TaskView 的 deps.unmet、next、batch。
 * 要求 views 已有 status、childSummary、deps、parallelWith。
 * - unmet = 依赖里还不是「已合并完成」的任务（作废前置算已满足；待同步本地的前置状态是等待合并，也算未满足）。
 * - 只对「未开始」的叶子分类（有未作废子任务的父任务不笼统出现，需求 12.2）；其余任务 next 为 null。
 * - 先后：悬空 / 在环 → confirm；外部阻塞未解除 → blocked；依赖全满足 → ready；
 *   未满足的依赖全处于进行中 / 等待 review / 等待合并 → soon（UI 稿口径）；其余 → blocked。
 * - 可开工任务按并行边并查集分批（需求 12.3），批号从 1 起按文档顺序首次出现编号；单独一个任务也自成一批。
 * @param {object[]} views TaskView[]，按文档 → 任务顺序
 */
export function classifyNext(views) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  const ready = [];
  for (const v of views) {
    v.deps.unmet = v.deps.on.filter((k) => { const d = byKey.get(k); return d && d.status !== null && d.status !== 'done'; });
    if (v.status !== 'not_started' || v.childSummary?.total) continue;
    if (v.deps.dangling.length || v.deps.inCycle) v.next = 'confirm';
    else if (v.deps.external.some((e) => !e.resolved)) v.next = 'blocked';
    else if (!v.deps.unmet.length) { v.next = 'ready'; ready.push(v); }
    else v.next = v.deps.unmet.every((k) => SOON.has(byKey.get(k).status)) ? 'soon' : 'blocked';
  }
  const root = new Map(ready.map((v) => [v.key, v.key]));
  const find = (k) => (root.get(k) === k ? k : find(root.get(k)));
  for (const v of ready) for (const p of v.parallelWith) if (root.has(p)) root.set(find(p), find(v.key));
  const batchOf = new Map();
  for (const v of ready) {
    const r = find(v.key);
    if (!batchOf.has(r)) batchOf.set(r, batchOf.size + 1);
    v.batch = batchOf.get(r);
  }
}

/**
 * 文档侧冲突（design §3.9 表的 c、e、f、g、k；需求 9）：只附加提示，不改状态。
 * 写进每个 TaskView.conflicts（类型字母），并返回 Board.conflicts 明细。
 * 作废任务只查 e（编号重复是文档本身的问题），其余不查。
 * @param {object[]} tasks Task[]，与 views 一一对应
 * @param {object[]} views TaskView[]
 */
function detectConflicts(tasks, views) {
  const out = [];
  const add = (v, type, detail, source) => {
    v.conflicts.push(type);
    out.push({ type, taskKey: v.key, ...(source && { source }), detail });
  };
  // 同文档的任务只写编号，跨文档写完整任务键。
  const label = (k, docId) => (k.startsWith(`${docId}#`) ? k.slice(docId.length + 1) : k);
  tasks.forEach((t, i) => {
    const v = views[i];
    if (t.duplicate) add(v, 'e', msg`编号 ${t.number} 在文档里出现了不止一次`);
    if (t.void) return;
    if (v.rule === '8.2-3') add(v, 'c', msg('复选框已勾选，但没有关联 PR（仅文档确认）'));
    if (v.deps.dangling.length) {
      const { file, line, text } = v.deps.dangling[0];
      add(v, 'f', msg`依赖了找不到的对象：${joinList([...new Set(v.deps.dangling.map((x) => x.raw))])}`, { file, line, text });
    }
    if (v.deps.inCycle) add(v, 'g', msg`与 ${joinList(v.deps.cycleWith.map((k) => label(k, t.docId)))} 构成循环依赖`);
    const c = v.childSummary;
    if (c?.total && v.status === 'done' && c.done < c.total) add(v, 'k', msg`父任务已完成，但子任务只完成 ${c.done} / ${c.total}`);
    if (c?.total && v.status === 'not_started' && c.done === c.total) add(v, 'k', msg`子任务已全部完成（${c.total} 个），父任务还是未开始`);
  });
  return out;
}

// ---- 任务 3.4：PR 关联、PR 侧冲突、即将可开工在等什么、在等我处理 ----

const SOURCE_TEXT = { title: msg('标题'), body: msg('描述'), branch: msg('分支名') };
const hasRefs = (r) => r.keys.length + r.nums.length + r.codes.length > 0;
// 列表太长只列前 5 个，detail 是给人看的一句话
const brief = (keys) => (keys.length > 5 ? msg`${joinList(keys.slice(0, 5))} 等 ${keys.length} 个` : joinList(keys));

/**
 * PR ↔ 任务（design §3.8.2）；最后叠加手动记录（applyManual，任务 4.1）。
 * 候选文档 = PR 所属分支线 docFilter 过滤后的文档；未归类或没配 docFilter 的用全部文档。
 * 来源只取一处：标题有引用 → 标题；否则描述；都没有才看分支名。标题生效时另解析描述 / 分支名，
 * 与标题**完全不重叠**才记冲突 i（#360 标题 M0-c、描述「任务 3–10」只是写法粗细不同，不算指向不同）。
 * 歧义 / 不存在 → 冲突 h，这部分不关联；一条都没关联上的 PR 即「未关联」（需求 6.7）。多对多（需求 6.5）。
 * 已关闭未合并的 PR 不报 h / i / n（N21），问题只留在 refIssues 里给 PR 详情看。
 * 3.5 用它找出「已关联的已合并 PR」去跑 checkLocalSync。
 * @param {object[]} docs PlanDoc[]
 * @param {object[]} prs PullRequest[]
 * @param {object} config ProjectConfig（用 branchLines）
 * @param {object[]} [manual] ManualRecord[]
 * @returns {{ links: {pr: number, taskKey: string, source: 'manual'|'title'|'body'|'branch', evidence: string, at?: string}[],
 *   prs: Map<number, {branchLine: string|null, refIssues: string[], tasks: string[], unlinked: string[]}>,
 *   conflicts: {type: 'h'|'i'|'n'|'j', pr: number, taskKey?: string, detail: string}[],
 *   removed: {pr: number, taskKey: string, source: string, evidence: string}[] }}
 *   evidence = 命中的原文片段（「M0-c」「任务 15.2」），页面拼「来源：PR 标题里的『M0-c』」；手动关联 evidence 为空、带记录时间 at。
 *   prs 的 tasks 已含手动关联、去掉手动解除；unlinked = 被手动解除的任务键；removed = 被手动解除的自动关联。
 */
export function linkPrs(docs, prs, config, manual = []) {
  const lines = config?.branchLines ?? [];
  const links = [];
  const info = new Map();
  const conflicts = [];
  for (const pr of prs) {
    const { branchLine, issues } = classifyBranchLine(pr, lines);
    const filter = lines.find((l) => l.id === branchLine)?.docFilter;
    const cands = filter ? docs.filter((d) => new RegExp(filter).test(d.docId)) : docs;
    const alias = aliasMap(cands);
    const opts = {
      knownDocIds: [...cands.map((d) => d.docId), ...alias.keys()],
      knownCodes: cands.flatMap((d) => (d.groups ?? []).map((g) => g.code).filter(Boolean)),
    };
    const raw = { title: unalias(extractRefs(pr.title, opts), alias), body: unalias(extractRefs(pr.body, opts), alias),
      branch: unalias(extractBranchRefs(pr.headRefName, opts), alias) };
    const source = ['title', 'body', 'branch'].find((s) => hasRefs(raw[s]));
    const res = source ? resolveRefs(raw[source], cands) : { tasks: [], ambiguous: [], missing: [] };
    const evidence = source ? raw[source].spans.filter((x) => x.kind !== 'docId').map((x) => x.text).join('、') : '';
    // 「任务 13（部分）」：PR 只做了一部分，合并后不算完成（deriveStatus）；同段另有完整引用（编号 / 键 / 代号）覆盖到的照常算完整
    const r = source && raw[source];
    const whole = r?.partial.length ? resolveRefs({ ...r, nums: r.nums.filter((n) => !r.partial.includes(n)) }, cands).tasks : null;
    for (const taskKey of res.tasks) {
      links.push({ pr: pr.number, taskKey, source, evidence, ...(whole && !whole.includes(taskKey) ? { partial: true } : {}) });
    }

    const refIssues = [];
    const where = source && msg`PR ${SOURCE_TEXT[source]}`;
    for (const a of res.ambiguous) refIssues.push(msg`${where}里的「${a.raw}」有歧义，可能是 ${brief(a.candidates)}`);
    for (const m of res.missing) {
      // 3.2 交接：只命中重复编号任务时 resolveRefs 也记 missing，这里改口，别让人以为任务不存在
      refIssues.push(onlyDuplicates(m, cands)
        ? msg`${where}里的「${m}」对应的编号在文档里重复出现，无法确定是哪一条`
        : msg`${where}引用了不存在的任务：${m}`);
    }
    // 已关闭未合并的 PR 不进「需要确认」的 h / i / n：它不参与关联与状态（excludedPrs、deriveStatus 都跳过），
    // 写法问题也没法再改（如 #20 改分支名后被 GitHub 关闭，旧分支名永远留在 PR 上）。PR 详情仍列 refIssues。
    const report = pr.state !== 'CLOSED';
    if (report) for (const detail of refIssues) conflicts.push({ type: 'h', pr: pr.number, detail });
    if (source === 'title' && res.tasks.length) {
      for (const s of ['body', 'branch']) {
        const other = hasRefs(raw[s]) ? resolveRefs(raw[s], cands).tasks : [];
        if (!other.length || other.some((k) => res.tasks.includes(k))) continue;
        const detail = msg`标题指向 ${brief(res.tasks)}，${SOURCE_TEXT[s]}却指向 ${brief(other)}`;
        refIssues.push(detail);
        if (report) conflicts.push({ type: 'i', pr: pr.number, detail });
      }
    }
    // n 原本只经 conflicts 呈现；关闭后不报，就挪进 refIssues，PR 详情才看得到（放在 h 循环之后，不会被当成 h 报）
    if (report) for (const detail of issues) conflicts.push({ type: 'n', pr: pr.number, detail });
    else refIssues.push(...issues);
    info.set(pr.number, { branchLine, refIssues, tasks: res.tasks, unlinked: [] });
  }
  const removed = applyManual(docs, manual, links, info, conflicts);
  return { links, prs: info, conflicts, removed };
}

/**
 * 叠加手动记录（design §3.8.2、需求 7.1、7.2、7.5），原地改 links / info / conflicts，返回被解除的自动关联。
 * - link：加关联；与自动关联同一对时来源改记「手动」（手动 > 标题 > 描述 > 分支名）。
 * - unlink：删掉该自动关联。记录一直在，所以每次刷新重新推出的自动关联照样被删，不会「回来」；撤销 = 删记录。
 *   对应的自动关联本来就不存在（如 PR 标题已改）时什么也不做。
 * - 任务键不存在（改号 / 删除）→ 冲突 j，记录不动、不参与关联（需求 7.5）。
 * - PR 不在当前 PR 列表（GitHub 还没拉到、超出回溯下限）→ 暂不生效，拉到后自然生效。
 * 同一 (taskKey, pr) 以最后一条为准（store 保证只留一条；这里防手改文件出现重复）。
 */
function applyManual(docs, manual, links, info, conflicts) {
  const removed = [];
  if (!manual.length) return removed;
  const keys = new Set(docs.flatMap((d) => (d.tasks ?? []).map((t) => t.key)));
  const latest = new Map(manual.map((r) => [`${r.taskKey}\n${r.pr}`, r]));
  for (const r of latest.values()) {
    if (!keys.has(r.taskKey)) {
      conflicts.push({ type: 'j', taskKey: r.taskKey, pr: r.pr,
        detail: r.action === 'link'
          ? msg`手动关联记录指向不存在的任务 ${r.taskKey}（PR #${r.pr}），请改挂或删除这条记录`
          : msg`手动解除记录指向不存在的任务 ${r.taskKey}（PR #${r.pr}），请改挂或删除这条记录` });
      continue;
    }
    const i = info.get(r.pr);
    if (!i) continue;
    const at = links.findIndex((l) => l.pr === r.pr && l.taskKey === r.taskKey);
    if (r.action === 'unlink') {
      if (at < 0) continue;
      removed.push(links.splice(at, 1)[0]);
      i.tasks = i.tasks.filter((k) => k !== r.taskKey);
      i.unlinked.push(r.taskKey);
    } else {
      const link = { pr: r.pr, taskKey: r.taskKey, source: 'manual', evidence: '', at: r.at };
      if (at >= 0) links[at] = link;
      else { links.push(link); i.tasks = [...i.tasks, r.taskKey]; }
    }
  }
  return removed;
}

// 引用（编号或完整任务键）在候选里只对得上重复编号的任务。范围与代号不在此列。
function onlyDuplicates(ref, cands) {
  const i = ref.lastIndexOf('#');
  const num = ref.slice(i + 1);
  const docs = i < 0 ? cands : cands.filter((d) => d.docId === ref.slice(0, i));
  return docs.some((d) => (d.tasks ?? []).some((t) => t.duplicate && t.number === num));
}

/**
 * 「即将可开工」的任务列出在等什么（design §3.9、需求 12.4）：每个未满足前置的状态、它的 open PR、待同步的已合并 PR。
 * 写进 deps.waitingFor = [{ on, status, prs: open PR 号[], syncPending: PR 号[] | null }]；其余任务为空数组。
 */
function annotateSoon(views, prByNum) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  for (const v of views) {
    v.deps.waitingFor = v.next !== 'soon' ? [] : v.deps.unmet.map((k) => {
      const d = byKey.get(k);
      return { on: k, status: d.status, prs: d.prs.filter((l) => prByNum.get(l.pr)?.state === 'OPEN').map((l) => l.pr),
        syncPending: d.syncPending };
    });
  }
}

/**
 * PR 侧的任务冲突（design §3.9 表的 a、b、d、l、m）；h、i、n 是 PR 级的，由 linkPrs 给出。只附加提示，不改状态。
 * l 只报真的「抢跑」：同一个 PR 里一起做的前置、已勾选且只差本地 pull 的前置，都不算。
 * @param {object[]} tasks Task[]，与 views 一一对应
 */
function detectPrConflicts(tasks, views, prByNum) {
  const checked = new Set(tasks.filter((t) => t.checkbox === 'done').map((t) => t.key));
  const byKey = new Map(views.map((v) => [v.key, v]));
  const out = [];
  const add = (v, type, detail) => { v.conflicts.push(type); out.push({ type, taskKey: v.key, detail }); };
  const nums = (links) => joinList(links.map((l) => `#${l.pr}`));
  tasks.forEach((t, i) => {
    const v = views[i];
    if (!v.prs.length) return;
    if (t.void) { add(v, 'm', msg`任务已作废，仍关联着 PR ${nums(v.prs)}`); return; }
    const live = v.prs.filter((l) => prByNum.get(l.pr)?.state !== 'CLOSED');
    const wholeMerged = live.filter((l) => !l.partial && prByNum.get(l.pr)?.state === 'MERGED');
    if (v.rule !== '8.2-1' && wholeMerged.length && t.checkbox !== 'done') add(v, 'a', msg`PR ${nums(wholeMerged)} 已合并，但复选框未勾`);
    if (v.rule === '8.2-1' && t.checkbox === 'done') add(v, 'b', msg`复选框已勾，但 PR ${nums(live)} 还没合并`);
    if (!live.length) add(v, 'd', msg`关联的 PR ${nums(v.prs)} 均已关闭未合并`);
    const mine = new Set(live.map((l) => l.pr));
    const early = v.deps.unmet.filter((k) => !(byKey.get(k).syncPending && checked.has(k)) && !byKey.get(k).prs.some((l) => mine.has(l.pr)));
    if (live.length && early.length) add(v, 'l', msg`依赖 ${brief(early)} 还没完成，却已有 PR ${nums(live)}`);
  });
  return out;
}

/**
 * 「在等我处理」里与 PR 有关的两类（design §3.9、需求 12.6）：
 * - 全部 open PR：draft → kind 'review'，已等 now − createdAt；ready → 'merge'，已等 now − (readyAt ?? createdAt)；
 * - 本地待同步的已合并 PR → 'sync'，已等 now − mergedAt，并给出在哪个工作区 pull 哪条分支。
 * 按分支线（配置顺序，未归类最后）→ 已等时长倒序。extra = 停滞任务（staleWaiting，自带 since），一起排；外部阻塞由前端追加。
 * @returns {{ kind: 'review'|'merge'|'sync', pr: number, branchLine: string|null, tasks: string[], since: string,
 *   waitedMs: number, workspace?: {id: string, path: string|null, branch: string} }[]}
 */
function waitingList(prs, info, sync, config, nowMs, extra = []) {
  const lines = config?.branchLines ?? [];
  const out = extra.map((x) => ({ ...x, waitedMs: nowMs - Date.parse(x.since) }));
  for (const p of prs) {
    const { branchLine, tasks } = info.get(p.number);
    let item;
    if (p.state === 'OPEN') {
      const since = p.isDraft ? p.createdAt : p.readyAt ?? p.createdAt;
      item = { kind: p.isDraft ? 'review' : 'merge', since };
    } else if (p.state === 'MERGED' && sync[p.number]?.state === 'pending') {
      // 工作区 id 与 loadProjectDocs 一致：分支线配了独立工作区用分支线 id，否则主工作区 'repo'
      const line = lines.find((l) => l.id === branchLine);
      const own = line?.workspace && line.workspace !== config?.repo?.path;
      // docRef 分支线（N17）没有检出，「同步」= 主仓库 fetch 后合并提交出现在 docRef 上
      item = { kind: 'sync', since: p.mergedAt,
        workspace: { id: own ? line.id : 'repo', path: own ? line.workspace : config?.repo?.path ?? null, branch: p.baseRefName,
          ...(line?.docRef ? { fetchRef: line.docRef } : {}) } };
    } else continue;
    out.push({ pr: p.number, branchLine, tasks, ...item, waitedMs: nowMs - Date.parse(item.since) });
  }
  const rank = (id) => (id === null ? lines.length : lines.findIndex((l) => l.id === id));
  return out.sort((a, b) => rank(a.branchLine) - rank(b.branchLine) || b.waitedMs - a.waitedMs);
}

// ---- 任务 5.3：会话 ↔ 任务、活动标记、会话侧冲突、停滞任务 ----

const MINUTE = 6e4;
const DAY = 864e5;
const hasTaskRefs = (r) => r.keys.length + r.nums.length + r.codes.length > 0;
const SIGNAL_TEXT = { prompt: msg('人发消息'), dispatch: msg('子 agent 派活') };

/**
 * 会话 ↔ 任务（design §3.8.3）。对每个会话按信号时间顺序走一遍：
 * 1. 上下文 docId = 整个会话 touch 过的文档 ∪ prompt / dispatch 里写出的 docId（取全会话，先说「做任务 3」、
 *    后读 spec 的会话也能定位）。
 * 2. 候选文档 = 会话某个 cwd 落在分支线工作区时用该分支线 docFilter 过滤的文档，否则全部文档。
 * 3. 带任务引用的 prompt / dispatch 设「当前焦点」= resolveRefs 唯一命中的任务；歧义 / 不存在 → 冲突 h、不关联。
 *    整条消息一个都没对上时焦点清空（人已经转去做别的，别把后续活动记到旧任务上）；只写 docId、不带引用的消息不改焦点。
 * 4. 每条信号的 until（到下一条信号前最后一条记录的时间，5.2 给出）计入当前焦点 → 焦点段的最后活动时间。
 * 5. edit → 被改的任务行；pr-link → 该 PR 的全部关联任务；branch = 某 PR head → 该 PR 的全部关联任务，
 *    且在切到下一个分支前一直计活动（会话整段都在这条分支上）。
 * ponytail: 5.2 的 branch 信号每个分支只记首次，A → B → A 切回 A 时不再计 A；真遇到再让 5.2 记每次切换。
 * ponytail: 焦点只有一个——同一时刻并行派出多个子 agent 时只有最后一个派的任务算「运行中」，其余是「最近活跃」
 *           （状态照样是进行中）；要精确得按子 agent 文件各自的时间算，改动在 5.2。
 *
 * @param {object[]} docs PlanDoc[]
 * @param {object[]} sessions SessionRecord[]
 * @param {object[]} prs PullRequest[]（用 headRefName 对 branch 信号）
 * @param {Map<number, {tasks: string[]}>} prInfo linkPrs(...).prs
 * @param {object} config ProjectConfig（用 branchLines 的 workspace / docFilter）
 * @returns {{ links: {sessionId: string, taskKey: string, firstAt: string, lastAt: string,
 *     evidence: {kind: string, pos: {at: string, file: string, line: number}, note: string}[]}[],
 *   conflicts: {type: 'h', sessionId: string, source: {file: string, line: number, text: string}, detail: string}[],
 *   linkedIds: Set<string> }}
 *   links 按会话 → 任务首次出现顺序；activity 由 computeBoard 按 now 补（要看任务状态）。
 */
export function linkSessions(docs, sessions, prs, prInfo, config) {
  const lines = config?.branchLines ?? [];
  const links = [];
  const conflicts = [];
  const linkedIds = new Set();
  // docRef 文档（N17）与主工作区那份同路径，但会话改 / 碰的是磁盘上的文件，不是 ref 上那份：不进会话上下文、不认 edit
  const byPath = (p) => docs.filter((d) => d.path === p && !d.ref);
  for (const s of sessions) {
    const cands = sessionCandidates(docs, s.cwds ?? [], lines);
    const ctx = new Set();
    for (const g of s.signals) {
      if (g.kind === 'touch') for (const d of byPath(g.docPath)) ctx.add(d.docId);
      if (g.kind === 'prompt' || g.kind === 'dispatch') for (const id of g.refs.docIds) ctx.add(id);
    }
    const ctxIds = [...ctx];
    const per = new Map(); // 任务键 → SessionLink
    const hit = (key, g, lastAt, note) => {
      const l = per.get(key) ?? per.set(key, { sessionId: s.id, taskKey: key, firstAt: g.at, lastAt, evidence: [] }).get(key);
      if (Date.parse(g.at) < Date.parse(l.firstAt)) l.firstAt = g.at;
      if (Date.parse(lastAt) > Date.parse(l.lastAt)) l.lastAt = lastAt;
      if (note) l.evidence.push({ kind: g.kind, pos: { at: g.at, file: g.file, line: g.line }, note });
    };
    const reported = new Set();
    const issue = (g, detail) => {
      if (reported.has(detail)) return;
      reported.add(detail);
      conflicts.push({ type: 'h', sessionId: s.id, source: { file: g.file, line: g.line, text: g.snippet }, detail });
    };
    const name = s.title ? msg`会话「${s.title}」` : msg`会话 ${s.id}`;
    let focus = [];
    let onBranch = [];
    for (const g of s.signals) {
      if ((g.kind === 'prompt' || g.kind === 'dispatch') && hasTaskRefs(g.refs)) {
        const res = resolveRefs(g.refs, cands, ctxIds);
        // 主线程收紧（实测误报）：会话没有任何文档上下文、消息里只有裸编号（没写 docId / 任务键 / 里程碑代号），
        // 而候选文档不止一份时，「在全部文档里恰好唯一」不足为凭——编排会话里的「5.3」恰好只在某份无关 spec
        // 里唯一，会被误关联。此时不关联（歧义照常报 h）；单文档项目不受影响。
        // 同理，有上下文但裸编号在上下文文档里对不上时，resolveRefs 会回退到全部文档求唯一——同样不采信，
        // 只保留落在上下文文档里的命中（实测：派 devboard 任务 5.5 的消息被关联到无关的 task-panel-backend#5.5）。
        const bareOnly = !g.refs.keys.length && !g.refs.docIds.length && !g.refs.codes.length;
        if (bareOnly && cands.length > 1) res.tasks = res.tasks.filter((k) => ctxIds.includes(k.slice(0, k.indexOf('#'))));
        // 子 agent 派活的说明通常会写明 spec 名；只有裸编号的派活多半属于别的项目 / 仓库外的 spec（实测：派 devboard
        // 自己的任务 3.1…6.3 被整会话上下文——含子 agent 执行过的命令——带到 task-panel-backend），一律不采信。
        if (bareOnly && g.kind === 'dispatch' && cands.length > 1) res.tasks = [];
        for (const a of res.ambiguous) issue(g, msg`${name}里的「${a.raw}」有歧义，可能是 ${brief(a.candidates)}`);
        for (const m of res.missing) {
          issue(g, onlyDuplicates(m, cands) ? msg`${name}里的「${m}」对应的编号在文档里重复出现，无法确定是哪一条`
            : msg`${name}引用了不存在的任务：${m}`);
        }
        focus = res.tasks;
        for (const k of focus) hit(k, g, g.until, msg`${SIGNAL_TEXT[g.kind]}：「${g.snippet}」`);
      } else if (g.kind === 'edit') {
        for (const d of byPath(g.docPath)) {
          for (const t of d.tasks ?? []) if (!t.duplicate && g.taskNums.includes(t.number)) hit(t.key, g, g.until, msg`改了 ${d.docId} 的任务行 ${t.number}`);
        }
      } else if (g.kind === 'pr-link') {
        for (const k of prInfo.get(g.pr)?.tasks ?? []) hit(k, g, g.until, msg`会话登记了 PR #${g.pr}`);
      } else if (g.kind === 'branch') {
        onBranch = [];
        for (const p of prs.filter((x) => x.headRefName === g.branch)) {
          for (const k of prInfo.get(p.number)?.tasks ?? []) { hit(k, g, g.until, msg`会话分支 ${g.branch} = PR #${p.number} 的 head`); onBranch.push(k); }
        }
      }
      for (const k of [...focus, ...onBranch]) hit(k, g, g.until, null);
    }
    if (per.size) linkedIds.add(s.id);
    links.push(...per.values());
  }
  return { links, conflicts, linkedIds };
}

// N17：docRef 分支线的文档 docId 带前缀（next:ADR-0033-…），PR 里写的是不带前缀的原名（alias）。
// 候选里别的文档已占用这个原名时不认（未归类 PR 用全部文档，原名归主工作区那份）。
function aliasMap(cands) {
  const ids = new Set(cands.map((d) => d.docId));
  return new Map(cands.filter((d) => d.alias && !ids.has(d.alias)).map((d) => [d.alias, d.docId]));
}
function unalias(raw, alias) {
  if (!alias.size) return raw;
  const back = (id) => alias.get(id) ?? id;
  return { ...raw, docIds: raw.docIds.map(back), keys: raw.keys.map((k) => { const i = k.lastIndexOf('#'); return `${back(k.slice(0, i))}${k.slice(i)}`; }) };
}

// 会话在哪条分支线的工作区里干活，就只在那条分支线的文档里认引用（与 PR 的候选口径一致）。
function sessionCandidates(docs, cwds, lines) {
  const inside = (c, w) => c === w || c.startsWith(`${w}/`) || c.startsWith(`${w}\\`);
  const hit = lines.filter((l) => l.workspace && cwds.some((c) => inside(c.normalize('NFC'), l.workspace)));
  if (!hit.length || hit.some((l) => !l.docFilter)) return docs;
  return docs.filter((d) => hit.some((l) => new RegExp(l.docFilter).test(d.docId)));
}

/**
 * 活动标记（design §3.8.3 第 8 步、需求 8.3）：now − lastAt ≤ 运行中阈值 → running；
 * 任务是「进行中」且 now − lastAt > 停滞阈值 → stale；其余 recent。
 * 每条 SessionLink 各自标；TaskView.activity 只在命中 (a) 时给，取各会话里最近的一次活动。停滞不改状态。
 */
function markActivity(views, nowMs, defaults) {
  const running = (defaults.sessionRunningMinutes ?? 10) * MINUTE;
  const stale = (defaults.sessionStaleDays ?? 3) * DAY;
  for (const v of views) {
    const of = (lastAt) => {
      const idle = nowMs - Date.parse(lastAt);
      return idle <= running ? 'running' : v.status === 'in_progress' && idle > stale ? 'stale' : 'recent';
    };
    for (const l of v.sessions) l.activity = of(l.lastAt);
    if (v.inProgressBy.includes('session')) v.activity = of(v.sessions.map((l) => l.lastAt).sort().at(-1));
  }
}

/**
 * 会话侧的任务冲突（design §3.9）：
 * - o：进行中靠会话、最近一次活动已超停滞阈值（即 activity = stale）。
 * - l：依赖未满足却已有关联会话；同一会话里一起在做的前置、已勾选且只差本地 pull 的前置不算；PR 侧已报 l 的不重复报。
 */
function detectSessionConflicts(tasks, views, nowMs) {
  const checked = new Set(tasks.filter((t) => t.checkbox === 'done').map((t) => t.key));
  const byKey = new Map(views.map((v) => [v.key, v]));
  const out = [];
  const add = (v, type, detail) => { v.conflicts.push(type); out.push({ type, taskKey: v.key, detail }); };
  tasks.forEach((t, i) => {
    const v = views[i];
    if (t.void || !v.sessions.length) return;
    if (v.activity === 'stale') {
      const last = v.sessions.map((l) => l.lastAt).sort().at(-1);
      add(v, 'o', msg`任务仍在进行中，关联 AI 会话已 ${Math.floor((nowMs - Date.parse(last)) / DAY)} 天没有动静`);
    }
    if (v.conflicts.includes('l')) return;
    const mine = new Set(v.sessions.map((l) => l.sessionId));
    const early = v.deps.unmet.filter((k) => !(byKey.get(k).syncPending && checked.has(k)) && !byKey.get(k).sessions.some((l) => mine.has(l.sessionId)));
    if (early.length) add(v, 'l', msg`依赖 ${brief(early)} 还没完成，却已有 AI 会话在做`);
  });
  return out;
}

/**
 * 「在等我处理」里的停滞任务（需求 12.6）：kind 'stale'，since = 最近一次会话活动，sessions = 关联会话 id
 * （5.5 用 Board.sessions 里的 lastSummary 画「要不要接着做？」卡片）。分支线按 docFilter 归，归不上为 null。
 */
function staleWaiting(views, config) {
  const lines = (config?.branchLines ?? []).filter((l) => l.docFilter);
  return views.filter((v) => v.activity === 'stale').map((v) => {
    const docId = v.key.slice(0, v.key.lastIndexOf('#'));
    return { kind: 'stale', pr: null, taskKey: v.key, tasks: [v.key],
      branchLine: lines.find((l) => new RegExp(l.docFilter).test(docId))?.id ?? null,
      sessions: v.sessions.map((l) => l.sessionId), since: v.sessions.map((l) => l.lastAt).sort().at(-1) };
  });
}

// ---- 任务 6.5：诊断页「不满足约定之处」 ----

/**
 * 不满足最低约定之处（需求 3.5、18.2；design §8）：逐条写明「哪条约定、哪份文档哪一行 / 哪个 PR」，方便 owner 让 AI 改。
 * rule = design §8 的条目号：1 任务行、3 依赖 / 并行写法、5 预计耗时、7 PR 标题（含分支线前缀 / 标签）。
 * 只收文档与 PR 标题的写法问题；会话里的歧义引用不是约定问题，只进「需要确认」。
 * 文档内按行号排，PR 按 PR 列表顺序接在文档之后。
 * @returns {{rule: 1|3|5|7, docId?: string, line?: number, pr?: number, detail: string}[]}
 */
function conventionIssues(docs, conflicts) {
  const out = [];
  const byDoc = new Map(docs.map((d) => [d.docId, []]));
  const at = (docId, rule, line, detail) => byDoc.get(docId)?.push({ rule, docId, line, detail });
  for (const d of docs) {
    const p = d.parse ?? {}; // engine 的最小输入可以不带 parse（见 computeBoard 注释）
    for (const line of p.unrecognizedLines ?? []) at(d.docId, 1, line, msg('像任务行，但不是「- [ ] 编号 标题」的写法'));
    for (const t of d.tasks) if (t.duplicate) at(d.docId, 1, t.line, msg`编号 ${t.number} 在文档里出现了不止一次`);
    for (const r of p.unknownRelations ?? []) at(d.docId, 3, r.line, msg`未识别的依赖说法：${r.text}`);
    for (const r of p.unknownEstimates ?? []) at(d.docId, 5, r.line, msg`无法识别的耗时写法：${r.text}`);
  }
  // 悬空依赖（冲突 f）：写了依赖但对象找不到，多半是编号写错或跨文档没写 docId
  for (const c of conflicts) {
    if (c.type === 'f') at(c.taskKey.slice(0, c.taskKey.lastIndexOf('#')), 3, c.source.line, c.detail);
  }
  for (const list of byDoc.values()) out.push(...list.sort((a, b) => a.line - b.line));
  // PR 侧：标题引用歧义 / 不存在（h）、标题与描述 / 分支名指向不同（i）、分支线前缀 / 标签不一致（n）
  for (const c of conflicts) if (c.pr != null && 'hin'.includes(c.type)) out.push({ rule: 7, pr: c.pr, detail: c.detail });
  return out;
}

// ---------------- 任务 6.3：最近变化（design §3.9、需求 10.3） ----------------

/**
 * 最近变化：全部从当前看板推出，不存历史（需求 10.3）；复选框没有时间，勾选变化不在其列（页面注明）。
 * 三类事件，按时间倒序（同一时刻保持 PR → 会话 → 任务的产生顺序）：
 * - `pr`：createdAt（opened；draft = 当时是 draft，即现在仍是或后来转过 ready）、readyAt（ready）、mergedAt（merged）、
 *   closedAt（closed，只算关闭未合并的）落在窗口内。带 tasks（关联任务键，空 = 没关联到任务）；merged 另带
 *   done（因这次合并成为已合并完成的任务）与 localSync（'pending' = GitHub 已合并、本地还没 pull）。
 * - `session`：关联会话的一段活动在窗口内结束（SessionLink.lastAt）；同一会话、同一时刻、同一活动标记的任务并成一条，
 *   activity 为 running / recent / stale。
 * - `status`：statusSince 在窗口内、且不是 PR 引起的状态变化。8.2-1 / 8.2-2 的 statusSince 恰是某个关联 PR 的
 *   opened / ready / merged 时间，已体现在那条 PR 事件里，不再单列；实际只剩会话带来的「进行中」（时间 = 会话 firstAt）。
 * @param {object} board computeBoard 的结果（用 tasks、prs、sessions）
 * @param {{from?: number|null, to?: number|null}} [win] 窗口，epoch 毫秒，闭区间；null = 该侧不限
 * @returns {object[]}
 */
export function recentChanges(board, { from = null, to = null } = {}) {
  const inWin = (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return (from == null || t >= from) && (to == null || t <= to);
  };
  const views = new Map(board.tasks.map((v) => [v.key, v]));
  const prEvents = [];
  for (const p of board.prs) {
    const base = { kind: 'pr', pr: p.number, tasks: p.tasks ?? [] };
    if (inWin(p.createdAt)) prEvents.push({ ...base, action: 'opened', at: p.createdAt, draft: p.isDraft || p.readyAt != null });
    if (inWin(p.readyAt)) prEvents.push({ ...base, action: 'ready', at: p.readyAt });
    if (p.state === 'MERGED' && inWin(p.mergedAt)) {
      const done = base.tasks.filter((k) => views.get(k)?.status === 'done' && views.get(k).statusSince === p.mergedAt);
      prEvents.push({ ...base, action: 'merged', at: p.mergedAt, done, localSync: p.localSync ?? null });
    }
    if (p.state === 'CLOSED' && inWin(p.closedAt)) prEvents.push({ ...base, action: 'closed', at: p.closedAt });
  }
  const source = new Map((board.sessions ?? []).map((s) => [s.id, s.source]));
  const segs = new Map();
  for (const v of board.tasks) {
    for (const l of v.sessions ?? []) {
      if (!inWin(l.lastAt)) continue;
      const k = `${l.sessionId}\n${l.lastAt}\n${l.activity}`;
      const e = segs.get(k) ?? segs.set(k, { kind: 'session', at: l.lastAt, sessionId: l.sessionId, source: source.get(l.sessionId) ?? null,
        activity: l.activity, tasks: [] }).get(k);
      e.tasks.push(v.key);
    }
  }
  const statuses = board.tasks.filter((v) => v.rule !== '8.2-1' && v.rule !== '8.2-2' && inWin(v.statusSince))
    .map((v) => ({ kind: 'status', at: v.statusSince, taskKey: v.key, status: v.status }));
  // sort 是稳定排序：同一时刻保持拼接顺序
  return [...prEvents, ...segs.values(), ...statuses].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
