// 疑似凭据遮蔽（design §3.12，需求 16.4、16.6）。
// 会话片段、错误信息（含 gh 的 stderr）、日志在记录或展示前都先过 mask()，宁可多遮不可漏遮。

export const MASKED = '‹已遮蔽›';

// 顺序有讲究：私钥块先整段吃掉；各家令牌前缀其次；键值对只遮值、保留键名；最后才是泛化的长串兜底。
const RULES = [
  // PEM 私钥：片段被截短时可能没有 END 行，遮到末尾
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASKED],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, MASKED],       // Anthropic / OpenAI 等
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASKED],           // GitHub 经典令牌
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASKED],         // GitHub 细粒度令牌
  [/\bAKIA[0-9A-Z]{16}\b/g, MASKED],                   // AWS 访问密钥 ID
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASKED],         // Slack
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASKED], // JWT
  // password: xxx / api_key=xxx：键名留着便于看懂上下文，值遮掉
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, `$1$2${MASKED}`],
  [/\b[0-9a-fA-F]{32,}\b/g, MASKED],                   // ≥32 位十六进制
];

// ≥32 位 base64 / base64url 串。ponytail: 启发式——只遮同时含数字、大写、小写的串，且不把 `/` 算进串里，
// 以免把长路径（`/Users/x/Projects/app-v2/...`）、长分支名误遮；代价是含 `/` 的标准 base64 会被切成几段，
// 不足 32 位的段漏遮。常见令牌已由上面的前缀规则覆盖；真遇到漏遮再加规则。
const LONG_B64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const looksRandom = (s) => /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);

/**
 * 把文本里的疑似凭据替换为 ‹已遮蔽›。非字符串原样返回。
 * @param {string} text
 * @returns {string}
 */
export function mask(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(LONG_B64, (s) => (looksRandom(s) ? MASKED : s));
}
