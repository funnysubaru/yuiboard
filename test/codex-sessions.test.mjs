// 会话来源 codex（N10）：起点归属、文件发现、有界读行、人发 / 派活信号、子 agent 归组、增量缓存。
// 夹具全部在临时目录里现造，正文一律虚构；结构仿 2026-10 的真实记录（外层字段顺序 timestamp, ordinal, type, payload）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, utimes, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scan, resolveScanScope, defaultRecordsDir, codex } from '../src/sessions/codex.mjs';

const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-codex-')));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const uid = (n) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// 仿实物的几种记录。
const meta = (id, cwd, ts, extra = {}) => JSON.stringify({ timestamp: ts, ordinal: 0, type: 'session_meta',
  payload: { session_id: id, id, timestamp: ts, ...(cwd ? { cwd } : {}), originator: 'test', cli_version: '0.0.0', source: 'cli', base_instructions: { text: '（虚构）系统说明' }, ...extra } });
const ctx = (ts, ord, cwd) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'turn_context', payload: { turn_id: 't', cwd } });
const userItem = (ts, ord, text) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'event_msg',
  payload: { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } });
const userResp = (ts, ord, ...texts) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) } });
const aiMsg = (ts, ord, text) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const call = (ts, ord, name, args) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'response_item',
  payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'c' } });
const output = (ts, ord, text) => JSON.stringify({ timestamp: ts, ordinal: ord, type: 'response_item',
  payload: { type: 'function_call_output', call_id: 'c', output: text } });
const jsonl = (...lines) => lines.map((l) => `${l}\n`).join('');

// 记录文件：<records>/<YYYY/MM/DD>/rollout-<YYYY-MM-DD>T00-00-00-<id>.jsonl，返回相对记录根的路径。
async function put(records, day, id, text) {
  const rel = `${day}/rollout-${day.replaceAll('/', '-')}T00-00-00-${id}.jsonl`;
  await mkdir(path.join(records, day), { recursive: true });
  await writeFile(path.join(records, rel), text);
  return rel;
}

// 空间：<t>/space（extraCwds）⊃ <t>/space/repo（仓库根）；兄弟目录 repo-other 与 <t>/elsewhere 不属于项目。
async function makeSpace() {
  const t = await tmpDir();
  const space = path.join(t, 'space');
  const repo = path.join(space, 'repo');
  const records = path.join(t, 'records');
  await mkdir(repo, { recursive: true });
  await mkdir(records);
  return { t, space, repo, records, opts: { dir: records, includeRoots: [repo], includeExact: [space] } };
}

test('来源接口：id / label；记录根缺省走 CODEX_HOME 或 ~/.codex', () => {
  assert.equal(codex.id, 'codex');
  assert.equal(codex.label, 'Codex');
  assert.equal(typeof codex.scan, 'function');
  assert.equal(typeof codex.resolveScanScope, 'function');
  assert.equal(defaultRecordsDir({ CODEX_HOME: '/x/codex' }), path.join('/x/codex', 'sessions'));
  assert.equal(defaultRecordsDir({}), path.join(os.homedir(), '.codex', 'sessions'));
});

