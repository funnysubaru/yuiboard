// 任务标题 / 正文的 Markdown 口径（N12）：纯数据、不碰 DOM。前端 app.mjs 据此建节点，
// 服务端 docs.mjs 用同一份「认不了的写法」判断报诊断，Claude Code mod 用 mdText 取纯文本，三处口径一致。

// 行内：`代码`、**加粗**、~~删除线~~、图片（照原文）、[文字](链接)、_斜体_；最左的先认，加粗 / 删除线 / 斜体里面递归。
// 斜体只认下划线、两侧不能紧贴字母数字或下划线：snake_case、__tests__、native_x_y 照字面；__x__ 也不当加粗。
// ponytail: 不认 *斜体* 与单个 ~ 删除线——实物里单星号多是 `*.mjs`、`cron */5` 这类通配，单 ~ 多是 1.2~1.8 这类范围。
const MD_INLINE = /`([^`]+)`|\*\*(.+?)\*\*|~~(.+?)~~|(!\[[^\]]*\]\([^)]*\))|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\p{L}\p{N}_])_(?![\s_])(.+?)(?<![\s_])_(?![\p{L}\p{N}_])/gu;

/** 行内解析 → [字符串 | { tag: 'code'|'b'|'s'|'i'|'a', href?, children }]；非 http(s) 链接只留文字。 */
export function mdParse(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MD_INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] != null) out.push({ tag: 'code', children: [m[1]] });
    else if (m[2] != null) out.push({ tag: 'b', children: mdParse(m[2]) });
    else if (m[3] != null) out.push({ tag: 's', children: mdParse(m[3]) });
    else if (m[4] != null) out.push(m[4]);
    else if (m[5] != null) out.push(/^https?:\/\//.test(m[6]) ? { tag: 'a', href: m[6], children: [m[5]] } : m[5]);
    else out.push({ tag: 'i', children: mdParse(m[7]) });
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((x) => x !== '');
}

// SVG / 悬停 / 下拉只收纯文本；复用同一解析结果，保留代码里的星号和不配对的标记，不改任务原文。
const flat = (x) => (typeof x === 'string' ? x : x.children.map(flat).join(''));
export const mdText = (text) => mdParse(text ?? '').map(flat).join('');

export const MD_FENCE = /^\s*(`{3,}|~{3,})/;

// 渲染器认不了、照原文显示并标「此处未按 Markdown 渲染」的写法（N12 方向 B），诊断页「不满足约定之处」第 8 条同口径。
// HTML 只认常见标签名，<v>、<id>、<docRef> 这类占位符是普通文字。
const HTML_TAGS = 'br|div|span|img|table|details|summary|sup|sub|kbd|p|a|b|i|em|strong|ul|ol|li|code|pre|hr';
const UNRENDERED = [
  ['heading', /^#{1,6}\s/],
  ['hr', /^([-*_])(?:[ \t]*\1){2,}$/],
  ['image', /!\[[^\]]*\]\([^)]*\)/],
  ['footnote', /\[\^[^\]\s]+\]/],
  ['html', new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^<>]*)?/?>`, 'i')],
];

/** 一行（引用记号、行内代码不算）里认不了的写法：'heading' | 'hr' | 'image' | 'footnote' | 'html' | null。 */
export function mdUnrendered(line) {
  const s = line.trim().replace(/^(?:>\s*)+/, '').replace(/`[^`]*`/g, '``');
  return UNRENDERED.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** 一段正文里认不了的行（代码块里的不算）：[{ i: 下标, kind }]。 */
export function mdUnrenderedLines(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = MD_FENCE.exec(line.replace(/^\s*(?:>\s?)+/, ''));
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
    if (f) { fence = f[1]; return; }
    const kind = mdUnrendered(line);
    if (kind) out.push({ i, kind });
  });
  return out;
}
