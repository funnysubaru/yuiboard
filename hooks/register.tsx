import type { EngineInterface as Engine, Register } from 'claude-code'

import { setLang } from '../web/i18n.mjs'
import { applyEdit, docIssues, isTaskDoc, parseDoc, prTitles, titleIssues } from '../src/guard.mjs'
import { commandText, conventionBrief, focusOf, focusPath, guardDocText, guardTitleText, langOf, paneOf, pickProject } from './model.mjs'
import type { View } from './state.d.ts'

// 钩子模块（design §5）：会话开始 / 结束、/yuiboard、轮询、面板绘制。只做摆放，不含文案。
// 硬规则：本文件的代码不得含中日文字符（需求 8.3），注释除外；界面文案一律由 hooks/model.mjs 产出。
const PANE = 'yuiboard'
const EVERY_MS = 5000

// $.state 的键（hooks/state.d.ts）；validate 要求 plugin / key 在源码里是字面量
const TOGGLED = { plugin: 'yuiboard', key: 'toggled' } as const
const PICKED = { plugin: 'yuiboard', key: 'picked' } as const
const PENDING = { plugin: 'yuiboard', key: 'pendingScroll' } as const
const SESSION = { plugin: 'yuiboard', key: 'sessionId' } as const
const FOCUS_KEY = { plugin: 'yuiboard', key: 'focusKey' } as const
const REV = { plugin: 'yuiboard', key: 'rev' } as const
const AUTO_OPENED = { plugin: 'yuiboard', key: 'autoOpened' } as const
const VIEW = { plugin: 'yuiboard', key: 'view' } as const

/** 顶部横幅的三种原因（design §7）；paneOf 负责翻译成文字 */
export type Problem =
  | { kind: 'oversize' }
  | { kind: 'offline'; url: string; message: string }
  | { kind: 'http'; status: number; messages: string[] }

// 摘要是 Board 的同构子集（design §3.1），形状由 web/app.mjs 的口径函数认，这里不重复声明
type Summary = any
export type Projects = { errors: unknown[]; warnings: unknown[]; projects: { id: string; name: string; [k: string]: unknown }[] }
export type Focus = { keys: string[]; recent: boolean }

/** 轮询得到的数据：模块变量，不进 $.state（design §3.2）。任务 6 的 ui.render 读它组装 paneOf 的输入 */
export type Polled = {
  /** 服务地址，去掉末尾斜杠 */
  url: string
  /** 面板语言 zh / ja / en */
  lang: string
  /** 最近一次成功的 /api/projects 响应 */
  projects: Projects | null
  /** 各项目最近一次成功的摘要与它的 ETag；出错时保留上次的 */
  summaries: Record<string, { etag: string | null; summary: Summary }>
  /** 认出的项目（手动选的优先），认不出为 null */
  projectId: string | null
  /** 当前会话在该项目里的聚焦任务；还没认出项目或没有摘要时为 null */
  focus: Focus | null
  /** 本轮请求的问题；空数组 = 一切正常 */
  problems: Problem[]
}

// 每次 session.start 重来一份：真实重载时模块变量本就清空，测试里再触发 session.start 等同重载
// seenId：本模块上一轮见到的会话 id。/clear、/resume、/branch 会清空 $.state 而模块变量还在，只看 $.state 会把
// 会话切换当成首次取得（PR #38 review P1）；重载后模块是新的（seenId 为 null），才退回 $.state 里记的 id
type Live = Polled & { busy: boolean; timer: { cancel: () => void } | null; projectsText: string | null; switchedFrom: string | null | undefined; seenId: string | null }
const fresh = (url: string, lang: string): Live => ({
  url, lang, projects: null, summaries: {}, projectId: null, focus: null, problems: [],
  busy: false, timer: null, projectsText: null, switchedFrom: undefined, seenId: null,
})
let S: Live = fresh('', 'en')
/** 身份代号：session.end、会话切换、重载都加一；响应回来时代号不同就丢弃（旧身份的迟到响应） */
let gen = 0

/** 只读取值：给面板绘制用 */
export const polled = (): Readonly<Polled> => S

type Got = { kind: 'ok'; value: unknown; etag: string | null } | { kind: 'same' } | { kind: 'bad'; problem: Problem }