test('resolveScanScope：记录根用 Codex 的缺省或配置值；工作区 + git worktree + extraCwds 与 Claude 同口径', async () => {
  const t = await tmpDir();
  const repo = path.join(t, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(t, 'wt');
  git(repo, 'worktree', 'add', '-q', wt);
  const s = await resolveScanScope({ extraCwds: ['/x/extra'] }, [repo], { CODEX_HOME: '/x/codex' });
  assert.equal(s.dir, path.join('/x/codex', 'sessions'));
  assert.deepEqual(s.includeRoots.sort(), [repo, wt].sort());
  assert.deepEqual(s.includeExact, ['/x/extra']);
  assert.equal((await resolveScanScope({ dir: '/y/rec' }, [repo], {})).dir, '/y/rec');
});

test('起点归属：仓库根 / extraCwds 精确目录归属；相似前缀、外部目录、精确目录的子目录、后来才进入的都不归属', async () => {
  const { t, space, repo, records, opts } = await makeSpace();
  const ownRoot = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), path.join(repo, 'src'), '2026-10-01T01:00:00.000Z'), ctx('2026-10-01T01:00:01.000Z', 1, repo)));
  await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), space, '2026-10-01T02:00:00.000Z')));
  await put(records, '2026/10/01', uid(3), jsonl(meta(uid(3), path.join(space, 'repo-other'), '2026-10-01T03:00:00.000Z')));
  await put(records, '2026/10/01', uid(4), jsonl(meta(uid(4), path.join(t, 'elsewhere'), '2026-10-01T04:00:00.000Z')));
  await put(records, '2026/10/01', uid(5), jsonl(meta(uid(5), path.join(space, 'notes'), '2026-10-01T05:00:00.000Z')));
  // 起点在外，后来 turn_context 进入仓库：owner 已定首版只看起点
  await put(records, '2026/10/02', uid(6), jsonl(meta(uid(6), path.join(t, 'elsewhere'), '2026-10-02T01:00:00.000Z'), ctx('2026-10-02T01:01:00.000Z', 1, repo)));

  const { sessions, cache, diagnostics } = await scan(opts);
  assert.deepEqual(sessions.map((s) => s.id), [`codex:${uid(1)}`, `codex:${uid(2)}`]);
  const s1 = sessions[0];
  assert.equal(s1.source, 'codex');
  assert.deepEqual(s1.files, [ownRoot]);
  assert.deepEqual(s1.cwds, [path.join(repo, 'src'), repo]);
  assert.deepEqual(s1.branches, []);
  assert.equal(s1.firstAt, '2026-10-01T01:00:00.000Z');
  assert.equal(s1.lastAt, '2026-10-01T01:00:01.000Z');
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.sessions, 2);
  // 未归属文件在缓存里只剩 {own:false}：不留 cwd、ID、时间
  for (const n of [3, 4, 5, 6]) {
    const [rel, f] = Object.entries(cache.files).find(([k]) => k.includes(uid(n)));
    assert.deepEqual(f, { own: false }, rel);
  }
  const text = JSON.stringify(cache);
  assert.ok(!text.includes('elsewhere') && !text.includes('repo-other') && !text.includes('notes'));
});

test('起点 cwd 缺失时取首个 turn_context.cwd；还没写到 turn_context 时下轮再判', async () => {
  const { repo, records, opts } = await makeSpace();
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), null, '2026-10-01T01:00:00.000Z')));
  const r1 = await scan(opts);
  assert.deepEqual(r1.sessions, []);
  assert.equal(r1.cache.files[rel], undefined); // 未判定：不缓存，下轮重读
  await appendFile(path.join(records, rel), jsonl(ctx('2026-10-01T01:00:05.000Z', 1, repo)));
  const r2 = await scan({ ...opts, prev: r1.cache });
  assert.deepEqual(r2.sessions.map((s) => s.id), [`codex:${uid(1)}`]);
});

test('首行不合规：ID 与文件名不符、不是 session_meta、坏 JSON → 不采纳并诊断；首行没写完 → 不诊断，写完后采纳', async () => {
  const { repo, records, opts } = await makeSpace();
  const bad1 = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(9), repo, '2026-10-01T01:00:00.000Z')));
  const bad2 = await put(records, '2026/10/01', uid(2), jsonl(ctx('2026-10-01T01:00:00.000Z', 0, repo)));
  const bad3 = await put(records, '2026/10/01', uid(3), '{"timestamp":\n');
  const half = await put(records, '2026/10/01', uid(4), meta(uid(4), repo, '2026-10-01T04:00:00.000Z').slice(0, 50));
  const r1 = await scan(opts);
  assert.deepEqual(r1.sessions, []);
  assert.deepEqual(r1.diagnostics.unreadableFiles.map((f) => f.file).sort(), [bad1, bad2, bad3].sort());
  assert.equal(r1.cache.files[half], undefined);
  await writeFile(path.join(records, half), jsonl(meta(uid(4), repo, '2026-10-01T04:00:00.000Z')));
  const r2 = await scan({ ...opts, prev: r1.cache });
  assert.deepEqual(r2.sessions.map((s) => s.id), [`codex:${uid(4)}`]);
  // 坏文件的诊断每轮都在（来自缓存）
  assert.deepEqual(r2.diagnostics.unreadableFiles.map((f) => f.file).sort(), [bad1, bad2, bad3].sort());
});

