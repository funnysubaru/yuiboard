// N27：约定摘要注入（需求 1）与写入拦截（需求 2）。替身同 poll.test.ts：http.fetch 回虚构的 devboard，
// $.state 由测试钩子代答，时钟用 kit 的 mock。文件用 .ts：用例名是中文，hooks/*.tsx 不得含中日文字符（N25 需求 8.3）。
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const URL = 'http://127.0.0.1:4317'
const PARSE_OK = { state: 'ok', unrecognizedLines: [], unknownRelations: [], unknownEstimates: [], diagnostics: [], mermaidUsed: false }
const SUMMARY = JSON.stringify({
  projectId: 'p1', freshness: { github: {} }, degraded: {}, stats: { docs: [] },
  workspaces: [{ id: 'repo', path: '/w/one' }],
  sessions: [{ id: 'S1', source: 'claude', title: 'S1' }],
  docs: [{ docId: 'a', title: 'A', kind: 'tasks', parse: PARSE_OK, archived: false, groups: [], tasks: [
    { key: 'a#1', number: '1', title: 'one', checkbox: false, void: false, docId: 'a', groupId: null, parentKey: null },
  ] }],
  tasks: [], conflicts: [], prs: [],
})
const PROJECTS = JSON.stringify({
  errors: [], warnings: [],
  projects: [{ id: 'p1', name: 'One', docSources: [{ type: 'spec-dir', path: '.claude/specs', files: [] }], excluded: [] }],
})

// 被看仓库里的文件（$.fs.read / exists 由测试代答）；ran 记下真正跑到底的工具调用
const OLD = '# A\n\n- [ ] 1 one\n- [-] 2 旧问题\n'
function world(on: On, id = 'S1', files: Record<string, string | null> = { '/w/one/.claude/specs/a/tasks.md': OLD }, cwd = '/elsewhere') {
  const clock = mock.clock(on)
  const w = { clock, ran: [] as string[], reads: [] as string[], offline: false }
  // 目录也算存在（files 里有以它开头的路径）；list 给出直接子项
  on('fs.exists', ($, e) => ({ value: Object.hasOwn(files, e.path) || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => {
    const kids = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(`${e.path}/`)) continue
      const rest = f.slice(e.path.length + 1)
      kids.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...kids].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    w.reads.push(e.path)
    // null：文件在，但读不了（权限、超过 4 MiB）
    const text = files[e.path]
    if (text === undefined || text === null) throw new Error('EACCES')
    return { value: text }
  })
  on('tool.call', ($, e) => {
    w.ran.push(e.tool)
    return { result: {} as never }
  })
  const state = new Map<string, unknown>()
  on('state.get', ($, e) => ({ value: { value: state.get(e.key), version: 0 } }))
  on('state.set', ($, e) => {
    state.set(e.key, e.value)
    return { value: { isSet: true, version: 0 } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: cwd }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'yuiboard' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', ($, e) => {
    if (w.offline) return { deny: 'connect ECONNREFUSED 127.0.0.1:4317' }
    const path = e.url.slice(URL.length)
    const text = path === '/api/projects' ? PROJECTS : path === '/api/projects/p1/summary' ? SUMMARY : null
    return { value: text === null ? { status: 404, ok: false, headers: {}, text: '{}' } : { status: 200, ok: true, headers: {}, text } }
  })
  // 引擎自己的系统提示：一段 shared
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  return w
}

// 组提示的事实：测试里读不到会话的模型与工具，照引擎的形状给一份
const COMPOSE = { model: 'claude-test', promptModel: 'claude-test', surfaces: [], tools: [], outputStyle: null, traits: [] }

async function start($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/elsewhere', surface: null, isInteractive: true })
  await w.clock.settle()
}
const brief = async ($: Engine) => (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'yuiboard:convention')

test('认出项目后在系统提示末尾加约定摘要（session 一侧），写明项目名、任务文档与完整约定的位置', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const s = await brief($)
  expect(s?.scope).toBe('session')
  expect(s?.text).toContain('One')
  expect(s?.text).toContain('.claude/specs/*/tasks.md')
  expect(s?.text).toContain('/CONVENTION.zh-CN.md')
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.id).toBe('yuiboard:convention')
})

