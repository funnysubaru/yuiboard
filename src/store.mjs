// devboard 自己的数据（design §3.11）：可丢弃的缓存 `cache/<项目>/`（任务 3.5）与唯一的业务数据
// 手动关联 `data/<项目>/manual-links.json`（任务 4.1）。
// 这是 src/ 里唯一允许写盘的模块（需求 16.1，server.test 有静态检查），所有写入都经 atomicWrite，
// 且目标目录必须是 `…/cache/<项目>` 或 `…/data/<项目>`。
// 缓存版本不符或损坏一律当不存在、由调用方重建；手动关联文件损坏则只读、绝不覆盖（需求 7.3、7.6）。
import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { msg } from './msg.mjs';

// 缓存格式的手动版本号：改了缓存文件的结构就 +1。
const CACHE_FORMAT = 1;
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * 缓存版本 = 格式号 + src/ 全部源码的哈希。解析规则、看板结构一改，旧的 docs.json / board.json 就作废，
 * 不必靠人记得手动升版本（并行开发中解析器常改，旧缓存回放会显示过时的解析结果）。只在启动时算一次。
 * ponytail: 代码一改连 github.json 也作废，代价是重启后多拉一轮完整 PR（几页）；需要时再按文件分别算。
 */
let versionPromise = null;
export function cacheVersion() {
  versionPromise ??= (async () => {
    const hash = createHash('sha1');
    const files = (await readdir(SRC_DIR, { recursive: true })).filter((f) => f.endsWith('.mjs')).sort();
    for (const f of files) hash.update(f).update(await readFile(path.join(SRC_DIR, f)));
    return `${CACHE_FORMAT}:${hash.digest('hex').slice(0, 12)}`;
  })();
  return versionPromise;
}

/**
 * 读 `<dir>/<name>.json`。文件不存在、JSON 损坏、cacheVersion 不符 → null（调用方重建）。
 * @param {string} dir 项目的缓存目录 `cache/<项目>`
 * @param {'github'|'docs'|'board'|'sessions'} name
 * @returns {Promise<any|null>} 写入时的 value
 */
export async function readCache(dir, name) {
  try {
    const obj = JSON.parse(await readFile(path.join(dir, `${name}.json`), 'utf8'));
    return obj?.cacheVersion === (await cacheVersion()) ? obj.value : null;
  } catch {
    return null;
  }
}

let tmpSeq = 0;

/**
 * 原子写 `<dir>/<name>.json`：先写同目录 `.tmp` 再 rename，读的一方永远看不到写了一半的文件；
 * 目录（含被人删掉的 cache/）按需重建；文件 mode 0600，目录 0700（缓存里有 PR 标题等仓库信息）。
 * Windows 上目标文件被其它进程占着时 rename 报 EPERM，隔一会儿重试（design §6，未实测）。
 */
export async function writeCache(dir, name, value) {
  await atomicWrite(dir, `${name}.json`, JSON.stringify({ cacheVersion: await cacheVersion(), value }));
}

