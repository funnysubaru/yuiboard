// 会话来源 claude-code（任务 5.1）：归属、粗筛、增量读、坏行、子 agent、标题来源。
// 夹具全部在临时目录里现造：目录名依赖临时路径；正文一律虚构，结构仿真实记录（字段名与顺序同实物）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, readdir, stat, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scan, resolveScanScope, defaultRecordsDir, claudeCode } from '../src/sessions/claude-code.mjs';
import { linkSessions } from '../src/engine.mjs';
import { parseTasksDoc } from '../src/parse.mjs';
import { focusOf } from '../hooks/model.mjs';

const tmpDir = async () => realpathSync(await mkdtemp(path.join(os.tmpdir(), 'devboard-sessions-')));
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

// 仿实物的几种记录。顶层字段顺序同实物：message / attachment 在前，timestamp、cwd 在后。
const user = (cwd, timestamp, text = '（虚构）请继续') =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: 'u', timestamp, userType: 'external', cwd, sessionId: 's', version: '2.0.0', gitBranch: 'main' });
const assistant = (cwd, timestamp) =>
  JSON.stringify({ parentUuid: 'u', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: '（虚构）好的' }] }, type: 'assistant', uuid: 'a', timestamp, cwd, sessionId: 's', gitBranch: 'main' });
const customTitle = (t) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' });
const agentName = (n) => JSON.stringify({ type: 'agent-name', agentName: n, sessionId: 's' });
const jsonl = (...lines) => lines.map((l) => `${l}\n`).join('');

async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
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

async function snapshot(dir) {
  const out = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    const st = await stat(p);
    out.push(`${p} ${st.size} ${st.mtimeMs}`);
  }
  return out.sort();
}

test('来源接口：id / label；记录根缺省走 CLAUDE_CONFIG_DIR 或 ~/.claude', () => {
  assert.equal(claudeCode.id, 'claude-code');
  assert.equal(claudeCode.label, 'Claude Code');
  assert.equal(typeof claudeCode.scan, 'function');
  assert.equal(defaultRecordsDir({ CLAUDE_CONFIG_DIR: '/x/cfg' }), path.join('/x/cfg', 'projects'));
  assert.equal(defaultRecordsDir({}), path.join(os.homedir(), '.claude', 'projects'));
});

test('归属：目录名粗筛 + 记录里的 cwd 精确确认；repo-other 前缀误中被排除；不中的目录不打开', async () => {
  const { t, space, repo, records, opts } = await makeSpace();
  // 仓库根目录里起的会话，中途 cd 到子目录；带子 agent。
  const own = path.join(records, enc(repo));
  await put(path.join(own, 's-own.jsonl'), jsonl(user(repo, '2026-09-20T01:00:00.000Z'), assistant(path.join(repo, 'src'), '2026-09-20T01:05:00.000Z')));
  await put(path.join(own, 's-own', 'subagents', 'agent-a1.jsonl'), jsonl(user(repo, '2026-09-20T02:00:00.000Z'), customTitle('子 agent 的标题不算')));
  await put(path.join(own, 's-own', 'subagents', 'agent-a1.meta.json'), '{"agentType":"x"}');
  await put(path.join(own, 's-own', 'tool-results', 'r.txt'), '（虚构）工具输出');
  // extraCwds 精确目录里起的会话（目录名大小写不同也认）。
  const exactDir = path.join(records, enc(space).toUpperCase());
  await put(path.join(exactDir, 's-exact.jsonl'), jsonl(user(space, '2026-09-21T01:00:00.000Z')));
  // ⑧ 同一精确目录里、但首个 cwd 是 space 下别的目录，也从未进入仓库 → 不属于项目。
  await put(path.join(exactDir, 's-foreign.jsonl'), jsonl(customTitle('（虚构）别人的会话'), user(path.join(space, 'notes'), '2026-09-21T03:00:00.000Z')));
  // 兄弟目录 repo-other：目录名以 enc(repo)+'-' 开头会被粗筛误中，cwd 确认后排除。
  const other = path.join(space, 'repo-other');
  await put(path.join(records, enc(other), 's-other.jsonl'), jsonl(user(other, '2026-09-22T01:00:00.000Z')));
  // 目录名不中：即使里面记录声称 cwd 在仓库里，也不打开。
  await put(path.join(records, enc(path.join(t, 'elsewhere')), 's-skip.jsonl'), jsonl(user(repo, '2026-09-23T01:00:00.000Z')));

  const before = await snapshot(records);
  const { sessions, cache, diagnostics } = await scan(opts);
  assert.deepEqual(sessions.map((s) => s.id), ['s-exact', 's-own']);
  assert.deepEqual(await snapshot(records), before, '扫描不改动会话目录');

  const s = sessions.find((x) => x.id === 's-own');
  assert.equal(s.source, 'claude-code');
  assert.deepEqual(s.files, [`${enc(repo)}/s-own.jsonl`, `${enc(repo)}/s-own/subagents/agent-a1.jsonl`]);
  assert.deepEqual(s.cwds, [repo, path.join(repo, 'src')]);
  assert.equal(s.firstAt, '2026-09-20T01:00:00.000Z');
  assert.equal(s.lastAt, '2026-09-20T02:00:00.000Z', '子 agent 的记录按时间并入父会话');
  assert.equal(s.title, '（虚构）请继续', '子 agent 文件里的 custom-title 不当父会话标题，兜底用首条人发消息');
  assert.equal(s.brokenLines, 0);

  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.sessions, 2);
  assert.deepEqual(diagnostics.unreadableFiles, []);

  // ⑧ / repo-other：缓存里只有文件偏移，不含 cwd、时间、标题。
  const text = JSON.stringify(cache);
  for (const leak of ['notes', 'repo-other"', '别人的会话', '2026-09-21T03', '2026-09-22T01', 'elsewhere']) {
    assert.ok(!text.includes(leak), `缓存不应含 ${leak}`);
  }
});

