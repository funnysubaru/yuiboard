// 任务 6.1：面板三视图与聚焦滚动（design §5、§6）。终端与桌面各跑一遍。
// 世界的替身写法同 hooks/poll.test.ts：$.state、http.fetch、会话身份、ui.open / ui.scroll 都由测试钩子代答；
// 摘要是手写的最小虚构数据（字段名照 design §3.1），mod 测试环境没有 Node，用不了 summarize()。
// 文件用 .ts：用例名与断言里的文案是中文，hooks/*.tsx 的代码不得含中日文字符（需求 8.3）。
import { test, expect, mock } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { On, PluginState } from 'claude-code'
import { FG, scrollKey } from './register'

const URL = 'http://127.0.0.1:4317'
/** 面板里的链接地址（register.tsx 的 localLink 把回环地址写成 localhost） */
const WEB = 'http://localhost:4317'
const START = { cwd: '/w/one', surface: null, isInteractive: true }

type Link = { sessionId: string; activity: string; firstAt: string; lastAt: string }
const RUN = (sessionId: string): Link[] => [{ sessionId, activity: 'running', firstAt: '2026-10-10T00:00:00Z', lastAt: '2026-10-11T00:00:00Z' }]

const task = (docId: string, number: string, title: string, groupId: string | null = null, parentKey: string | null = null) =>
  ({ key: `${docId}#${number}`, number, title, checkbox: 'open', void: false, docId, groupId, parentKey })
const view = (key: string, sessions: Link[] = []) => ({
  key, status: sessions.length ? 'in_progress' : 'not_started', rule: sessions.length ? '8.2-4' : null, docOnly: false,
  syncPending: [], syncUnchecked: false, inProgressBy: sessions.length ? ['session'] : [], activity: sessions.length ? 'running' : null,
  childSummary: null, next: 'ready', prs: [], sessions, deps: { on: [], unmet: [], external: [] },
})
const counts = (done = 0) => ({ not_started: 0, in_progress: 0, in_review: 0, awaiting_merge: 0, done })
const PARSE_OK = { state: 'ok', unrecognizedLines: [], unknownRelations: [], unknownEstimates: [], diagnostics: [], mermaidUsed: false }
const doc = (docId: string, groups: { id: string; title: string }[], tasks: ReturnType<typeof task>[]) =>
  ({ docId, title: docId.toUpperCase(), path: `.claude/specs/${docId}/tasks.md`, kind: 'spec', archived: false, workspaceId: 'main',
    sourceType: 'spec', sourceLabel: 'spec', parse: PARSE_OK, groups, tasks })

/**
 * 项目 p1（One，工作区 /w/one）：文档 a 有分组 g1（1、1.2 是 1 的子任务）与 g2（2），文档 b 有 1；
 * links 给出各任务关联的会话；conflicts 默认 2 条 c、1 条 a，需要确认计数 3。big 给出一份 n 个长标题任务的文档 z。
 */
