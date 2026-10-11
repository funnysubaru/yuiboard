// 界面语言（N22 任务 22.3）：中文原文即翻译键，日 / 英各一份词典（i18n-ja.mjs、i18n-en.mjs）。
// 语言在模块加载时定下：本浏览器手动选过的优先，否则跟浏览器语言；切换语言写 localStorage 后整页重载，
// 所以模块顶层的常量（五态文案、视图名）也能直接用 t()。Node 里（测试）没有 window，固定中文。
import ja, { server as jaServer } from './i18n-ja.mjs';
import en, { server as enServer } from './i18n-en.mjs';

export const LANGS = [['zh', '中文'], ['ja', '日本語'], ['en', 'English']];
const DICTS = { ja, en };
const SERVER = { ja: jaServer, en: enServer };
export const LANG_KEY = 'devboard:lang';

/** 浏览器语言 → zh / ja / en；都不是时用英文。 */
export function pickLang(saved, languages) {
  if (LANGS.some(([id]) => id === saved)) return saved;
  for (const l of languages ?? []) {
    const p = String(l).toLowerCase();
    if (p.startsWith('zh')) return 'zh';
    if (p.startsWith('ja')) return 'ja';
    if (p.startsWith('en')) return 'en';
  }
  return 'en';
}

let lang = 'zh';
if (typeof window !== 'undefined') {
  let saved = null;
  try { saved = globalThis.localStorage?.getItem(LANG_KEY); } catch { /* 读不了就跟浏览器 */ }
  lang = pickLang(saved, globalThis.navigator?.languages ?? [globalThis.navigator?.language]);
}

export const getLang = () => lang;
/** 测试用；页面里切换语言走 localStorage + 重载。 */
export function setLang(l) { lang = l; compiled.clear(); }

const fill = (s, vals) => s.replace(/\{(\d+)\}/g, (_, i) => String(vals[i] ?? ''));

/**
 * 界面文案：t`共 ${n} 项` 或 t('总览')。键是中文原文、插值处写 {0}{1}…；缺译时用中文。
 * 插值原样填入，服务端来的中文由调用处自己套 tx()。
 */
export function t(strings, ...vals) {
  const key = typeof strings === 'string' ? strings : strings.reduce((a, s, i) => `${a}{${i - 1}}${s}`);
  return fill(lang === 'zh' ? key : DICTS[lang][key] ?? key, vals);
}

// 服务端发来的中文说明（诊断、需要确认的理由、读取失败原因……）：整句对词典里的模板做匹配。
// 插值默认是用户内容（会话标题、路径、文档原话、引用写法），原样保留；只有 SLOTS 登记的位置
// 才再翻译：'msg' = 服务端自己拼进来的子句（「PR 标题」「会话「x」」、错误原因），递归 tx；
// 'list' = 服务端用 joinList()（src/msg.mjs）拼的引用 / 编号列表：外层「… 等 N 个」照词典翻，分隔符是不可见标记 U+2063 +「、」，
// 英文换成「, 」、中日去掉标记；引用项（如文档名）里自带的「、」前面没有标记，原样保留。
// 新增带插值的服务端句子时，插值若是服务端子句或列表，记得在这里登记（test/i18n.test.mjs 检查键都存在）。
export const SLOTS = {
  '配置文件 {0} 读取失败：{1}': { 1: 'msg' },
  '配置文件 {0} 不是合法 JSON（{1}）：{2}': { 1: 'msg', 2: 'msg' },
  '项目 {0} 的 {1} 项：{2}': { 2: 'msg' },
  '正则无效：{0}': { 0: 'msg' },
  '没有「- [ ] 编号 标题」格式的行；共 {0} 个无编号复选框；第 {1} 行像任务行但格式不对': { 1: 'list' },
  '第 {0} 行像任务行但未能识别': { 0: 'list' },
  'ADR 编号 {0} 重复：另见 {1}；按文件名区分': { 1: 'list' },
  '本地没有 {0}，合并提交也不在本地': { 0: 'msg' },
  'git 出错：{0}': { 0: 'msg' },
  '工作区 {0} 的来源「{1}」读取失败：{2}': { 2: 'msg' },
  '读不到 {0}：{1}': { 1: 'msg' },
  '读取或解析失败：{0}': { 0: 'msg' },
  '依赖了找不到的对象：{0}': { 0: 'list' },
  '与 {0} 构成循环依赖': { 0: 'list' },
  'PR {0}': { 0: 'msg' },
  '{0}里的「{1}」有歧义，可能是 {2}': { 0: 'msg', 2: 'list' },
  '{0}里的「{1}」对应的编号在文档里重复出现，无法确定是哪一条': { 0: 'msg' },
  '{0}引用了不存在的任务：{1}': { 0: 'msg' },
  '标题指向 {0}，{1}却指向 {2}': { 0: 'list', 1: 'msg', 2: 'list' },
  '任务已作废，仍关联着 PR {0}': { 0: 'list' },
  'PR {0} 已合并，但复选框未勾': { 0: 'list' },
  '复选框已勾，但 PR {0} 还没合并': { 0: 'list' },
  '关联的 PR {0} 均已关闭未合并': { 0: 'list' },
  '依赖 {0} 还没完成，却已有 PR {1}': { 0: 'list', 1: 'list' },
  '{0}：「{1}」': { 0: 'msg' },
  '依赖 {0} 还没完成，却已有 AI 会话在做': { 0: 'list' },
  '悬空依赖：{0}': { 0: 'list' },
  '外部前置 {0}': { 0: 'list' },
  '前置 {0} 无法排期': { 0: 'list' },
  '会话来源出错：{0}': { 0: 'msg' },
  '最近一次刷新失败：{0}': { 0: 'msg' },
  '手动关联文件读不了：{0}': { 0: 'msg' },
  '手动关联写入失败：{0}': { 0: 'msg' },
  'JSON 格式错误（{0}）': { 0: 'msg' },
  '工作区 {0} 的 worktree 列表读取失败：{1}': { 1: 'msg' },
  '会话目录读不了：{0}': { 0: 'msg' },
  '{0}：{1}，单独显示': { 1: 'msg' },
  // 服务端日志与 devboard-ctl 输出（N26.1，src/say.mjs）
  '警告：{0}': { 0: 'msg' },
  '配置错误：{0}': { 0: 'msg' },
  '请求处理失败：{0} {1}：{2}': { 2: 'msg' },
  'GitHub 请求 {0}（剩余 {1}），{2}': { 1: 'msg', 2: 'msg' },
  'GitHub 请求 {0}（剩余 {1}）': { 1: 'msg' },
  '写缓存 {0}.json 失败：{1}': { 1: 'msg' },
  'devboard 启动失败：{0}': { 0: 'msg' },
  '写入后校验出错：{0}': { 0: 'msg' },
  '另一个进程（PID {0}）正在改配置，{1} 秒内没等到；稍后重试': { 0: 'msg' },
  '命令 {0} 失败：{1}': { 1: 'msg' },
};