test('只认 YYYY/MM/DD/rollout-*.jsonl 常规文件：符号链接、非日期目录、其它文件名都忽略', async () => {
  const { t, repo, records, opts } = await makeSpace();
  const outside = path.join(t, 'outside.jsonl');
  await writeFile(outside, jsonl(meta(uid(1), repo, '2026-10-01T01:00:00.000Z')));
  await mkdir(path.join(records, '2026/10/01'), { recursive: true });
  await symlink(outside, path.join(records, '2026/10/01', `rollout-2026-10-01T00-00-00-${uid(1)}.jsonl`));
  await symlink(path.join(t, 'space'), path.join(records, '2026/10/02'));
  await mkdir(path.join(records, 'archive/10/01'), { recursive: true });
  await writeFile(path.join(records, 'archive/10/01', `rollout-x-${uid(2)}.jsonl`), jsonl(meta(uid(2), repo, '2026-10-01T01:00:00.000Z')));
  await writeFile(path.join(records, '2026/10/01', `notes-${uid(3)}.jsonl`), jsonl(meta(uid(3), repo, '2026-10-01T01:00:00.000Z')));
  const ok = await put(records, '2026/10/03', uid(4), jsonl(meta(uid(4), repo, '2026-10-03T01:00:00.000Z')));
  const { sessions } = await scan(opts);
  assert.deepEqual(sessions.map((s) => s.files), [[ok]]);
});

test('记录根不存在：来源不可用，不抛错', async () => {
  const { t, opts } = await makeSpace();
  const r = await scan({ ...opts, dir: path.join(t, 'nope') });
  assert.deepEqual(r.sessions, []);
  assert.equal(r.diagnostics.available, false);
  assert.match(r.diagnostics.error, /不存在/);
});

test('时间取记录外层 timestamp：改文件 mtime 不影响；没有合法时间的会话不输出', async () => {
  const { repo, records, opts } = await makeSpace();
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, '2026-10-01T01:00:00.000Z'), aiMsg('2026-10-01T03:00:00.000Z', 1, '（虚构）好的')));
  await utimes(path.join(records, rel), new Date('2030-01-01'), new Date('2030-01-01'));
  await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, 'not-a-time')));
  const { sessions } = await scan(opts);
  assert.deepEqual(sessions.map((s) => [s.id, s.firstAt, s.lastAt]), [[`codex:${uid(1)}`, '2026-10-01T01:00:00.000Z', '2026-10-01T03:00:00.000Z']]);
});

// ---- 信号（任务 2）----

const T = (hhmm) => `2026-10-01T${hhmm}:00.000Z`;
const sigOpts = (opts) => ({ ...opts, knownDocIds: ['demo', 'other'], knownCodes: ['M0-c'] });
const strip = ({ refs, ...rest }) => (refs ? { ...rest, refs: { keys: refs.keys, nums: refs.nums, codes: refs.codes, docIds: refs.docIds } } : rest);
const AGENTS = '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\n（虚构）照 demo 任务 9 做\n</INSTRUCTIONS>';
const ENV = '<environment_context>\n  <cwd>/x</cwd>\n  （虚构）demo 任务 9\n</environment_context>';

// 一个根会话 + 可选子 agent 文件；lines(repo) 返回 meta 之后的行。
async function scanRoot(lines, children = []) {
  const { repo, records, opts } = await makeSpace();
  const file = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('00:59')), ...lines(repo)));
  const kids = [];
  for (const [i, c] of children.entries()) {
    const id = uid(10 + i);
    kids.push(await put(records, '2026/10/01', id, jsonl(meta(id, repo, c.at, { parent_thread_id: c.parent ?? uid(1), ...c.meta }), ...c.lines(repo))));
  }
  const r = await scan(sigOpts(opts));
  return { ...r, s: r.sessions.find((x) => x.id === `codex:${uid(1)}`), file, kids, repo, records, opts };
}

test('人发：只认 UserMessage；response_item 里的 AGENTS / 环境块带任务号也不出信号', async () => {
  const { s, file } = await scanRoot(() => [
    userResp(T('01:00'), 1, AGENTS, ENV, '继续做 demo 任务 2，先补测试'),
    userItem(T('01:00'), 2, '继续做 demo 任务 2，先补测试'),
    output(T('01:05'), 3, '（虚构）测试通过'),
  ]);
  assert.deepEqual(s.signals.map(strip), [{
    kind: 'prompt', at: T('01:00'), file, line: 3,
    refs: { keys: [], nums: ['2'], codes: [], docIds: ['demo'] },
    snippet: '继续做 demo 任务 2，先补测试', until: T('01:05'),
  }]);
  assert.equal(s.title, '继续做 demo 任务 2，先补测试');
  assert.equal(s.lastSummary, '继续做 demo 任务 2，先补测试');
});

