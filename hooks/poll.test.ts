// 任务 5.1：轮询、会话身份与认项目（design §3.2、§5.2 前两步、§7）。
// 引擎底下的世界全由测试钩子代答：http.fetch 回虚构的 devboard、session.id / cwd 可在两轮之间改、
// 时钟用 kit 的 mock（clock.every 只在 advance 时触发）。
// 坑：测试 import 的 register.tsx 与引擎加载的插件不是同一个模块实例，测试里调 polled() 读不到插件的数据；
// 测试的 $ 也没有 state 这个名词。所以 $.state 由测试钩子 state.get / state.set 代答（w.state 可直接读写），
// 模块变量经正式面板读出（seen()）：摘要换没换看任务行的标题（面板不显示 ETag）。
// 文件用 .ts 而不是 .tsx：用例名是中文，而 hooks/*.tsx 的代码不得含中日文字符（需求 8.3）；本文件不含 JSX。
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PluginState } from 'claude-code'
import { t, setLang, getLang } from '../web/i18n.mjs'

const URL = 'http://127.0.0.1:4317'
const START = { cwd: '/w/one', surface: null, isInteractive: true }

// 虚构摘要：p1 的工作区 /w/one，会话 S1 关联任务 a#1（运行中）；p2 的工作区 /w/two
const task = (key: string, number: string, parentKey: string | null = null, groupId: string | null = null) =>
  ({ key, number, title: `T ${number}`, checkbox: false, void: false, docId: key.split('#')[0], groupId, parentKey })
// 面板（paneOf）要读的字段：freshness、degraded、stats、文档的 kind / parse
const COUNTS = { not_started: 0, in_progress: 3, in_review: 0, awaiting_merge: 0, done: 0 }
const PARSE_OK = { state: 'ok', unrecognizedLines: [], unknownRelations: [], unknownEstimates: [], diagnostics: [], mermaidUsed: false }
const summaryOf = (project: string, sessions: string[], links: Record<string, { sessionId: string; activity: string; lastAt: string }[]>) => ({
  projectId: project,
  freshness: { github: {} },
  degraded: {},
  stats: { docs: [{ docId: 'a', total: 3, counts: COUNTS, groups: [{ groupId: 'g1', total: 2, counts: COUNTS }] }] },
  workspaces: [{ id: 'main', path: `/w/${project === 'p1' ? 'one' : 'two'}` }],
  sessions: sessions.map(id => ({ id, source: 'claude', title: id })),
  docs: [{ docId: 'a', title: 'A', kind: 'spec', parse: PARSE_OK, archived: false, groups: [{ id: 'g1', title: 'G1' }], tasks: [task('a#1', '1', null, 'g1'), task('a#1.2', '1.2', 'a#1', 'g1'), task('a#2', '2')] }],
  tasks: ['a#1', 'a#1.2', 'a#2'].map(key => ({ key, status: 'in_progress', sessions: links[key] ?? [] })),
  conflicts: [], prs: [],
})
const RUN = (sessionId: string, at = '2026-10-11T00:00:00Z') => [{ sessionId, activity: 'running', lastAt: at }]
const PROJECTS = JSON.stringify({ errors: [], warnings: [], projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] })

type Reply = { status: number; text?: string; etag?: string } | { deny: string }
type Call = { url: string; etag: string | undefined }