function summary(links: Record<string, Link[]> = {}, opt: { conflicts?: unknown[]; big?: number; configWarnings?: string[] } = {}) {
  const docs = [
    doc('a', [{ id: 'g1', title: 'Stage one' }, { id: 'g2', title: 'Stage two' }],
      [task('a', '1', 'Parent **one**', 'g1'), task('a', '1.2', 'Child', 'g1', 'a#1'), task('a', '2', 'Second', 'g2')]),
    doc('b', [], [task('b', '1', 'Other')]),
  ]
  if (opt.big) docs.push(doc('z', [], Array.from({ length: opt.big }, (_, i) => task('z', String(i + 1), `${'x'.repeat(190)} ${i + 1}`))))
  const keys = docs.flatMap(d => d.tasks.map(x => x.key))
  return {
    projectId: 'p1',
    freshness: { github: { state: 'ok', lastSuccessAt: '2026-10-11T00:00:00Z', rate: { remaining: 4000, limit: 5000 } } },
    degraded: { noPrData: false, noSessionData: false, prFromCache: false },
    workspaces: [{ id: 'main', path: '/w/one', branch: 'main', commit: '0123456789ab', detached: false }],
    diagnostics: {
      config: { path: '/x/devboard.config.json', projects: 2, warnings: opt.configWarnings ?? [] },
      sources: [], convention: [], sessionSources: [], sessions: null, github: null,
    },
    defaults: {},
    stats: {
      docs: docs.map(d => ({ docId: d.docId, total: d.tasks.length, counts: counts(), groups: d.groups.map(g => ({ groupId: g.id, total: d.tasks.filter(x => x.groupId === g.id).length, counts: counts() })) })),
    },
    docs,
    tasks: keys.map(k => view(k, links[k])),
    conflicts: opt.conflicts ?? [
      { type: 'c', taskKey: 'a#1', detail: 'only doc' }, { type: 'c', taskKey: 'a#2', detail: 'only doc' },
      { type: 'a', taskKey: 'b#1', detail: 'merged not ticked', source: { file: 'tasks.md', line: 3, text: '- [ ] 1 Other' } },
    ],
    prs: [],
    sessions: [{ id: 'S1', source: 'claude', title: 'S1' }],
  }
}
const PROJECTS = JSON.stringify({ errors: [], warnings: [], projects: [{ id: 'p1', name: 'One', branchLines: [], errors: [] }, { id: 'p2', name: 'Two', branchLines: [], errors: [] }] })
const P2 = { ...summary(), projectId: 'p2', workspaces: [{ id: 'main', path: '/w/two', branch: 'main', commit: 'fedcba987654', detached: false }], sessions: [] }

