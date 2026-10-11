// 服务端日志与 devboard-ctl 输出的语言（N26.1）：环境变量 DEVBOARD_LANG（zh / ja / en）优先，
// 其次 LC_ALL / LC_MESSAGES / LANG，都认不出用英文（launchd / systemd 下通常没有 LANG，即英文）。
// 句子仍按 msg 模板写，翻译复用页面的服务端词典；每次现读环境变量，测试可在进程内切换。
import { pickLang, txIn } from '../web/i18n.mjs';

export const logLang = (env = process.env) => pickLang(env.DEVBOARD_LANG, [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter(Boolean));
export const say = (s) => txIn(logLang(), s);
