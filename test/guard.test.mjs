import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTaskDoc, prTitles, commandTexts, docIssues, titleIssues, applyEdit } from '../src/guard.mjs';
import { parseTasksDoc, parseAdrDoc } from '../src/parse.mjs';
import { conventionBrief } from '../hooks/model.mjs';
import { setLang } from '../web/i18n.mjs';

// 项目配置的投影（/api/projects 的 docSources、excluded）与摘要里的工作区
const project = {
  docSources: [
    { type: 'spec-dir', path: '.claude/specs', files: [] },
    { type: 'adr-dir', path: 'docs/adr', files: [] },
    { type: 'task-list', path: null, files: ['NEXT.md', './plans/roadmap.md'] },
    { type: 'md-dir', path: 'docs/plans', files: [] },
  ],
  excluded: ['old-*'],
};
const workspaces = [{ id: 'repo', path: '/r' }, { id: 'v2', path: '/w/v2' }, { id: 'next', path: '/r', ref: 'origin/next' }];
const at = (file) => isTaskDoc(file, project, workspaces);

test('isTaskDoc：四种来源各认一层，含还没写出来的新文件', () => {
  assert.deepEqual(at('/r/.claude/specs/foo/tasks.md'), { kind: 'tasks', docId: 'foo', workspace: '/r' });
  assert.deepEqual(at('/r/docs/adr/0001-x.md'), { kind: 'adr', docId: '0001-x', workspace: '/r' });
  assert.deepEqual(at('/r/NEXT.md'), { kind: 'tasks', docId: 'NEXT', workspace: '/r' });
  assert.deepEqual(at('/r/plans/roadmap.md'), { kind: 'tasks', docId: 'plans/roadmap', workspace: '/r' }, 'files 里的 ./ 规范化');
  assert.deepEqual(at('/r/docs/plans/a.md'), { kind: 'tasks', docId: 'a', workspace: '/r' });
  assert.deepEqual(at('/w/v2/.claude/specs/bar/tasks.md'), { kind: 'tasks', docId: 'bar', workspace: '/w/v2' }, '分支线自配的工作区');
});

test('isTaskDoc：不是任务文档的一律 null', () => {
  for (const f of [
    '/r/.claude/specs/foo/design.md', '/r/.claude/specs/foo/sub/tasks.md', '/r/.claude/specs/tasks.md',
    '/r/docs/adr/sub/0002.md', '/r/docs/adr/README.txt', '/r/docs/plans/deep/a.md', '/r/README.md',
    '/elsewhere/NEXT.md', '/rr/NEXT.md', 'NEXT.md',
  ]) assert.equal(at(f), null, f);
});

test('isTaskDoc：excluded 通配、.. 与重复斜杠、NFD 路径', () => {
  assert.equal(at('/r/.claude/specs/old-thing/tasks.md'), null);
  assert.deepEqual(at('/r/.claude/specs/foo/../bar//tasks.md')?.docId, 'bar');
  assert.equal(at('/r/.claude/specs/../../etc/tasks.md'), null);
  assert.deepEqual(at('/r/.claude/specs/' + 'が'.normalize('NFD') + '/tasks.md')?.docId, 'が');
});

test('conventionBrief：三语都不超过 1,500 字，列出任务文档与对应语言的完整约定文件（N27 需求 1.2、1.3）', () => {
  const p = { name: '演示', docSources: [{ type: 'spec-dir', path: '.claude/specs' }, { type: 'task-list', files: ['NEXT.md'] }, { type: 'adr-dir', path: 'docs/adr' }] };
  try {
    for (const [lang, file] of [['zh', 'CONVENTION.zh-CN.md'], ['ja', 'CONVENTION.ja.md'], ['en', 'CONVENTION.md']]) {
      setLang(lang);
      const b = conventionBrief(p, '/plugin/');
      assert.ok(b.length <= 1500, `${lang} ${b.length}`);
      assert.ok(b.includes('.claude/specs/*/tasks.md, NEXT.md, docs/adr/*.md'), lang);
      assert.ok(b.endsWith(`/plugin/${file}`), lang);
      if (lang !== 'zh') assert.doesNotMatch(b, /[任务约定]/, `${lang} 没有漏译`);
    }
  } finally {
    setLang('zh');
  }
});