/** GET 一个 JSON；304 不解析。4 MiB 上限：Content-Length 超限时 fetch 以「is over the 4194304-byte limit」拒绝，否则截断成坏 JSON */
async function getJson($: Engine, url: string, path: string, etag: string | null): Promise<Got> {
  let r
  try {
    r = await $.http.fetch(url + path, etag ? { headers: { 'If-None-Match': etag } } : undefined)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'bad', problem: /4194304-byte limit/.test(message) ? { kind: 'oversize' } : { kind: 'offline', url, message } }
  }
  if (r.status === 304) return { kind: 'same' }
  if (!r.ok) {
    let messages: string[] = []
    try {
      const m = JSON.parse(r.text)?.messages
      if (Array.isArray(m)) messages = m.map(String)
    } catch {
      // 响应体不是 JSON：只报状态码
    }
    return { kind: 'bad', problem: { kind: 'http', status: r.status, messages } }
  }
  try {
    return { kind: 'ok', value: JSON.parse(r.text), etag: r.headers.etag ?? null }
  } catch {
    return { kind: 'bad', problem: { kind: 'oversize' } }
  }
}

/** 一轮轮询（design §3.2）；上一轮未完就跳过 */
async function poll($: Engine) {
  const s = S
  if (s.busy) return
  s.busy = true
  try {
    await round($, s)
  } finally {
    s.busy = false
  }
}

async function round($: Engine, s: Live) {
  // 1. 会话身份：/clear、/resume、/branch 之后 id 换新且不再触发 session.start，所以每轮重读。
  // 上一次见过的 id 先看模块里的（$.state 可能刚被引擎清空），模块是重载后新的才看 $.state
  const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  const known = (await $.state.get(SESSION)).value ?? null
  const prev = s.seenId ?? known
  s.seenId = id
  if (known !== id) await $.state.set(SESSION, id)
  // prev 为 null 是首次取得（含重载后第一轮）：只记下，picked / toggled / view 原样保留
  if (prev !== null && prev !== id) {
    gen++
    if (s.switchedFrom === undefined) s.switchedFrom = s.projectId
    s.projectId = null
    s.focus = null
    await $.state.set(PICKED, null)
    await $.state.set(PENDING, null)
    await $.state.set(FOCUS_KEY, null)
  }
  if (s !== S) return
  const my = gen
  let changed = false

  // 2. 项目列表
  const list = await getJson($, s.url, '/api/projects', null)
  if (my !== gen) return
  if (list.kind !== 'ok') {
    if (list.kind === 'bad') changed = setProblems(s, [list.problem]) || changed
    if (changed) await bump($)
    return
  }
  const text = JSON.stringify(list.value)
  if (text !== s.projectsText) {
    s.projectsText = text
    s.projects = list.value as Projects
    changed = true
  }
  const ids = (s.projects?.projects ?? []).map(p => p.id)

  // 3. 摘要：认出项目后只拉该项目，之前拉全部；各带上次的 ETag
  const picked = (await $.state.get(PICKED)).value ?? null
  if (s.projectId !== null && !ids.includes(s.projectId)) s.projectId = null
  const current = picked !== null && ids.includes(picked) ? picked : s.projectId
  const targets = current !== null ? [current] : ids
  const got = await Promise.all(targets.map(p => getJson($, s.url, `/api/projects/${encodeURIComponent(p)}/summary`, s.summaries[p]?.etag ?? null)))
  if (my !== gen) return
  const problems: Problem[] = []
  targets.forEach((p, i) => {
    const g = got[i]
    if (!g || g.kind === 'same') return
    if (g.kind === 'bad') problems.push(g.problem)
    else {
      s.summaries[p] = { etag: g.etag, summary: g.value }
      changed = true
    }
  })
  changed = setProblems(s, problems) || changed

  // 4. 认项目：手动选的优先，其次 devboard 的会话归属与 cwd（model.pickProject）；认出后不再变，直到会话切换
  const before = s.projectId
  s.projectId = current ?? pickProject(ids.map(p => ({ id: p, summary: s.summaries[p]?.summary ?? null })), id, cwd)
  if (s.projectId !== before) changed = true
  if (s.projectId !== null && s.switchedFrom !== undefined) {
    // 会话切换后认出的项目与之前的不同：折叠状态属于旧项目，清空
    if (s.projectId !== s.switchedFrom) await $.state.set(TOGGLED, [])
    s.switchedFrom = undefined
  }
  // 认出项目才自动打开（owner 已定 3）。新会话发出第一条消息之前 devboard 读不到它，cwd 也常不在工作区下，
  // 会话开始那一轮往往认不出；所以不只看首轮，而是本会话第一次认出时开一次。记下会话 id：重载不重复开，
  // 用户关掉后也不再弹；换了会话（/clear 等）认出后再开一次
  if (s.projectId !== null && (await $.state.get(AUTO_OPENED)).value !== id) {
    await $.state.set(AUTO_OPENED, id)
    await $.ui.open({ id: PANE, title: 'YUIBoard' })
  }

  // 5. 聚焦：第一个聚焦任务换了 → 展开它的整条路径（撤销用户对这些节点的收起）并记下待滚动目标（design §5.2）
  const summary = s.projectId !== null ? s.summaries[s.projectId]?.summary : undefined
  const focus: Focus | null = summary ? focusOf(summary, id) : null
  if (JSON.stringify(focus) !== JSON.stringify(s.focus)) changed = true
  s.focus = focus
  const key = focus?.keys[0]
  // 处理过的聚焦键存 $.state：重载后聚焦没变就不会再撤销用户的收起、不会再滚
  const handled = (await $.state.get(FOCUS_KEY)).value ?? null
  if (summary !== undefined && key === undefined) {
    // 拿到了摘要、本会话却没有聚焦：忘掉已处理的键与待滚动目标，同一任务再出现时按「出现」处理（PR #38 review P2）。
    // 没拿到摘要（离线、还没认出项目）时不动，免得重载后首轮连不上就把同一聚焦当成新出现
    if (handled !== null) await $.state.set(FOCUS_KEY, null)
    if (((await $.state.get(PENDING)).value ?? null) !== null) await $.state.set(PENDING, null)
  } else if (key !== undefined && key !== handled) {
    const path = new Set(focusPath(summary, key))
    const toggled = (await $.state.get(TOGGLED)).value ?? []
    await $.state.set(TOGGLED, toggled.filter(k => !path.has(k)))
    await $.state.set(PENDING, key)
    await $.state.set(FOCUS_KEY, key)
  }

  // 6. 有变化 → rev 加一，面板重画
  if (changed) await bump($)
}

