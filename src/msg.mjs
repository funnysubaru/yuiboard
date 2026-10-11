// 会显示到页面上的中文句子用 msg 标记（N22 任务 22.3）：运行时原样拼成中文，服务端口径不变；
// 前端 tx() 按 web/i18n-*.mjs 里同一模板翻成日 / 英，test/i18n.test.mjs 据此检查词典是否齐全。
// 一句话写成一个模板，别拼接半句（拼出来的整句对不上模板就翻不了）。
export const msg = (strings, ...vals) => (typeof strings === 'string' ? strings : String.raw({ raw: strings }, ...vals));

// 句子里由服务端拼的引用 / 编号列表用 joinList() 连：分隔符是不可见标记 U+2063 + 中文顿号，
// 前端 tx() 认这个标记，英文换成「, 」、中日去掉标记。U+2063 当转义符用：列表项原文里的 U+2063 写成两个，
// 前端还原成一个，所以文档名等引用原文里的「、」和 U+2063 都不会被当成分隔符（PR #34 review）。
export const LIST_MARK = '\u2063';
export const joinList = (items) => items.map((x) => String(x).replaceAll(LIST_MARK, LIST_MARK + LIST_MARK)).join(`${LIST_MARK}、`);