const titlesOf = (c) => prTitles(c).map((x) => x.title);

test('prTitles：只取 gh pr create / edit 的字面标题，读不出的不返回（N27 需求 2.3）', () => {
  assert.deepEqual(titlesOf(`gh pr create --title "feat: N27 任务 3" --body x`), ['feat: N27 任务 3']);
  assert.deepEqual(titlesOf(`cd /r && gh pr edit 12 -t 'fix: 任务 4（部分）'`), ['fix: 任务 4（部分）']);
  assert.deepEqual(titlesOf(`gh pr create --title=feat:\\ x --fill`), ['feat: x']);
  assert.deepEqual(titlesOf(`gh pr create --title "say \\"hi\\" 任务 1"`), ['say "hi" 任务 1']);
  assert.deepEqual(titlesOf(`gh pr create --fill`), []);
  assert.deepEqual(titlesOf(`gh pr create --title "$TITLE"`), [], '变量');
  assert.deepEqual(titlesOf(`gh pr create --title "$(cat <<'EOF'\nx\nEOF\n)"`), [], '命令替换');
  assert.deepEqual(titlesOf(`gh pr view 12 --json title`), []);
  assert.deepEqual(titlesOf(`echo gh pr create --title "a"; gh pr edit 3 --title "b"`), ['b'], 'echo 后面的不算');
  assert.deepEqual(titlesOf(`gh issue create --title "任务 1"`), []);
});
test('commandTexts：提交标题（含 heredoc）、PR 标题、新建分支名；读不出的不返回（N32）', () => {
  const texts = (c) => commandTexts(c).map((x) => `${x.branch ? 'b' : 't'}:${x.text}`);
  assert.deepEqual(texts(`git -C /w/x commit -qm "feat: N31 面板" -m "正文 N9"`), ['t:feat: N31 面板'], '-C 带值；第二个 -m 是正文');
  assert.deepEqual(texts(`git add -A && git commit -m "$(cat <<'EOF'\nfeat: N32 焦点\n\n正文 N9\nEOF\n)" && git push`), ['t:feat: N32 焦点'], 'heredoc 取正文第一行');
  assert.deepEqual(texts(`git commit --message="fix: 任务 3"`), ['t:fix: 任务 3']);
  assert.deepEqual(texts(`git -c user.name=x commit -am 'fix: 任务 4'`), ['t:fix: 任务 4']);
  assert.deepEqual(texts(`git commit -m "$MSG"`), [], '变量');
  assert.deepEqual(texts(`git commit -F msg.txt`), []);
  assert.deepEqual(texts(`echo git commit -m "N1"; git log -m`), [], 'echo 后面、别的子命令都不算');
  assert.deepEqual(texts(`git worktree add -q -b feat/n32-x ../wt && cd ../wt`), ['b:feat/n32-x']);
  assert.deepEqual(texts(`git switch -c fix/n4; git checkout -B task-3.2; git checkout main`), ['b:fix/n4', 'b:task-3.2']);
  assert.deepEqual(texts(`gh pr create --draft --title "feat: N32 焦点" --body "$(cat <<'EOF'\n任务 9\nEOF\n)"`), ['t:feat: N32 焦点']);
  assert.deepEqual(texts(`git commit -m "$(cat <<'EOF'\nfeat: x\n`), [], 'heredoc 没有结束行');
  // 读不出的提交信息不拿别的命令的 heredoc 充数（yuiboard PR #10 review）；前面另有 heredoc 时取它自己那段
  assert.deepEqual(texts(`git commit -m "$MSG"; cat <<'EOF'\nfeat: alpha#2\nEOF`), [], '变量');
  assert.deepEqual(texts(`git commit -m "$(git log -1 --format=%s)"; cat <<'EOF'\nfeat: alpha#2\nEOF`), [], '不含 heredoc 的命令替换');
  assert.deepEqual(texts(`cat <<'A'\nalpha#9\nA\ngit commit -m "$(cat <<'EOF'\nfeat: alpha#3\nEOF\n)"`), ['t:feat: alpha#3'], '前面另有 heredoc');
  // 按命令先后输出（PR #54 review）：扫描器对同一时刻的信号只给最后一条续活动
  assert.deepEqual(texts(`git commit -m "fix: alpha#1" && gh pr create --title "feat: alpha#2" --body x`), ['t:fix: alpha#1', 't:feat: alpha#2']);
  assert.deepEqual(texts(`gh pr edit 3 --title "feat: alpha#2" && git commit -m "fix: alpha#1"`), ['t:feat: alpha#2', 't:fix: alpha#1']);
});
test('prTitles：取同一条命令里的 --base / -B', () => {
  assert.deepEqual(prTitles(`gh pr create -B v2 -t "任务 1"`), [{ title: '任务 1', base: 'v2' }]);
  assert.deepEqual(prTitles(`gh pr create --title x --base=main`), [{ title: 'x', base: 'main' }]);
  assert.deepEqual(prTitles(`gh pr edit 3 -t x`), [{ title: 'x', base: null }]);
});