function setProblems(s: Live, problems: Problem[]) {
  if (JSON.stringify(problems) === JSON.stringify(s.problems)) return false
  s.problems = problems
  return true
}

async function bump($: Engine) {
  await $.state.set(REV, ((await $.state.get(REV)).value ?? 0) + 1)
}

/**
 * N27：认出了项目、拿到了摘要、且最近一轮轮询没有出错时，给拦截用的项目配置投影与摘要；否则 null（放行）。
 * 轮询出错（服务连不上、4xx / 5xx、摘要超限）时面板照旧显示上次的内容，拦截却要停：缓存可能已过时，
 * 「服务连不上就放行」（需求 2.6，公开 PR #8 review）。下一轮成功后自动恢复。
 */
function guarded() {
  if (S.projectId === null || S.problems.length > 0) return null
  const project = S.projects?.projects.find(p => p.id === S.projectId)
  const summary = S.summaries[S.projectId]?.summary
  return project !== undefined && summary ? { project: project as any, summary } : null
}

/**
 * N27 写任务文档的拦截（需求 2.1、2.2）：不是本项目的任务文档就放行；是的话读原文（只读），算出写后全文，
 * 本次新引入的约定问题非空就拦。apply 返回 null（Edit 对不上原文）时放行，交给工具自己报错。
 */
async function docGuard($: Engine, file: string, apply: (before: string) => string | null) {
  const g = guarded()
  if (!g) return null
  // 文件所在的检出：工作区本身，或它的 git worktree（owner 多在 worktree 里开发，看板读的是工作区，两边同样按约定写）
  const root = await checkoutRoot($, file.slice(0, file.lastIndexOf('/')), g.summary.workspaces ?? [])
  const doc = root !== null ? isTaskDoc(file, g.project, [{ path: root }]) : null
  if (!doc) return null
  const before = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
  const after = apply(before)
  if (after === null) return null
  const issues = docIssues(before, after, { ...doc, milestoneCodePattern: g.project.milestoneCodePattern, prerequisiteIdPattern: g.project.prerequisiteIdPattern })
  return issues.length ? { deny: guardDocText(file, issues, $.plugin.root) } : null
}

/**
 * N27 PR 标题的拦截（需求 2.3）：命令里读得出的 gh pr create / edit 标题，按本项目的文档认引用。
 * 看板读的是工作区，PR 却常在 worktree / 分支上新加 spec 与任务再引用它们：按摘要查出问题时，再用当前检出里的
 * 任务文档（同 docId 的取当前检出的版本）重查一遍，还有问题才拦。
 */
