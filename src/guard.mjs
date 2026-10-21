// N27 约定检查（design §3、§4）：Claude Code mod 在 AI 写任务文档、起 PR 标题时用，口径与看板一致。
// 纯函数、不 import 任何 node: 模块（mod 只能 import 插件内的纯 ES 模块），路径一律按 POSIX 字符串处理。

import { globMatcher, parseTasksDoc, parseAdrDoc } from './parse.mjs';
import { extractRefs, aliasMap, unalias, hasRefs, refOptions, checkRefs } from './refs.mjs';
import { msg } from './msg.mjs';

// 规范化成绝对 POSIX 路径：合并重复斜杠、去掉 . 与 ..（越过根的 .. 丢弃）、NFC。不是绝对路径返回 null。
// ponytail: 不解析符号链接、不管大小写不敏感的文件系统（macOS 的 /var → /private/var、大小写别名会认不出）；
// Windows 路径也不认。漏认只是不检查，不会误拦；真碰上再在 mod 里用 $.fs.stat({ resolve: true }) 取真实路径。
function normalize(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const out = [];
  for (const seg of p.normalize('NFC').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

// 来源里配置的相对路径（.claude/specs、./plans/a.md）→ 规范化的相对路径
const rel = (p) => normalize(`/${p ?? ''}`).slice(1);

/**
 * AI 要写的文件是不是本项目的任务文档（与 docs.mjs 的发现规则同口径，含还没写出来的新文件）。
 * @param {string} file 绝对路径
 * @param {{ docSources: { type: string, path: string|null, files: string[] }[], excluded: string[] }} project
 *   /api/projects 里该项目的投影
 * @param {{ path: string, ref?: string }[]} workspaces 摘要里的工作区；带 ref 的（从 git ref 读文档，N17）不是本地文件，跳过
 * @returns {{ kind: 'tasks'|'adr', docId: string, workspace: string } | null}
 */
export function isTaskDoc(file, project, workspaces) {
  const abs = normalize(file);
  if (abs === null) return null;
  const isExcluded = globMatcher(project.excluded);
  for (const ws of workspaces) {
    const root = ws.ref ? null : normalize(ws.path);
    if (root === null || !abs.startsWith(`${root}/`)) continue;
    const r = abs.slice(root.length + 1);
    for (const s of project.docSources ?? []) {
      const hit = match(s, r);
      if (hit && !isExcluded(hit.docId)) return { ...hit, workspace: root };
    }
  }
  return null;
}

function match(source, r) {
  if (source.type === 'task-list') {
    return (source.files ?? []).some((f) => rel(f) === r) ? { kind: 'tasks', docId: r.replace(/\.[^./]+$/, '') } : null;
  }
  const dir = rel(source.path);
  if (!r.startsWith(`${dir}/`)) return null;
  const parts = r.slice(dir.length + 1).split('/');
  // spec-dir：<目录>/<spec>/tasks.md；adr-dir、md-dir：<目录>/<名>.md，都只认一层
  if (source.type === 'spec-dir') return parts.length === 2 && parts[1] === 'tasks.md' ? { kind: 'tasks', docId: parts[0] } : null;
  if (parts.length !== 1 || !parts[0].endsWith('.md')) return null;
  if (source.type === 'adr-dir') return { kind: 'adr', docId: parts[0].slice(0, -3) };
  if (source.type === 'md-dir') return { kind: 'tasks', docId: parts[0].slice(0, -3) };
  return null;
}

/**
 * 从一条 Bash 命令里取 `gh pr create` / `gh pr edit` 的 `--title` / `-t` 字面值（N27 需求 2.3）。
 * 只认单引号、双引号与不带引号的字面量；值里有变量、命令替换（含 heredoc 写法）时读不出，不返回——宁可放行，不猜。
 * 一条命令里可以有多处（`&&`、`;`、`|`、换行分隔）。同一条里的 `--base` / `-B` 一并取出，按分支线认引用用。
 * @param {string} command
 * @returns {{ title: string, base: string|null }[]} 读得出的标题
 */
export function prTitles(command) {
  const out = [];
  const text = stripHeredocs(String(command));
  // heredoc 没有结束行：正文与命令分不清，宁可放行
  if (text === null) return out;
  for (const words of commands(text)) out.push(...prTitlesOf(words));
  return out;
}

// 分好词的一条命令里 gh pr create / edit 的标题（prTitles 与 commandTexts 共用，后者要保持动作的先后顺序）
function prTitlesOf(words) {
  // 命令名是这条命令的第一个词（前面的环境变量赋值 FOO=1 跳过）：`echo gh pr create …` 不算
  const i = words.findIndex((w) => typeof w !== 'string' || !/^[A-Za-z_]\w*=/.test(w));
  if (words[i] !== 'gh' || words[i + 1] !== 'pr' || !['create', 'edit'].includes(words[i + 2])) return [];
  const titles = [];
  let base = null;
  for (let j = i + 3; j < words.length; j++) {
    const w = words[j];
    if (typeof w !== 'string') continue;
    // 带值的选项：它的值不再当选项看（--body '--title=任务 99' 里的不是标题，PR review）
    const eq = w.indexOf('=');
    const flag = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    const inline = flag !== w ? w.slice(eq + 1) : undefined;
    if (!WITH_VALUE.has(flag)) continue;
    const value = inline ?? words[++j];
    if (flag === '--title' || flag === '-t') { if (typeof value === 'string') titles.push(value); }
    else if (flag === '--base' || flag === '-B') base = typeof value === 'string' ? value : null;
  }
  return titles.map((title) => ({ title, base }));
}

/**
 * 一条 Bash 命令里 AI 写下的、能看出在做哪个任务的文字（N32）：`git commit` 的提交标题、`gh pr create` / `gh pr edit` 的标题、
 * 新建的分支名（`git worktree add -b`、`git checkout -b`、`git switch -c`，大写选项同）。提交标题取 `-m` 值的第一行，
 * `-m "$(cat <<'EOF' …)"` 取这个参数自己那段 heredoc 正文的第一行；`-m "$MSG"`、不含 heredoc 的命令替换读不出，一律不返回
 * （别的命令的 heredoc 不能拿来当提交标题，yuiboard PR #10 review）。不认 -F 文件。
 * @param {string} command
 * @returns {{ text: string, branch: boolean }[]}
 */
export function commandTexts(command) {
  const bodies = [];
  const text = stripHeredocs(String(command), bodies);
  if (text === null) return [];
  const out = [];
  const subject = (s) => s.split('\n').map((l) => l.trim()).find(Boolean);
  // 按命令的先后输出：扫描器给同一时刻的信号排序时，后续活动只续最后一条，顺序反了焦点就落到先做的那个任务上（PR #54 review）
  for (const words of commands(text)) {
    out.push(...prTitlesOf(words).map((t) => ({ text: t.title, branch: false })));
    let i = words.findIndex((w) => typeof w !== 'string' || !/^[A-Za-z_]\w*=/.test(w));
    if (words[i] !== 'git') continue;
    // git 的全局选项：-C <路径>、-c <键=值> 带值，其余不带
    for (i++; typeof words[i] === 'string' && words[i].startsWith('-'); i++) if (words[i] === '-C' || words[i] === '-c') i++;
    const sub = words[i] === 'worktree' && words[i + 1] === 'add' ? 'worktree' : words[i];
    const flag = { commit: /^-[A-Za-z]*m$|^--message$/, worktree: /^-[bB]$/, checkout: /^-[bB]$/, switch: /^-[cC]$|^--create$/ }[sub];
    if (!flag) continue;
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j];
      if (typeof w !== 'string') continue;
      const inline = sub === 'commit' && w.startsWith('--message=') ? w.slice('--message='.length) : undefined;
      if (inline === undefined && !flag.test(w)) continue;
      const v = inline ?? words[j + 1];
      const t = sub !== 'commit' ? v : typeof v === 'string' ? subject(v) : v && subject(ownHeredoc(text, v, bodies) ?? '');
      if (typeof t === 'string' && t) out.push({ text: t, branch: sub !== 'commit' });
      break; // 只取第一处：第二个 -m 是提交正文
    }
  }
  return out;
}