/** 装好替身：server[路径] 决定回什么（函数可按调用变化），gate 不为空时 fetch 挂起到它放行。 */
function world(on: On, init: { id?: string; cwd?: string; language?: string } = {}) {
  const clock = mock.clock(on)
  const w = {
    clock,
    state: new Map<string, unknown>(),
    id: init.id ?? 'S1',
    cwd: init.cwd ?? '/w/elsewhere',
    calls: [] as Call[],
    opened: [] as string[],
    gate: null as Promise<void> | null,
    server: {
      '/api/projects': { status: 200, text: PROJECTS },
      '/api/projects/p1/summary': { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], { 'a#1': RUN('S1') })), etag: '"p1-v1"' },
      '/api/projects/p2/summary': { status: 200, text: JSON.stringify(summaryOf('p2', [], {})), etag: '"p2-v1"' },
    } as Record<string, Reply | (() => Reply)>,
  }
  const versions = new Map<string, number>()
  on('state.get', ($, e) => ({ value: { value: w.state.get(e.key), version: versions.get(e.key) ?? 0 } }))
  on('state.set', ($, e) => {
    w.state.set(e.key, e.value)
    versions.set(e.key, (versions.get(e.key) ?? 0) + 1)
    return { value: { isSet: true, version: versions.get(e.key) ?? 0 } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: w.id }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('settings.read', () => ({ value: init.language === undefined ? {} : { language: init.language } }))
  on('command.register', () => ({ value: { command: 'yuiboard' } }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('http.fetch', async ($, e) => {
    const path = e.url.slice(URL.length)
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.calls.push({ url: path, etag: headers['If-None-Match'] })
    const gate = w.gate
    if (gate) await gate
    const r = w.server[path]
    const reply = typeof r === 'function' ? r() : r ?? { status: 404, text: '{"error":"not-found","messages":[]}' }
    if ('deny' in reply) return { deny: reply.deny }
    const etag = reply.etag
    if (etag !== undefined && headers['If-None-Match'] === etag) return { value: { status: 304, ok: false, headers: { etag }, text: '' } }
    const h: Record<string, string> = etag ? { etag } : {}
    return { value: { status: reply.status, ok: reply.status < 300, headers: h, text: reply.text ?? '' } }
  })
  return w
}

type W = ReturnType<typeof world>
type Key = keyof PluginState['yuiboard']
const get = <K extends Key>(w: W, key: K) => w.state.get(key) as PluginState['yuiboard'][K] | undefined
const put = <K extends Key>(w: W, key: K, value: PluginState['yuiboard'][K]) => void w.state.set(key, value)

type El = { type: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }
/** 装饰符号（状态标记、分隔点、行尾链接、高亮竖线），不算一段文字 */
const DECOR = new Set(['\u2715', '\u00b7', '\u26a0', '\u2713', '\u258e', '\u2197'])
/** 一行（带 key 的 Box）里各段显示的文字：Text 的字符串、Link / Button 的标签，嵌套的 Box 一并展开；去掉装饰符号 */
const pieces = (row: El | undefined): string[] => (row?.children ?? []).flatMap(c => {
  if (!c || typeof c !== 'object') return []
  const e = c as El
  const out = e.type === 'Text' ? [(e.children ?? []).join('')]
    : e.type === 'Box' ? pieces(e)
    : e.props?.label === undefined ? [] : [String(e.props.label)]
  return out.filter(s => !DECOR.has(s))
})

/**
 * 插件模块变量的可见部分：挂一次面板，从正式面板读回轮询的结果。
 * projectId 取「在浏览器打开」链接里的 project=；focus 取聚焦卡片的行键（标题行以「本会话最近做的」开头即 recent）；
 * problems 按横幅还原（连不上：文字、url、错误；HTTP：状态码与各条 messages；超限：带链接的那条）；
 * lang 按「总览」按钮的文字认；titles 是正文里任务行的标题，代替原先的 ETag 判断用的是哪一版摘要。
 */
async function seen($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'yuiboard', surface: 'terminal', component: 'Pane', requestId: 'yuiboard',
    props: { title: 'YUIBoard', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const boxes = (await ui.findAll({ type: 'Box' })) as El[]
  const row = (key: string) => boxes.find(b => b.key === key)
  const keys = boxes.map(b => b.key).filter((k): k is string => k !== undefined)
  const href = String((row('open')?.children?.find(c => (c as El).type === 'Link') as El | undefined)?.props?.href ?? '')
  const projectId = /[?&]project=([^&]+)/.exec(href)?.[1] ?? null

  const nav = pieces(row('nav:overview'))[0]
  const before = getLang()
  const lang = (['zh', 'ja', 'en'] as const).find(l => (setLang(l), t('总览')) === nav) ?? null
  setLang(lang ?? before)
  const recentText = t('本会话最近做的')
  setLang(before)

  const head = row('focus')
  const focus = head === undefined ? null : {
    keys: keys.filter(k => k.startsWith('focus:') && k !== 'focus:more' && k !== 'focus:others' && !/:why$/.test(k)).map(k => k.slice('focus:'.length)),
    recent: (pieces(head)[0] ?? '').startsWith(recentText),
  }

  const problems: unknown[] = []
  for (const b of boxes.filter(x => x.key?.startsWith('banner:'))) {
    const p = pieces(b)
    const http = /^HTTP (\d+)$/.exec(p[0] ?? '')
    const last = problems[problems.length - 1] as { kind: string; status: number; messages: string[] } | undefined
    if (http) {
      const status = Number(http[1])
      if (last?.kind === 'http' && last.status === status && p[1] !== undefined) last.messages.push(p[1])
      else problems.push({ kind: 'http', status, messages: p[1] === undefined ? [] : [p[1]] })
    } else if (p.length >= 4) problems.push({ kind: 'offline', url: p[1], message: p[2] })
    else if (b.children?.some(c => (c as El).type === 'Link')) problems.push({ kind: 'oversize' })
  }
  // 任务行最后一段是标题
  const titles = keys.filter(k => k.startsWith('task:')).map(k => pieces(row(k)).at(-1))
  await ui.unmount()
  return { projectId, focus, problems, lang, titles }
}
/** 第一版摘要在面板正文里的任务标题（文档 a 下先是不在分组里的 2，再是分组 g1 的 1、1.2） */
const V1 = ['T 2', 'T 1', 'T 1.2']
/** 会话开始并跑完首轮（首轮在后台跑，settle 让它跑完） */
async function start($: Engine, w: W) {
  await $.session.start(START)
  await w.clock.settle()
}
/** 等一个轮询周期 */
const tick = (w: W) => w.clock.advance(5000)
/** 挂起 fetch，返回放行函数 */
function hold(w: W) {
  let release = () => {}
  w.gate = new Promise<void>(r => { release = () => { w.gate = null; r() } })
  return () => release()
}

test('首轮拉全部项目的摘要；按会话 id 认出 p1 后自动打开面板，之后只拉 p1 并带 ETag', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.calls.map(c => c.url)).toEqual(['/api/projects', '/api/projects/p1/summary', '/api/projects/p2/summary'])
  expect((await seen($)).projectId).toBe('p1')
  expect(w.opened).toEqual(['yuiboard'])
  w.calls.length = 0
  await tick(w)
  expect(w.calls).toEqual([{ url: '/api/projects', etag: undefined }, { url: '/api/projects/p1/summary', etag: '"p1-v1"' }])
})

test('304 不解析、不重画：rev 不变；摘要换了内容 rev 加一', async ($, on) => {
  const w = world(on)
  await start($, w)
  const rev = get(w, 'rev') ?? 0
  await tick(w)
  expect(get(w, 'rev')).toBe(rev)
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], { 'a#1': RUN('S1') })).replace('"T 2"', '"T 2b"'), etag: '"p1-v2"' }
  await tick(w)
  expect(get(w, 'rev')).toBe(rev + 1)
  expect((await seen($)).titles).toEqual(['T 2b', 'T 1', 'T 1.2'])
})

