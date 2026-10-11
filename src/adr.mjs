// ADR 来源（design §3.2 adr-dir、§3.3 ADR 段；需求 2.6、D5）：ADR 只做文档级条目（编号 / 标题 / 状态原文），
// 文中有带编号的任务行时照常拆成任务。discoverAdrs 经 docs.mjs 的 DISCOVERERS 表接入，parseAdrDoc 是纯函数。
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseTasksDoc } from './docs.mjs';
import { msg } from './msg.mjs';

const ADR_NUMBER = /ADR-(\d+)/;
// 状态两种写法：「- **状态**: 已批准」「> 状态:已接受」「**Status**: Accepted」「ステータス：承認済み」这类行内写法优先；
// 否则取「## 状态」标题后的首个非空行。只看前 30 行，免得正文里的「状态」说明被误认。
const STATUS_INLINE = /^[>\-*\s]*\**(?:状态|Status|ステータス|状態)\**\s*[:：]\s*(.+)/;
const STATUS_HEADING = /^#+\s*(?:状态|Status|ステータス|状態)\s*$/;
const STATUS_SCAN_LINES = 30;
const STATUS_MAX = 80;
// H1 常以「ADR-0014: 」「ADR-0022 — 」开头，编号另有字段，标题里去掉免得页面上重复。
const TITLE_PREFIX = /^ADR-\d+\s*(?:[:：—–-]\s*)?/;

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

const adrNumber = (docId) => ADR_NUMBER.exec(docId)?.[1] ?? null;

/**
 * 解析一篇 ADR。任务行、分组、关系全部沿用 parseTasksDoc；只额外给出 adr 字段并调整两处：
 * 没有任务行是 ADR 的常态（无编号检查清单静默忽略），不记 no-tasks；编号重复记进 parse.diagnostics。
 * @param {string} text
 * @param {string} docId 文件名去扩展名
 * @param {{ file?: string, duplicates?: string[] } & object} [opts] 其余同 parseTasksDoc 的 opts
 * @returns {object} parseTasksDoc 的结果 + { kind: 'adr', adr: { number: string|null, status: string|null } }；
 *   number 为文件名里的数字原文（如 '0014'），status 为原文、不归一化，超过 80 字截断并加「…」
 */
export function parseAdrDoc(text, docId, opts = {}) {
  // ADR 的检查清单常写「- [ ] **461 个孤儿目录…**」这类加粗数字开头的条目，会被任务行正则误认成编号任务
  // （还会互相撞成重复编号）。ADR 内只认不加粗的编号任务：把这类行的加粗前缀挪开，行数不变，
  // 它们随之按无编号复选框计数、静默忽略。
  text = text.replace(/^(\s*[-*]\s+\[.\]\s+)(\*\*\d)/gm, '$1·$2');
  const doc = parseTasksDoc(text, docId, opts);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const number = adrNumber(docId);
  if (doc.parse.state === 'no-tasks') {
    doc.parse.state = 'ok';
    delete doc.parse.reason;
  }
  if (opts.duplicates?.length) {
    doc.parse.diagnostics.push({
      message: msg`ADR 编号 ${number} 重复：另见 ${opts.duplicates.join('、')}；按文件名区分`,
      source: { file: opts.file ?? docId, line: 1, text: lines[0].trim().slice(0, 160) },
    });
  }
  return {
    ...doc, kind: 'adr',
    title: doc.title?.replace(TITLE_PREFIX, '') || doc.title,
    adr: { number, status: findStatus(lines) },
  };
}

function findStatus(lines) {
  const head = lines.slice(0, STATUS_SCAN_LINES);
  let raw = null;
  for (const l of head) {
    const m = STATUS_INLINE.exec(l);
    if (m) { raw = m[1]; break; }
  }
  if (raw === null) {
    const i = head.findIndex((l) => STATUS_HEADING.test(l));
    if (i >= 0) raw = lines.slice(i + 1).find((l) => l.trim()) ?? null;
  }
  if (raw === null) return null;
  const chars = [...raw.trim()]; // 按码点截，不把 emoji 截成半个
  return chars.length > STATUS_MAX ? `${chars.slice(0, STATUS_MAX).join('')}…` : chars.join('');
}