// 读不出字面值的词里写着 heredoc 时，取它自己那段正文：stripHeredocs 按 opener 出现的顺序收正文，词前面有几个 opener 就是第几段。
// 词里没有 opener（变量、普通命令替换）→ null
function ownHeredoc(text, word, bodies) {
  if (heredocOpeners(word.text).next().done) return null;
  return bodies[[...heredocOpeners(text.slice(0, word.at))].length] ?? null;
}

// gh pr create / edit 里带值的选项（gh 2.x）：分词时跳过它们的值
const WITH_VALUE = new Set([
  '--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H', '--label', '-l', '--assignee', '-a',
  '--reviewer', '-r', '--milestone', '-m', '--project', '-p', '--repo', '-R', '--template', '-T', '--recover',
  '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer',
  '--add-project', '--remove-project',
]);

// 去掉 heredoc 正文，正文里的文字不是命令。按行处理：一行里的每个 opener（`<<EOF`、`<<-'EOF'`、`<<"DOC TEXT"`、`<<123`，
// 同一行可以有好几个）按顺序各吃掉自己的正文与结束行；heredoc 常写在 --body "$(cat <<'EOF' …)" 里，不管在不在引号里一律按行去掉。
// 分隔符读不出（含 $、反斜杠、紧跟引号等）或找不到结束行时返回 null：分不清正文与命令，调用方放行（PR review）。
// `<<<` 是 here-string，不算。引号里或算术里出现的 `<<` 也会被当成 opener，最坏只是放行，不会误拦。
// bodies 给了就按出现顺序收下各段正文（commandTexts 取 heredoc 写的提交信息）。
function stripHeredocs(s, bodies = null) {
  const lines = s.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const pending = [];
    for (const m of heredocOpeners(line)) {
      const delim = m[2] ?? m[3] ?? m[4];
      const next = line[m.index + m[0].length];
      if (!delim || (next !== undefined && !/[\s;&|<>()]/.test(next))) return null;
      pending.push({ delim, tabs: m[1] === '-' });
    }
    for (const h of pending) {
      let k = i + 1;
      while (k < lines.length && (h.tabs ? lines[k].replace(/^\t+/, '') : lines[k]) !== h.delim) k++;
      if (k >= lines.length) return null;
      bodies?.push(lines.slice(i + 1, k).join('\n'));
      i = k;
    }
  }
  return out.join('\n');
}