test('认不出项目时不自动打开面板，每轮都拉全部项目', async ($, on) => {
  const w = world(on, { id: 'S9', cwd: '/w/elsewhere' })
  await start($, w)
  expect((await seen($)).projectId).toBe(null)
  expect(w.opened).toEqual([])
  w.calls.length = 0
  await tick(w)
  expect(w.calls.map(c => c.url)).toEqual(['/api/projects', '/api/projects/p1/summary', '/api/projects/p2/summary'])
})

test('会话开始时认不出、之后某轮认出项目：那一轮自动打开一次，之后不再打开；换会话认出后再打开一次', async ($, on) => {
  // 新会话还没发消息时 devboard 读不到它，cwd 也不在工作区下：首轮认不出
  const w = world(on, { id: 'S5', cwd: '/w/elsewhere' })
  await start($, w)
  expect(w.opened).toEqual([])
  // devboard 读到了这个会话（摘要的 sessions 里出现 S5）
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1', 'S5'], { 'a#1': RUN('S1') })), etag: '"p1-v2"' }
  await tick(w)
  expect((await seen($)).projectId).toBe('p1')
  expect(w.opened).toEqual(['yuiboard'])
  await tick(w)
  await tick(w)
  expect(w.opened).toEqual(['yuiboard'])
  // /clear 后换了会话 id，认出后再打开一次
  w.id = 'S1'
  await tick(w)
  await tick(w)
  expect((await seen($)).projectId).toBe('p1')
  expect(w.opened).toEqual(['yuiboard', 'yuiboard'])
})