test('prTitles：别的选项的值不当选项看；heredoc 正文不是命令；heredoc 没结束放行（PR review）', () => {
  assert.deepEqual(titlesOf(`gh pr create --title 'chore: sync' --body '--title=任务 99'`), ['chore: sync']);
  assert.deepEqual(titlesOf(`gh pr create -b -t -t x`), ['x'], '-b 的值是 -t');
  assert.deepEqual(titlesOf(`cat <<'EOF'\ngh pr create -t '任务 99'\nEOF`), []);
  assert.deepEqual(titlesOf(`gh pr create --title "x" --body "$(cat <<'EOF'\nsay "hi" it's\ngh pr create -t "任务 99"\nEOF\n)"\ngh pr edit 3 -t y`), ['x', 'y']);
  assert.deepEqual(titlesOf(`cat <<-EOF\n\tgh pr create -t z\n\tEOF\ngh pr create -t w`), ['w'], '<<- 允许结束行前有制表符');
  assert.deepEqual(titlesOf(`cat <<'EOF'\ngh pr create -t '任务 99'`), [], '没有结束行');
  assert.deepEqual(titlesOf(`grep x <<< "gh" && gh pr create -t v`), ['v'], 'here-string 不是 heredoc');
});

test('prTitles：同一行多个 heredoc、带空格或数字的分隔符都吃掉正文；读不出的分隔符放行（第二轮 review）', () => {
  assert.deepEqual(titlesOf(`cat <<FIRST <<SECOND\nignored\nFIRST\ngh pr create -t 'Task 99'\nSECOND\ngh pr create -t ok`), ['ok']);
  assert.deepEqual(titlesOf(`cat <<'DOC TEXT'\ngh pr create -t 'Task 99'\nDOC TEXT\ngh pr create -t ok`), ['ok']);
  assert.deepEqual(titlesOf(`cat <<123\ngh pr create -t 'Task 99'\n123\ngh pr create -t ok`), ['ok']);
  assert.deepEqual(titlesOf(`cat <<$X\ngh pr create -t 'Task 99'\n$X`), [], '分隔符带 $：放行');
  assert.deepEqual(titlesOf(`cat <<EOF'x'\ngh pr create -t 'Task 99'\nEOFx`), [], '分隔符紧跟引号：放行');
  assert.deepEqual(titlesOf(`cat <<FIRST <<SECOND\nFIRST\ngh pr create -t 'Task 99'`), [], '第二段没结束：放行');
});

test('prTitles：开关选项不吞下一项（--remove-milestone 不带值）', () => {
  assert.deepEqual(titlesOf(`gh pr edit 3 --remove-milestone -t '任务 99'`), ['任务 99']);
});

test('prTitles：反斜杠换行续行', () => {
  assert.deepEqual(titlesOf('gh pr create \\\n  --title "任务 1" \\\n  --body x'), ['任务 1']);
  assert.deepEqual(titlesOf('gh pr create\\\n --title x'), ['x']);
});

test('prTitles：命令前的环境变量赋值不影响', () => {
  assert.deepEqual(titlesOf(`GH_HOST=x gh pr create -t "任务 1"`), ['任务 1']);
});

