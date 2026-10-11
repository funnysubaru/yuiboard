import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTasksDoc } from '../src/docs.mjs';
import { extractRefs, extractBranchRefs, resolveRefs } from '../src/refs.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.tasks.md`, import.meta.url), 'utf8');
const COLLAB = 'collab-m0-space-run';
// 候选是 PlanDoc（design §4）；这里只用到 docId / groups / tasks，parseTasksDoc 的结果补上 docId 即可。
const doc = (docId, text) => ({ docId, ...parseTasksDoc(text, docId) });
const collab = doc(COLLAB, fixture(COLLAB));
// 协作版另一份 spec：也有任务 3 和一个里程碑，用来检验「恰好一处」与 docId / 上下文收窄。
const collabOther = doc('collab-other', '### 里程碑 M1：x\n\n- [ ] 3 另一份文档的 3\n- [ ] 3.1 子任务\n');
const COLLAB_LINE = [collab, collabOther]; // 协作版分支线 docFilter `^collab-` 过滤后的候选
// 个人版：30 个 spec 都有任务 3（design §3.5 验收推演最后一条）。
const PERSONAL = Array.from({ length: 30 }, (_, i) => doc(`personal-${i}`, `## 任务\n\n- [ ] 3 第三步\n- [ ] 4 第四步\n`));

const optsOf = (docs) => ({
  knownDocIds: docs.map((d) => d.docId),
  knownCodes: docs.flatMap((d) => d.groups.map((g) => g.code).filter(Boolean)),
});
const link = (text, docs, ctx) => resolveRefs(extractRefs(text, optsOf(docs)), docs, ctx);
const nums = (keys) => keys.map((k) => k.split('#')[1]);
const groupNums = (d, code) => {
  const g = d.groups.find((x) => x.code === code);
  return d.tasks.filter((t) => t.groupId === g.id).map((t) => t.number);
};

// ---- design §3.5 验收推演（PR 标题为虚构，保留真实标题的识别难点） ----

test('#360 M0-c → 协作版候选内唯一 → 任务 3–10 及子任务', () => {
  const r = link('[V2] feat(collab): M0-c 推送服务 + 部署脚本 + 网页端 + 场景 A 在模拟环境通过 (collab 2.0.4)', COLLAB_LINE);
  assert.deepEqual(r.ambiguous, []);
  assert.deepEqual(r.missing, []);
  const got = nums(r.tasks);
  assert.deepEqual(got, groupNums(collab, 'M0-c'));
  assert.equal(got[0], '3');
  assert.equal(got.at(-1), '10.2');
  assert.ok(got.includes('4.1') && got.includes('8.5'));
  assert.ok(got.every((n) => { const top = Number(n.split('.')[0]); return top >= 3 && top <= 10; }));
});

test('#365 M0-d → 任务 11–12 及子任务', () => {
  const r = link('[V2] feat(collab): M0-d 场景 B + 断线重连用例，修两处缺陷，web 对齐设计稿 (collab 2.0.5)', COLLAB_LINE);
  assert.deepEqual(nums(r.tasks), ['11', '11.1', '11.2', '12', '12.1', '12.2']);
  assert.deepEqual([r.ambiguous, r.missing], [[], []]);
});

test('#344 只认 M0-b：「M0」不是代号，001–010、T1 测试、(1.15.706) 都不认', () => {
  const raw = extractRefs('[V2] feat(collab): 群聊 M0 存储层（M0-b）— 迁移 001–010 + 推送 RPC + T1 测试 (1.15.706)', optsOf(COLLAB_LINE));
  assert.deepEqual(raw.codes, ['M0-b']);
  assert.deepEqual([raw.nums, raw.keys], [[], []]);
  const r = resolveRefs(raw, COLLAB_LINE);
  assert.deepEqual(nums(r.tasks), groupNums(collab, 'M0-b'));
  assert.equal(nums(r.tasks)[0], '2');
});

