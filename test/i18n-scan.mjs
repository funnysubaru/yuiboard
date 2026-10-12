// i18n 静态扫描（N22 任务 22.3）：从源码里找出 t`…` / t('…')（前端）与 msg`…` / msg('…')（服务端）的翻译键，
// 以及没被包起来的中文字符串字面量。只是够用的 JS 词法：注释、三种字符串、模板嵌套、正则字面量。
const CJK = /[぀-ヿ㐀-鿿！-｠]/;
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

/**
 * @param {string} src
 * @param {string[]} tags 认哪些标签名（前端 ['t']，服务端 ['msg']）
 * @returns {{ keys: {key: string, line: number}[], bare: {text: string, line: number, start: number, end: number}[] }}
 *   bare 的 start / end 是字面量（含引号）在源码里的位置。
 */
export function scan(src, tags) {
  const keys = [];
  const bare = [];
  const lineAt = (pos) => src.slice(0, pos).split('\n').length;
  const tagBefore = (pos, call) => {
    const head = src.slice(Math.max(0, pos - 40), pos);
    return tags.some((tag) => new RegExp(call ? `(?<![\\w$.])${tag}\\(\\s*$` : `(?<![\\w$.])${tag}$`).test(head));
  };
  const unesc = (s, j) => {
    const c = s[j + 1];
    if (c === 'u') {
      const m = /^u\{([0-9a-fA-F]+)\}|^u([0-9a-fA-F]{4})/.exec(s.slice(j + 1));
      return [String.fromCodePoint(parseInt(m[1] ?? m[2], 16)), m[0].length + 1];
    }
    if (c === '\n') return ['', 2];
    return [ESC[c] ?? c, 2];
  };

  // 从 i 开始扫代码；stop = true 时遇到不配对的 } 返回其后位置（模板插值的结尾）。
  function code(i, stop) {
    let prev = '';
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || KEYWORDS_BEFORE_REGEX.has(prev))) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && (cls || src[j] !== '/')) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          j++;
        }
        i = j + 1;
        while (/[a-z]/.test(src[i] ?? '')) i++;
        prev = 'regex';
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        let text = '';
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\') { const [ch, len] = unesc(src, j); text += ch; j += len; } else text += src[j++];
        }
        if (tagBefore(i, true)) keys.push({ key: text, line: lineAt(i) });
        else if (CJK.test(text)) bare.push({ text, line: lineAt(i), start: i, end: j + 1 });
        i = j + 1;
        prev = 'str';
        continue;
      }
      if (c === '`') {
        const tagged = tagBefore(i, false) || tagBefore(i, true);
        let j = i + 1;
        let cur = '';
        const parts = [];
        while (j < src.length && src[j] !== '`') {
          if (src[j] === '\\') { const [ch, len] = unesc(src, j); cur += ch; j += len; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { parts.push(cur); cur = ''; j = code(j + 2, true); continue; }
          cur += src[j++];
        }
        parts.push(cur);
        const key = parts.reduce((a, s, k) => `${a}{${k - 1}}${s}`);
        if (tagged) keys.push({ key, line: lineAt(i) });
        else if (parts.some((p) => CJK.test(p))) bare.push({ text: key, line: lineAt(i), start: i, end: j + 1 });
        i = j + 1;
        prev = 'str';
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (stop && depth === 0) return i + 1; depth--; }
      const w = /^[\w$]+/.exec(src.slice(i, i + 64));
      if (w) { prev = w[0]; i += w[0].length; continue; }
      prev = c;
      i++;
    }
    return i;
  }
  code(0, false);
  return { keys, bare };
}

/**
 * 去掉 // 与 /* *\/ 注释后，找出仍含中日文字符的行（N25：hooks/*.tsx 的代码不写文案，注释可用中文）。
 * 认三种引号的字符串（里面的 // 不是注释，如 URL），单 / 双引号到行尾为止（JSX 文本里的 don't 不吞后面的行）。
 * ponytail: 不认 JSX 与正则字面量；正则里紧挨的 // 会被当成注释开头吞掉该行余下部分。TSX 只做摆放、没有正则时够用，
 * 真写了这种正则再换成按 TS 语法树剥注释。
 * @returns {{ line: number, text: string }[]}
 */
export function cjkInCode(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? src.length : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ''); // 保留换行，行号不变
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out.split('\n').flatMap((text, k) => (CJK.test(text) ? [{ line: k + 1, text: text.trim() }] : []));
}
