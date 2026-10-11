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
export function setLang(l) { lang = l; compiled = null; }

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
// 'list' = 服务端用「、」拼的引用 / 编号列表：只翻外层的「… 等 N 个」，列表本身原样——引用项（如文档名）里
// 也可能有「、」，没法和服务端加的分隔符区分，宁可英文里保留「、」也不改写引用原文。
// 新增带插值的服务端句子时，插值若是服务端子句或列表，记得在这里登记（test/i18n.test.mjs 检查键都存在）。
export const SLOTS = {
  '配置文件 {0} 读取失败：{1}': { 1: 'msg' },
  '配置文件 {0} 不是合法 JSON（{1}）：{2}': { 1: 'msg', 2: 'msg' },
  '项目 {0} 的 {1} 项：{2}': { 2: 'msg' },
  '正则无效：{0}': { 0: 'msg' },
  '没有「- [ ] 编号 标题」格式的行；共 {0} 个无编号复选框；第 {1} 行像任务行但格式不对': { 1: 'list' },
  '第 {0} 行像任务行但未能识别': { 0: 'list' },
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
};

let compiled = null;
const memo = new Map();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function templates() {
  if (compiled) return compiled;
  memo.clear();
  // 长模板先试：免得「{0}」开头的短模板吃掉整句。
  compiled = Object.keys(SERVER[lang]).filter((k) => /\{\d+\}/.test(k)).sort((a, b) => b.length - a.length).map((key) => {
    const order = [];
    const re = new RegExp(`^${key.split(/\{(\d+)\}/).map((p, i) => (i % 2 ? (order.push(Number(p)), '([\\s\\S]*?)') : esc(p))).join('')}$`);
    return { key, re, order };
  });
  return compiled;
}

/** 翻译服务端生成的中文句子；zh 原样返回。 */
export function tx(s) {
  if (lang === 'zh' || typeof s !== 'string' || !/[　-鿿]/.test(s)) return s;
  const dict = SERVER[lang];
  if (Object.hasOwn(dict, s)) return dict[s];
  const list = templates();
  if (memo.has(s)) return memo.get(s);
  let out = s;
  for (const { key, re, order } of list) {
    const m = re.exec(s);
    if (!m) continue;
    const vals = [];
    order.forEach((idx, k) => { vals[idx] = slot(SLOTS[key]?.[idx], m[k + 1]); });
    out = fill(dict[key], vals);
    break;
  }
  memo.set(s, out);
  return out;
}

// 列表只认 engine brief() 的「… 等 N 个」截断写法，不拿列表内容去对整本词典（里面是引用原文）。
const MORE = /^([\s\S]*) 等 (\d+) 个$/;

function slot(kind, v) {
  if (kind === 'msg') return tx(v);
  if (kind !== 'list') return v;
  const m = MORE.exec(v);
  return m ? fill(SERVER[lang]['{0} 等 {1} 个'], [m[1], m[2]]) : v;
}