test('#372 任务 15.2 → 15.2；R2.9 与版本括号不认', () => {
  const raw = extractRefs('[V2] docs+fix(collab): 任务 15.2 使用文档与 design 回写，频道权限收紧、在线状态补全、R2.9 按发送时刻判断 (collab 2.0.7)', optsOf(COLLAB_LINE));
  assert.deepEqual(raw.nums, ['15.2']);
  assert.deepEqual(raw.scopes, ['collab']);
  assert.deepEqual(resolveRefs(raw, COLLAB_LINE).tasks, [`${COLLAB}#15.2`]);
});

test('#369 UI 改进轮没写任务号 / 代号 → 无引用、不按文字猜（任务 18 不关联）', () => {
  const r = link('[V2] feat(collab): 界面打磨——新侧栏、消息菜单、撤回提示 (collab 2.0.6)', COLLAB_LINE);
  assert.deepEqual(r, { tasks: [], ambiguous: [], missing: [] });
});

test('#346 ADR-0042 §8.3、#361 渲染引擎 9.4 → 不认', () => {
  for (const t of [
    'fix(api): config.json 读后写回改为严格解析 + 原子写 (1.15.709) — ADR-0042 §8.3 前置 D 补齐',
    'refactor(plugins): 插件入口 init 改名 setup，为升级渲染引擎 9.4 做准备 (1.15.726)',
  ]) {
    const raw = extractRefs(t, optsOf(PERSONAL));
    assert.deepEqual([raw.keys, raw.nums, raw.codes, raw.docIds], [[], [], [], []], t);
  }
});

test('个人版「任务 3」：30 个 spec 都有 3 → 引用歧义并列出全部候选，不猜', () => {
  const r = link('fix(panel): 任务 3 收尾', PERSONAL);
  assert.deepEqual(r.tasks, []);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].raw, '3');
  assert.equal(r.ambiguous[0].candidates.length, 30);
  assert.equal(r.ambiguous[0].candidates[0], 'personal-0#3');
});

// ---- 识别规则 ----

test('裸数字与版本号一律不认（需求 6.4）', () => {
  const titles = [
    'feat: x (collab 2.0.4)', 'fix(api): y (1.15.743–744)', '升级渲染引擎 9.4', 'ADR-0042 §8.3',
    '同步元数据搬家 3b/4', '迁移 001–010', 'T1 测试', 'ADR-0042 接缝 PR 4', '修 3 个问题', '(1.15.688 + 689)',
  ];
  for (const t of titles) {
    const raw = extractRefs(t, optsOf(COLLAB_LINE));
    assert.deepEqual([raw.keys, raw.nums, raw.codes], [[], [], []], t);
  }
});

test('任务 N / Task N：列表、范围、T 前缀；Task 前紧贴字母不算', () => {
  assert.deepEqual(extractRefs('任务 4.1–4.3、4.5 与 Task 7.1/7.2').nums, ['4.1–4.3', '4.5', '7.1', '7.2']);
  assert.deepEqual(extractRefs('Task: 3；task #2.5b；任务T1').nums, ['3', '2.5b', '1']);
  assert.deepEqual(extractRefs('subtask 3、任务 12abc').nums, []);
  const r = link('任务 4.1–4.3', [collab]);
  assert.deepEqual(nums(r.tasks), ['4.1', '4.2', '4.3']);
});

test('完整任务键（含描述里的 Task: 行）不走收窄，直接按键查；键不存在记 missing', () => {
  const raw = extractRefs('正文\nTask: collab-m0-space-run#15.2\n另见 collab-m0-space-run#99', optsOf(COLLAB_LINE));
  assert.deepEqual(raw.keys, [`${COLLAB}#15.2`, `${COLLAB}#99`]);
  assert.deepEqual(raw.docIds, [COLLAB]);
  assert.deepEqual(raw.nums, [], 'Task: 后接完整键时不再当成带前缀编号');
  const r = resolveRefs(raw, COLLAB_LINE);
  assert.deepEqual(r.tasks, [`${COLLAB}#15.2`]);
  assert.deepEqual(r.missing, [`${COLLAB}#99`]);
});