// 本模块唯一的写盘入口。目录的上一级必须叫 cache 或 data（design §3.12 只读自检：写入目标限于 data/ / cache/），
// 项目 id 带 `/`、`..` 之类拼出别的路径时在这里挡住。
async function atomicWrite(dir, name, text) {
  const root = path.basename(path.dirname(path.resolve(dir)));
  if (root !== 'cache' && root !== 'data') throw new Error(`拒绝写入 ${dir}：只允许 cache/<项目> 或 data/<项目> 目录`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`; // 每次写各用各的临时文件，同名文件并发写也不会互相踩
  await writeFile(tmp, text, { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(tmp, file);
    } catch (e) {
      if (e.code !== 'EPERM' || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

// ---------------- 手动关联（任务 4.1，design §3.11、需求 7） ----------------

const MANUAL_FILE = 'manual-links.json';

/**
 * 手动关联文件的「戳」：修改时间 + 大小。轮询比对它发现 owner 手改（design §3.11），不变就不重读。
 * @param {string} dir `data/<项目>`
 * @returns {Promise<string|null>} 文件不存在为 null
 */
export async function manualStamp(dir) {
  try {
    const s = await stat(path.join(dir, MANUAL_FILE));
    return `${s.mtimeMs}:${s.size}`;
  } catch (e) {
    return e.code === 'ENOENT' ? null : `error:${e.code}`; // 读不了也给个戳，让调用方去 readManual 拿到原因
  }
}

/**
 * 读手动关联。文件不存在 = 还没有记录（`[]`）；读失败、JSON 损坏、结构不对 → records null + error 原因，
 * 调用方据此只用自动关联、写接口 409（需求 7.6）。结构不对也当损坏：宁可只读，也不能在下次写入时把读不懂的内容冲掉。
 * @param {string} dir `data/<项目>`
 * @returns {Promise<{records: {project: string, taskKey: string, pr: number, action: 'link'|'unlink', at: string}[]|null,
 *   error: string|null, stamp: string|null}>} stamp 取自读之前，读的过程中文件又变了下一轮轮询会再读
 */
export async function readManual(dir) {
  const stamp = await manualStamp(dir);
  let text;
  try {
    text = await readFile(path.join(dir, MANUAL_FILE), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { records: [], error: null, stamp } : { records: null, error: e.message, stamp };
  }
  let records;
  try {
    records = JSON.parse(text);
  } catch (e) {
    return { records: null, error: msg`JSON 格式错误（${e.message}）`, stamp };
  }
  if (!Array.isArray(records)) return { records: null, error: msg('内容应是记录数组'), stamp };
  const bad = records.findIndex((r) => !isManualRecord(r));
  if (bad >= 0) return { records: null, error: msg`第 ${bad + 1} 条记录格式不对（需要 project、taskKey、pr、action、at 五个字段）`, stamp };
  return { records, error: null, stamp };
}

function isManualRecord(r) {
  return r !== null && typeof r === 'object' && typeof r.project === 'string' && typeof r.taskKey === 'string' && r.taskKey !== ''
    && Number.isSafeInteger(r.pr) && r.pr > 0 && (r.action === 'link' || r.action === 'unlink') && typeof r.at === 'string';
}

const manualLocks = new Map(); // 目录 → 串行锁：同一文件的「读最新 → 改 → 写」不交错

/**
 * 新增 / 覆盖 / 撤销一条手动记录（design §3.11）：进程内互斥 → 读最新文件 → 改 → 原子写。
 * 同一 (taskKey, pr) 只留一条，新动作覆盖旧的；change 不带 action = 撤销，即删掉这一条（没有则不写盘）。
 * 文件损坏或读不了 → 抛 code 'EMANUAL_BROKEN'，文件一个字节都不动（需求 7.6）。
 * 输出带缩进、一条一行对象，方便人读和手改（需求 7.4）。
 * @param {string} dir `data/<项目>`
 * @param {string} project 项目 id（记录的 project 字段）
 * @param {{taskKey: string, pr: number, action?: 'link'|'unlink'}} change
 * @param {string} at ISO 时间（调用方给，测试可固定）
 * @returns {Promise<{records: object[], stamp: string|null}>}
 */
export function changeManual(dir, project, { taskKey, pr, action }, at) {
  const run = (manualLocks.get(dir) ?? Promise.resolve()).then(async () => {
    const cur = await readManual(dir);
    if (cur.error) throw Object.assign(new Error(cur.error), { code: 'EMANUAL_BROKEN' });
    const rest = cur.records.filter((r) => !(r.taskKey === taskKey && r.pr === pr));
    if (!action && rest.length === cur.records.length) return { records: cur.records, stamp: cur.stamp };
    const records = action ? [...rest, { project, taskKey, pr, action, at }] : rest;
    await atomicWrite(dir, MANUAL_FILE, `${JSON.stringify(records, null, 2)}\n`);
    return { records, stamp: await manualStamp(dir) };
  });
  manualLocks.set(dir, run.catch(() => {}));
  return run;
}