test('认不出项目时不加', async ($, on) => {
  const w = world(on, 'S9')
  await start($, w)
  expect(await brief($)).toBeUndefined()
})

test('guard 为 off 时不加', { options: { guard: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await brief($)).toBeUndefined()
})

// ---- 写入拦截（需求 2） ----
const SPEC = '/w/one/.claude/specs/a/tasks.md'
/** 工具调用的结果：被拦时 isError 且 text 是拦截说明 */
const call = async ($: Engine, input: Record<string, unknown>) => {
  const r = (await $.tool.call(input as never)) as { deny?: string; isError?: boolean; text?: string }
  return r.deny ?? (r.isError ? r.text : undefined)
}

test('Write 任务文档带进不合约定的写法：拦下，说明哪一行、原文与建议；工具没跑', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const denied = await call($, { tool: 'Write', file_path: SPEC, content: `${OLD}### 任务 3：标题式\n` })
  expect(denied).toContain('第 5 行「### 任务 3：标题式」')
  expect(denied).toContain('- [ ] 3 标题式')
  expect(w.ran).toEqual([])
})

test('原有问题不拦：Write 保留旧问题、Edit 改别处都放行；新文件按空原文比', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await call($, { tool: 'Write', file_path: SPEC, content: `${OLD}- [ ] 3 three\n` })).toBeUndefined()
  expect(await call($, { tool: 'Edit', file_path: SPEC, old_string: '1 one', new_string: '1 uno' })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: '/w/one/.claude/specs/b/tasks.md', content: '- [ ] 1 x\n' })).toBeUndefined()
  expect(w.ran).toEqual(['Write', 'Edit', 'Write'])
})

test('Edit 带进问题：按读到的原文算出写后全文再查，拦下', async ($, on) => {
  const w = world(on)
  await start($, w)
  const denied = await call($, { tool: 'Edit', file_path: SPEC, old_string: '- [ ] 1 one', new_string: '- [ ] task 1 one' })
  expect(denied).toContain('YUIBoard')
  expect(w.reads).toEqual([SPEC])
  expect(w.ran).toEqual([])
})

test('不是任务文档、Edit 对不上原文、读文件出错：都放行', async ($, on) => {
  const w = world(on, 'S1', { [SPEC]: OLD, '/w/one/.claude/specs/c/tasks.md': null })
  await start($, w)
  expect(await call($, { tool: 'Write', file_path: '/w/one/.claude/specs/a/design.md', content: '- [-] 1 x\n' })).toBeUndefined()
  expect(await call($, { tool: 'Edit', file_path: SPEC, old_string: 'nope', new_string: '- [-] 1 x' })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: '/w/one/.claude/specs/c/tasks.md', content: '- [-] 1 x\n' })).toBeUndefined()
  expect(w.ran).toEqual(['Write', 'Edit', 'Write'])
})

test('gh pr create / edit 的标题认不了：拦下；认得出、没有引用、读不出的放行', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const denied = await call($, { tool: 'Bash', command: 'gh pr create --draft --title "fix: 任务 99" --body x' })
  expect(denied).toContain('PR 标题「fix: 任务 99」')
  expect(denied).toContain('不存在的任务：99')
  for (const command of ['gh pr create --title "fix: 任务 1"', 'gh pr edit 3 -t "chore: 同步 main"', 'gh pr create --title "$T"', 'ls']) {
    expect(await call($, { tool: 'Bash', command })).toBeUndefined()
  }
  expect(w.ran.length).toBe(4)
})

test('认不出项目、guard 为 off：一律放行', { options: { guard: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await call($, { tool: 'Write', file_path: SPEC, content: '- [-] 9 x\n' })).toBeUndefined()
  expect(await call($, { tool: 'Bash', command: 'gh pr create -t "任务 99"' })).toBeUndefined()
  expect(w.ran).toEqual(['Write', 'Bash'])
})

test('认不出项目时放行', async ($, on) => {
  const w = world(on, 'S9')
  await start($, w)
  expect(await call($, { tool: 'Write', file_path: SPEC, content: '- [-] 9 x\n' })).toBeUndefined()
  expect(w.ran).toEqual(['Write'])
})