const heredocOpeners = (s) => s.matchAll(/(?<!<)<<(?!<)(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()'"`$\\]+))?/g);

// 极简 shell 分词：按控制符切成多条命令，每条是词的数组；读不出字面值的词（含 $、`）记成 { text, at }（原样文字与起点下标），
// 调用方只认字符串，commandTexts 拿它找自己的 heredoc。
// ponytail: 不处理 $'…'、子 shell 里的命令；这些情况的标题按读不出放行。
function commands(s) {
  const cmds = [];
  let words = [];
  let word = '';
  let has = false; // 当前词是否已开始（空引号 "" 也是一个词）
  let opaque = false;
  let at = 0; // 当前词的起点
  const end = () => {
    if (has) words.push(opaque ? { text: word, at } : word);
    word = ''; has = false; opaque = false;
  };
  const cut = () => { end(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!has) at = i;
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) { opaque = true; has = true; break; }
      word += s.slice(i + 1, j); has = true; i = j;
    } else if (c === '"') {
      has = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) word += s[++i];
        else if (s[i] === '$' || s[i] === '`') { opaque = true; word += s[i]; }
        else word += s[i];
      }
    } else if (c === '\\' && s[i + 1] === '\n') {
      i++; // 反斜杠换行 = 续行，两个字符都去掉
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[++i]; has = true;
    } else if (c === '$' || c === '`') {
      opaque = true; has = true; word += c;
    } else if (/\s/.test(c) && c !== '\n') {
      end();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      cut();
    } else {
      word += c; has = true;
    }
  }
  cut();
  return cmds;
}

