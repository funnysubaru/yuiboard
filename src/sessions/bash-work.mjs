// 一条 Bash 命令算不算实际工作（claude-code、codex 共用）。只读命令文字，判断结果标在当前信号上，不产生信号。
// ponytail: 启发式，宁可漏认，判断不了一律不算：不看命令是否成功；`python scripts/x.py`、循环里的路径、变量拼的路径、cp / mv / rm / git apply / perl -i 都认不出；
// 带命令替换的那条命令不看写文件（引号嵌套分不清哪些是文本）。要更全得跑 shell 语义，或对比 worktree 的文件变化（只读约束下做不到）。Codex 同样只看命令文字。
import { commandDir, commandSteps, stepTexts } from '../guard.mjs';
import { isRecordTitle } from '../refs.mjs';

// 算「改代码」的文件：在会话工作目录里、不是 Markdown（规划文档、备忘、草稿都是 Markdown，临时脚本在工作目录外）。
const isMarkdown = (file) => /\.(?:md|mdx|markdown)$/i.test(file);
export const isCodePath = (file, cwds) => !isMarkdown(file) && (!file.startsWith('/') || cwds.some((c) => file.startsWith(`${c}/`)));

// 日志、输出文件是跑命令的副产品，不是改代码
const BY_PRODUCT = /\/\.git\/|\.(?:log|txt|out|tmp)$/i;
// 重定向：只有操作符时操作数是下一个词，操作数紧贴时是同一个词
const REDIRECT = /^(?:\d*(?:<<<|<<-?|<>|<&|>>|>&|>\||<|>)|&>>?)/;
// docs 分支是为了写文档，和 docs 提交同口径只算提到（回放：记录 owner 决定的会话建的就是这种分支）
export const DOCS_BRANCH = /^docs[/-]/;

/**
 * 命令里有没有实际工作：新建 worktree 或分支、非 docs 提交（读不出标题也算）、写工作目录内的非 Markdown 文件。
 * @param {string} command
 * @param {string|null} cwd 命令的起点，相对路径按它算；不知道时相对路径不算
 * @param {(file: string) => boolean} inProject 绝对路径在不在项目工作区或它的 worktree 里（不含 extraCwds，那常是仓库的上级目录）。
 *   不用会话的 cwds：cd 进临时目录后 cwds 里就有它，而 /dev/null、临时目录、工作目录外都不算（owner 2026-11-01 定）
 */
export function commandWorked(command, cwd, inProject) {
  return commandSteps(command).some((step) => gitWorked(step) || writtenFiles(step).some((f) => isCodeTarget(f, step, cwd, inProject)));
}

