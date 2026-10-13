// 文档约定（CONVENTION.md 英文、CONVENTION.zh-CN.md、CONVENTION.ja.md）的示例必须真能被识别（任务 6.7，需求 3.1、3.2；N22 三语）：
// 从文档里的代码块抽出任务行、关系、耗时写法（markdown 块）与 PR 标题（text 块）、分支名（branch 块），
// 分别喂给 parseTasksDoc 与 refs.mjs。改了约定文档或解析器而两边对不上时这里失败。
// 细节断言写在中文版上；英 / 日版的示例是逐块翻译，按位置与中文版比对解析结果（任务、作废、耗时、分组、前置、关系）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTasksDoc } from '../src/docs.mjs';
import { extractRefs, extractBranchRefs } from '../src/refs.mjs';
import { mdParse, mdUnrendered } from '../web/md.mjs';

// 顶层围栏代码块（外层可用更长的围栏包住内层 ```mermaid）→ [{lang, text}]
function blocks(md) {
  const out = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const f = /^(`{3,})(\w*)\s*$/.exec(line);
    if (!cur) { if (f) cur = { fence: f[1], lang: f[2], lines: [] }; continue; }
    if (f && f[1] === cur.fence && !f[2]) { out.push({ lang: cur.lang, text: cur.lines.join('\n') }); cur = null; continue; }
    cur.lines.push(line);
  }
  return out;
}

// 每个 markdown 示例块以「# 示例：<名字>」/「# Example: <name>」/「# 例：<名前>」开头；裸数字示例是正文里的行内代码
const LANGS = {
  zh: { file: 'CONVENTION.zh-CN.md', bare: 'fix: 修 3 个问题' },
  en: { file: 'CONVENTION.md', bare: 'fix: 3 bugs' },
  ja: { file: 'CONVENTION.ja.md', bare: 'fix: 3 件のバグを修正' },
};
function load({ file, bare }) {
  const MD = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const ALL = blocks(MD);
  const docs = ALL.filter((b) => b.lang === 'markdown')
    .map((b) => ({ name: /^# (?:示例：|Example: |例：)(.+)$/m.exec(b.text)?.[1], text: b.text, doc: parseTasksDoc(b.text, 'ex') }));
  const lines = (lang) => ALL.filter((b) => b.lang === lang).flatMap((b) => b.text.split('\n')).filter((l) => l.trim());
  return { file, MD, docs, lines, bare };
}
const ALL_LANGS = Object.values(LANGS).map(load);
const ZH = ALL_LANGS[0];
const NAMES = ['任务行', '兼容的任务行', '标题式任务', '里程碑', '关系写法', '前置条件表', '英文关系写法', '日文关系写法', '兼容的关系写法', '作废', '预计耗时', '英文与日文的作废和耗时', '进行中'];
const byName = (name) => ZH.docs[NAMES.indexOf(name)].doc;
const sig = (doc) => doc.relations.map((r) => `${r.kind} ${r.via} ${[r.subjects, r.objects].map((x) => x.flatMap((o) => o.keys.length ? o.keys : [o.id ?? o.raw]).join('+')).join(' <- ')}`);

test('三语约定文档：八条都在，示例块齐全', () => {
  assert.deepEqual(ZH.docs.map((d) => d.name), NAMES);
  for (const { file, MD, docs, lines } of ALL_LANGS) {
    const heads = [...MD.matchAll(/^## (\d)\. /gm)].map((m) => m[1]);
    assert.deepEqual(heads, ['1', '2', '3', '4', '5', '6', '7', '8'], file);
    assert.equal(docs.length, NAMES.length, file);
    assert.ok(docs.every((d) => d.name), `${file} 每个示例块要有标题行`);
    assert.ok(lines('text').length >= 5 && lines('branch').length >= 2, file);
  }
});

test('每个 markdown 示例整份识别：解析 ok、无未识别行、无未识别关系说法、无认不出的耗时', () => {
  for (const { name, doc } of ALL_LANGS.flatMap((l) => l.docs)) {
    assert.equal(doc.parse.state, 'ok', name);
    assert.ok(doc.tasks.length > 0, name);
    assert.deepEqual(doc.parse.unrecognizedLines, [], name);
    assert.deepEqual(doc.parse.unknownRelations, [], name);
    assert.deepEqual(doc.parse.unknownEstimates, [], name);
  }
});

test('任务行：推荐与兼容写法的编号都认出；标题式任务在没有任务行时兜底', () => {
  const nums = (name) => byName(name).tasks.map((t) => t.number);
  assert.deepEqual(nums('任务行'), ['1', '1.1', '2', '2.5b', '2.10']);
  assert.equal(byName('任务行').tasks.find((t) => t.number === '2.5b').parentKey, 'ex#2');
  assert.deepEqual(nums('兼容的任务行'), ['1', '1.1', '2']);
  assert.equal(byName('兼容的任务行').tasks[1].title, '整体加粗的任务');
  assert.deepEqual(nums('标题式任务'), ['1', '2']);
});

test('关系：示例里每一行写了依赖 / 并行 / 顺序的，都产出至少一条带该行来源的关系', () => {
  const KEY = /依赖|并行|依次|完成后|需要 P|-->|→|depends|parallel|in order|needs P|依存|並行|順に|以降|が必要/i;
  for (const { name, text, doc } of ALL_LANGS.flatMap((l) => l.docs)) {
    text.split('\n').forEach((l, i) => {
      if (!KEY.test(l) || /^\s*[|#]/.test(l)) return;
      assert.ok(doc.relations.some((r) => r.source.line === i + 1), `${name} 第 ${i + 1} 行没识别：${l}`);
    });
  }
  const rel = byName('关系写法');
  assert.ok(rel.relations.every((r) => [...r.subjects, ...r.objects].every((x) => !x.dangling)), '推荐写法里没有悬空引用');
  assert.equal(byName('兼容的关系写法').parse.mermaidUsed, true);
  assert.ok(byName('里程碑').relations.some((r) => r.via === 'group-note' && r.kind === 'dep'), '分组说明段整组依赖');
});

test('外部前置：前置表登记、划掉 / 已决即解除，「需要 P1」产生外部阻塞', () => {
  const d = byName('前置条件表');
  assert.deepEqual(d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]), [['P1', false, ['10']], ['P2', true, []], ['P3', true, []]]);
  assert.ok(d.relations.some((r) => r.objects.some((o) => o.type === 'prereq' && o.id === 'P1' && !o.dangling)));
});

test('英文 / 日文关系写法与中文推荐写法产出同样的关系', () => {
  assert.deepEqual(sig(byName('日文关系写法')), sig(byName('英文关系写法')));
  assert.equal(sig(byName('英文关系写法')).length, 9);
  for (const name of ['英文关系写法', '日文关系写法']) {
    const d = byName(name);
    assert.deepEqual(d.groups.map((g) => g.code), ['M1', 'M2'], name);
    assert.deepEqual(d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]), [['P1', false, ['6']], ['P2', true, []]], name);
    assert.ok(d.relations.every((r) => [...r.subjects, ...r.objects].every((x) => !x.dangling)), name);
  }
  const ew = byName('英文与日文的作废和耗时');
  assert.deepEqual(ew.tasks.map((t) => [t.number, t.void, t.estimateHours]), [['1', true, null], ['2', false, 1.5], ['3', true, null], ['4', false, 24]]);
});

test('作废、预计耗时、进行中标记', () => {
  assert.deepEqual(byName('作废').tasks.map((t) => [t.number, t.void]), [['6', true], ['7', true], ['8', false]]);
  assert.deepEqual(byName('预计耗时').tasks.map((t) => t.estimateHours), [8, 4, 2, 1.5]);
  assert.equal(byName('进行中').tasks[0].checkbox, 'doing');
});

test('PR 标题与描述：示例每行都认出任务号 / 代号 / 任务键；分支名示例也认得出；裸数字不识别', () => {
  const opts = { knownDocIds: ['devboard-mvp'], knownCodes: ['M0-c'] };
  for (const { file, MD, lines, bare } of ALL_LANGS) {
    for (const t of lines('text')) {
      const r = extractRefs(t, opts);
      assert.ok(r.keys.length + r.nums.length + r.codes.length > 0, `${file} ${t}`);
      // N9：带部分标记的示例（任务号、任务键、代号）都要认出标记
      if (/部分|一部|\(partial\)/.test(t)) assert.ok(r.partial.length > 0, `${file} 部分标记：${t}`);
    }
    for (const b of lines('branch')) {
      const r = extractBranchRefs(b, { knownCodes: opts.knownCodes });
      assert.ok(r.nums.length + r.codes.length > 0, `${file} ${b}`);
    }
    assert.ok(MD.includes(`\`${bare}\``), `${file} 要有裸数字示例`);
    assert.deepEqual(extractRefs(bare, opts).nums, [], file);
  }
});

