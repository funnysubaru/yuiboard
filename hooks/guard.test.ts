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
  const w = { clock, ran: [] as string[], reads: [] as string[] }
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

// ---- worktree（PR review）：owner 多在工作区的 git worktree 里开发 ----
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