test('按 cwd 在工作区之下认项目', async ($, on) => {
  const w = world(on, { id: 'S9', cwd: '/w/two/sub' })
  await start($, w)
  expect((await seen($)).projectId).toBe('p2')
  expect(w.opened).toEqual(['yuiboard'])
})

test('上一轮未完时跳过本轮，不发新请求', async ($, on) => {
  const w = world(on)
  await start($, w)
  const release = hold(w)
  w.calls.length = 0
  await tick(w)
  expect(w.calls.length).toBe(1)
  await tick(w)
  await tick(w)
  expect(w.calls.length).toBe(1)
  release()
  await w.clock.settle()
  expect(w.calls.length).toBe(2)
  await tick(w)
  expect(w.calls.length).toBe(4)
})

test('连不上：记 offline（含 url），保留上次摘要', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.server['/api/projects'] = { deny: 'connect ECONNREFUSED 127.0.0.1:4317' }
  const rev = get(w, 'rev') ?? 0
  await tick(w)
  const p = await seen($)
  expect(p.problems).toEqual([{ kind: 'offline', url: URL, message: expect.stringContaining('ECONNREFUSED') }])
  expect(p.titles).toEqual(V1)
  expect(p.projectId).toBe('p1')
  expect(get(w, 'rev')).toBe(rev + 1)
  // 同样的问题再来一轮不重画；恢复后问题清空
  await tick(w)
  expect(get(w, 'rev')).toBe(rev + 1)
  w.server['/api/projects'] = { status: 200, text: PROJECTS }
  await tick(w)
  expect((await seen($)).problems).toEqual([])
})

test('409 / 500：记 http（状态码与服务端 messages），保留上次摘要', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.server['/api/projects/p1/summary'] = { status: 409, text: JSON.stringify({ error: 'config', messages: ['bad path'] }) }
  await tick(w)
  let p = await seen($)
  expect(p.problems).toEqual([{ kind: 'http', status: 409, messages: ['bad path'] }])
  expect(p.titles).toEqual(V1)
  w.server['/api/projects/p1/summary'] = { status: 500, text: 'oops' }
  await tick(w)
  p = await seen($)
  expect(p.problems).toEqual([{ kind: 'http', status: 500, messages: [] }])
  expect(p.titles).toEqual(V1)
  expect(p.focus).toEqual({ keys: ['a#1'], recent: false })
})

test('截断的 JSON 与 4 MiB 拒绝都记 oversize，保留上次摘要与 ETag', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.server['/api/projects/p1/summary'] = { status: 200, text: '{"docs":[{"tit', etag: '"p1-big"' }
  await tick(w)
  let p = await seen($)
  expect(p.problems).toEqual([{ kind: 'oversize' }])
  expect(p.titles).toEqual(V1)
  w.calls.length = 0
  w.server['/api/projects/p1/summary'] = { deny: 'response body of 5000000 bytes is over the 4194304-byte limit' }
  await tick(w)
  expect(w.calls[1]?.etag).toBe('"p1-v1"')
  p = await seen($)
  expect(p.problems).toEqual([{ kind: 'oversize' }])
  expect(p.titles).toEqual(V1)
})

test('会话 id 在两轮之间改变：清掉项目、picked、聚焦、pendingScroll，重新认项目；项目变了清 toggled', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect((await seen($)).projectId).toBe('p1')
  expect(get(w, 'pendingScroll')).toBe('a#1')
  put(w, 'toggled', ['doc:z'])
  put(w, 'picked', 'p1')
  // 新会话 S2 在 /w/two，只有 p2 的工作区包含它
  w.id = 'S2'
  w.cwd = '/w/two'
  w.calls.length = 0
  await tick(w)
  expect(w.calls.map(c => c.url)).toEqual(['/api/projects', '/api/projects/p1/summary', '/api/projects/p2/summary'])
  const p = await seen($)
  expect(p.projectId).toBe('p2')
  expect(p.focus).toEqual({ keys: [], recent: false })
  expect(get(w, 'sessionId')).toBe('S2')
  expect(get(w, 'picked')).toBe(null)
  expect(get(w, 'pendingScroll')).toBe(null)
  expect(get(w, 'toggled')).toEqual([])
})