test('⑧ 未归属会话后来 cd 进仓库：变为本项目会话，并从头补读之前的时间', async () => {
  const { space, repo, records, opts } = await makeSpace();
  const file = path.join(records, enc(space), 's-late.jsonl');
  await put(file, jsonl(customTitle('（虚构）后来才进仓库'), user(path.join(space, 'notes'), '2026-09-21T01:00:00.000Z')));
  const r1 = await scan(opts);
  assert.deepEqual(r1.sessions, []);
  assert.ok(!JSON.stringify(r1.cache).includes('后来才进仓库'));

  await appendFile(file, jsonl(user(repo, '2026-09-21T02:00:00.000Z')));
  const r2 = await scan({ ...opts, prev: r1.cache });
  assert.equal(r2.sessions.length, 1);
  assert.equal(r2.sessions[0].firstAt, '2026-09-21T01:00:00.000Z');
  assert.equal(r2.sessions[0].title, '（虚构）后来才进仓库');
});

test('⑦ 坏行：跳过并计数、诊断列出文件，其余行照常', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(path.join(records, enc(repo), 's-bad.jsonl'), [
    user(repo, '2026-09-20T01:00:00.000Z'),
    '{"type":"user","message":{"role":"user","content":"（虚构）写到一半',
    'not json at all',
    '{"type":"custom-title",,}',
    '',
    user(repo, '2026-09-20T03:00:00.000Z'),
  ].join('\n') + '\n');
  const { sessions, diagnostics } = await scan(opts);
  assert.equal(sessions[0].brokenLines, 3);
  assert.equal(sessions[0].lastAt, '2026-09-20T03:00:00.000Z');
  assert.equal(sessions[0].title, '（虚构）请继续');
  assert.deepEqual(diagnostics.brokenLines, [{ file: `${enc(repo)}/s-bad.jsonl`, count: 3 }]);
});

test('标题来源：最后一条 custom-title → agent-name → custom-title.json → 首条人发消息；截 60 字', async () => {
  const { repo, records, opts } = await makeSpace();
  const dir = path.join(records, enc(repo));
  const ts = '2026-09-20T01:00:00.000Z';
  await put(path.join(dir, 't1.jsonl'), jsonl(customTitle('旧标题'), user(repo, ts), agentName('代理名'), customTitle('新标题')));
  await put(path.join(dir, 't1', 'custom-title.json'), '{"customTitle":"文件标题"}');
  await put(path.join(dir, 't2.jsonl'), jsonl(agentName('代理名'), user(repo, ts)));
  await put(path.join(dir, 't2', 'custom-title.json'), '{"customTitle":"文件标题"}');
  await put(path.join(dir, 't3.jsonl'), jsonl(user(repo, ts)));
  await put(path.join(dir, 't3', 'custom-title.json'), '{"customTitle":"文件标题"}');
  await put(path.join(dir, 't4.jsonl'), jsonl(customTitle('长'.repeat(70)), user(repo, ts)));
  await put(path.join(dir, 't5.jsonl'), jsonl(user(repo, ts)));
  const { sessions } = await scan(opts);
  assert.deepEqual(sessions.map((s) => s.title), ['新标题', '代理名', '文件标题', '长'.repeat(60), '（虚构）请继续']);
});

test('⑨ 增量读：只读新增部分、半行留到下次；截短重写与换 inode 整个重读；没变原样沿用', async () => {
  const { repo, records, opts } = await makeSpace();
  const file = path.join(records, enc(repo), 's-inc.jsonl');
  const first = user(repo, '2026-09-20T01:00:00.000Z');
  await put(file, jsonl(first));
  const r1 = await scan(opts);
  assert.equal(r1.sessions[0].lastAt, '2026-09-20T01:00:00.000Z');

  // 没变：同一份缓存状态直接沿用。
  const r1b = await scan({ ...opts, prev: r1.cache });
  assert.deepEqual(r1b.sessions, r1.sessions);

  // 把已读过的第一行原地改成乱码（同长度）后再追加：增量读从偏移开始，不会重读到乱码。
  const fh = await open(file, 'r+');
  await fh.write('x'.repeat(Buffer.byteLength(first)), 0);
  await fh.close();
  const half = user(repo, '2026-09-20T03:00:00.000Z');
  await appendFile(file, `${user(repo, '2026-09-20T02:00:00.000Z')}\n${half.slice(0, 40)}`);
  const r2 = await scan({ ...opts, prev: r1.cache });
  assert.equal(r2.sessions[0].brokenLines, 0, '偏移之前的内容没有被重读');
  assert.equal(r2.sessions[0].lastAt, '2026-09-20T02:00:00.000Z', '半行不读');
  const f2 = r2.cache.sessions[`${enc(repo)}/s-inc`].files[`${enc(repo)}/s-inc.jsonl`];
  assert.equal(f2.offset, (await stat(file)).size - 40, '偏移停在最后一个换行之后');
  assert.equal(f2.lines, 2);

  // 半行补全 → 下次读到。
  await appendFile(file, `${half.slice(40)}\n`);
  const r3 = await scan({ ...opts, prev: r2.cache });
  assert.equal(r3.sessions[0].lastAt, '2026-09-20T03:00:00.000Z');

  // 截短重写：之前累积的首末时间作废。
  await writeFile(file, jsonl(user(repo, '2026-09-25T01:00:00.000Z')));
  const r4 = await scan({ ...opts, prev: r3.cache });
  assert.equal(r4.sessions[0].firstAt, '2026-09-25T01:00:00.000Z');
  assert.equal(r4.sessions[0].lastAt, '2026-09-25T01:00:00.000Z');

  // 换 inode（写新文件再 rename 覆盖），即使变大也整个重读：更早的 firstAt 被新内容取代。
  const tmp = `${file}.new`;
  await writeFile(tmp, jsonl(user(repo, '2026-09-26T01:00:00.000Z'), user(repo, '2026-09-26T02:00:00.000Z'), user(repo, '2026-09-26T03:00:00.000Z')));
  await rename(tmp, file);
  const r5 = await scan({ ...opts, prev: r4.cache });
  assert.equal(r5.sessions[0].firstAt, '2026-09-26T01:00:00.000Z');
  assert.equal(r5.sessions[0].lastAt, '2026-09-26T03:00:00.000Z');
});