// 第 8 条（N12）：正文里页面认不了的 Markdown 写法（web/md.mjs 的 mdUnrendered），页面照原文显示并标明，这里给改写建议。
const MD_ADVICE = {
  heading: msg('正文里的标题不按 Markdown 渲染，照原文显示；建议改成加粗行'),
  hr: msg('正文里的分隔线不按 Markdown 渲染，照原文显示；建议删掉或改成空行'),
  image: msg('图片不按 Markdown 渲染，照原文显示；建议改成链接 [说明](地址)'),
  footnote: msg('脚注不按 Markdown 渲染，照原文显示；建议把说明写进正文或括号'),
  html: msg('HTML 标签不按 Markdown 渲染，照原文显示；建议改成 Markdown 写法，或放进行内代码'),
};

/**
 * 一份已解析文档自身的约定问题（design §8 第 1、3、5、8 条；engine 的「不满足约定」与 N27 写入拦截共用）。
 * 不含跨文档的悬空依赖（冲突 f，要全部文档才判得出）。
 * @param {{ tasks: object[], parse?: object }} doc parseTasksDoc / parseAdrDoc 的结果
 * @returns {{ rule: 1|3|5|8, line: number, detail: string }[]} 未排序
 */
export function docIssuesOf(doc) {
  const out = [];
  const p = doc.parse ?? {}; // engine 的最小输入可以不带 parse（见 computeBoard 注释）
  const at = (rule, line, detail) => out.push({ rule, line, detail });
  for (const line of p.unrecognizedLines ?? []) at(1, line, msg('像任务行，但不是「- [ ] 编号 标题」的写法'));
  for (const t of doc.tasks ?? []) if (t.duplicate) at(1, t.line, msg`编号 ${t.number} 在文档里出现了不止一次`);
  for (const r of p.unknownRelations ?? []) at(3, r.line, msg`未识别的依赖说法：${r.text}`);
  for (const r of p.unknownEstimates ?? []) at(5, r.line, msg`无法识别的耗时写法：${r.text}`);
  for (const r of p.unrenderedMarkdown ?? []) at(8, r.line, MD_ADVICE[r.kind]);
  for (const x of p.diagnostics ?? []) at(1, x.source.line, x.message); // N9：复选框写法、混用的标题式任务等
  return out;
}

/**
 * 本次写入新引入的约定问题（N27 需求 2.1、2.2）：写前、写后各解析一遍做多重集差，写前已有的问题不算。
 * 两轮配对：先按「条目 + 说明 + 该行原文」（行号随增删行移动也认得出是同一处），剩下的再按「条目 + 说明」——
 * 改了带问题的那一行（勾选复选框、改标题）时原文变了，问题还是原来那个，不能当新问题拦（PR review）。
 * @param {string} before 写前全文（新文件为空串）
 * @param {string} after 写后全文
 * @param {{ kind: 'tasks'|'adr', docId: string, milestoneCodePattern?: string, prerequisiteIdPattern?: string }} doc
 * @returns {{ rule: number, line: number, text: string, detail: string, untouched?: true }[]} 按行号排；
 *   untouched = 这一行写前就有、原样没动，是新写的内容改变了它的读法（例如在非任务小节、标题式任务文档里加了 `- [ ]` 任务行）
 */
