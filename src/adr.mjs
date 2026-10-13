// ADR 来源（design §3.2 adr-dir、§3.3 ADR 段；需求 2.6、D5）：ADR 只做文档级条目（编号 / 标题 / 状态原文），
// 文中有带编号的任务行时照常拆成任务。discoverAdrs 经 docs.mjs 的 DISCOVERERS 表接入；纯函数 parseAdrDoc 在 parse.mjs（N27），这里转出。
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { adrNumber } from './parse.mjs';

export { parseAdrDoc } from './parse.mjs';

/**
 * adr-dir 来源：目录下（不递归）每个 .md 一篇；docId = 文件名去扩展名（编号会重复，不能用编号当 docId）。
 * 编号取自文件名，所以重复在发现阶段就能查出，交给 parseAdrDoc 记诊断。
 * @returns {Promise<{ docId: string, kind: 'adr', abs: string, path: string, duplicates: string[] }[]>}
 *   duplicates = 编号相同的其它 ADR 的 docId
 */
export async function discoverAdrs(source, ws) {
  const root = path.resolve(ws, source.path);
  const out = [];
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const abs = path.join(root, ent.name);
    out.push({
      docId: ent.name.slice(0, -3).normalize('NFC'), kind: 'adr', abs,
      path: path.relative(ws, abs).split(path.sep).join('/').normalize('NFC'),
    });
  }
  out.sort((a, b) => (a.docId < b.docId ? -1 : 1));
  const byNumber = Map.groupBy(out, (d) => adrNumber(d.docId));
  for (const d of out) {
    const n = adrNumber(d.docId);
    d.duplicates = n === null ? [] : byNumber.get(n).filter((x) => x !== d).map((x) => x.docId);
  }
  return out;
}