test('超长行跨读块、多字节字符不被切坏；CRLF 行照常', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(path.join(records, enc(repo), 's-big.jsonl'),
    `${user(repo, '2026-09-20T01:00:00.000Z', '中'.repeat(600_000))}\r\n${user(repo, '2026-09-20T02:00:00.000Z')}\r\n`);
  const { sessions } = await scan(opts);
  assert.equal(sessions[0].brokenLines, 0);
  assert.equal(sessions[0].lastAt, '2026-09-20T02:00:00.000Z');
});

test('会话目录不存在：来源不可用，不抛错', async () => {
  const { t, repo } = await makeSpace();
  const r = await scan({ dir: path.join(t, 'nope'), includeRoots: [repo], includeExact: [] });
  assert.deepEqual(r.sessions, []);
  assert.equal(r.diagnostics.available, false);
  assert.match(r.diagnostics.error, /会话目录不存在/);
});

test('resolveScanScope：工作区 + git worktree list（仓库外也算）+ extraCwds；非 git 目录记诊断', async () => {
  const t = await tmpDir();
  const repo = path.join(t, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(t, '工作树');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat');
  const plain = path.join(t, 'plain');
  await mkdir(plain);

  const scope = await resolveScanScope({ extraCwds: [t] }, [repo, plain], { CLAUDE_CONFIG_DIR: path.join(t, 'cfg') });
  assert.deepEqual(scope.includeRoots.sort(), [repo, plain, wt.normalize('NFC')].sort());
  assert.deepEqual(scope.includeExact, [t]);
  assert.equal(scope.dir, path.join(t, 'cfg', 'projects'));
  assert.equal(scope.diagnostics.length, 1);
  assert.match(scope.diagnostics[0].message, /plain/);

  assert.equal((await resolveScanScope({ dir: '/x/records' }, [])).dir, '/x/records');
});

// ---- 任务 5.2：信号提取与遮蔽。夹具 ①–⑥、⑩（正文一律虚构）。----

import { MASKED } from '../src/mask.mjs';

const REPO_GH = 'acme/widgets';
const DOCS = [
  { docId: 'collab-m0-space-run', path: '.claude/specs/collab-m0-space-run/tasks.md', sourceType: 'spec-dir', kind: 'tasks' },
  { docId: 'collab-m0', path: '.claude/specs/collab-m0', sourceType: 'spec-dir', kind: 'planning' },
  { docId: 'devboard-mvp', path: '.claude/specs/devboard-mvp/tasks.md', sourceType: 'spec-dir', kind: 'tasks' },
  { docId: 'docs/plan', path: 'docs/plan.md', sourceType: 'task-list', kind: 'tasks' },
];
const sigOpts = (opts) => ({ ...opts, knownDocIds: DOCS.map((d) => d.docId), knownCodes: ['M0-c'], docs: DOCS, repo: REPO_GH });

// 人发消息（实物字段：origin.kind = human）；extra 覆盖字段做反例。gitBranch 只在 ⑥ 里带，免得分支信号混进其它用例。
const human = (cwd, timestamp, content, extra = {}) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content }, uuid: 'u', timestamp, permissionMode: 'default', origin: { kind: 'human' }, userType: 'external', cwd, sessionId: 's', version: '2.0.0', ...extra });
const ai = (cwd, timestamp, blocks, extra = {}) =>
  JSON.stringify({ parentUuid: 'u', isSidechain: false, message: { role: 'assistant', content: blocks }, type: 'assistant', uuid: 'a', timestamp, cwd, sessionId: 's', ...extra });
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', id: 'toolu_x', name, input });
const toolResult = (cwd, timestamp, out) =>
  JSON.stringify({ parentUuid: 'a', isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_x', type: 'tool_result', content: out }] }, uuid: 'r', timestamp, cwd, sessionId: 's' });
const prLink = (timestamp, repo, n) => JSON.stringify({ type: 'pr-link', sessionId: 's', prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp });
const T = (hhmm) => `2026-09-20T${hhmm}:00.000Z`;

async function scanOne(lines, extraFiles = {}, rawFiles = {}) {
  const { repo, records, opts } = await makeSpace();
  const dir = path.join(records, enc(repo));
  await put(path.join(dir, 's1.jsonl'), jsonl(...lines(repo)));
  for (const [rel, ls] of Object.entries(extraFiles)) await put(path.join(dir, 's1', rel), jsonl(...ls(repo)));
  for (const [rel, text] of Object.entries(rawFiles)) await put(path.join(dir, 's1', rel), text);
  const r = await scan(sigOpts(opts));
  return { ...r, s: r.sessions[0], file: `${enc(repo)}/s1.jsonl`, repo, records, opts, dir };
}
const strip = ({ refs, ...rest }) => (refs ? { ...rest, refs: { keys: refs.keys, nums: refs.nums, codes: refs.codes, docIds: refs.docIds } } : rest);

test('① 人发消息点名文档与任务 → prompt 信号（位置、片段）；之后的 git commit 不产生信号，其时间计入 until', async () => {
  const { s, file } = await scanOne((repo) => [
    human(repo, T('01:00'), '继续做 collab-m0-space-run 的任务 2.5b，先把测试补上'),
    ai(repo, T('01:05'), [text('好的，先跑测试。'), tool('Bash', { command: 'git commit -m "（虚构）补测试"', description: '提交' })]),
    toolResult(repo, T('01:06'), '[main abc1234]（虚构）补测试'),
  ]);
  assert.deepEqual(s.signals.map(strip), [{
    kind: 'prompt', at: T('01:00'), file, line: 1,
    refs: { keys: [], nums: ['2.5b'], codes: [], docIds: ['collab-m0-space-run'] },
    snippet: '继续做 collab-m0-space-run 的任务 2.5b，先把测试补上', until: T('01:06'),
  }]);
  assert.equal(s.title, '继续做 collab-m0-space-run 的任务 2.5b，先把测试补上', '无标题记录时用首条人发消息');
  assert.equal(s.lastSummary, '好的，先跑测试。', '最后消息摘要取人发消息与 AI 文字中较晚者');
  assert.equal(s.aiOnlyMentions, 0);
});

test('② 只说「任务 3 先做」：prompt 信号只有编号、没有 docId（歧义由 engine 判定）', async () => {
  const { s } = await scanOne((repo) => [human(repo, T('01:00'), '任务 3 先做')]);
  assert.equal(s.signals.length, 1);
  assert.deepEqual(strip(s.signals[0]).refs, { keys: [], nums: ['3'], codes: [], docIds: [] });
});

test('③ 只在 AI 回复里提到任务 13：不产生信号，只计 aiOnlyMentions', async () => {
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '看看现在进度怎么样'),
    ai(repo, T('01:01'), [text('进度正常，下一步任务 13。')]),
    ai(repo, T('01:02'), [text('另外 devboard-mvp#4.1 也可以开始了。')]),
    ai(repo, T('01:03'), [text('没有任务号的回复不计。')]),
  ]);
  assert.deepEqual(s.signals, []);
  assert.equal(s.aiOnlyMentions, 2);
  assert.equal(s.lastSummary, '没有任务号的回复不计。');
});

