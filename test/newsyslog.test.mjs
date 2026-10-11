import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('macOS 日志轮转：小文件不动，超限后保留三份归档并收紧权限', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devboard-newsyslog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'newsyslog.conf');
  writeFileSync(config, readFileSync(new URL('../ops/devboard.newsyslog.conf', import.meta.url), 'utf8')
    .split('\n').map((line) => {
      if (!line.trim() || line.trim().startsWith('#')) return line;
      const [file, ...fields] = line.trim().split(/\s+/);
      assert.ok(['devboard.log', 'devboard.error.log'].includes(path.basename(file)));
      return [path.join(dir, path.basename(file)), ...fields].join('\t');
    }).join('\n'));
  const logs = ['devboard.log', 'devboard.error.log'].map((name) => path.join(dir, name));
  const rotate = () => execFileSync('/usr/sbin/newsyslog', ['-r', '-f', config], { timeout: 10_000 });
  for (const file of logs) writeFileSync(file, 'small\n');
  rotate();
  for (const file of logs) {
    assert.equal(readFileSync(file, 'utf8'), 'small\n');
    assert.equal(existsSync(`${file}.0`), false);
  }
  // 实写字节：macOS newsyslog 按已分配磁盘块判断大小，稀疏文件不能覆盖阈值。
  for (let round = 0; round < 4; round++) {
    for (const file of logs) writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1, 65 + round));
    rotate();
  }
  for (const file of logs) {
    assert.ok(statSync(file).size < 1024);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    for (let i = 0; i < 3; i++) assert.equal(readFileSync(`${file}.${i}`)[0], 68 - i);
    assert.equal(existsSync(`${file}.3`), false, '不得留下第四份归档');
  }
});