test('人发：桌面端上下文只取「## My request:」之后；以 # 开头的普通消息照常识别', async () => {
  const { s } = await scanRoot(() => [
    userItem(T('01:00'), 1, '# Files mentioned by the user:\n\n## tasks.md: /x/.claude/specs/other/tasks.md\n\n## My request:\n做 demo 任务 2'),
    userItem(T('01:10'), 2, '# 标题式开头\n接着做 demo 任务 3'),
  ]);
  assert.deepEqual(s.signals.map((x) => [x.at, x.refs.docIds, x.refs.nums, x.snippet]), [
    [T('01:00'), ['demo'], ['2'], '做 demo 任务 2'],
    [T('01:10'), ['demo'], ['3'], '# 标题式开头 接着做 demo 任务 3'],
  ]);
});

test('人发：自动化心跳、回答 Codex 提问整条不算人发', async () => {
  const { s } = await scanRoot(() => [
    userItem(T('01:00'), 1, '<heartbeat>\n（虚构）定时检查 demo 任务 2\n</heartbeat>'),
    userItem(T('01:10'), 2, '<send_user_message_question_reply>\n选 demo 任务 3\n</send_user_message_question_reply>'),
  ]);
  assert.deepEqual(s.signals, []);
  assert.equal(s.title, null);
});

test('助手公开回复：不出信号，提到任务号只计 aiOnlyMentions；摘要取最后一条消息；reasoning / 工具输出不进摘要', async () => {
  const { s, cache } = await scanRoot(() => [
    userItem(T('01:00'), 1, '看看进度'),
    aiMsg(T('01:01'), 2, '下一步做 demo 任务 4。'),
    JSON.stringify({ timestamp: T('01:02'), ordinal: 3, type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '（虚构）推理哨兵' }] } }),
    aiMsg(T('01:03'), 4, '没有任务号的回复。'),
    output(T('01:04'), 5, '（虚构）工具输出哨兵'),
  ]);
  assert.deepEqual(s.signals, []);
  assert.equal(s.aiOnlyMentions, 1);
  assert.equal(s.lastSummary, '没有任务号的回复。');
  assert.equal(s.lastAt, T('01:04'));
  assert.ok(!JSON.stringify(cache).includes('哨兵'));
});

test('派活：spawn_agent / followup_task 出 dispatch，send_message 不算；缓存里没有完整参数', async () => {
  const long = '（虚构）完整派活说明'.repeat(30);
  const { s, file, cache } = await scanRoot(() => [
    userItem(T('01:00'), 1, '开工'),
    call(T('01:01'), 2, 'spawn_agent', { task_name: 'demo 任务 5', message: `按规则实现。${long}`, agent_type: 'worker' }),
    call(T('01:02'), 3, 'followup_task', { target: 'a', message: '再看一下 demo 任务 6' }),
    call(T('01:03'), 4, 'send_message', { target: 'a', message: 'demo 任务 7 也看' }),
    call(T('01:04'), 5, 'exec', { cmd: 'echo demo 任务 8' }),
  ]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.line, x.refs.nums]), [['dispatch', 3, ['5']], ['dispatch', 4, ['6']]]);
  assert.equal(s.signals[0].file, file);
  for (const x of s.signals) assert.ok([...x.snippet].length <= 60);
  assert.ok(!JSON.stringify(cache).includes('完整派活说明'.repeat(3)));
});

test('子 agent：输入不算人发；它自己派的活算 dispatch；fork 复制的父历史不计时间、不出信号', async () => {
  const { s, kids } = await scanRoot(() => [userItem(T('01:00'), 1, '开工')], [
    { at: T('02:00'), lines: () => [
      userResp(T('02:00'), 1, '（派活原文）做 demo 任务 9'),
      userItem(T('02:00'), 2, '（假设子 agent 也写了 UserMessage）demo 任务 9'),
      call(T('02:10'), 3, 'spawn_agent', { task_name: 'x', message: '嵌套派活 demo 任务 10' }),
    ] },
    { at: T('03:00'), meta: { forked_from_id: uid(1), subagent_history_start_ordinal: 3 }, lines: () => [
      userItem(T('03:00'), 1, '（父历史副本）demo 任务 11'),
      call(T('03:00'), 2, 'spawn_agent', { task_name: 'x', message: '（父历史副本）demo 任务 12' }),
      aiMsg(T('03:20'), 3, '（虚构）子 agent 回复'),
    ] },
  ]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.file, x.refs.nums]), [['dispatch', kids[0], ['10']]]);
  assert.equal(s.lastAt, T('03:20'));
  assert.equal(s.lastSummary, '开工', '子 agent 的回复不进父会话摘要');
});