test('④ 长会话多焦点：不带引用的「继续」不产生信号；每条信号的 until 截到下一条信号之前；增量追加后续上', async () => {
  const { s, repo, opts, dir, cache } = await scanOne((repo) => [
    human(repo, T('01:00'), '做 devboard-mvp 的任务 3.2'),
    ai(repo, T('01:10'), [text('（虚构）改好了')]),
    human(repo, T('02:00'), '继续'),
    ai(repo, T('02:30'), [text('（虚构）又改了一处')]),
    human(repo, T('09:00'), '换 devboard-mvp 的任务 4.1'),
    ai(repo, T('09:20'), [text('（虚构）开始')]),
  ]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.refs.nums, x.at, x.until, x.line]), [
    ['prompt', ['3.2'], T('01:00'), T('02:30'), 1],
    ['prompt', ['4.1'], T('09:00'), T('09:20'), 5],
  ]);
  await appendFile(path.join(dir, 's1.jsonl'), jsonl(ai(repo, T('09:40'), [text('（虚构）还在做')]), human(repo, T('10:00'), '回到任务 3.2')));
  const r2 = await scan(sigOpts({ ...opts, prev: cache }));
  assert.deepEqual(r2.sessions[0].signals.map((x) => [x.refs.nums, x.until, x.line]), [
    [['3.2'], T('02:30'), 1], [['4.1'], T('09:40'), 5], [['3.2'], T('10:00'), 8],
  ]);
});

