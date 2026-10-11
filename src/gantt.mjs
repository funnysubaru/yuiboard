// 甘特排布（design §3.10、需求 15）：只推时间（epoch 毫秒），像素换算归前端（6.2）。
// 纯函数：不读时钟、不存排期（需求 15.11），每次由 computeBoard 从文档、PR、会话重新推。

import { msg } from './msg.mjs';

const DAY = 864e5;

/**
 * 给每个 TaskView 填 gantt（design §3.10.2）。要求 views 已有 status、syncPending、prs、sessions、deps、childSummary。
 * 只排未作废叶子；父任务不单独排，只给子孙范围的并集 span（汇总细括号条）。
 *
 * - 事实段 fact：开始 = min(关联会话 firstAt, 未关闭关联 PR 的 createdAt)；已合并完成 / 已勾选且待同步 → 结束 = 已合并 PR 最晚 mergedAt；
 *   仅文档确认、无合并 PR 但有会话 → 结束 = 会话最晚 lastAt，endFromSession（条上注明「结束取自会话（无 PR）」）；
 *   已完成却没有任何事实时间 → noTime（不画、不约束后继，需求 15.8）；其余有开始时间的画到 now。
 * - 无法排期 unschedulable：依赖成环（未完成的）、悬空依赖、未解除的外部前置、前置无法排期（沿依赖向下游传染）。
 *   不编造预估，但已开工的照样画事实段。
 * - 预估段 est：已开工 → [now, 开始 + 工期]，已过期则 overdue 不向后编造；未开始（含只有 [~] 标记）→
 *   从 max(now, 各前置结束) 起排工期。工期 = 预计耗时 ÷ hoursPerDay 天，没写按 defaultDurationDays 并标 defaultDuration；
 *   轴上连续排，1 天 = 24 小时。
 *
 * TaskView.gantt = { fact, factFrom, est, defaultDuration, overdue, noTime, unschedulable, endFromSession, span }
 *   fact / est / span: [开始毫秒, 结束毫秒] | null；factFrom: [开始来源, 结束来源?]（如「PR #360」「会话 <id>」；
 *   画到今天时没有结束来源）；unschedulable: 原因句子[] | null（如「外部前置 P1、P5」「前置 13、14 无法排期」）。
 *
 * @param {object[]} docs PlanDoc[]，任务顺序与 views 一致
 * @param {object[]} views TaskView[]
 * @param {Map<number, object>} prByNum PR 号 → PullRequest
 * @param {{hoursPerDay?: number, defaultDurationDays?: number}} defaults DevboardConfig.defaults；缺项按 8 小时 / 1 天
 * @param {number} nowMs
 */