async function titleGuard($: Engine, command: string) {
  const g = guarded()
  if (!g) return null
  for (const { title, base } of prTitles(command)) {
    const check = (docs: object[]) => titleIssues(title, docs, g.project.branchLines ?? [], base)
    let issues = check(g.summary.docs ?? [])
    if (!issues.length) continue
    const root = await checkoutRoot($, await $.session.cwd(), g.summary.workspaces ?? [])
    if (root !== null) {
      const local = await checkoutDocs($, root, g.project)
      const ids = new Set(local.map(d => d.docId))
      issues = check([...(g.summary.docs ?? []).filter((d: { docId: string }) => !ids.has(d.docId)), ...local])
    }
    if (issues.length) return { deny: guardTitleText(title, issues, $.plugin.root) }
  }
  return null
}

/**
 * from（目录）所在检出的根：本身是某个工作区，或是工作区的 git worktree（`.git` 是文件，写着
 * `gitdir: <工作区>/.git/worktrees/…`）；都不是返回 null。只读：$.fs.exists / read。
 * ponytail: 不解析符号链接，工作区路径与文件路径写法不同（/var 与 /private/var）时认不出，认不出只是不检查。
 */
async function checkoutRoot($: Engine, from: string, workspaces: { path: string; ref?: string }[]) {
  const roots = workspaces.filter(w => !w.ref).map(w => w.path.replace(/\/+$/, ''))
  let dir = from.replace(/\/+$/, '')
  for (let i = 0; i < 64 && dir.startsWith('/'); i++) {
    if (roots.includes(dir)) return dir
    if (await $.fs.exists(`${dir}/.git`)) {
      // 主仓库的 .git 是目录，read 会拒绝：那是别的仓库，不是本项目的 worktree
      const git = await $.fs.read(`${dir}/.git`).catch(() => '')
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(typeof git === 'string' ? git : '')
      return m && roots.some(r => m[1]!.startsWith(`${r}/.git/worktrees/`)) ? dir : null
    }
    if (dir === '' || dir === '/') break
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
  return null
}

/** 某个检出里按 docSources 能发现的任务文档，解析成摘要里文档的形状（只读） */
async function checkoutDocs($: Engine, root: string, project: any) {
  const files: string[] = []
  for (const s of project.docSources ?? []) {
    if (s.type === 'task-list') {
      files.push(...(s.files ?? []).map((f: string) => `${root}/${f}`))
      continue
    }
    const dir = `${root}/${s.path}`
    for (const en of await $.fs.list(dir).catch(() => [])) {
      if (s.type === 'spec-dir' && en.kind === 'dir') files.push(`${dir}/${en.name}/tasks.md`)
      else if (s.type !== 'spec-dir' && en.kind === 'file' && en.name.endsWith('.md')) files.push(`${dir}/${en.name}`)
    }
  }
  const docs: { docId: string }[] = []
  for (const f of files) {
    const doc = isTaskDoc(f, project, [{ path: root }])
    if (!doc || !(await $.fs.exists(f))) continue
    const text = await $.fs.read(f)
    if (typeof text === 'string') docs.push(parseDoc(text, { ...doc, milestoneCodePattern: project.milestoneCodePattern, prerequisiteIdPattern: project.prerequisiteIdPattern }) as { docId: string })
  }
  return docs
}

/** 界面语言（owner 已定 2）：配置项 lang；auto 时依次看 Claude 设置的 language、系统区域 */
async function pickLang($: Engine, configured: unknown) {
  if (configured === 'zh' || configured === 'ja' || configured === 'en') return configured
  let language: unknown
  try {
    language = (await $.settings.read()).language
  } catch {
    // 读不了设置就只看区域
  }
  let locale: string | undefined
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    // 环境没有 Intl
  }
  // model.mjs 是 JS，TS 从混合元组推出的返回类型偏宽；实际只会是 zh / ja / en
  return langOf(language, locale) as string
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // 重新开始（真实重载时这些本就是空的）：旧定时器停掉，旧身份的请求作废
    S.timer?.cancel()
    gen++
    const lang = await pickLang($, options.lang)
    setLang(lang)
    // 空串或只有空白按未设置处理：plugin configure 存进去的 "" 用 ?? 挡不住，会连到空地址
    S = fresh((String(options.url ?? '').trim() || 'http://127.0.0.1:4317').replace(/\/+$/, ''), lang)
    await $.command.register({ name: 'yuiboard', description: 'Open the YUIBoard pane' })
    const s = S
    // 首轮放到后台：服务挂起时 fetch 最长等 30 秒，不能拖住会话开始。自动打开在 round 里认出项目时做
    void poll($)
    s.timer = $.clock.every(EVERY_MS, () => void poll($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // 身份作废：进行中的请求回来后丢弃；$.state 的 sessionId 留着旧值，下一轮读到新 id 按会话切换处理
    gen++
    return next(e)
  })

  // N27 写之前（需求 1）：认出被看的项目后，在系统提示末尾加约定摘要。内容只随项目变，同一会话内不反复打破提示缓存
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const project = options.guard === 'off' || S.projectId === null ? undefined : S.projects?.projects.find(p => p.id === S.projectId)
    if (project === undefined) return r
    // 组要点出错就照原样返回：不能因为 YUIBoard 让系统提示组不出来（需求 2.6 同理）
    try {
      return { sections: [...r.sections, { id: 'yuiboard:convention', text: conventionBrief(project, $.plugin.root), scope: 'session' as const }] }
    } catch {
      return r
    }
  })

  // N27 写的时候拦截（需求 2）：见 docGuard / titleGuard。检查本身出错一律放行（需求 2.6），不因 YUIBoard 卡住用户
  const off = options.guard === 'off'
  on('tool.call', { tool: 'Write' }, async ($, e, next) => (off ? null : await docGuard($, e.file_path, () => e.content)) ?? next(e))
    .catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => (off ? null
    : await docGuard($, e.file_path, before => applyEdit(before, e.old_string, e.new_string, e.replace_all === true))) ?? next(e))
    .catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (off ? null : await titleGuard($, e.command)) ?? next(e))
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'yuiboard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'YUIBoard' })
    return { text: commandText() }
  })

  // 面板（design §5、§6；owner 2026-10-12 定的面板稿）：paneOf 给出全部行与文字，这里只按行摆放、上色、接按钮；不含任何文案。
  // 颜色只用引擎主题键，终端与桌面都跟着用户的深色 / 浅色主题走
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // 绘制时读的 $.state 都会订阅：rev（摘要换了）、视图、折叠、待滚动目标变了就重画
    await $.state.get(REV)
    const view: View = (await $.state.get(VIEW)).value ?? 'overview'
    const toggled = (await $.state.get(TOGGLED)).value ?? []
    const pending = (await $.state.get(PENDING)).value ?? null
    const p = polled()
    const pane: Pane = paneOf({
      summary: p.projectId !== null ? (p.summaries[p.projectId]?.summary ?? null) : null,
      projects: p.projects, projectId: p.projectId, view, toggled, focus: p.focus, url: p.url,
      now: await $.clock.now(), problems: p.problems,
    })
    // 行底色（面板稿 v2）：桌面等远端界面用带透明度的色值，叠在任何背景上都是浅色调；
    // 终端不认透明度，按当前主题的深浅取一套，读不出深浅（跟随系统、ANSI 主题）就不铺底色
    const shade = e.surface === 'terminal' ? await terminalShade($) : null
    const bgOf = (tone: string | undefined) => (tone === undefined ? undefined
      : e.surface === 'terminal' ? (shade === null ? undefined : TINT[shade][tone]) : TINT.alpha[tone])
    const title = pane.header.find(r => r.kind === 'title')
    const open = pane.header.find(r => r.kind === 'link')
    const navs = pane.header.filter(r => r.kind === 'nav')
    const stats = pane.header.filter(r => r.kind === 'stat')
    const rows = [...pane.body, ...(pane.more ? [pane.more] : [])]
    // 聚焦卡片的边框用主任务的状态色
    const cardTone = pane.focus.find(r => r.kind === 'focus')?.tone

    // 聚焦滚动（design §5.2 第 3、4 步）：绘制里不能写 $.state，所以放到 clock.after(0)；滚成了才清 pendingScroll。
    // 滚动回来之前又画了一帧会再排一次，多滚一次同一行无害（block 默认 nearest，已在视野内不动）
    const target = scrollKey(view, pending, rows.map(r => r.key))
    if (target !== null) {
      $.clock.after(0, () => void (async () => {
        // 面板已关等情况下 scroll 会拒绝：当作没滚成，pendingScroll 留给下一帧
        const r = await $.ui.scroll({ in: PANE, to: { key: target } }).catch(() => ({ deny: 'failed' }))
        // 等待期间聚焦又换了：留给下一帧滚新的
        if (!r.deny && (await $.state.get(PENDING)).value === pending) await $.state.set(PENDING, null)
      })())
    }

    const flip = (key: string) => async () => {
      const cur = (await $.state.get(TOGGLED)).value ?? []
      await $.state.set(TOGGLED, cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key])
    }
    // 手动选项目：立刻跑一轮轮询，认出后 rev 加一重画（上一轮未完时跳过，下一轮再认）
    const pick = (id: string) => async () => {
      await $.state.set(PICKED, id)
      await poll($)
    }
    // 缩进每级两格，最多占宽度的三分之一，深链不把行挤没
    const indent = (level: number) => Math.min(level * 2, Math.floor(e.props.bodyColumns / 3))
    // 任务类行是 [图标, 编号, 标题]：编号占同宽一列，标题对齐；诊断项名同理
    const numbered = (row: Row) => row.texts.length === 3 && NUMBERED.has(row.kind)
    const numWidth = Math.min(8, Math.max(0, ...[...pane.focus, ...rows].filter(numbered).map(r => r.texts[1]!.length)))
    const labelWidth = Math.min(20, Math.max(0, ...rows.filter(r => r.kind === 'diag' && r.level === 0).map(r => cols(r.texts[0]!)))) + 1
    // 块与块之间空一行；块内各行之间一条更窄的细缝。终端最小单位是一行，细缝只在桌面等远端界面画
    const spacing = (row: Row) => (row.gap === true ? 1 : row.sep === true && e.surface !== 'terminal' ? SEP : 0)
    const sep = (i: number) => (i > 0 ? [<Text dimColor>·</Text>] : [])
    const tone = (row: Row, i: number) => row.tones?.[i] ?? undefined

    const line = (row: Row) => {
      // 链接地址与按钮的 key 都计入引擎的 10 万字上限，model 的 rowCost / fit 已按这里的画法算过
      const href = row.href !== undefined ? localLink(row.href) : undefined
      const pad = indent(row.level)
      if (row.kind === 'pick' && row.pick !== undefined) {
        return (
          <Box key={row.key} paddingLeft={pad}>
            <Button key={`use:${row.pick}`} label={row.texts.join(' ')} onPress={pick(row.pick)} />
          </Box>
        )
      }
      // 整行文字就是链接文字（其余 N 项…、另有 N 条）
      if ((row.kind === 'link' || row.kind === 'more') && href !== undefined) {
        return (
          <Box key={row.key} paddingLeft={pad}>
            <Link href={href} label={`${row.texts.join(' ')} ↗`} />
          </Box>
        )
      }
      // 横幅与诊断的问题明细：问题要看全，照常折行
      if (row.kind === 'banner') {
        return (
          <Box key={row.key} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={pad}>
            <Text color="error">✕</Text>
            {row.texts.flatMap((s, i) => [...sep(i), <Text color={i === 0 ? 'error' : undefined}>{s}</Text>])}
            {href !== undefined && <Link href={href} label={'↗'} />}
          </Box>
        )
      }
      if (row.kind === 'diag' && row.level > 0) {
        return (
          <Box key={row.key} paddingLeft={pad + 2 + labelWidth}>
            <Text color="warning">{row.texts[0]}</Text>
          </Box>
        )
      }
      if (row.kind === 'diag') {
        const mark = row.error ? <Text color="error">✕</Text> : row.warn ? <Text color="warning">⚠</Text> : <Text color="success">✓</Text>
        return (
          <Box key={row.key} flexDirection="row" columnGap={1} marginLeft={pad} backgroundColor={bgOf(row.error ? 'stale' : row.warn ? 'warn' : undefined)}>
            {mark}
            <Box minWidth={labelWidth} flexShrink={0}><Text dimColor={!row.warn} color={row.warn ? 'warning' : undefined}>{row.texts[0]}</Text></Box>
            <Box flexShrink={1} flexGrow={1}><Text wrap="wrap" color={row.warn ? 'warning' : undefined}>{row.texts[1] ?? ''}</Text></Box>
          </Box>
        )
      }

      // 其余各行：折叠三角、[竖条、图标、编号、]文字、行尾进度 / 计数与 ↗。
      // 任务、说明类的行照常换行，续行对齐到文字起点（面板稿 v2）；文档、分组、卡片标题这类短行放不下截断
      const dim = DIM.has(row.kind)
      const head = row.texts.slice(0, -1)
      const last = row.texts.at(-1) ?? ''
      const t = row.tone
      const fg = t !== undefined ? FG[t] : undefined
      const lead = row.toggle !== undefined
        ? <Button key={row.toggle} label={row.open ? '▾' : '▸'} plain dimColor={!row.open} onPress={flip(row.toggle)} />
        : null
      const parts = head.map((s, i) => {
        if (i === 0 && row.status !== undefined) return <Text color={fg ?? COLOR[row.status]}>{s}</Text>
        // 编号就是跳到网页的入口（owner 2026-10-12 晚）：常驻，不随悬停变化
        if (i === 1 && numbered(row)) {
          return (
            <Box minWidth={numWidth} flexShrink={0}>
              {href !== undefined ? <Link href={href} label={s} /> : <Text dimColor>{s}</Text>}
            </Box>
          )
        }
        return <Text color={tone(row, i)} dimColor={dim || tone(row, i) === 'subtle'} bold={row.kind === 'checkGroup'}>{s}</Text>
      })
      const lastTone = tone(row, row.texts.length - 1) ?? (row.warn ? 'warning' : undefined)
      // 已完成的标题转灰，作废的加删除线
      const faded = t === 'done' || t === 'void'
      // 行尾 ↗ 只在聚焦卡片的主任务上，常显；其余行的链接在编号上。不放悬停才出现的东西，悬停时排版不能动（owner 2026-10-12）
      const link = href === undefined || (numbered(row) && row.kind !== 'focus') ? null : <Link href={href} label={'↗'} />
      // 主任务在任务树里：桌面描一圈橙色细框；终端的边框要多占两行，只加粗
      const outline = row.highlight === true && row.kind === 'task' && e.surface !== 'terminal'
      // 竖条与底色按 band（展开的子孙沿用父任务的）；竖条是一格宽的色块，换行的行也从头到尾连着
      const b = row.band ?? t
      return (
        <Box key={row.key} flexDirection="row" alignItems="stretch" columnGap={1} marginLeft={pad} marginTop={spacing(row)} backgroundColor={bgOf(b)}
          {...(outline ? { borderStyle: 'round', borderColor: 'claude' } : {})}>
          {b !== undefined && <Box key="bar" width={1} flexShrink={0} backgroundColor={b === 'todo' || b === 'void' ? undefined : FG[b]} />}
          {lead}
          {parts}
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap={WRAP.has(row.kind) ? 'wrap' : 'truncate-end'} color={lastTone} dimColor={dim || faded || lastTone === 'subtle'}
              strikethrough={t === 'void'} bold={row.kind === 'checkGroup' || row.highlight === true}>{last}</Text>
          </Box>
          {row.end !== undefined && <Text color={row.endTone} dimColor={row.endTone === undefined}>{row.end}</Text>}
          {link}
        </Box>
      )
    }

    const nav = (row: Row) => {
      const v = row.view as View
      return (
        <Box key={row.key} flexDirection="row" columnGap={1}>
          <Button key={`go:${v}`} label={row.texts[0]!} plain variant={row.active ? 'primary' : undefined} dimColor={!row.active} onPress={() => void $.state.set(VIEW, v)} />
          {row.texts[1] !== undefined && <Text color={tone(row, 1)}>{row.texts[1]}</Text>}
        </Box>
      )
    }
    // 总览数字一行：各段之间「·」
    const stat = (row: Row, n: number) => (
      <Box key={row.key} flexDirection="row" columnGap={1}>
        {sep(n)}
        {row.texts.map((s, i) => (
          <Text color={tone(row, i) ?? (i === 0 && row.status !== undefined ? COLOR[row.status] : row.warn ? 'warning' : undefined)} dimColor={tone(row, i) === 'subtle'}>{s}</Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box key="top" flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box key="title" flexDirection="row" columnGap={1} flexShrink={1}>
            {title !== undefined && <Text bold>{title.texts[0]}</Text>}
            {title?.texts[1] !== undefined && <Text dimColor wrap="truncate-end">{title.texts[1]}</Text>}
          </Box>
          {open?.href !== undefined && <Box key="open" flexShrink={0}><Link href={localLink(open.href)} label={`${open.texts[0]} ↗`} /></Box>}
        </Box>
        {navs.length > 0 && <Box key="nav" flexDirection="row" flexWrap="wrap" columnGap={2}>{navs.map(nav)}</Box>}
        {stats.length > 0 && <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={1}>{stats.map(stat)}</Box>}
        {pane.banners.map(line)}
        {pane.focus.length > 0 && (
          <Box key="focus-card" flexDirection="column" borderStyle="round" paddingX={1} marginY={0}
            {...(cardTone !== undefined ? { borderColor: FG[cardTone] } : { borderDimColor: true })}>
            {pane.focus.map(line)}
          </Box>
        )}
        {rows.map(line)}
      </Box>
    )
  })
}