test('遮蔽：标题、片段、摘要里的令牌被遮；缓存与记录里搜不到令牌原文与大段正文', async () => {
  const token = `ghp_${'fake'.repeat(9)}`;
  const tail = '（虚构）正文结尾哨兵';
  const body = `按 demo 任务 2 接入，令牌是 ${token} ，${'（虚构）很长的正文'.repeat(20)}${tail}`;
  const { s, cache, sessions } = await scanRoot(() => [
    userItem(T('01:00'), 1, body),
    call(T('01:01'), 2, 'spawn_agent', { task_name: `派活 ${token}`, message: `demo 任务 2 ${body}` }),
    aiMsg(T('01:02'), 3, `收到 ${token}，${'（虚构）很长的回复'.repeat(20)}${tail}`),
  ]);
  assert.ok(s.title.includes('‹已遮蔽›') && [...s.title].length <= 60);
  assert.ok(s.lastSummary.startsWith('收到 ‹已遮蔽›') && [...s.lastSummary].length <= 120);
  for (const x of s.signals) assert.ok(x.snippet.includes('‹已遮蔽›') && [...x.snippet].length <= 60, x.kind);
  for (const json of [JSON.stringify(cache), JSON.stringify(sessions)]) {
    assert.ok(!json.includes(token) && !json.includes(tail));
    assert.ok(!json.includes('（虚构）很长的正文'.repeat(7)) && !json.includes('（虚构）很长的回复'.repeat(14)));
  }
});

// ---- 子 agent 归组与增量缓存（任务 3）----

const ids = (r) => r.sessions.map((x) => x.id);

test('归组：根 + 子 agent + 孙 agent 合成一条，文件与时间取并集', async () => {
  const { repo, records, opts } = await makeSpace();
  const root = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:01'), 1, '开工')));
  const kid = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:10'), { parent_thread_id: uid(1) }), call(T('01:20'), 1, 'spawn_agent', { task_name: 'x', message: 'demo 任务 2' })));
  const grand = await put(records, '2026/10/02', uid(3), jsonl(meta(uid(3), path.join(repo, 'sub'), T('01:30'), { parent_thread_id: uid(2) }), aiMsg(T('02:00'), 1, '（虚构）完成')));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(ids(r), [`codex:${uid(1)}`]);
  const s = r.sessions[0];
  assert.deepEqual(s.files, [root, kid, grand]);
  assert.deepEqual([s.firstAt, s.lastAt], [T('01:00'), T('02:00')]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.file, x.until]), [['dispatch', kid, T('02:00')]]);
  assert.deepEqual(s.cwds, [repo, path.join(repo, 'sub')]);
  assert.deepEqual(r.diagnostics.messages, []);
});

test('父会话缺失：子 agent 单独显示并诊断；父文件后到，下一轮并入父会话', async () => {
  const { repo, records, opts } = await makeSpace();
  const kid = await put(records, '2026/10/02', uid(2), jsonl(meta(uid(2), repo, T('02:00'), { parent_thread_id: uid(1) }), call(T('02:10'), 1, 'spawn_agent', { task_name: 'x', message: 'demo 任务 2' })));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(ids(r1), [`codex:${uid(2)}`]);
  assert.deepEqual(r1.diagnostics.messages, [`${kid}：父会话记录不存在，单独显示`]);
  await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00'))));
  const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
  assert.deepEqual(ids(r2), [`codex:${uid(1)}`]);
  assert.equal(r2.sessions[0].signals.length, 1);
  assert.deepEqual(r2.diagnostics.messages, []);
});

test('父会话属外项目或不可读：子 agent 单独显示、不带父的时间与信号，诊断彼此区分', async () => {
  const { t, repo, records, opts } = await makeSpace();
  await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), path.join(t, 'elsewhere'), T('00:00')), userItem(T('00:01'), 1, '外项目的 demo 任务 9')));
  const kidA = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('02:00'), { parent_thread_id: uid(1) })));
  await put(records, '2026/10/01', uid(3), '{坏的首行}\n');
  const kidB = await put(records, '2026/10/01', uid(4), jsonl(meta(uid(4), repo, T('03:00'), { parent_thread_id: uid(3) })));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(ids(r), [`codex:${uid(2)}`, `codex:${uid(4)}`]);
  assert.deepEqual(r.sessions.map((x) => [x.firstAt, x.signals.length]), [[T('02:00'), 0], [T('03:00'), 0]]);
  assert.deepEqual(r.diagnostics.messages.sort(), [`${kidA}：父会话不属于本项目，单独显示`, `${kidB}：父会话记录不可读，单独显示`].sort());
});