test('里程碑代号：只认候选里真实存在的，整词、忽略大小写', () => {
  const o = optsOf(COLLAB_LINE);
  assert.deepEqual(extractRefs('m0-c 和 M1 收尾', o).codes, ['M0-c', 'M1']);
  assert.deepEqual(extractRefs('M0-cd、xM0-c、M0-c1、M0-z、M2', o).codes, []);
  assert.deepEqual(extractRefs('M0-c', { knownCodes: [] }).codes, [], '不在 knownCodes 里的不认');
});

test('恰好一处才关联：协作版两份 spec 都有 3 → 歧义；零处 → missing', () => {
  const r = link('[V2] feat(collab): 任务 3、15.9', COLLAB_LINE);
  assert.deepEqual(r.tasks, []);
  assert.deepEqual(r.ambiguous, [{ raw: '3', candidates: [`${COLLAB}#3`, 'collab-other#3'] }]);
  assert.deepEqual(r.missing, ['15.9']);
});

test('代号在多份候选里都有 → 歧义，候选写成 docId#代号', () => {
  const a = doc('spec-a', '### 里程碑 M1：a\n- [ ] 1 x\n');
  const b = doc('spec-b', '### 里程碑 M1：b\n- [ ] 1 y\n');
  const r = link('feat: M1 收尾', [a, b]);
  assert.deepEqual(r.ambiguous, [{ raw: 'M1', candidates: ['spec-a#M1', 'spec-b#M1'] }]);
});

test('docId 收窄：文本写了 docId 只在它里面找；该 docId 不在候选里 → missing，不回退去猜', () => {
  assert.deepEqual(link('collab-other 的任务 3', COLLAB_LINE).tasks, ['collab-other#3']);
  const all = [...COLLAB_LINE, PERSONAL[0]];
  const r = resolveRefs(extractRefs('personal-0 任务 3', optsOf(all)), COLLAB_LINE);
  assert.deepEqual([r.tasks, r.missing], [[], ['3']]);
});

test('scope 收窄：feat(collab) 命中部分 docId 时收窄；命中为空则不收窄', () => {
  const desktop = doc('desktop-chat', '## x\n- [ ] 3 桌面端的 3\n');
  assert.deepEqual(link('feat(collab): 任务 3', [collab, desktop]).tasks, [`${COLLAB}#3`]);
  assert.deepEqual(link('feat(mobile,desktop): 任务 3', [collab, desktop]).tasks, ['desktop-chat#3']);
  const r = link('feat(panel): 任务 3', [collab, desktop]);
  assert.equal(r.ambiguous[0].candidates.length, 2);
});

test('会话上下文 docId 收窄（design §3.8.3）；上下文不在候选里则不收窄', () => {
  assert.deepEqual(link('继续做任务 3', COLLAB_LINE, ['collab-other']).tasks, ['collab-other#3']);
  assert.equal(link('继续做任务 3', COLLAB_LINE, ['personal-0']).ambiguous.length, 1);
  assert.deepEqual(link('collab-m0-space-run 任务 3', COLLAB_LINE, ['collab-other']).tasks, [`${COLLAB}#3`], '消息自带 docId 优先');
});

test('重复编号不参与；代号展开只含未作废、非重复任务', () => {
  const d = doc('dup', '### 里程碑 M1：x\n\n- [ ] 1 a\n- [ ] 1.1 b\n- [x] ~~1.2 作废~~\n- [ ] 2 第一个 2\n- [ ] 2 重复的 2\n');
  assert.deepEqual(link('任务 2', [d]), { tasks: [], ambiguous: [], missing: ['2'] });
  assert.deepEqual(nums(link('M1', [d]).tasks), ['1', '1.1']);
  const other = doc('other', '- [ ] 2 唯一的 2\n');
  assert.deepEqual(link('任务 2', [d, other]).tasks, ['other#2'], '重复的那份不算一处命中');
});