export function layoutGantt(docs, views, prByNum, defaults, nowMs) {
  const hoursPerDay = defaults?.hoursPerDay ?? 8;
  const defaultDays = defaults?.defaultDurationDays ?? 1;
  const tasks = docs.flatMap((d) => d.tasks ?? []);
  const byKey = new Map(views.map((v) => [v.key, v]));
  const taskOf = new Map(tasks.map((t) => [t.key, t]));
  const leaves = tasks.filter((t) => !t.void && !byKey.get(t.key).childSummary?.total);
  const live = new Set(leaves.map((t) => t.key));
  const end = new Map(); // 任务键 → 结束毫秒；没有（无时间 / 无法排期）则不设，不约束后继
  const unsched = new Set();
  // 同文档写编号，跨文档写完整任务键（同 detectConflicts）
  const label = (k, docId) => (k.startsWith(`${docId}#`) ? k.slice(docId.length + 1) : k);
  const empty = () => ({ fact: null, factFrom: [], est: null, defaultDuration: false, overdue: false, noTime: false,
    unschedulable: null, endFromSession: false, span: null });

  const done = (v) => v.status === 'done' || (v.syncPending?.length > 0 && taskOf.get(v.key).checkbox === 'done');
  // 事实开始时间与来源；关闭未合并的 PR 不算（它没参与状态判定）
  const factStart = (v) => {
    const cands = [
      ...v.prs.map((l) => prByNum.get(l.pr)).filter((p) => p && p.state !== 'CLOSED').map((p) => [Date.parse(p.createdAt), `PR #${p.number}`]),
      ...v.sessions.map((s) => [Date.parse(s.firstAt), msg`会话 ${s.sessionId}`]),
    ];
    return cands.sort((a, b) => a[0] - b[0])[0] ?? null;
  };
  // 已完成（含已勾选且待同步）的事实段；没有事实时间 → 无时间
  const placeDone = (v, g) => {
    const start = factStart(v);
    const merged = v.prs.map((l) => prByNum.get(l.pr)).filter((p) => p?.state === 'MERGED').map((p) => [Date.parse(p.mergedAt), `PR #${p.number}`]);
    const sess = v.sessions.map((s) => [Date.parse(s.lastAt), msg`会话 ${s.sessionId}`]);
    const last = (merged.length ? merged : sess).sort((a, b) => b[0] - a[0])[0];
    if (!start || !last) { g.noTime = true; return; }
    g.fact = [start[0], last[0]];
    g.factFrom = [start[1], last[1]];
    g.endFromSession = !merged.length;
    end.set(v.key, last[0]);
  };

  // 环上未完成的任务：不排（design 的 cyc 分支）；已完成的照常画事实——完成了就不需要预估，也不该连累下游
  for (const t of leaves) {
    const v = byKey.get(t.key);
    if (!v.deps.inCycle) continue;
    v.gantt = empty();
    if (done(v)) { placeDone(v, v.gantt); continue; }
    const s = factStart(v);
    if (s) { v.gantt.fact = [s[0], nowMs]; v.gantt.factFrom = [s[1]]; }
    v.gantt.unschedulable = [msg('依赖成环')];
    unsched.add(t.key);
  }

  // Kahn：只在「非环叶子」之间连边，入度 0 的按文档顺序进队（结果稳定）；指向环上任务的边视为已处理。
  const preds = (k) => byKey.get(k).deps.on.filter((d) => live.has(d));
  const indeg = new Map();
  const succ = new Map();
  for (const t of leaves) {
    if (byKey.get(t.key).deps.inCycle) continue;
    const ps = preds(t.key).filter((d) => !byKey.get(d).deps.inCycle);
    indeg.set(t.key, ps.length);
    for (const d of ps) (succ.get(d) ?? succ.set(d, []).get(d)).push(t.key);
  }
  const queue = [...indeg.keys()].filter((k) => indeg.get(k) === 0);
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    place(byKey.get(k), taskOf.get(k));
    for (const s of succ.get(k) ?? []) if (indeg.set(s, indeg.get(s) - 1).get(s) === 0) queue.push(s);
  }

  function place(v, t) {
    const g = (v.gantt = empty());
    if (done(v)) { placeDone(v, g); return; }
    const start = factStart(v);
    if (start) { g.fact = [start[0], nowMs]; g.factFrom = [start[1]]; }
    const reasons = [];
    if (v.deps.dangling.length) reasons.push(msg`悬空依赖：${[...new Set(v.deps.dangling.map((x) => x.raw))].join('、')}`);
    const ext = v.deps.external.filter((e) => !e.resolved).map((e) => e.id);
    if (ext.length) reasons.push(msg`外部前置 ${ext.join('、')}`);
    const up = preds(v.key).filter((d) => unsched.has(d));
    if (up.length) reasons.push(msg`前置 ${up.map((d) => label(d, t.docId)).join('、')} 无法排期`);
    if (reasons.length) { g.unschedulable = reasons; unsched.add(v.key); return; }

    g.defaultDuration = t.estimateHours == null;
    const dur = Math.round((g.defaultDuration ? defaultDays : t.estimateHours / hoursPerDay) * DAY);
    if (start) {
      // 已开工：不因前置未完成后移（冲突 l 另报）；过期只标「超出预计」
      const planEnd = start[0] + dur;
      if (planEnd > nowMs) { g.est = [nowMs, planEnd]; end.set(v.key, planEnd); }
      else { g.overdue = true; end.set(v.key, nowMs); }
      return;
    }
    const s = Math.max(nowMs, ...preds(v.key).map((d) => end.get(d) ?? -Infinity));
    g.est = [s, s + dur];
    end.set(v.key, s + dur);
  }

  // 父任务：汇总条 = 子孙叶子事实 / 预估范围的并集
  for (const t of tasks) {
    if (t.void || live.has(t.key)) continue;
    byKey.get(t.key).gantt = empty();
  }
  for (const t of leaves) {
    const g = byKey.get(t.key).gantt;
    const ends = [g.fact, g.est].filter(Boolean).flat();
    if (!ends.length) continue;
    for (let p = t.parentKey; p && byKey.has(p); p = taskOf.get(p).parentKey) {
      if (taskOf.get(p).void) continue;
      const pg = byKey.get(p).gantt;
      pg.span = [Math.min(pg.span?.[0] ?? Infinity, ...ends), Math.max(pg.span?.[1] ?? -Infinity, ...ends)];
    }
  }
}

/**
 * 甘特分组行 / 文档行 / 全局的汇总（需求 15.9）：完成数 / 总数（未作废任务、父子各一条，口径同 stats 与需求 10.1），
 * 预估完成日 estEnd = 范围内预估段最晚结束（毫秒，没有为 null → 页面写「—」），
 * unschedulable / noTime = 范围内无法排期 / 无时间的叶子数（页面写「不含 N 个无法排期任务」「无时间（N）」）。
 * all 不含已归档文档（同 stats）；没有 groupId 的任务只计入文档。筛选后的重算归前端。
 * @returns {{ all: Summary, docs: (Summary & { docId: string, groups: (Summary & { groupId: string })[] })[] }}
 */
export function summarizeGantt(docs, views) {
  const byKey = new Map(views.map((v) => [v.key, v]));
  const sum = (tasks) => {
    const out = { done: 0, total: 0, estEnd: null, unschedulable: 0, noTime: 0 };
    for (const t of tasks) {
      const v = byKey.get(t.key);
      if (!v.status) continue;
      out.total++;
      if (v.status === 'done') out.done++;
      if (v.gantt.est) out.estEnd = Math.max(out.estEnd ?? -Infinity, v.gantt.est[1]);
      if (v.gantt.unschedulable) out.unschedulable++;
      if (v.gantt.noTime) out.noTime++;
    }
    return out;
  };
  return {
    all: sum(docs.filter((d) => !d.archived).flatMap((d) => d.tasks ?? [])),
    docs: docs.map((d) => ({
      docId: d.docId, ...sum(d.tasks ?? []),
      groups: (d.groups ?? []).map((g) => ({ groupId: g.id, ...sum(d.tasks.filter((t) => t.groupId === g.id)) })),
    })),
  };
}