test('⑤ 子 agent：派活 → dispatch；子 agent 文件里的派活原文不算人发消息；子 agent 改任务行 → edit（只算改过的行）+ touch', async () => {
  const tasksAbs = (repo) => path.join(repo, '.claude/specs/devboard-mvp/tasks.md');
  const { s, file } = await scanOne((repo) => [
    human(repo, T('01:00'), '开工'),
    ai(repo, T('01:01'), [tool('Agent', { description: '任务 5.2 信号提取', prompt: 'feature_name: devboard-mvp；（虚构）按规则实现', subagent_type: 'spec-impl' })]),
  ], {
    'subagents/agent-x1.jsonl': (repo) => [
      human(repo, T('01:02'), '（派活原文）任务 9.9 也顺便看看', { isSidechain: true, origin: undefined }),
      ai(repo, T('01:10'), [tool('Edit', { file_path: tasksAbs(repo), old_string: '- [ ] 5.2 会话信号\n- [ ] 5.3 会话关联', new_string: '- [~] 5.2 会话信号\n- [ ] 5.3 会话关联' })], { isSidechain: true }),
      ai(repo, T('01:20'), [tool('MultiEdit', { file_path: tasksAbs(repo), edits: [{ old_string: '- [ ] 5.4 调度', new_string: '- [x] 5.4 调度\n  - 补一行说明' }] })], { isSidechain: true }),
      ai(repo, T('01:30'), [tool('Write', { file_path: tasksAbs(repo), content: '- [ ] 1.1 整份重写\n- [ ] 1.2 不算改任务行' })], { isSidechain: true }),
    ],
  });
  const sub = file.replace('s1.jsonl', 's1/subagents/agent-x1.jsonl');
  assert.deepEqual(s.signals.map((x) => strip({ ...x, until: undefined })), [
    { kind: 'dispatch', at: T('01:01'), file, line: 2, refs: { keys: [], nums: ['5.2'], codes: [], docIds: ['devboard-mvp'] }, snippet: '任务 5.2 信号提取 feature_name: devboard-mvp；（虚构）按规则实现', toolUseId: 'toolu_x', until: undefined },
    { kind: 'touch', at: T('01:10'), file: sub, line: 2, docPath: '.claude/specs/devboard-mvp/tasks.md', until: undefined },
    { kind: 'edit', at: T('01:10'), file: sub, line: 2, docPath: '.claude/specs/devboard-mvp/tasks.md', taskNums: ['5.2'], until: undefined },
    { kind: 'edit', at: T('01:20'), file: sub, line: 3, docPath: '.claude/specs/devboard-mvp/tasks.md', taskNums: ['5.4'], until: undefined },
  ]);
  assert.equal(s.signals[0].until, T('01:02'), '子 agent 文件的记录按时间并入 until');
  assert.equal(s.signals.at(-1).until, T('01:30'));
});

test('子 agent 各算各的：meta.json 对上派活的 toolUseId → agent 信号与 lane；它的记录只续自己这一路，不续主线', async () => {
  const tasksAbs = (repo) => path.join(repo, '.claude/specs/devboard-mvp/tasks.md');
  const agentTool = (id, description) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: '（虚构）', subagent_type: 'x' } });
  const { s, repo, dir, opts, cache } = await scanOne((repo) => [
    human(repo, T('01:00'), '做 devboard-mvp 的任务 3.2'),
    ai(repo, T('01:01'), [agentTool('toolu_a', 'devboard-mvp 任务 5.2'), agentTool('toolu_b', 'devboard-mvp 任务 5.3')]),
    ai(repo, T('01:05'), [text('（虚构）等它们')]),
  ], {
    'subagents/agent-a.jsonl': (repo) => [
      human(repo, T('01:02'), '（派活原文）', { isSidechain: true }),
      ai(repo, T('01:40'), [tool('Edit', { file_path: tasksAbs(repo), old_string: '- [ ] 5.2 会话信号', new_string: '- [x] 5.2 会话信号' })], { isSidechain: true }),
      ai(repo, T('01:50'), [text('（虚构）做完了')], { isSidechain: true }),
    ],
    'subagents/agent-b.jsonl': (repo) => [ai(repo, T('01:03'), [text('（虚构）开始')], { isSidechain: true }), ai(repo, T('02:30'), [text('（虚构）还在做')], { isSidechain: true })],
    'subagents/agent-c.jsonl': (repo) => [ai(repo, T('01:04'), [text('（虚构）没有 meta 的子 agent')], { isSidechain: true })],
  }, {
    'subagents/agent-a.meta.json': '{"agentType":"x","toolUseId":"toolu_a"}',
    'subagents/agent-b.meta.json': '{"agentType":"x","toolUseId":"toolu_b"}',
  });
  assert.deepEqual(s.signals.map((x) => [x.kind, x.at, x.until, x.lane ?? null, x.toolUseId ?? null]), [
    ['prompt', T('01:00'), T('01:00'), null, null],
    ['dispatch', T('01:01'), T('01:01'), null, 'toolu_a'],
    ['dispatch', T('01:01'), T('01:05'), null, 'toolu_b'], // 主线的记录续主线最近一条；没有 meta 的 agent-c（01:04）仍并入主线
    ['agent', T('01:02'), T('01:02'), 'toolu_a', null],
    ['agent', T('01:03'), T('02:30'), 'toolu_b', null],
    ['touch', T('01:40'), T('01:40'), 'toolu_a', null],
    ['edit', T('01:40'), T('01:50'), 'toolu_a', null],
  ]);
  // 增量追加：主线的新记录续主线，子 agent 的新记录续它自己
  await appendFile(path.join(dir, 's1.jsonl'), jsonl(ai(repo, T('03:00'), [text('（虚构）主线')])));
  await appendFile(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), jsonl(ai(repo, T('03:10'), [text('（虚构）补一句')], { isSidechain: true })));
  const s2 = (await scan(sigOpts({ ...opts, prev: cache }))).sessions[0];
  assert.deepEqual(s2.signals.filter((x) => x.kind !== 'touch').map((x) => [x.kind, x.lane ?? null, x.until]), [
    ['prompt', null, T('01:00')], ['dispatch', null, T('01:01')], ['dispatch', null, T('03:00')],
    ['agent', 'toolu_a', T('01:02')], ['agent', 'toolu_b', T('02:30')], ['edit', 'toolu_a', T('03:10')],
  ]);
});