// ---- N35：提交标题、新建分支名、派活说明 ----
const REPO = { [SPEC]: OLD, '/w/one/.git': null, '/other/.git': null, ...{} }
const agent = (prompt: string) => ({ tool: 'Agent', description: 'x', prompt })

test('本仓库的 git commit、新建分支写明的文档名对不上：拦下；裸数字放行并提示，结果里带 context', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on, 'S1', REPO, '/w/one/src')
  await start($, w)
  expect(await call($, { tool: 'Bash', command: 'git commit -m "feat: a#99"' })).toContain('不存在的任务：a#99')
  expect(await call($, { tool: 'Bash', command: 'git switch -c fix/x && git commit -m "feat: a#99"' })).toContain('a#99')
  expect(w.ran).toEqual([])
  const r = (await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: 任务 99"' } as never)) as { deny?: string; context?: string[] }
  expect(r.deny).toBeUndefined()
  expect(r.context?.[0]).toContain('任务 99')
  expect(((await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: a#1"' } as never)) as { context?: string[] }).context).toBeUndefined()
  expect(w.ran).toEqual(['Bash', 'Bash'])
})

test('别的仓库里的、判断不了在哪的命令不拦；git -C、cd 进本仓库与它的 worktree 算本仓库', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on, 'S1', { ...WT_FILES_N35, '/other/.git': null }, '/other')
  await start($, w)
  for (const command of ['git commit -m "a#99"', 'cd ~/x && git commit -m "a#99"', 'git -C "$D" commit -m "a#99"']) {
    expect(await call($, { tool: 'Bash', command })).toBeUndefined()
  }
  expect(await call($, { tool: 'Bash', command: 'git -C /w/one commit -m "a#99"' })).toContain('a#99')
  expect(await call($, { tool: 'Bash', command: 'cd /wt/n35 && git commit -m "a#99"' })).toContain('a#99')
  expect(await call($, { tool: 'Bash', command: 'cd /wt/n35 && git commit -m "a#7"' })).toBeUndefined()
  // 管道左边的 cd 不改后面的目录：提交还在 /other（PR #60 review）
  expect(await call($, { tool: 'Bash', command: 'cd /w/one | cat; git commit -m "a#99"' })).toBeUndefined()
})

test('Git 路径变量指到别的仓库：同一次 Bash 里 export 过的提交不按本仓库查', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on, 'S1', REPO, '/w/one/src')
  await start($, w)
  expect(await call($, { tool: 'Bash', command: 'export GIT_DIR=/other/.git GIT_WORK_TREE=/other; git commit -m "a#99"' })).toBeUndefined()
  expect(await call($, { tool: 'Bash', command: 'git commit -m "a#99"' })).toContain('a#99')
})

test('派活说明：写明的对不上才拦，行内代码、别的项目的编号放行，裸数字只提示', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(await call($, agent('实现 a#99'))).toContain('派活说明')
  expect(await call($, agent('参考 ``a#99`` 的写法\n\n~~~\na#99\n~~~\n\n    a#99'))).toBeUndefined()
  for (const prompt of ['实现 a#1', '修 other-vendor#127', '别写成 `a#99`', '没有任务号']) expect(await call($, agent(prompt))).toBeUndefined()
  const r = (await $.tool.call(agent('做任务 99') as never)) as { context?: string[] }
  expect(r.context?.[0]).toContain('任务 99')
  expect(w.ran.length).toBe(6)
})

test('派活的 description 与 prompt 各算各的 Markdown：prompt 开头的缩进代码不查，跨字段的反引号不配对', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const tool of ['Agent', 'Task']) {
    expect(await call($, { tool, description: '分析日志', prompt: '    a#99\n\n请分析以上日志。' })).toBeUndefined()
  }
  expect(await call($, { tool: 'Agent', description: '修 `x', prompt: '实现 a#99 `' })).toContain('派活说明')
  expect(await call($, { tool: 'Agent', description: '实现 a#99', prompt: '没有任务号' })).toContain('派活说明')
  expect(w.ran.length).toBe(2)
})