test('会话切换后仍是同一项目：toggled 保留', async ($, on) => {
  const w = world(on)
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1', 'S2'], { 'a#1': RUN('S1') })), etag: '"p1-v1"' }
  await start($, w)
  put(w, 'toggled', ['doc:z'])
  w.id = 'S2'
  await tick(w)
  expect((await seen($)).projectId).toBe('p1')
  expect(get(w, 'toggled')).toEqual(['doc:z'])
})

test('session.end 之后，旧身份发出、迟到的响应被丢弃', async ($, on) => {
  const w = world(on)
  await start($, w)
  // 旧身份的这一轮挂在 fetch 上，期间会话被 /clear；挂起时服务端的摘要已经换成聚焦 a#2 的
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], { 'a#2': RUN('S1') })), etag: '"p1-v2"' }
  const release = hold(w)
  await tick(w)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  expect(get(w, 'sessionId')).toBe('S1')
  release()
  await w.clock.settle()
  const p = await seen($)
  expect(p.titles).toEqual(V1)
  expect(p.focus).toEqual({ keys: ['a#1'], recent: false })
  expect(get(w, 'pendingScroll')).toBe('a#1')
  // 下一轮读到新 id S3（devboard 还没读到它，cwd 也不在工作区里）→ 按会话切换处理
  w.id = 'S3'
  await tick(w)
  expect(get(w, 'sessionId')).toBe('S3')
  expect((await seen($)).projectId).toBe(null)
  expect(get(w, 'pendingScroll')).toBe(null)
})

test('/clear 后引擎清空 $.state（模块变量还在）、换了会话：按会话切换处理，丢掉手动选的旧项目，重新认项目（PR #38 review P1）', async ($, on) => {
  const w = world(on)
  await start($, w)
  // 手动选了 p2
  put(w, 'picked', 'p2')
  await tick(w)
  expect((await seen($)).projectId).toBe('p2')
  // /clear：只触发 session.end，引擎清空 state，模块变量（认出的 p2）还在；新会话 S2 的 cwd 在 p1 的工作区下
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  w.state.clear()
  w.id = 'S2'
  w.cwd = '/w/one/src'
  w.calls.length = 0
  await tick(w)
  await tick(w)
  expect(get(w, 'sessionId')).toBe('S2')
  expect((await seen($)).projectId).toBe('p1')
  expect(w.calls.map(c => c.url)).toContain('/api/projects/p1/summary')
})

test('聚焦任务消失后同一任务再出现：按「出现」处理，撤销收起并设 pendingScroll（PR #38 review P2）', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(get(w, 'pendingScroll')).toBe('a#1')
  // 滚过了；用户收起文档 a
  put(w, 'pendingScroll', null)
  put(w, 'toggled', ['doc:a'])
  // 本会话暂时没有聚焦：忘掉已处理的键
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], {})), etag: '"p1-v2"' }
  await tick(w)
  expect((await seen($)).focus).toEqual({ keys: [], recent: false })
  expect(get(w, 'focusKey')).toBe(null)
  // 同一任务再出现：展开路径、滚过去
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], { 'a#1': RUN('S1') })), etag: '"p1-v3"' }
  await tick(w)
  expect(get(w, 'toggled')).toEqual([])
  expect(get(w, 'pendingScroll')).toBe('a#1')
  expect(get(w, 'focusKey')).toBe('a#1')
})

test('连不上时聚焦不算消失：保留已处理的键，恢复后同一聚焦不再展开、不再滚', async ($, on) => {
  const w = world(on)
  await start($, w)
  put(w, 'pendingScroll', null)
  put(w, 'toggled', ['doc:a'])
  // 重载后首轮连不上（没有摘要）
  w.server['/api/projects'] = { deny: 'connect ECONNREFUSED' }
  await $.session.start(START)
  await w.clock.settle()
  expect(get(w, 'focusKey')).toBe('a#1')
  // 恢复连接，同一聚焦
  w.server['/api/projects'] = { status: 200, text: PROJECTS }
  await tick(w)
  expect(get(w, 'toggled')).toEqual(['doc:a'])
  expect(get(w, 'pendingScroll')).toBe(null)
})