/** 待滚动的目标行键：只在总览、有待滚动目标、且这一帧画出了该任务行时（design §5.2）；否则 null */
export const scrollKey = (view: View, pending: string | null, drawn: string[]) =>
  pending !== null && view === 'overview' && drawn.includes(`task:${pending}`) ? `task:${pending}` : null

/** 桌面端只认 https: 与 http://localhost 的链接；本机回环地址统一写成 localhost（devboard 的 Host 白名单放行 localhost:<端口>） */
const localLink = (href: string) => href.replace(/^http:\/\/(?:127\.0\.0\.1|\[::1\]|devboard\.localhost)(?=[:/]|$)/, 'http://localhost')

/** paneOf 的一行（hooks/model.mjs 顶部 JSDoc） */
type Row = {
  key: string
  kind: string
  level: number
  texts: string[]
  status?: string
  toggle?: string
  open?: boolean
  href?: string
  warn?: boolean
  error?: boolean
  highlight?: boolean
  tones?: (string | null)[]
  tone?: string
  band?: string
  gap?: boolean
  sep?: boolean
  end?: string
  endTone?: string
  view?: View
  active?: boolean
  pick?: string
}
type Pane = { header: Row[]; banners: Row[]; focus: Row[]; body: Row[]; more: Row | null }