test('父子链成环：不合并，各自单独显示并诊断；forked_from_id 不参与归组', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00'), { parent_thread_id: uid(2) })));
  await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('02:00'), { parent_thread_id: uid(1) })));
  await put(records, '2026/10/01', uid(3), jsonl(meta(uid(3), repo, T('03:00'))));
  await put(records, '2026/10/01', uid(4), jsonl(meta(uid(4), repo, T('04:00'), { forked_from_id: uid(3) })));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(ids(r), [1, 2, 3, 4].map((n) => `codex:${uid(n)}`));
  assert.equal(r.diagnostics.messages.filter((m) => m.includes('成环')).length, 2);
});

test('增量：半行留到下轮；未变文件原样沿用；追加只读新增并续上 until', async () => {
  const { repo, records, opts } = await makeSpace();
  const head = jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:01'), 1, '做 demo 任务 2'));
  const half = output(T('01:05'), 2, '（虚构）输出');
  const rel = await put(records, '2026/10/01', uid(1), head + half.slice(0, 20));
  const r1 = await scan(sigOpts(opts));
  assert.equal(r1.sessions[0].lastAt, T('01:01'));
  const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
  assert.deepEqual(r2.cache, r1.cache);
  assert.deepEqual(r2.sessions, r1.sessions);
  await appendFile(path.join(records, rel), `${half.slice(20)}\n${aiMsg(T('01:09'), 3, '（虚构）好')}\n`);
  const r3 = await scan({ ...sigOpts(opts), prev: r2.cache });
  const s = r3.sessions[0];
  assert.equal(s.lastAt, T('01:09'));
  assert.equal(s.signals.length, 1);
  assert.equal(s.signals[0].until, T('01:09'));
  assert.equal(r3.cache.files[rel].lines, 4);
});

test('超长行：跨两轮才写完的超限行整行丢弃、计一次坏行，后面的合法行照常', async () => {
  const { repo, records, opts } = await makeSpace();
  const o = { ...sigOpts(opts), lineMax: 64 };
  const big = output(T('01:02'), 2, 'x'.repeat(200));
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00'))).replace('（虚构）系统说明', '') + big.slice(0, 100));
  const r1 = await scan(o);
  assert.equal(r1.cache.files[rel].skipping, true);
  await appendFile(path.join(records, rel), `${big.slice(100)}\n${userItem(T('01:03'), 3, '做 demo 任务 2')}\n`);
  const r2 = await scan({ ...o, prev: r1.cache });
  const s = r2.sessions[0];
  assert.equal(s.brokenLines, 1);
  assert.deepEqual(r2.diagnostics.brokenLines, [{ file: rel, count: 1 }]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.line]), [['prompt', 3]]);
  assert.equal(s.lastAt, T('01:03'), '被丢弃的超长行不计时间');
});

test('坏 JSON 行计数，其它行与其它会话照常', async () => {
  const { repo, records, opts } = await makeSpace();
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')), '{"timestamp":"x",坏}', 'not json', userItem(T('01:02'), 3, '做 demo 任务 2')));
  await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('02:00'))));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(ids(r), [`codex:${uid(1)}`, `codex:${uid(2)}`]);
  assert.equal(r.sessions[0].brokenLines, 2);
  assert.equal(r.sessions[0].signals.length, 1);
  assert.deepEqual(r.diagnostics.brokenLines, [{ file: rel, count: 2 }]);
});

test('截短重写与换 inode：旧信号清掉、从头读；新子 agent 出现时整组重读', async () => {
  const { repo, records, opts } = await makeSpace();
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:01'), 1, '做 demo 任务 2'), userItem(T('01:02'), 2, '做 demo 任务 3')));
  const r1 = await scan(sigOpts(opts));
  assert.equal(r1.sessions[0].signals.length, 2);
  await writeFile(path.join(records, rel), jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:05'), 1, '改做 demo 任务 4')));
  const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
  assert.deepEqual(r2.sessions[0].signals.map((x) => x.refs.nums), [['4']]);
  await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:06'), { parent_thread_id: uid(1) }), call(T('01:07'), 1, 'spawn_agent', { task_name: 'x', message: 'demo 任务 5' })));
  const r3 = await scan({ ...sigOpts(opts), prev: r2.cache });
  assert.deepEqual(r3.sessions[0].signals.map((x) => x.refs.nums), [['4'], ['5']]);
});

test('scope 变化（文档 / 归属范围）缓存作废；未归属判定只在 scope 不变时沿用', async () => {
  const { t, repo, records, opts } = await makeSpace();
  const other = path.join(t, 'elsewhere');
  await mkdir(other);
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), other, T('01:00')), userItem(T('01:01'), 1, '做 demo 任务 2')));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(r1.cache.files[rel], { own: false });
  const r2 = await scan({ ...sigOpts(opts), includeRoots: [repo, other], prev: r1.cache });
  assert.deepEqual(ids(r2), [`codex:${uid(1)}`]);
  const r3 = await scan({ ...sigOpts(opts), includeRoots: [repo, other], knownDocIds: ['other'], prev: r2.cache });
  assert.deepEqual(r3.sessions[0].signals[0].refs.docIds, [], 'demo 不再是已知文档，按新口径重新提取');
});