test('同一会话手动选了项目后 mod 重载：首轮不当成会话切换，仍是该项目，view / toggled 不变', async ($, on) => {
  const w = world(on, { id: 'S9', cwd: '/w/elsewhere' })
  await start($, w)
  expect((await seen($)).projectId).toBe(null)
  put(w, 'picked', 'p2')
  put(w, 'view', 'diag')
  put(w, 'toggled', ['doc:a'])
  await tick(w)
  expect((await seen($)).projectId).toBe('p2')
  expect(w.opened).toEqual(['yuiboard'])
  // 重载：模块变量从头来（session.start 再触发），$.state 保留；本会话已自动打开过，不再打开
  w.opened.length = 0
  w.calls.length = 0
  await start($, w)
  expect(w.calls.map(c => c.url)).toEqual(['/api/projects', '/api/projects/p2/summary'])
  expect((await seen($)).projectId).toBe('p2')
  expect(w.opened).toEqual([])
  expect(get(w, 'picked')).toBe('p2')
  expect(get(w, 'view')).toBe('diag')
  expect(get(w, 'toggled')).toEqual(['doc:a'])
})

test('重载后聚焦未变：不改 toggled、不设 pendingScroll', async ($, on) => {
  const w = world(on)
  await start($, w)
  put(w, 'toggled', ['doc:a'])
  put(w, 'pendingScroll', null)
  await start($, w)
  expect((await seen($)).focus).toEqual({ keys: ['a#1'], recent: false })
  expect(get(w, 'toggled')).toEqual(['doc:a'])
  expect(get(w, 'pendingScroll')).toBe(null)
})

test('聚焦变化：删掉 toggled 里聚焦路径的键、设 pendingScroll；聚焦不变时不设', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(get(w, 'pendingScroll')).toBe('a#1')
  // 用户收起了文档、分组、父任务 1，另有无关的 doc:b；滚动已经做过
  put(w, 'toggled', ['doc:a', 'grp:a/g1', 'task:a#1', 'doc:b'])
  put(w, 'pendingScroll', null)
  await tick(w)
  expect(get(w, 'pendingScroll')).toBe(null)
  expect(get(w, 'toggled')).toEqual(['doc:a', 'grp:a/g1', 'task:a#1', 'doc:b'])
  // 聚焦转到 1.2：文档、分组、祖先任务 1 都展开
  const rev = get(w, 'rev') ?? 0
  w.server['/api/projects/p1/summary'] = { status: 200, text: JSON.stringify(summaryOf('p1', ['S1'], { 'a#1.2': RUN('S1') })), etag: '"p1-v2"' }
  await tick(w)
  expect((await seen($)).focus).toEqual({ keys: ['a#1.2'], recent: false })
  expect(get(w, 'toggled')).toEqual(['doc:b'])
  expect(get(w, 'pendingScroll')).toBe('a#1.2')
  expect(get(w, 'rev')).toBe(rev + 1)
})

test('/yuiboard 打开面板并回一行文字', async ($, on) => {
  const w = world(on)
  const r = await $.command.run({ command: 'yuiboard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(typeof r.text).toBe('string')
  expect(w.opened).toEqual(['yuiboard'])
})

test('lang 配置：auto 时跟 Claude 设置的 language', { options: { lang: 'auto' } }, async ($, on) => {
  const w = world(on, { language: 'japanese' })
  await start($, w)
  expect((await seen($)).lang).toBe('ja')
})

test('lang 配置：指定 en 时不看设置', { options: { lang: 'en' } }, async ($, on) => {
  const w = world(on, { language: 'japanese' })
  await start($, w)
  expect((await seen($)).lang).toBe('en')
})

test('url 配置为空串（plugin configure 存成 ""）时按未设置处理，仍连默认地址', { options: { url: '' } }, async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.calls[0]?.url).toBe('/api/projects')
})
