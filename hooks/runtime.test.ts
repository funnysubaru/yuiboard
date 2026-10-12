// claude plugin test：在 mod 的真实运行环境（无 DOM、无 Node）里实际加载 web/ 的模块（任务 4.3），
// 并对最小 register 做冒烟。validate 只做静态检查，这里证明运行时 import 可用。
import { test, expect, mock } from 'claude-code/testing'
import { checkItems, STATUS_UI, CONFLICT_TEXT, hashFor } from '../web/app.mjs'
import { t, tx, setLang, getLang } from '../web/i18n.mjs'

test('web/app.mjs 与 web/i18n.mjs 在 mod 环境里可加载、可调用', async () => {
  // 没有 window：i18n 固定 zh，app.mjs 顶层常量按中文求值（design §4.1）
  expect(getLang()).toBe('zh')
  expect(STATUS_UI.in_progress.text).toBe('进行中')
  expect(typeof CONFLICT_TEXT).toBe('object')
  const board = { docs: [{ archived: false, tasks: [{ key: 'd#1' }] }], prs: [], conflicts: [{ type: 'c', taskKey: 'd#1' }, { type: 'c', taskKey: 'gone#1' }] }
  expect(checkItems(board, { line: null }).length).toBe(1)
  expect(hashFor('overview', 'p', 'd#1', null)).toContain('focus=')
  setLang('en')
  try {
    expect(t('总览')).toBe('Overview')
    expect(t(STATUS_UI.in_progress.text)).toBe('In progress')
    expect(typeof tx('x')).toBe('string')
  } finally {
    setLang('zh')
  }
})

test('/yuiboard 打开 yuiboard 面板，面板在终端与桌面都画得出', async ($, on) => {
  // 面板绘制要读 $.clock.now()
  mock.clock(on)
  const opened: { id: string; title?: string }[] = []
  // 测试里没有真实界面，ui.open 由测试钩子代答
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  expect((await $.command.run({
    command: 'yuiboard', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 },
  })).text).toBe('已打开 YUIBoard 面板')
  expect(opened).toEqual([{ id: 'yuiboard', title: 'YUIBoard' }])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'yuiboard', surface, component: 'Pane', requestId: 'yuiboard',
      props: { title: 'YUIBoard', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    // 还没开始会话、没有数据：只画顶栏的标题与「在浏览器打开」
    expect((await ui.find({ key: 'title' }))?.text).toBe('YUIBoard')
    await ui.unmount()
  }
})