/** 装好替身；serve(p1 的摘要) 换 p1 的回答（ETag 跟着换） */
function world(on: On, init: { id?: string; cwd?: string; p1?: unknown } = {}) {
  const clock = mock.clock(on)
  const w = {
    clock,
    state: new Map<string, unknown>(),
    id: init.id ?? 'S1',
    cwd: init.cwd ?? '/w/elsewhere',
    server: {} as Record<string, { status: number; text: string; etag: string }>,
    serve(s: unknown) {
      const text = JSON.stringify(s)
      this.server['/api/projects/p1/summary'] = { status: 200, text, etag: `"p1-${text.length}-${Math.random()}"` }
    },
  }
  w.server['/api/projects'] = { status: 200, text: PROJECTS, etag: '' }
  w.server['/api/projects/p2/summary'] = { status: 200, text: JSON.stringify(P2), etag: '"p2"' }
  w.serve(init.p1 ?? summary({ 'a#1': RUN('S1') }))
  const versions = new Map<string, number>()
  on('state.get', ($, e) => ({ value: { value: w.state.get(e.key), version: versions.get(e.key) ?? 0 } }))
  on('state.set', ($, e) => {
    w.state.set(e.key, e.value)
    versions.set(e.key, (versions.get(e.key) ?? 0) + 1)
    return { value: { isSet: true, version: versions.get(e.key) ?? 0 } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.id }))
  on('session.cwd', () => ({ value: w.cwd }))
  // 界面语言固定中文，断言直接写 model 产出的中文文案
  on('settings.read', () => ({ value: { language: 'chinese' } }))
  on('command.register', () => ({ value: { command: 'yuiboard' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', ($, e) => {
    const r = w.server[e.url.slice(URL.length)]
    const none: Record<string, string> = {}
    if (!r) return { value: { status: 404, ok: false, headers: none, text: '{"messages":[]}' } }
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    if (r.etag && headers['If-None-Match'] === r.etag) return { value: { status: 304, ok: false, headers: { etag: r.etag }, text: '' } }
    return { value: { status: r.status, ok: true, headers: r.etag ? { etag: r.etag } : none, text: r.text } }
  })
  return w
}
type W = ReturnType<typeof world>
type Key = keyof PluginState['yuiboard']
const get = <K extends Key>(w: W, key: K) => w.state.get(key) as PluginState['yuiboard'][K] | undefined
const put = <K extends Key>(w: W, key: K, value: PluginState['yuiboard'][K]) => void w.state.set(key, value)

async function start($: Engine, w: W) {
  await $.session.start(START)
  await w.clock.settle()
}
const tick = (w: W) => w.clock.advance(5000)

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
/** 挂一次面板；测试的 $.state 由钩子代答、不会通知面板，所以改了状态后用 ui.redraw() 重画再读 */
async function mount($: Engine, w: W, surface: Surface) {
  const ui = await $.ui.mount({
    plugin: 'yuiboard', surface, component: 'Pane', requestId: 'yuiboard',
    props: { title: 'YUIBoard', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await w.clock.settle()
  return ui
}
type UI = Awaited<ReturnType<typeof mount>>
/** 画出的全部带 key 的 Box 的键，按文档顺序 */
const keys = async (ui: UI) => (await ui.findAll({ type: 'Box' })).map(b => b.key).filter((k): k is string => k !== undefined)
const text = async (ui: UI, key: string) => (await ui.find({ type: 'Box', key }))?.text
/** 元素树里的全部节点（含自身） */
const walk = (el: unknown): FoundElement[] => {
  if (!el || typeof el !== 'object') return []
  const e = el as FoundElement
  return [e, ...(e.children ?? []).flatMap(walk)]
}
/** 整棵树计入引擎 10 万字上限的字符：字符串子节点、标签、Markdown 原文、key、链接地址 */
const treeChars = (el: unknown): number => {
  if (typeof el === 'string') return el.length
  if (!el || typeof el !== 'object') return 0
  const e = el as { props?: Record<string, unknown>; children?: unknown[] }
  const own = ['key', 'label', 'text', 'href'].reduce((n, p) => n + (typeof e.props?.[p] === 'string' ? (e.props[p] as string).length : 0), 0)
  return own + (e.children ?? []).reduce((n: number, c) => n + treeChars(c), 0)
}
/**
 * 这一帧面板要滚到的行：用插件同一个 scrollKey，对真实画出的键与当前 $.state 求值。
 * claude 2.1.293 的测试套件里插件发出的 $.ui.scroll 到不了测试钩子（没有面板这个落点，报 no implementation），
 * 断言不了 ui.scroll 的实参，只能断言滚动的决定；真实滚动在任务 7 实物验收里看。
 */
const scrollTarget = async (ui: UI, w: W) => scrollKey(get(w, 'view') ?? 'overview', get(w, 'pendingScroll') ?? null, await keys(ui))

for (const surface of SURFACES) {
  test(`[${surface}] 顶栏：项目名、三个视图按钮、需要确认计数同 checkItems 全部条数（含 c）、在浏览器打开`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await mount($, w, surface)
    expect(await text(ui, 'title')).toContain('One')
    expect(await text(ui, 'nav:overview')).toContain('总览')
    expect(await text(ui, 'nav:check')).toContain('3')
    expect(await text(ui, 'nav:diag')).toContain('诊断')
    // 链接写成 localhost：桌面端只认 https: 与 http://localhost
    const open = await ui.find({ type: 'Link', text: /在浏览器打开/ })
    expect(open?.props.href).toBe(`${WEB}/#/overview?project=p1`)
    // 数字一行：进度条与百分比、可开工
    expect(await text(ui, 'stat:progress')).toContain('0%')
    expect(await text(ui, 'stat:ready')).toContain('可开工')
    await ui.unmount()
  })

  test(`[${surface}] 切视图：按钮写 view，数字只在总览`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await mount($, w, surface)
    await ui.press({ key: 'go:check' })
    expect(get(w, 'view')).toBe('check')
    await ui.redraw()
    let k = await keys(ui)
    expect(k).toContain('check:a')
    expect(k).not.toContain('stat:progress')
    expect(k).not.toContain('task:a#1')
    await ui.press({ key: 'go:diag' })
    await ui.redraw()
    k = await keys(ui)
    expect(k).toContain('diag:config')
    expect(k).toContain('diag:github')
    await ui.press({ key: 'go:overview' })
    await ui.redraw()
    expect(await keys(ui)).toContain('stat:progress')
    await ui.unmount()
  })

  test(`[${surface}] 默认只展开聚焦路径，父任务默认展开；文档 / 分组 / 父任务的折叠按钮切换 toggled 并重画`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await mount($, w, surface)
    let k = await keys(ui)
    expect(k).toEqual(expect.arrayContaining(['doc:a', 'grp:a/g1', 'task:a#1', 'task:a#1.2', 'grp:a/g2', 'doc:b']))
    expect(k).not.toContain('task:a#2')
    expect(k).not.toContain('task:b#1')
    // 折叠按钮的 key 是折叠键，显示 ▾ / ▸
    expect((await ui.find({ type: 'Button', key: 'doc:a' }))?.props.label).toBe('\u25BE')
    expect((await ui.find({ type: 'Button', key: 'doc:b' }))?.props.label).toBe('\u25B8')
    // 任务标题去掉 Markdown 记号、照常换行（面板稿 v2）；文档行放不下截断
    expect(await text(ui, 'task:a#1')).toContain('Parent one')
    const wraps = async (key: string) => walk(await ui.find({ type: 'Box', key })).filter(n => n.type === 'Text').map(n => n.props.wrap).filter(Boolean)
    expect(await wraps('task:a#1')).toEqual(['wrap'])
    expect(await wraps('doc:a')).toEqual(['truncate-end'])

    await ui.press({ key: 'doc:b' })
    await ui.press({ key: 'grp:a/g1' })
    expect(get(w, 'toggled')).toEqual(['doc:b', 'grp:a/g1'])
    await ui.redraw()
    k = await keys(ui)
    expect(k).toContain('task:b#1')
    expect(k).not.toContain('task:a#1')

    await ui.press({ key: 'grp:a/g1' })
    await ui.redraw()
    await ui.press({ key: 'task:a#1' })
    expect(get(w, 'toggled')).toEqual(['doc:b', 'task:a#1'])
    await ui.redraw()
    k = await keys(ui)
    expect(k).toContain('task:a#1')
    expect(k).not.toContain('task:a#1.2')
    await ui.unmount()
  })

  test(`[${surface}] 聚焦卡片：文档名、状态图标、编号、标题、状态原因，高亮；没有关联时显示说明`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await mount($, w, surface)
    const card = await text(ui, 'focus:a#1')
    expect(card).toContain('\u25D4')
    expect(card).toContain('Parent one')
    expect(await text(ui, 'focus')).toContain('本会话正在做 · a')
    expect(await text(ui, 'focus:a#1:why')).toContain('AI 会话')
    // 卡片里主任务的 ↗ 常显
    // 直接装着 ↗ 的那个 Box
    const linkBox = async (key: string) => walk(await ui.find({ type: 'Box', key }))
      .find(n => n.type === 'Box' && (n.children ?? []).some(c => (c as FoundElement)?.type === 'Link'))
    expect((await linkBox('focus:a#1'))?.props.display).toBeUndefined()
    // 任务行的链接画在编号上，常驻；没有悬停才出现的东西，悬停时排版不能动（owner 2026-10-12）
    const taskTree = walk(await ui.find({ type: 'Box', key: 'task:a#1' }))
    expect(taskTree.filter(n => n.type === 'Link').map(n => [n.props.label, n.props.href])).toEqual([['1', `${WEB}/#/overview?project=p1&focus=a%231`]])
    expect(taskTree.some(n => n.props?.display === 'none')).toBe(false)
    // 状态色调（面板稿 v2）：运行中的行左侧一道橙色竖条（一格宽的色块，换行时撑满行高）、铺橙色底；
    // 展开的未开始子任务 1.2 沿用父任务的竖条与底色（owner 2026-10-12），图标仍是自己的灰色
    const texts = async (key: string) => walk(await ui.find({ type: 'Box', key })).filter(n => n.type === 'Text')
    const box = async (key: string) => (await ui.find({ type: 'Box', key }))!.props
    const bar = async (key: string) => walk(await ui.find({ type: 'Box', key })).find(n => n.type === 'Box' && n.props?.key === 'bar')?.props
    expect((await bar('task:a#1'))?.backgroundColor).toBe('claude')
    expect((await bar('task:a#1'))?.width).toBe(1)
    expect((await box('task:a#1')).alignItems).toBe('stretch')
    expect((await bar('task:a#1.2'))?.backgroundColor).toBe('claude')
    expect((await box('task:a#1.2')).backgroundColor).toBe((await box('task:a#1')).backgroundColor)
    expect((await texts('task:a#1.2')).find(n => (n.children ?? []).join('') === '\u25CB 未开始')?.props.color).toBe('inactive')
    // 桌面铺带透明度的底色；终端按主题深浅取（读不出就不铺）
    if (surface === 'desktop') expect((await box('task:a#1')).backgroundColor).toBe('#d9775724')
    else expect([undefined, '#3a2a22', '#fcefe9']).toContain((await box('task:a#1')).backgroundColor)
    // 高亮：主任务在正文里的行加粗（不再反色）；桌面再描一圈橙色细框，终端不描（边框会多占两行）
    const row = await texts('task:a#1')
    expect(row.some(n => n.props.bold === true)).toBe(true)
    expect(row.some(n => n.props.inverse === true)).toBe(false)
    expect((await box('task:a#1')).borderColor).toBe(surface === 'desktop' ? 'claude' : undefined)
    expect((await box('task:a#1.2')).borderColor).toBeUndefined()
    // 块内细缝：1.2 是 1 展开的子任务，桌面与上一行隔一条细缝，终端不隔（最小单位是一行）
    expect((await box('task:a#1.2')).marginTop).toBe(surface === 'desktop' ? 0.25 : 0)
    // 前景色相与网页一致（owner 2026-10-12）：等待 review 紫、等待合并青；诊断问题项另用黄底
    expect([FG.review, FG.merge, FG.run, FG.done]).toEqual(['merged', 'planMode', 'claude', 'success'])
    // 聚焦卡片的边框用主任务的状态色
    expect((await box('focus-card')).borderColor).toBe('claude')
    expect(walk(await ui.find({ type: 'Box', key: 'task:a#1.2' })).some(n => n.props?.bold === true)).toBe(false)

    // 本会话 S1 没有关联：卡片说「本会话还没关联到任务」，文档全部折叠
    w.serve(summary({}))
    await tick(w)
    await ui.redraw()
    expect(await text(ui, 'focus')).toContain('本会话还没关联到任务')
    expect(await keys(ui)).not.toContain('task:a#1')
    await ui.unmount()
  })

  test(`[${surface}] 收起父任务 1 后聚焦转到 1.2：1 自动展开、滚到 1.2；聚焦不变不滚`, async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await mount($, w, surface)
    expect(await scrollTarget(ui, w)).toBe('task:a#1')
    // 滚成之后插件清 pendingScroll（见 scrollTarget 的注释：这一步在测试里代做）
    put(w, 'pendingScroll', null)
    await ui.press({ key: 'task:a#1' })
    expect(get(w, 'toggled')).toEqual(['task:a#1'])
    // 聚焦不变：再轮询、再画都不滚，也不撤销收起
    await tick(w)
    await ui.redraw()
    expect(get(w, 'toggled')).toEqual(['task:a#1'])
    expect(await keys(ui)).not.toContain('task:a#1.2')
    expect(await scrollTarget(ui, w)).toBe(null)

    w.serve(summary({ 'a#1.2': RUN('S1') }))
    await tick(w)
    expect(get(w, 'toggled')).toEqual([])
    await ui.redraw()
    expect(await keys(ui)).toEqual(expect.arrayContaining(['task:a#1', 'task:a#1.2']))
    expect(await scrollTarget(ui, w)).toBe('task:a#1.2')
    await ui.unmount()
  })

  test(`[${surface}] 在诊断视图时聚焦变化不滚，回到总览后滚一次`, async ($, on) => {
    const w = world(on)
    await start($, w)
    put(w, 'view', 'diag')
    put(w, 'pendingScroll', null)
    w.serve(summary({ 'a#2': RUN('S1') }))
    await tick(w)
    expect(get(w, 'pendingScroll')).toBe('a#2')
    const ui = await mount($, w, surface)
    expect(await scrollTarget(ui, w)).toBe(null)
    expect(get(w, 'pendingScroll')).toBe('a#2')
    await ui.press({ key: 'go:overview' })
    await ui.redraw()
    expect(await scrollTarget(ui, w)).toBe('task:a#2')
    put(w, 'pendingScroll', null)
    await ui.redraw()
    expect(await scrollTarget(ui, w)).toBe(null)
    await ui.unmount()
  })

  test(`[${surface}] 需要确认：c 默认折叠，展开后每组最多 30 条，其余「另有 N 条」带链接`, async ($, on) => {
    const conflicts = [
      ...Array.from({ length: 33 }, () => ({ type: 'c', taskKey: 'a#1', detail: 'only doc' })),
      { type: 'a', taskKey: 'b#1', detail: 'merged not ticked' },
    ]
    const w = world(on, { p1: summary({ 'a#1': RUN('S1') }, { conflicts }) })
    await start($, w)
    put(w, 'view', 'check')
    const ui = await mount($, w, surface)
    expect(await text(ui, 'nav:check')).toContain('34')
    let k = await keys(ui)
    expect(k).toContain('check:c')
    expect(k).toContain('check:a:0')
    expect(k).not.toContain('check:c:0')
    await ui.press({ key: 'check:c' })
    expect(get(w, 'toggled')).toEqual(['check:c'])
    await ui.redraw()
    k = await keys(ui)
    expect(k).toContain('check:c:29')
    expect(k).not.toContain('check:c:30')
    expect(await text(ui, 'check:c:more')).toContain('另有 3 条')
    const more = walk(await ui.find({ type: 'Box', key: 'check:c:more' })).find(n => n.type === 'Link')
    expect(String(more?.props.href)).toBe(`${WEB}/#/check?project=p1&type=c`)
    await ui.unmount()
  })

  test(`[${surface}] 预算截断：全部展开超出 90,000 字时停在整行，末尾「其余 N 项」带链接`, async ($, on) => {
    const w = world(on, { p1: summary({ 'a#1': RUN('S1') }, { big: 600 }) })
    await start($, w)
    put(w, 'toggled', ['doc:z'])
    const ui = await mount($, w, surface)
    const k = await keys(ui)
    expect(k).toContain('task:z#1')
    expect(k).not.toContain('task:z#600')
    expect(await text(ui, 'more')).toMatch(/其余 \d+ 项/)
    const link = walk(await ui.find({ type: 'Box', key: 'more' })).find(n => n.type === 'Link')
    expect(String(link?.props.href)).toBe(`${WEB}/#/overview?project=p1`)
    await ui.unmount()
  })

  test(`[${surface}] 全部展开的大摘要：整棵树（文字 + key + 链接地址）≤ 100,000，末尾提示行与每个任务行编号上的链接都在`, async ($, on) => {
    const w = world(on, { p1: summary({ 'a#1': RUN('S1') }, { big: 800 }) })
    await start($, w)
    put(w, 'toggled', ['doc:z', 'doc:b', 'grp:a/g2'])
    const ui = await mount($, w, surface)
    expect(treeChars(await ui.drawn())).toBeLessThanOrEqual(100000)
    const k = await keys(ui)
    const tasks = k.filter(x => x.startsWith('task:'))
    expect(tasks.length).toBeGreaterThan(100)
    expect(tasks).not.toContain('task:z#800')
    // 引擎截断时 Box 会丢 key、链接只画文字：末尾提示行带 key 且是链接，说明整棵树没被截
    expect(k[k.length - 1]).toBe('more')
    expect(walk(await ui.find({ type: 'Box', key: 'more' })).some(n => n.type === 'Link')).toBe(true)
    for (const key of tasks) {
      const link = walk(await ui.find({ type: 'Box', key })).find(n => n.type === 'Link')
      expect(String(link?.props.href)).toStartWith(`${WEB}/#/overview?project=p1&focus=`)
    }
    await ui.unmount()
  })

  test(`[${surface}] 诊断：有问题的行用警告色`, async ($, on) => {
    const w = world(on, { p1: summary({ 'a#1': RUN('S1') }, { configWarnings: ['bad field'] }) })
    await start($, w)
    put(w, 'view', 'diag')
    const ui = await mount($, w, surface)
    const colors = async (key: string) => walk(await ui.find({ type: 'Box', key })).filter(n => n.type === 'Text').map(n => n.props.color)
    expect(await colors('diag:config')).toContain('warning')
    expect(await colors('diag:config:0')).toContain('warning')
    expect(await colors('diag:workspaces')).not.toContain('warning')
    expect(await colors('diag:docs')).not.toContain('warning')
    await ui.unmount()
  })

  test(`[${surface}] 认不出项目时列项目按钮，按下后认成该项目`, async ($, on) => {
    const w = world(on, { id: 'S9', cwd: '/w/elsewhere' })
    await start($, w)
    const ui = await mount($, w, surface)
    expect(await text(ui, 'pick')).toContain('当前目录不在看板的项目里')
    expect(await keys(ui)).toEqual(expect.arrayContaining(['pick:p1', 'pick:p2']))
    await ui.press({ key: 'use:p2' })
    expect(get(w, 'picked')).toBe('p2')
    await ui.redraw()
    expect(await text(ui, 'title')).toContain('Two')
    expect(await keys(ui)).not.toContain('pick:p1')
    await ui.unmount()
  })
}

// N31 PR review：状态文字一列同宽，英文最长的「◑ Awaiting review」也放得下，编号与标题起点不因状态错开
const cols = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)
for (const surface of SURFACES) {
  test(`[${surface}] 状态文字一列同宽：英文界面最长的状态也不超出`, { options: { lang: 'en' } }, async ($, on) => {
    const s = summary({ 'a#1': RUN('S1') })
    s.tasks.find(v => v.key === 'a#1.2')!.status = 'in_review'
    const w = world(on, { p1: s })
    await start($, w)
    const ui = await mount($, w, surface)
    const marks = await Promise.all(['focus:a#1', 'task:a#1', 'task:a#1.2'].map(async (key) => {
      const box = walk(await ui.find({ type: 'Box', key })).find(n => n.type === 'Box' && n.props?.minWidth !== undefined)!
      return { width: box.props!.minWidth as number, text: walk(box).filter(n => n.type === 'Text').flatMap(n => n.children ?? []).join('') }
    }))
    expect(marks.map(m => m.text)).toContain('◑ Awaiting review')
    expect(new Set(marks.map(m => m.width)).size).toBe(1)
    for (const m of marks) expect(m.width).toBeGreaterThanOrEqual(cols(m.text))
    await ui.unmount()
  })
}