/** 状态 → 引擎主题色（design §6，owner 2026-10-12 定的面板稿）；作废的 status 是 void */
const COLOR: Record<string, string> = {
  done: 'success', awaiting_merge: 'planMode', in_review: 'merged', in_progress: 'claude', not_started: 'inactive', void: 'subtle',
}
/**
 * 状态色调 → 前景主题键，色相与网页一致（owner 2026-10-12）：运行中橙、停滞红、等待 review 紫、等待合并青、
 * 待同步蓝、已完成绿
 */
export const FG: Record<string, string> = {
  run: 'claude', stale: 'error', review: 'merged', merge: 'planMode', sync: 'suggestion', done: 'success', todo: 'inactive', void: 'subtle',
}
/**
 * 状态色调 → 行底色（面板稿 v2）。引擎主题里没有这类浅底色，只能自定：终端分深色 / 浅色主题两套，
 * 桌面等远端界面用带透明度的色值（#rrggbbaa），叠在哪种背景上都是浅色调。未开始、作废不铺；warn 是诊断问题项的黄底
 */
const TINT: Record<'dark' | 'light' | 'alpha', Record<string, string>> = {
  dark: { run: '#3a2a22', stale: '#3b2324', review: '#2f2638', merge: '#1e3332', sync: '#212a3b', done: '#222f21', warn: '#363020' },
  light: { run: '#fcefe9', stale: '#fcebeb', review: '#f3edfb', merge: '#e5f4f3', sync: '#eaf0fd', done: '#eaf5eb', warn: '#fbf3dd' },
  alpha: { run: '#d9775724', stale: '#e06c6c24', review: '#8b5cf624', merge: '#0ea5b724', sync: '#7aa2f724', done: '#7fb77e24', warn: '#e2b55a24' },
}
/** 终端当前主题的深浅：读 /config 的 theme 行；跟随系统、ANSI 主题等读不出时为 null */
async function terminalShade($: Engine): Promise<'dark' | 'light' | null> {
  let value: unknown
  try {
    value = (await $.config.list()).find(r => r.key === 'theme')?.value
  } catch {
    return null
  }
  if (typeof value !== 'string' || value.includes('ansi')) return null
  return value.startsWith('dark') ? 'dark' : value.startsWith('light') ? 'light' : null
}
/** 块内细缝的高度（行高的几分之一）；只在桌面等远端界面用 */
const SEP = 0.25
/** 文字照常换行的行（任务、说明类）；其余放不下截断 */
const WRAP = new Set(['task', 'focus', 'focusItem', 'focusLine', 'checkItem', 'empty'])
/** 文字整行画灰的行 */
const DIM = new Set(['focusHead', 'focusLine', 'focusToggle', 'empty'])
/** texts 为 [图标, 编号, 标题] 时编号对齐成一列的行 */
const NUMBERED = new Set(['task', 'focus', 'focusItem', 'checkItem'])
/** 终端里占的列数：中日韩全角字算两列 */
const cols = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)