export function docIssues(before, after, doc) {
  const list = (text) => {
    const parsed = parseDoc(text, doc);
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    return docIssuesOf(parsed).map((x) => ({ ...x, text: (lines[x.line - 1] ?? '').trim() }));
  };
  const exact = (x) => `${x.rule}\n${x.detail}\n${x.text}`;
  const loose = (x) => `${x.rule}\n${x.detail}`;
  const prev = before ? list(before) : [];
  // 一轮配对：after 里能在 pool 里找到同键的就抵消（同时从 pool 里拿掉，免得一个旧问题抵两次）
  const pair = (items, pool, key) => {
    const left = new Map();
    for (const x of pool) left.set(key(x), [...(left.get(key(x)) ?? []), x]);
    const rest = [];
    for (const x of items) {
      const hit = left.get(key(x));
      if (hit?.length) pool.splice(pool.indexOf(hit.shift()), 1);
      else rest.push(x);
    }
    return rest;
  };
  const fresh = pair(pair(list(after), prev, exact), prev, loose);
  const old = new Set(before.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return fresh.map((x) => (x.text && old.has(x.text) ? { ...x, untouched: true } : x)).sort((a, b) => a.line - b.line);
}

/**
 * 按看板同样的选项解析一份任务文档（tasks → parseTasksDoc，adr → parseAdrDoc）。
 * @param {string} text
 * @param {{ kind: 'tasks'|'adr', docId: string, milestoneCodePattern?: string|null, prerequisiteIdPattern?: string|null }} doc
 * @returns {object} 带 docId 的解析结果，形状同看板 / 摘要里的文档
 */
export function parseDoc(text, doc) {
  const opts = { milestoneCodePattern: doc.milestoneCodePattern ?? undefined, prerequisiteIdPattern: doc.prerequisiteIdPattern ?? undefined };
  return { docId: doc.docId, ...(doc.kind === 'adr' ? parseAdrDoc : parseTasksDoc)(text, doc.docId, opts) };
}

/**
 * PR 标题里认不了的引用（N27 需求 2.3；与 engine linkPrs 的冲突 h 同口径，只看标题）。
 * 候选文档按分支线 docFilter 过滤：知道 base 且对得上某条分支线时只看那条；不知道（gh pr edit、没写 --base）时
 * 各条分支线与全部文档都试一遍，取问题最少的那组——任何一条线下标题都没问题就不拦，宁可漏拦不误拦。
 * 标题没有任何引用时不报（同步 main、调 CI 这类 PR 本来就不对应任务）。
 * @param {string} title
 * @param {object[]} docs 摘要里的文档（docId、alias、adr、groups、tasks）
 * @param {{ base?: string, docFilter?: string|null }[]} [branchLines]
 * @param {string|null} [base] `gh pr create --base` 的值
 * @returns {string[]} 问题说明（中文原文，显示时经 tx 翻译）
 */
export function titleIssues(title, docs, branchLines = [], base = null) {
  const sets = [];
  const line = base ? branchLines.find((l) => l.base === base) : null;
  const pick = (filter) => (filter ? docs.filter((d) => new RegExp(filter).test(d.docId)) : docs);
  if (line) sets.push(pick(line.docFilter));
  else for (const f of [null, ...branchLines.map((l) => l.docFilter).filter(Boolean)]) sets.push(pick(f));
  let best = null;
  for (const cands of sets) {
    const alias = aliasMap(cands);
    const opts = refOptions(cands, alias);
    const raw = unalias(extractRefs(title, opts), alias);
    const issues = hasRefs(raw) ? checkRefs(raw, cands, alias, opts.knownDocIds, msg('PR 标题')).issues : [];
    if (best === null || issues.length < best.length) best = issues;
    if (!best.length) break;
  }
  return best ?? [];
}

/**
 * Edit 工具写后的全文：old 在原文里恰好一处（replaceAll 时至少一处）才替换；对不上返回 null，交给 Edit 自己报错。
 * 不用 String.replace（new 里的 $& 之类会被当成替换模式）。
 * @returns {string|null}
 */
export function applyEdit(before, oldString, newString, replaceAll = false) {
  if (oldString === '') return before === '' ? newString : null;
  const parts = before.split(oldString);
  if (parts.length === 1 || (!replaceAll && parts.length > 2)) return null;
  return parts.join(newString);
}
