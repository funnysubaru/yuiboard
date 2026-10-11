#!/usr/bin/env node
// 测试用的 gh 替身：github.test.mjs 把 project.github.ghPath 指向本文件。
// 行为由环境变量 FAKE_GH（JSON）控制，字段均可省：
//   prs      GraphQL 节点数组文件（默认同目录 prs.json），按 updatedAt 倒序分页回放
//   page     每页条数（默认 100）
//   mode     ok | auth | notfound | network | ratelimited
//   remaining / limit / resetAt   rateLimit 字段
//   scopes   `api -i /rate_limit` 返回的 X-Oauth-Scopes；为 null 时不带该头（细粒度令牌）
//   log      每次调用往该文件追加一行参数（query 正文略去），测试据此数请求次数
//   delayMs  模拟慢请求，验证轮询间隔短于请求耗时时也能观察状态
import { readFileSync, appendFileSync } from 'node:fs';

const cfg = JSON.parse(process.env.FAKE_GH || '{}');
if (cfg.delayMs) await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
const args = process.argv.slice(2);
if (cfg.log) appendFileSync(cfg.log, `${JSON.stringify(args.map((a) => (a.startsWith('query=') ? 'query=…' : a)))}\n`);

const rateLimit = { cost: 1, remaining: cfg.remaining ?? 4990, limit: cfg.limit ?? 5000, resetAt: cfg.resetAt ?? '2026-09-26T09:00:00Z' };
// 假令牌形态串运行时拼出，避免仓库里出现令牌字面量被扫描工具误报；测试断言它被遮蔽
const FAKE_TOKEN = ['gh', 'p_', 'ABCDEFabcdef0123456789', 'ABCDEFabcdef0123'].join('');
const fail = (stderr, stdout = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exit(1); };

if (args[0] === 'api' && args[1] === '-i' && args[2] === '/rate_limit') {
  const scopes = 'scopes' in cfg ? cfg.scopes : 'gist, read:org, repo, workflow';
  process.stdout.write(`HTTP/2.0 200 OK\r\nAccess-Control-Expose-Headers: X-OAuth-Scopes\r\n${scopes === null ? '' : `X-Oauth-Scopes: ${scopes}\r\n`}\r\n{"resources":{}}`);
  process.exit(0);
}

if (args[0] !== 'api' || args[1] !== 'graphql') fail(`unknown command: ${args.join(' ')}\n`);

const vars = {};
for (let i = 2; i < args.length; i += 2) {
  const [k, ...v] = args[i + 1].split('=');
  vars[k] = v.join('=');
}

switch (cfg.mode) {
  case 'auth':
    fail(`HTTP 401: Bad credentials (token ${FAKE_TOKEN})\nTry authenticating with:  gh auth login\n`);
    break;
  case 'notfound':
    fail(`gh: Could not resolve to a Repository with the name '${vars.owner}/${vars.name}'.\n`,
      JSON.stringify({ data: { rateLimit, repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository' }] }));
    break;
  case 'network':
    fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n');
    break;
  case 'ratelimited':
    fail('gh: API rate limit exceeded for user ID 1.\n',
      JSON.stringify({ data: { rateLimit: { ...rateLimit, remaining: 0 } }, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }));
    break;
}

const nodes = JSON.parse(readFileSync(cfg.prs ?? new URL('./prs.json', import.meta.url), 'utf8'))
  .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
const page = cfg.page ?? 100;
const start = vars.after ? Number(vars.after) : 0; // 游标就是下一页起始下标
const end = start + page;
process.stdout.write(JSON.stringify({ data: { rateLimit, repository: { pullRequests: {
  pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
  nodes: nodes.slice(start, end),
} } } }));