test('guard 为 off、服务断线：提交与派活一律放行', { options: { guard: 'off' } }, async ($, on) => {
  const w = world(on, 'S1', REPO, '/w/one')
  await start($, w)
  expect(await call($, { tool: 'Bash', command: 'git commit -m "a#99"' })).toBeUndefined()
  expect(await call($, agent('实现 a#99'))).toBeUndefined()
})

test('服务断线：提交与派活放行', async ($, on) => {
  const w = world(on, 'S1', REPO, '/w/one')
  await start($, w)
  w.offline = true
  await w.clock.advance(5000)
  expect(await call($, { tool: 'Bash', command: 'git commit -m "a#99"' })).toBeUndefined()
  expect(await call($, agent('实现 a#99'))).toBeUndefined()
  expect(w.ran).toEqual(['Bash', 'Agent'])
})

// ---- worktree（PR review）：owner 多在工作区的 git worktree 里开发 ----
const WT_FILES_N35 = {
  [SPEC]: OLD,
  '/w/one/.git': null,
  '/wt/n35/.git': 'gitdir: /w/one/.git/worktrees/n35\n',
  '/wt/n35/.claude/specs/a/tasks.md': `${OLD}- [ ] 7 seven\n`,
}
const WT = '/wt/feature'
const WT_FILES = {
  [SPEC]: OLD,
  [`${WT}/.git`]: 'gitdir: /w/one/.git/worktrees/feature\n',
  // 分支上给文档 a 加了任务 7（工作区与摘要里还没有），PR 标题会引用它
  [`${WT}/.claude/specs/a/tasks.md`]: `${OLD}- [ ] 7 seven\n`,
}

test('worktree 里的任务文档同样拦；别的仓库（.git 是目录或指向别处）不管', async ($, on) => {
  const w = world(on, 'S1', { ...WT_FILES, '/other/.git': null, '/x/.git': 'gitdir: /elsewhere/.git/worktrees/y\n' })
  await start($, w)
  expect(await call($, { tool: 'Write', file_path: `${WT}/.claude/specs/a/tasks.md`, content: `${OLD}- [ ] 7 seven\n- [-] 9 x\n` })).toContain('YUIBoard')
  expect(await call($, { tool: 'Write', file_path: '/other/.claude/specs/a/tasks.md', content: '- [-] 9 x\n' })).toBeUndefined()
  expect(await call($, { tool: 'Write', file_path: '/x/.claude/specs/a/tasks.md', content: '- [-] 9 x\n' })).toBeUndefined()
  expect(w.ran).toEqual(['Write', 'Write'])
})

test('PR 标题引用只在当前 worktree 里有的任务：按当前检出的文档重查，放行；两边都没有的照样拦', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on, 'S1', WT_FILES, `${WT}/src`)
  await start($, w)
  expect(await call($, { tool: 'Bash', command: 'gh pr create -t "feat: 任务 7"' })).toBeUndefined()
  expect(await call($, { tool: 'Bash', command: 'gh pr create -t "feat: 任务 8"' })).toContain('不存在的任务：8')
})

test('勾选原本就有问题的那一行（编号重复等）不拦：问题还是原来那个', async ($, on) => {
  const dup = '# A\n\n- [ ] 1 one\n- [ ] 1 one again\n'
  const w = world(on, 'S1', { [SPEC]: dup })
  await start($, w)
  expect(await call($, { tool: 'Edit', file_path: SPEC, old_string: '- [ ] 1 one again', new_string: '- [x] 1 one again' })).toBeUndefined()
  expect(w.ran).toEqual(['Edit'])
})

test('认出项目后服务断线：拦截停下、全部放行；服务恢复后照常拦（公开 PR #8 review）', { options: { lang: 'zh' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const bad = { tool: 'Write', file_path: SPEC, content: `${OLD}- [-] 9 x\n` }
  expect(await call($, bad)).toContain('YUIBoard')
  w.offline = true
  await w.clock.advance(5000)
  expect(await call($, bad)).toBeUndefined()
  expect(await call($, { tool: 'Bash', command: 'gh pr create -t "feat: 任务 99"' })).toBeUndefined()
  w.offline = false
  await w.clock.advance(5000)
  expect(await call($, bad)).toContain('YUIBoard')
  expect(w.ran).toEqual(['Write', 'Bash'])
})