// 每种语言一份编译好的模板与结果缓存（服务端日志按环境变量选语言，与页面语言无关，见 txIn）
const compiled = new Map();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function templates(l) {
  if (compiled.has(l)) return compiled.get(l);
  // 长模板先试：免得「{0}」开头的短模板吃掉整句。各语言词典的键相同，zh 借 en 的键（只为找出列表位置）。
  const list = Object.keys(SERVER[l] ?? SERVER.en).filter((k) => /\{\d+\}/.test(k)).sort((a, b) => b.length - a.length).map((key) => {
    const order = [];
    const re = new RegExp(`^${key.split(/\{(\d+)\}/).map((p, i) => (i % 2 ? (order.push(Number(p)), '([\\s\\S]*?)') : esc(p))).join('')}$`);
    return { key, re, order };
  });
  const c = { list, memo: new Map() };
  compiled.set(l, c);
  return c;
}

// 与 src/msg.mjs 的 LIST_MARK 相同：标记 +「、」是列表分隔符，两个标记是列表项原文里的一个 U+2063。
// 只在 SLOTS 登记为 'list' 的插值里解码（zh 也按模板找）：路径等普通插值没经过 joinList 转义，里面的标记组合原样保留。
// 对不上模板的句子分不清列表在哪，只能整句解码。
const MARK = '\u2063';
const unmark = (s, sep = '、') => s.replace(/\u2063([\u2063、])/g, (_, c) => (c === MARK ? MARK : sep));

/** 翻译服务端生成的中文句子（页面当前语言）；zh 只还原列表分隔符。 */
export const tx = (s) => txIn(lang, s);

/** 同 tx，但指定语言：服务端日志与 devboard-ctl 输出用（src/say.mjs）。 */
export function txIn(l, s) {
  if (typeof s !== 'string') return s;
  const dict = SERVER[l];
  if (!s.includes(MARK) && (!dict || !/[　-鿿]/.test(s))) return s;
  if (dict && Object.hasOwn(dict, s)) return dict[s];
  const { list, memo } = templates(l);
  if (memo.has(s)) return memo.get(s);
  let out = unmark(s);
  for (const { key, re, order } of list) {
    const m = re.exec(s);
    if (!m) continue;
    const vals = [];
    order.forEach((idx, k) => { vals[idx] = slot(l, SLOTS[key]?.[idx], m[k + 1]); });
    out = fill(dict ? dict[key] : key, vals);
    break;
  }
  memo.set(s, out);
  return out;
}

// 列表只认 engine brief() 的「… 等 N 个」截断写法，不拿列表内容去对整本词典（里面是引用原文）。
const MORE = /^([\s\S]*) 等 (\d+) 个$/;

function slot(l, kind, v) {
  if (kind === 'msg') return txIn(l, v);
  if (kind !== 'list') return v;
  const sep = (x) => unmark(x, l === 'en' ? ', ' : '、');
  const m = MORE.exec(v);
  // zh 没有词典，「等 N 个」用中文原模板
  return m ? fill(SERVER[l]?.['{0} 等 {1} 个'] ?? '{0} 等 {1} 个', [sep(m[1]), m[2]]) : sep(v);
}