test('英 / 日版示例逐块翻译：解析结果与中文版同位置的示例一致', () => {
  const sum = (d) => ({
    tasks: d.tasks.map((t) => [t.number, t.parentKey, t.checkbox, t.void, t.estimateHours]),
    groups: d.groups.map((g) => g.code), prereqs: d.prerequisites.map((p) => [p.id, p.resolved, p.blocksNums]),
    relations: sig(d), mermaid: d.parse.mermaidUsed,
  });
  for (const { file, docs } of ALL_LANGS.slice(1)) {
    docs.forEach(({ name, doc }, i) => assert.deepEqual(sum(doc), sum(ZH.docs[i].doc), `${file} 第 ${i + 1} 个示例「${name}」对应中文版「${NAMES[i]}」`));
  }
});

test('第 8 条 Markdown 子集：「照原文、不提示」的例子不被解析也不标，「标明未渲染」的例子都会标（与 web/md.mjs 同口径）', () => {
  for (const { file, MD } of ALL_LANGS) {
    const bullets = MD.slice(MD.indexOf('\n## 8. ')).split('\n- ').slice(1);
    const codes = (b) => [...b.matchAll(/(?<!`)`([^`]+)`(?!`)/g)].map((m) => m[1]);
    const kept = codes(bullets[1]);
    assert.ok(kept.length >= 6, file);
    for (const c of kept) assert.deepEqual([mdParse(c), mdUnrendered(c)], [[c], null], `${file}：${c}`);
    const marked = codes(bullets[2]).filter((c) => /^(#|!|\[\^|<)/.test(c));
    assert.equal(marked.length, 6, file);
    for (const c of marked) assert.ok(mdUnrendered(c), `${file}：${c}`);
  }
});

test('N27：文末「给 AI 的简短说明」代码块与插件注入的要点（hooks/model.mjs conventionSnippet）逐语言一致，示例真能识别', async () => {
  const { setLang } = await import('../web/i18n.mjs');
  const { conventionSnippet } = await import('../hooks/model.mjs');
  try {
    for (const [lang, l] of [['zh', LANGS.zh], ['en', LANGS.en], ['ja', LANGS.ja]]) {
      setLang(lang);
      const md = blocks(readFileSync(new URL(`../${l.file}`, import.meta.url), 'utf8')).filter((b) => b.lang === 'md');
      assert.equal(md.length, 1, l.file);
      assert.equal(md[0].text, conventionSnippet(), l.file);
      // 要点里举的 PR 标题写法都认得出，「部分」写法记为部分交付
      const titles = [...md[0].text.matchAll(/`((?:任务|Tasks?|タスク) [^`]+)`/g)].map((m) => m[1]);
      assert.ok(titles.length >= 3, l.file);
      for (const t of titles) assert.ok(extractRefs(t).nums.length, `${l.file} ${t}`);
      assert.ok(titles.some((t) => extractRefs(t).partial.length), l.file);
      // 任务行要点里说的状态与解析结果一致（PR review：曾把 [~] 写成作废，实际是进行中）
      const rule = md[0].text.split('\n')[1];
      const boxes = [...rule.matchAll(/`(\[[ x~]\])`/g)].map((m) => m[1]);
      assert.deepEqual(boxes, ['[x]', '[~]'], `${l.file} 列出完成与进行中`);
      const state = (line) => { const t = parseTasksDoc(`${line}\n`, 'ex').tasks[0]; return t && `${t.checkbox}${t.void ? ' void' : ''}`; };
      assert.equal(state('- [x] 1 a'), 'done');
      assert.equal(state('- [~] 1 a'), 'doing');
      const voidLine = [...rule.matchAll(/`(- \[x\] [^`]+)`/g)].map((m) => m[1]);
      assert.equal(voidLine.length, 1, `${l.file} 给出一种作废写法`);
      assert.equal(state(voidLine[0]), 'done void', `${l.file} ${voidLine[0]}`);
      // 依赖写法放进任务行能整句识别
      const deps = [...md[0].text.matchAll(/`([（(][^`]+[)）])`/g)].map((m) => m[1]);
      assert.equal(deps.length, 4, l.file);
      for (const d of deps) {
        const doc = parseTasksDoc(`### 里程碑 M1：a\n- [ ] 1 a\n- [ ] 2.1 b\n- [ ] 2.4 c\n- [ ] 9 x${d}\n`, 'ex');
        assert.deepEqual([doc.relations.length, doc.parse.unknownRelations], [1, []], `${l.file} ${d}`);
      }
    }
  } finally {
    setLang('zh');
  }
});