// ---- docIssues：只报本次写入新引入的问题（N27 需求 2.2、2.5） ----
const BASE = `# 计划

### 里程碑 M1：地基
- [ ] 1 搭骨架
- [ ] 2 解析器（依赖 1）
  正文：\`*.mjs\` 都要过一遍，cron */5 跑一次，版本 1.2~1.8 兼容，占位符 <v> 照写；别的仓库 other-vendor#127 也看。
- [ ] 3 收尾（依赖 1~2；依赖 1.1 + 1.2）
`;
const issuesOf = (after, before = BASE) => docIssues(before, after, { kind: 'tasks', docId: 'plan' });

test('docIssues：合法写法（含 *.mjs、cron */5、1.2~1.8、<v>、别的仓库引用、依赖 1~2）不报', () => {
  assert.deepEqual(issuesOf(BASE, ''), [], '新文件');
  assert.deepEqual(issuesOf(BASE), []);
});

test('docIssues：新写的混用标题式任务、错的复选框、小写 task、正文里的标题都报，带行号、原文与建议', () => {
  const after = `${BASE}### 任务 4：标题式
- [-] 5 怪复选框
- [ ] task 6 小写
- [ ] 7 有小节
  #### 小节
`;
  const got = issuesOf(after);
  assert.deepEqual(got.map((x) => [x.rule, x.line, x.text]), [
    [1, 8, '### 任务 4：标题式'], [1, 9, '- [-] 5 怪复选框'], [1, 10, '- [ ] task 6 小写'], [8, 12, '#### 小节'],
  ]);
  assert.match(got[0].detail, /建议改成「- \[ \] 4 标题式」/);
});

test('docIssues：原有问题不报，行号移动后也认得出；同样的问题多写一处才报', () => {
  const old = `${BASE}- [-] 5 怪复选框\n`;
  assert.deepEqual(issuesOf(`前言一行\n${old}`, old), [], '上面插一行，旧问题行号变了');
  assert.deepEqual(issuesOf(old.replace('搭骨架', '搭骨架（改名）'), old), [], '改别处');
  // 再写一处同样的：新行的复选框问题，以及两行都变成「编号 5 重复」
  assert.deepEqual(issuesOf(`${old}- [-] 5 怪复选框\n`, old).map((x) => x.line), [8, 9, 9]);
});

test('docIssues：在非任务小节末尾加任务行，原有的说明行变成依赖说法——报出并标 untouched（新写的内容改变了旧行的读法）', () => {
  // 实物写法（真实 spec 末尾常见的「执行顺序」小节）：加任务行之前这一节不是任务分组，说明行不按依赖读
  const before = '# 计划\n\n## 任务\n\n- [ ] 1 一\n- [ ] 2 二\n\n## 执行顺序\n\n- **任务 2 各子项可高度并行**：2.1 定契约后，2.2 可并行推进。\n';
  const got = docIssues(before, `${before}- [ ] 3 三\n`, { kind: 'tasks', docId: 'plan' });
  assert.ok(got.length > 0);
  assert.ok(got.every((x) => x.untouched), JSON.stringify(got));
  assert.ok(!docIssues(BASE, `${BASE}- [-] 4 x\n`, { kind: 'tasks', docId: 'plan' }).some((x) => x.untouched), '新写的行不标');
});

test('docIssues：改了原本就有问题的那一行（勾选、改标题），问题还是原来那个，不报（PR review）', () => {
  const b = '# A\n\n- [ ] 1 一\n- [ ] 2 二\n- [ ] 2 又一个二\n- [-] 3 三\n';
  assert.deepEqual(docIssues(b, b.replace('- [ ] 2 二', '- [x] 2 二'), { kind: 'tasks', docId: 'a' }), []);
  assert.deepEqual(docIssues(b, b.replace('- [-] 3 三', '- [-] 3 三（改名）'), { kind: 'tasks', docId: 'a' }), []);
  // 改那一行时又多写了一处同类问题：多出来的照样报
  assert.equal(docIssues(b, b.replace('- [-] 3 三', '- [-] 3 三（改名）\n- [-] 4 四'), { kind: 'tasks', docId: 'a' }).length, 1);
});