test('续段文件 rollout-…-<会话 ID>_<段 ID>.jsonl：并入同一会话，里面的人发消息照常出信号', async () => {
  const { repo, records, opts } = await makeSpace();
  const base = await put(records, '2026/09/13', uid(1), jsonl(meta(uid(1), repo, '2026-09-13T01:00:00.000Z'), userItem('2026-09-13T01:01:00.000Z', 1, '开工')));
  const segRel = `2026/09/28/rollout-2026-09-28T00-00-00-${uid(1)}_${uid(7)}.jsonl`;
  await mkdir(path.join(records, '2026/09/28'), { recursive: true });
  await writeFile(path.join(records, segRel), jsonl(
    meta(uid(1), repo, '2026-09-28T01:00:00.000Z', { history_base: { thread_id: uid(7), end_ordinal_exclusive: 2, end_byte_offset: 10 } }),
    userItem('2026-09-28T01:05:00.000Z', 3, '接着做 demo 任务 2')));
  const kid = await put(records, '2026/09/28', uid(2), jsonl(meta(uid(2), repo, '2026-09-28T02:00:00.000Z', { parent_thread_id: uid(1) })));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(ids(r), [`codex:${uid(1)}`]);
  const s = r.sessions[0];
  assert.deepEqual(s.files, [base, segRel, kid]);
  assert.equal(s.lastAt, '2026-09-28T02:00:00.000Z');
  assert.deepEqual(s.signals.map((x) => [x.kind, x.file, x.refs.nums]), [['prompt', segRel, ['2']]]);
  assert.equal(s.title, '开工');
});

// ---- PR #14 review ----

test('嵌套派活：子 agent 文件里的派活按时间切分焦点段，父文件之后的记录归到新焦点（until 不留在旧任务上）', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')),
    userItem(T('01:01'), 1, '做 demo 任务 1'),
    call(T('01:10'), 2, 'spawn_agent', { task_name: 'x', message: 'demo 任务 2' }),
    aiMsg(T('01:40'), 3, '（虚构）父会话还在说话')));
  const kid = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:15'), { parent_thread_id: uid(1) }),
    call(T('01:20'), 1, 'spawn_agent', { task_name: 'y', message: 'demo 任务 3' }),
    aiMsg(T('01:25'), 2, '（虚构）子 agent 结束')));
  const { sessions } = await scan(sigOpts(opts));
  assert.deepEqual(sessions[0].signals.map((x) => [x.refs.nums[0], x.at, x.until]), [
    ['1', T('01:01'), T('01:01')],
    ['2', T('01:10'), T('01:15')],
    ['3', T('01:20'), T('01:40')],
  ]);
  assert.equal(sessions[0].signals[2].file, kid);
});

test('嵌套派活：增量追加时各文件的新记录同样按时间归到焦点段', async () => {
  const { repo, records, opts } = await makeSpace();
  const root = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:01'), 1, '做 demo 任务 1')));
  const kid = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:02'), { parent_thread_id: uid(1) })));
  const r1 = await scan(sigOpts(opts));
  await appendFile(path.join(records, root), jsonl(aiMsg(T('01:30'), 2, '（虚构）父会话')));
  await appendFile(path.join(records, kid), jsonl(call(T('01:20'), 1, 'spawn_agent', { task_name: 'y', message: 'demo 任务 3' })));
  const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
  assert.deepEqual(r2.sessions[0].signals.map((x) => [x.refs.nums[0], x.until]), [['1', T('01:02')], ['3', T('01:30')]]);
});