test('子 agent 各算各的：没写任务的派活也留下（带 toolUseId、不带片段）；子 agent 的分支信号带 lane，与主线各记各的首次', async () => {
  const agentTool = (id, description) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: '（虚构）', subagent_type: 'x' } });
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '做 devboard-mvp 的任务 3.2', { gitBranch: 'feat' }),
    ai(repo, T('01:01'), [agentTool('toolu_d', '找一下相关代码')], { gitBranch: 'feat' }),
  ], {
    'subagents/agent-d.jsonl': (repo) => [
      ai(repo, T('01:02'), [text('（虚构）开始')], { isSidechain: true, gitBranch: 'feat' }),
      ai(repo, T('01:30'), [text('（虚构）换到独立 worktree')], { isSidechain: true, gitBranch: 'child-wt' }),
    ],
  }, { 'subagents/agent-d.meta.json': '{"toolUseId":"toolu_d"}' });
  assert.deepEqual(s.signals.map((x) => [x.kind, x.branch ?? null, x.lane ?? null, x.toolUseId ?? null, 'snippet' in x]), [
    ['prompt', null, null, null, true],
    ['branch', 'feat', null, null, false],
    ['dispatch', null, null, 'toolu_d', false],
    ['agent', null, 'toolu_d', null, false],
    ['branch', 'feat', 'toolu_d', null, false], // 主线记过 feat，子 agent 这一路照样记自己的首次
    ['branch', 'child-wt', 'toolu_d', null, false],
  ]);
  assert.deepEqual(s.branches, ['feat', 'child-wt']);
});

test('N29 扫描到引擎：同一条用户记录先点名任务、又带上 PR 分支时，点名的任务不被分支清掉；之后的记录才接管（PR #51 review）', async () => {
  const doc = { docId: 'devboard-mvp', path: '.claude/specs/devboard-mvp/tasks.md', archived: false,
    ...parseTasksDoc('- [ ] 2 甲\n- [ ] 3 乙\n- [ ] 4 丙\n', 'devboard-mvp') };
  const prs = [{ number: 9, headRefName: 'feat-c' }, { number: 10, headRefName: 'feat-d' }];
  const prInfo = new Map([[9, { tasks: ['devboard-mvp#3'] }], [10, { tasks: ['devboard-mvp#4'] }]]);
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '做 devboard-mvp 的任务 2', { gitBranch: 'feat-c' }), // 同一条记录：prompt 在前、分支在后
    ai(repo, T('01:20'), [text('（虚构）继续')], { gitBranch: 'feat-c' }),
    ai(repo, T('01:30'), [text('（虚构）切走')], { gitBranch: 'feat-d' }), // 另一条记录切到 PR #10 的分支：这时才接管
    ai(repo, T('01:40'), [text('（虚构）继续')], { gitBranch: 'feat-d' }),
  ]);
  const last = Object.fromEntries(linkSessions([doc], [s], prs, prInfo, {}).links.map((l) => [l.taskKey.split('#')[1], l.lastAt]));
  assert.deepEqual(last, { 2: T('01:20'), 3: T('01:20'), 4: T('01:40') });
});

test('N32 command：主线与子 agent 的提交、起 PR、建分支命令里的任务号 → command 信号（子 agent 的带 lane）；没写任务号的不出信号', async () => {
  const bash = (command) => tool('Bash', { command });
  const { s, file } = await scanOne((repo) => [
    human(repo, T('01:00'), '（虚构）继续'),
    ai(repo, T('01:01'), [bash('git worktree add -b feat/m0c-x ../wt'), bash(`git -C ../wt commit -m "$(cat <<'EOF'\nfeat: devboard-mvp#3 甲\nEOF\n)"`)]),
    ai(repo, T('01:02'), [bash('git commit -m "（虚构）补测试"'), bash('gh pr create --title "fix: 任务 4" --body x')]),
  ], {
    'subagents/agent-a.jsonl': (repo) => [ai(repo, T('01:03'), [bash('git commit -m "fix: 任务 5"')], { isSidechain: true })],
  }, { 'subagents/agent-a.meta.json': '{"toolUseId":"toolu_a"}' });
  assert.deepEqual(s.signals.filter((x) => x.kind === 'command').map((x) => [x.at, x.file === file, x.lane ?? null, x.snippet, strip(x).refs]), [
    [T('01:01'), true, null, 'feat/m0c-x', { keys: [], nums: [], codes: ['M0-c'], docIds: [] }],
    [T('01:01'), true, null, 'feat: devboard-mvp#3 甲', { keys: ['devboard-mvp#3'], nums: [], codes: [], docIds: ['devboard-mvp'] }],
    [T('01:02'), true, null, 'fix: 任务 4', { keys: [], nums: ['4'], codes: [], docIds: [] }],
    [T('01:03'), false, 'toolu_a', 'fix: 任务 5', { keys: [], nums: ['5'], codes: [], docIds: [] }],
  ]);
});