test('docIssues：ADR 按 ADR 解析（加粗数字开头的检查清单不当任务）', () => {
  const adr = '# ADR-0001: 选型\n\n- [ ] **461 个孤儿目录** 清掉\n';
  assert.deepEqual(docIssues('', adr, { kind: 'adr', docId: 'ADR-0001-x' }), []);
});

// ---- titleIssues：与 linkPrs 的冲突 h 同口径（N27 需求 2.3、2.5） ----
const parsed = (docId, text) => ({ docId, ...parseTasksDoc(text, docId) });
const PLAN = parsed('plan-a', '### 里程碑 M0-c：一\n- [ ] 1 一\n- [ ] 3 三\n');
const OTHER = parsed('v2-plan', '- [ ] 3 三\n');
const adr = (docId) => ({ docId, ...parseAdrDoc('# ADR-0033\n- [ ] 64 x\n', docId) });

test('titleIssues：认得出的、没有引用的、别的仓库的、版本号括号都不报', () => {
  for (const t of ['feat: N27 任务 1', 'fix: plan-a#3（部分）', 'feat: M0-c（部分）', 'chore: 同步 main', 'fix: other-vendor#127 升级',
    'release (collab 2.0.4)', 'feat: ADR-0033#64']) {
    assert.deepEqual(titleIssues(t, [PLAN, adr('ADR-0033-a')]), [], t);
  }
});

test('titleIssues：不存在、大小写写错、对不上的代号、ADR 简称多篇都报并给建议', () => {
  assert.match(titleIssues('fix: 任务 99', [PLAN])[0], /不存在的任务：99/);
  assert.match(titleIssues('fix: Plan-A#1', [PLAN])[0], /建议写成「plan-a#1」/);
  assert.match(titleIssues('feat: M0-z', [PLAN])[0], /M0-z/);
  assert.match(titleIssues('feat: ADR-0033#64', [adr('ADR-0033-a'), adr('ADR-0033-b')])[0], /有歧义/);
});

test('titleIssues：分支线——不知道 base 时任一条线下没问题就不报；知道 base 只看那条线', () => {
  const lines = [{ base: 'main', docFilter: '^(?!v2-)' }, { base: 'v2', docFilter: '^v2-' }];
  assert.match(titleIssues('fix: 任务 3', [PLAN, OTHER])[0], /有歧义/, '不分线时两份都有 3');
  assert.deepEqual(titleIssues('fix: 任务 3', [PLAN, OTHER], lines), []);
  assert.deepEqual(titleIssues('fix: 任务 1', [PLAN, OTHER], lines, 'main'), []);
  assert.match(titleIssues('fix: 任务 1', [PLAN, OTHER], lines, 'v2')[0], /不存在的任务：1/);
});

test('mod 能到达的模块都不 import node:（mod 只认插件内相对路径与 claude-code；CI 不装 Claude Code，validate 管不到，N27 design §2）', () => {
  const root = new URL('../', import.meta.url);
  const seen = new Set();
  const bad = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(new URL(rel, root), 'utf8');
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (spec === 'claude-code') continue;
      if (!spec.startsWith('.')) { bad.push(`${rel} → ${spec}`); continue; }
      walk(new URL(spec, new URL(rel, root)).href.slice(root.href.length));
    }
  };
  walk('hooks/register.tsx');
  assert.deepEqual(bad, []);
  for (const f of ['src/guard.mjs', 'src/parse.mjs', 'src/refs.mjs', 'web/md.mjs']) assert.ok(seen.has(f), f);
});

test('applyEdit：恰好一处才替换，replaceAll 全换，对不上返回 null；$& 照字面', () => {
  assert.equal(applyEdit('a b a', 'b', 'c'), 'a c a');
  assert.equal(applyEdit('a b a', 'a', 'c'), null, '多处且不是 replaceAll');
  assert.equal(applyEdit('a b a', 'a', 'c', true), 'c b c');
  assert.equal(applyEdit('a', 'x', 'y'), null);
  assert.equal(applyEdit('a', 'a', '$&$&'), '$&$&');
  assert.equal(applyEdit('', '', 'new'), 'new');
});
