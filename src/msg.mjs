// 会显示到页面上的中文句子用 msg 标记（N22 任务 22.3）：运行时原样拼成中文，服务端口径不变；
// 前端 tx() 按 web/i18n-*.mjs 里同一模板翻成日 / 英，test/i18n.test.mjs 据此检查词典是否齐全。
// 一句话写成一个模板，别拼接半句（拼出来的整句对不上模板就翻不了）。
export const msg = (strings, ...vals) => (typeof strings === 'string' ? strings : String.raw({ raw: strings }, ...vals));