test('N32 扫描到引擎：AI 提交写了任务号就接管主线焦点；早先点名的任务不再续活动，evidenceAt 记最近一次直接证据', async () => {
  const doc = { docId: 'devboard-mvp', path: '.claude/specs/devboard-mvp/tasks.md', archived: false,
    ...parseTasksDoc('- [ ] 2 甲\n- [ ] 3 乙\n', 'devboard-mvp') };
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '做 devboard-mvp 的任务 2'),
    ai(repo, T('01:30'), [tool('Bash', { command: 'git commit -m "feat: devboard-mvp#3 乙"' })]),
    ai(repo, T('02:00'), [text('（虚构）继续')]),
    ai(repo, T('02:10'), [tool('Bash', { command: 'git commit -m "fix: other-repo 的任务 99"' })]), // 对不上：不清焦点
    ai(repo, T('02:20'), [text('（虚构）继续')]),
  ]);
  const { links, conflicts } = linkSessions([doc], [s], [], new Map(), {});
  assert.deepEqual(links.map((l) => [l.taskKey, l.lastAt, l.evidenceAt]), [
    ['devboard-mvp#2', T('01:00'), T('01:00')],
    ['devboard-mvp#3', T('02:20'), T('01:30')],
  ]);
  assert.deepEqual(links[1].evidence.map((e) => [e.kind, e.note]), [['command', 'AI 执行的命令：「feat: devboard-mvp#3 乙」']]);
  assert.deepEqual(conflicts, [], '命令里对不上的任务号不报冲突');
});

test('N32 扫描到面板：一条命令里先提交、后起 PR，后续活动归最后那个动作的任务（PR #54 review）', async () => {
  const doc = { docId: 'devboard-mvp', path: '.claude/specs/devboard-mvp/tasks.md', archived: false,
    ...parseTasksDoc('- [ ] 2 甲\n- [ ] 3 乙\n', 'devboard-mvp') };
  for (const [command, last] of [
    ['git commit -m "fix: devboard-mvp#2 甲" && gh pr create --title "feat: devboard-mvp#3 乙" --body x', '3'],
    ['gh pr create --title "feat: devboard-mvp#3 乙" --body x && git commit -m "fix: devboard-mvp#2 甲"', '2'],
  ]) {
    const { s } = await scanOne((repo) => [
      human(repo, T('01:00'), '（虚构）开始'),
      ai(repo, T('01:30'), [tool('Bash', { command })]),
      ai(repo, T('01:40'), [text('（虚构）继续')]),
    ]);
    const { links } = linkSessions([doc], [s], [], new Map(), {});
    const lastAt = Object.fromEntries(links.map((l) => [l.taskKey.split('#')[1], l.lastAt]));
    assert.equal(lastAt[last], T('01:40'), command);
    assert.equal(lastAt[last === '2' ? '3' : '2'], T('01:30'), command);
    const summary = { docs: [{ ...doc, tasks: doc.tasks.map((t) => ({ ...t, docId: 'devboard-mvp' })) }],
      tasks: links.map((l) => ({ key: l.taskKey, status: 'in_progress', sessions: [{ ...l, activity: 'running' }] })) };
    assert.equal(focusOf(summary, s.id).keys[0], `devboard-mvp#${last}`, command);
  }
});

test('touch：Edit / Write 路径与 Bash 命令里的规划文档目录；整词匹配、每份文档只记第一次', async () => {
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '看一下'),
    ai(repo, T('01:01'), [tool('Bash', { command: 'ls .claude/specs/collab-m0-space-run/ && cat docs/plan.md.bak' })]),
    ai(repo, T('01:02'), [tool('Bash', { command: 'cat /x/wt/feat/.claude/specs/collab-m0/design.md' })]),
    ai(repo, T('01:03'), [tool('Read', { file_path: path.join(repo, 'docs/plan.md') })]),
    ai(repo, T('01:04'), [tool('Write', { file_path: path.join(repo, 'docs/plan.md'), content: '- [ ] 1 新任务' })]),
    ai(repo, T('01:05'), [tool('Edit', { file_path: path.join(repo, '.claude/specs/collab-m0-space-run/design.md'), old_string: 'a', new_string: '- [ ] 7 像任务行' })]),
  ]);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.docPath, x.at]), [
    ['touch', '.claude/specs/collab-m0-space-run/tasks.md', T('01:01')],
    ['touch', '.claude/specs/collab-m0', T('01:02')],
    ['touch', 'docs/plan.md', T('01:04')],
  ], 'docs/plan.md.bak 不算；Read 不算；Write 只算 touch；改 spec 目录里的非 tasks.md 不算 edit');
});

test('⑥ pr-link 只认本项目仓库、同一 PR 记一次；gitBranch 记首次出现、丢弃 HEAD', async () => {
  const { s, file } = await scanOne((repo) => [
    human(repo, T('01:00'), '开始', { gitBranch: 'HEAD' }),
    ai(repo, T('01:01'), [text('（虚构）好')], { gitBranch: 'collab-15.2-docs' }),
    prLink(T('01:02'), 'ACME/widgets', 372),
    prLink(T('01:03'), 'other/repo', 12),
    prLink(T('01:04'), REPO_GH, 372),
    JSON.stringify({ type: 'system', subtype: 'x', timestamp: T('01:05'), cwd: repo, gitBranch: 'main' }),
    ai(repo, T('01:06'), [text('（虚构）好')], { gitBranch: 'collab-15.2-docs' }),
  ]);
  assert.deepEqual(s.branches, ['collab-15.2-docs', 'main']);
  assert.deepEqual(s.signals.map((x) => [x.kind, x.branch ?? x.pr, x.at, x.line]), [
    ['branch', 'collab-15.2-docs', T('01:01'), 2],
    ['pr-link', 372, T('01:02'), 3],
    ['branch', 'main', T('01:05'), 6],
  ]);
  assert.ok(s.signals.every((x) => x.file === file));
});