function gitWorked(step) {
  const { words, git, heredocs } = step;
  if (git < 0) return false;
  const rest = args(words, git);
  const has = (re) => rest.some((w) => typeof w === 'string' && re.test(w));
  const notDocs = () => !DOCS_BRANCH.test(stepTexts(step).find((x) => x.branch)?.text ?? '');
  switch (words[git]) {
    case 'worktree': {
      if (rest[0] !== 'add') return false;
      if (has(/^-[bB]$/)) return notDocs(); // 新分支名优先于起点
      // <路径> [检出的分支]；--reason、--orphan 带值
      const [, ref] = rest.slice(1).filter((w, j, list) => !/^--(?:reason|orphan)$/.test(list[j - 1]) && (typeof w !== 'string' || !w.startsWith('-')));
      return typeof ref !== 'string' || !DOCS_BRANCH.test(ref.replace(/^origin\//, ''));
    }
    case 'switch': return has(/^-[cC]$|^--create$/) && notDocs();
    case 'checkout': return has(/^-[bB]$/) && notDocs();
    case 'branch': {
      // 带选项的是列出、删除、改名
      return rest.length > 0 && !rest.some((w) => typeof w === 'string' && (w.startsWith('-') || DOCS_BRANCH.test(w)));
    }
    case 'commit': {
      const stdin = rest.includes('-') && has(/^-[A-Za-z]*F$|^--file$/) ? heredocs[0]?.split('\n').map((l) => l.trim()).find(Boolean) : null;
      const title = stepTexts(step).find((x) => !x.branch && !x.pr)?.text ?? stdin;
      return !title || !isRecordTitle(title);
    }
    default: return false;
  }
}

// 这一步写到的、读得出字面值的路径
function writtenFiles(step) {
  const { words, i } = step;
  // [[ a > b ]]、(( a > b )) 的 > 是比较；命令替换里引号嵌套，分不清后面的 > 是不是文本
  if (words.some((w) => (typeof w === 'string' ? /^(?:\[\[$|\(\()/.test(w) : /\$\(|`/.test(w.text)))) return [];
  const out = redirects(step);
  const name = typeof words[i] === 'string' ? words[i].slice(words[i].lastIndexOf('/') + 1) : '';
  if (name === 'sed') out.push(...inPlaceFiles(words, i));
  else if (name === 'tee') out.push(...args(words, i).filter((w) => typeof w === 'string' && !w.startsWith('-')));
  else if (/^python[\d.]*$|^node$/.test(name)) for (const src of scripts(step, name)) out.push(...scriptFiles(src, name !== 'node'));
  return out;
}

function redirects({ words, text }) {
  const out = [];
  for (const at of words.gt ?? []) {
    if (/[02-9>]/.test(text[at - 1] ?? '')) continue; // 2> 是错误输出；>> 的第二个 >
    const m = /^>+\|?\s*(?:'([^']*)'|"([^"$`]*)"|([^\s;&|<>()'"`$]+))(?=[\s;&|<>()]|$)/.exec(text.slice(at));
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

// 命令名之后的词，去掉重定向的操作符和操作数
function args(words, i) {
  const out = [];
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    const op = typeof w === 'string' ? REDIRECT.exec(w)?.[0] : null;
    if (!op) out.push(w);
    else if (op === w) j++;
  }
  return out;
}

// sed -i 改的文件：没有 -e / -f 时第一个位置参数是脚本。-ie 的 e 是备份后缀，不是 -e
function inPlaceFiles(words, i) {
  const rest = args(words, i);
  if (!rest.some((w) => typeof w === 'string' && /^-[A-Za-z]*i|^--in-place/.test(w))) return [];
  const out = [];
  let script = false;
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (w === '') continue; // macOS 的 -i ''
    if (typeof w !== 'string' || !w.startsWith('-')) out.push(w);
    else if (/^-[A-Za-z]*[ef]$/.test(w) && !w.includes('i')) { script = true; j++; }
  }
  return out.slice(script ? 0 : 1).filter((w) => typeof w === 'string');
}

// 解释器实际跑的程序：-c / -e 的字面程序，或确实从 stdin 取程序时的 heredoc；运行脚本文件、-m、认不出的参数都看不到程序，heredoc 只是数据
function scripts({ words, i, heredocs }, name) {
  const rest = args(words, i);
  const inline = name === 'node' ? /^(?:-e|--eval)$/ : /^-c$/;
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (typeof w === 'string' && inline.test(w)) return typeof rest[j + 1] === 'string' ? [rest[j + 1]] : [];
    if (w === '-') break; // 解释器的选项到此为止，后面是程序的参数
    if (typeof w !== 'string' || !/^-u$|^--input-type=/.test(w)) return [];
  }
  return heredocs.slice(-1);
}

// 字符串在 code 里换成 \x01序号\x01，注释去掉，下面的正则因此碰不到字符串、注释里的调用样例
const LITERAL = '\\x01(\\d+)\\x01';
const PY_OPEN = new RegExp(`\\bopen\\(\\s*([^,()]+?)\\s*,\\s*(?:mode\\s*=\\s*)?${LITERAL}`, 'g');
const PY_PATH = /(?:\bPath\(\s*([^()]+?)\s*\)|\b([A-Za-z_]\w*))\.write_(?:text|bytes)\(/g;
const JS_WRITE = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\(\s*([^,()]+?)\s*,/g;

// 脚本源码里写文件的目标：字面路径，或脚本里赋过字面路径的变量；其余读不出。带 f 前缀、${} 的字符串不是字面路径
function scriptFiles(src, python) {
  const masked = maskSource(src, python);
  if (!masked) return [];
  const { code, strings } = masked;
  const opens = [...code.matchAll(PY_OPEN)].filter((m) => /^[rbt+]*[wax]/.test(strings[m[2]])).map((m) => m[1]);
  const exprs = python ? [...opens, ...[...code.matchAll(PY_PATH)].map((m) => m[1] ?? m[2])] : [...code.matchAll(JS_WRITE)].map((m) => m[1]);
  const literal = (i) => (/[{$]/.test(strings[i]) ? [] : [strings[i]]);
  return exprs.flatMap((e) => {
    const lit = new RegExp(`^${LITERAL}$`).exec(e);
    if (lit) return literal(lit[1]);
    if (!/^[A-Za-z_]\w*$/.test(e)) return [];
    return [...code.matchAll(new RegExp(`\\b${e}\\s*=\\s*(?:Path\\(\\s*)?${LITERAL}`, 'g'))].flatMap((m) => literal(m[1]));
  });
}

// 去掉注释、收走字符串。字符串没收尾时判断不了，返回 null。ponytail: 不认 JS 的正则字面量，里面的引号会打乱配对，最坏是漏认或多认这一段
function maskSource(src, python) {
  const strings = [];
  let code = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (python ? c === '#' : src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
    } else if (!python && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (c === "'" || c === '"' || (!python && c === '`')) {
      const q = python && src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < src.length && !src.startsWith(q, j) && (q.length > 1 || q === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length || !src.startsWith(q, j)) return null;
      code += `\x01${strings.length}\x01`;
      strings.push(src.slice(i + q.length, j));
      i = j + q.length - 1;
    } else {
      code += c;
    }
  }
  return { code, strings };
}

function isCodeTarget(file, { dir }, cwd, inProject) {
  if (/^[~$]/.test(file) || (dir === null && !file.startsWith('/'))) return false;
  const abs = commandDir(`${cwd}`, file.startsWith('/') || !dir ? file : `${dir}/${file}`);
  return abs !== null && !isMarkdown(abs) && !BY_PRODUCT.test(abs) && inProject(abs);
}