test('同一会话 ID 的两份主文件：只取路径靠前的一份，其余忽略并诊断', async () => {
  const { repo, records, opts } = await makeSpace();
  const a = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00'))));
  const dupRel = `2026/10/02/rollout-2026-10-02T09-00-00-${uid(1)}.jsonl`;
  await mkdir(path.join(records, '2026/10/02'), { recursive: true });
  await writeFile(path.join(records, dupRel), jsonl(meta(uid(1), repo, T('05:00')), userItem(T('05:01'), 1, '做 demo 任务 2')));
  const r = await scan(sigOpts(opts));
  assert.deepEqual(r.sessions.map((x) => [x.id, x.files]), [[`codex:${uid(1)}`, [a]]]);
  assert.deepEqual(r.diagnostics.messages, [`${dupRel}：会话 ID 与 ${a} 重复，已忽略`]);
});

test('文件名只认 rollout-<时刻>-<UUID>[_<UUID>]：中段是任意文字的文件不读，诊断里不会出现任意文字；系统错误文本先遮蔽', async () => {
  const { t, repo, records, opts } = await makeSpace();
  const token = `ghp_${'fake'.repeat(9)}`;
  await mkdir(path.join(records, '2026/10/01'), { recursive: true });
  await writeFile(path.join(records, '2026/10/01', `rollout-${token}-${uid(2)}.jsonl`), jsonl(meta(uid(2), repo, T('01:00'), { parent_thread_id: uid(1) })));
  const r = await scan(sigOpts(opts));
  assert.deepEqual([r.sessions, r.diagnostics.messages], [[], []]);
  const gone = await scan({ ...sigOpts(opts), dir: path.join(t, `nope-${token}`) });
  assert.ok(!gone.diagnostics.error.includes(token) && gone.diagnostics.error.includes('‹已遮蔽›'));
});

test('缓存 scope 绑定记录根：换了记录根，旧的未归属判定不沿用', async () => {
  const { t, repo, records, opts } = await makeSpace();
  const rel = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), path.join(t, 'elsewhere'), T('01:00'))));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(r1.cache.files[rel], { own: false });
  const other = path.join(t, 'records2');
  await put(other, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00'))));
  const r2 = await scan({ ...sigOpts(opts), dir: other, prev: r1.cache });
  assert.deepEqual(ids(r2), [`codex:${uid(1)}`]);
});

test('跨轮晚到的嵌套派活：新信号早于已读到的最晚记录时整组重读，焦点段照时间切开', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')),
    call(T('01:10'), 1, 'spawn_agent', { task_name: 'x', message: 'demo 任务 2' }),
    aiMsg(T('01:40'), 2, '（虚构）父会话还在说话')));
  const kid = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:15'), { parent_thread_id: uid(1) })));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(r1.sessions[0].signals.map((x) => [x.refs.nums[0], x.until]), [['2', T('01:40')]]);
  await appendFile(path.join(records, kid), jsonl(call(T('01:20'), 1, 'spawn_agent', { task_name: 'y', message: 'demo 任务 3' }), aiMsg(T('01:25'), 2, '（虚构）子 agent 结束')));
  const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
  assert.deepEqual(r2.sessions[0].signals.map((x) => [x.refs.nums[0], x.until]), [['2', T('01:15')], ['3', T('01:40')]]);
  assert.equal(r2.cache.files[kid].lines, 3, '重读后行号不重复累计');
});

test('跨轮晚到但不产生信号的记录（助手回复、工具输出）只做增量，不整组重读', async () => {
  const { repo, records, opts } = await makeSpace();
  const root = await put(records, '2026/10/01', uid(1), jsonl(meta(uid(1), repo, T('01:00')), userItem(T('01:01'), 1, '做 demo 任务 1'), aiMsg(T('01:40'), 2, '（虚构）')));
  const kid = await put(records, '2026/10/01', uid(2), jsonl(meta(uid(2), repo, T('01:15'), { parent_thread_id: uid(1) })));
  const r1 = await scan(sigOpts(opts));
  await appendFile(path.join(records, kid), jsonl(aiMsg(T('01:20'), 1, '（虚构）晚到的回复'), call(T('01:21'), 2, 'spawn_agent', { task_name: 'z', message: '没有任务号' })));
  // 根文件没变：只做增量就不会再打开它。设成不可读，若整组重读会报读取失败
  await chmod(path.join(records, root), 0o000);
  try {
    const r2 = await scan({ ...sigOpts(opts), prev: r1.cache });
    assert.deepEqual(r2.diagnostics.unreadableFiles, []);
    assert.deepEqual(r2.sessions[0].signals.map((x) => x.until), [T('01:40')]);
    assert.equal(r2.cache.files[kid].lines, 3);
  } finally {
    await chmod(path.join(records, root), 0o644);
  }
});
