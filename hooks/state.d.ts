// $.state 的类型约定（design §5.1）：只放视图、折叠、会话 id 这类小值；摘要本体放在钩子模块的变量里。
export type View = 'overview' | 'pr' | 'check' | 'diag'

declare module 'claude-code' {
  interface PluginState {
    yuiboard: {
      /** 当前视图 */
      view: View
      /** 与默认相反的折叠键（doc: / grp: / task: / check: / pr: 前缀，前四种同网页 state.toggled） */
      toggled: string[]
      /** 手动选的项目 id */
      picked: string | null
      /** 待滚动到的任务键；回到总览那一帧再滚（design §5.2） */
      pendingScroll: string | null
      /** 最近一次取得的会话 id：区分首次取得（含 mod 重载）与会话切换（design §3.2） */
      sessionId: string | null
      /** 最近一次处理过（展开路径、记待滚动）的聚焦任务键；重载后聚焦没变就不再处理（design §5.2） */
      focusKey: string | null
      /** 已为哪个会话 id 自动打开过面板：本会话第一次认出项目时开一次，重载不重复、用户关了不再弹（owner 已定 3） */
      autoOpened: string | null
      /** 摘要换了内容就加一，触发面板重画 */
      rev: number
    }
  }
}