test('spans 给出每处命中的原文与位置，供页面展示依据', () => {
  const text = '[V2] feat(collab): M0-c 与任务 15.2';
  const raw = extractRefs(text, optsOf(COLLAB_LINE));
  assert.deepEqual(raw.spans.map((s) => [s.kind, s.text, text.slice(s.index, s.index + s.text.length)]),
    [['num', '任务 15.2', '任务 15.2'], ['code', 'M0-c', 'M0-c']]);
});

// ---- 分支名 ----

test('分支名：collab-m0d → M0-d；collab-15.2-docs → 15.2；task-3；版本号与 collab-m0 不认', () => {
  const o = optsOf(COLLAB_LINE);
  const m0d = extractBranchRefs('feature/m0d-reconnect', o);
  assert.deepEqual(m0d.codes, ['M0-d']);
  assert.deepEqual(nums(resolveRefs(m0d, COLLAB_LINE).tasks), ['11', '11.1', '11.2', '12', '12.1', '12.2']);
  const docs = extractBranchRefs('feature/chat-15.2-docs', o);
  assert.deepEqual(docs.nums, ['15.2']);
  assert.deepEqual(resolveRefs(docs, COLLAB_LINE).tasks, [`${COLLAB}#15.2`]);
  assert.deepEqual(extractBranchRefs('devboard/task-1.2', o).nums, ['1.2']);
  assert.deepEqual(extractBranchRefs('fix/task_3', o).nums, ['3']);
  for (const b of ['release-2.0.4', 'feature/m0-storage', 'v2/collab', 'feature/adr0042-sync-meta-pr3b-break-glass', 'chore/node-44']) {
    const r = extractBranchRefs(b, o);
    assert.deepEqual([r.nums, r.codes], [[], []], b);
  }
});

test('「（部分）」/「(部分)」标记：修饰整条列表；同段另有完整同号引用就不算部分；随口的「一部分」不认', () => {
  assert.deepEqual(extractRefs('任务 13（部分）、任务 14').partial, ['13']);
  assert.deepEqual(extractRefs('Task 13、14 (部分)').partial, ['13', '14']);
  assert.deepEqual(extractRefs('任务 13（部分）；另见任务 13').partial, []);
  assert.deepEqual(extractRefs('修复任务 13 的一部分').partial, []);
  assert.deepEqual(extractRefs('任务 13（部分）').spans.map((x) => x.text), ['任务 13（部分）'], '依据原文带上标记');
});

test('英文 / 日文 PR 标题：Tasks 3 and 4 / Task 1, 2, and 5 / タスク 3 と 4 / (partial) / （一部）；subtasks 3 不算', () => {
  assert.deepEqual(extractRefs('feat: Tasks 3 and 4').nums, ['3', '4']);
  assert.deepEqual(extractRefs('feat: Task 1, 2, and 5 & 6').nums, ['1', '2', '5', '6']);
  assert.deepEqual(extractRefs('feat: タスク 3 と 4 を実装').nums, ['3', '4']);
  assert.deepEqual(extractRefs('feat: タスク 4.1〜4.3').nums, ['4.1–4.3']);
  assert.deepEqual(extractRefs('fix: Task 13 (partial)').partial, ['13']);
  assert.deepEqual(extractRefs('fix: タスク 13（一部）').partial, ['13']);
  assert.deepEqual(extractRefs('fix: 3 bugs and 4 typos').nums, [], '裸数字仍不认');
  assert.deepEqual(extractRefs('chore: subtasks 3 and 4').nums, []);
  assert.deepEqual(extractRefs('feat: Task 3 android build').nums, ['3'], 'and 后面要是编号、且是整词');
});