test('人发消息判定：isMeta、压缩摘要、任务通知、子 agent 回报、工具结果都不算；去掉 system-reminder，斜杠命令保留参数', async () => {
  const { s } = await scanOne((repo) => [
    human(repo, T('01:00'), '<command-message>kfc:spec</command-message>\n<command-name>/kfc:spec</command-name>\n<command-args>做任务 1.1</command-args>'),
    human(repo, T('01:01'), '<system-reminder>（虚构）任务 2.2 的提醒</system-reminder>就这样'),
    human(repo, T('01:02'), '任务 3.3 的元信息', { isMeta: true }),
    human(repo, T('01:03'), '（虚构）上文摘要：任务 4.4', { isCompactSummary: true, origin: undefined }),
    human(repo, T('01:04'), '<task-notification>任务 5.5 完成</task-notification>', { origin: { kind: 'task-notification' } }),
    human(repo, T('01:05'), '（虚构）回报：任务 6.6', { origin: { kind: 'peer' } }),
    human(repo, T('01:06'), [text('图里是任务 7.7'), { type: 'image', source: { type: 'base64', data: 'AAAA' } }]),
    toolResult(repo, T('01:07'), '（虚构）输出提到任务 8.8'),
    human(repo, T('01:08'), '<local-command-stdout>任务 9.9</local-command-stdout>', { origin: undefined }),
  ]);
  assert.deepEqual(s.signals.map((x) => x.refs.nums), [['1.1'], ['7.7']]);
  assert.equal(s.title, 'kfc:spec /kfc:spec 做任务 1.1');
});

test('⑩ 假令牌遮蔽；缓存与会话记录（即 Board 里的会话）的序列化结果里搜不到正文与令牌原文', async () => {
  const token = `ghp_${'fake'.repeat(9)}`;
  const tail = '（虚构）这是正文结尾的哨兵句';
  const body = `按任务 2.5b 接入，令牌是 ${token} ，${'（虚构）很长的正文'.repeat(20)}${tail}`;
  const { s, cache, sessions } = await scanOne((repo) => [
    human(repo, T('01:00'), body),
    ai(repo, T('01:01'), [text(`收到 ${token}，${'（虚构）很长的回复'.repeat(20)}${tail}`), tool('Agent', { description: `派活 ${token}`, prompt: `任务 2.5b ${body}` })]),
  ]);
  assert.ok(s.title.includes(MASKED) && [...s.title].length <= 60);
  assert.ok(s.lastSummary.startsWith(`收到 ${MASKED}`) && [...s.lastSummary].length <= 120);
  for (const sig of s.signals) assert.ok(sig.snippet.includes(MASKED) && [...sig.snippet].length <= 60, sig.kind);
  const board = sessions.map(({ signals, ...rest }) => rest);
  for (const [name, json] of [['cache', JSON.stringify(cache)], ['sessions', JSON.stringify(sessions)], ['board', JSON.stringify(board)]]) {
    assert.ok(!json.includes(token), `${name} 含令牌原文`);
    assert.ok(!json.includes(tail), `${name} 含正文`);
    // 片段上限 60 字、摘要 120 字：比上限长的连续正文不可能出现。
    assert.ok(!json.includes('（虚构）很长的正文'.repeat(7)), `${name} 含大段人发消息正文`);
    assert.ok(!json.includes('（虚构）很长的回复'.repeat(14)), `${name} 含大段 AI 回复正文`);
  }
});

test('标题记录里的令牌也遮蔽；其它项目的会话不提取信号，后来 cd 进仓库再从头补齐', async () => {
  const { space, repo, records, opts } = await makeSpace();
  await put(path.join(records, enc(repo), 't.jsonl'), jsonl(customTitle(`标题 ghp_${'fake'.repeat(9)}`), human(repo, T('01:00'), '任务 1.1')));
  const file = path.join(records, enc(space), 'late.jsonl');
  await put(file, jsonl(human(path.join(space, 'notes'), T('02:00'), '先看任务 2.2')));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(r1.sessions.map((x) => [x.id, x.title]), [['t', `标题 ${MASKED}`]]);
  // 查带引号的 "2.2"（信号里的编号是字符串）：裸 2.2 会偶然撞上 mtimeMs 小数（如 1790000000012.2345），曾导致偶发失败。
  assert.ok(!JSON.stringify(r1.cache).includes('"2.2"') && !JSON.stringify(r1.cache).includes('先看任务'));
  await appendFile(file, jsonl(human(repo, T('03:00'), '再做任务 3.3')));
  const r2 = await scan(sigOpts({ ...opts, prev: r1.cache }));
  assert.deepEqual(r2.sessions.find((x) => x.id === 'late').signals.map((x) => x.refs.nums), [['2.2'], ['3.3']]);
});

test('文档 / 代号 / 仓库变了：缓存作废，旧消息按新口径重新提取', async () => {
  const { repo, records, opts } = await makeSpace();
  await put(path.join(records, enc(repo), 'c.jsonl'), jsonl(human(repo, T('01:00'), '把 M0-d 收尾')));
  const r1 = await scan(sigOpts(opts));
  assert.deepEqual(r1.sessions[0].signals, [], 'M0-d 还不是已知代号');
  const r2 = await scan({ ...sigOpts(opts), knownCodes: ['M0-c', 'M0-d'], prev: r1.cache });
  assert.deepEqual(r2.sessions[0].signals.map((x) => x.refs.codes), [['M0-d']]);
});
