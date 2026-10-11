// 最小 DOM 替身：只实现 web/app.mjs 用到的那几样，让视图函数能在 Node 里渲染后断言（tasks.md「UI 稿对照走查」）。
// 故意没有任何「解析 HTML 字符串」的能力：若实现里有人用字符串拼 HTML，测试会直接拿不到节点而失败。

class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollLeft = 0;
    const styles = new Map();
    this.style = { setProperty: (k, v) => styles.set(k, String(v)), getPropertyValue: (k) => styles.get(k) ?? '' };
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (c) => { if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim(); },
      remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle: (c) => (this.classList.contains(c) ? (this.classList.remove(c), false) : (this.classList.add(c), true)),
    };
  }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  appendChild(node) {
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'object' ? n : new Text(n)); }
  contains(node) {
    for (let n = node; n; n = n.parentNode) { if (n === this) return true; }
    return false;
  }
  replaceChildren(...nodes) {
    // 浏览器卸载聚焦节点时退回 body；不能靠已脱离页面的 activeElement 蒙混过焦点恢复测试。
    for (let a = this.ownerDocument?.activeElement; a && a !== this; a = a.parentNode) {
      if (a.parentNode === this) { this.ownerDocument.activeElement = this.ownerDocument.body; break; }
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new Text(v)); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  /** 测试用：触发事件（不冒泡），target / currentTarget 都是自己；init 补 key 等字段。返回事件，可查 defaultPrevented / stopped。 */
  dispatch(type, init = {}) {
    const e = { type, target: this, currentTarget: this, stopPropagation() { e.stopped = true; }, preventDefault() { e.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  /** 只支持单个复合选择器：`tag`、`.a.b`、`#id`、`[attr]`、`[attr=值]` 的组合，不支持后代 / 子代组合符。 */
  querySelectorAll(selector) {
    const m = /^([a-z0-9]*)((?:[.#][\w-]+|\[[\w-]+(?:=[^\]]*)?\])*)$/i.exec(selector);
    if (!m) throw new Error(`fake-dom 不支持的选择器：${selector}`);
    const parts = [...m[2].matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:=([^\]]*))?\]/g)];
    const match = (el) => (!m[1] || el.tagName === m[1].toUpperCase()) && parts.every(([, sym, name, attr, val]) =>
      sym === '.' ? el.classList.contains(name)
        : sym === '#' ? el.getAttribute('id') === name
          : val === undefined ? el.hasAttribute(attr) : el.getAttribute(attr) === val.replace(/^["']|["']$/g, ''));
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

/** 装到 globalThis.document 上用；返回的对象就是 document。 */
export function createFakeDocument() {
  const element = (tag) => Object.assign(new Element(tag), { ownerDocument: doc });
  const doc = {
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    createTextNode: (text) => new Text(text),
    querySelector: (selector) => doc.documentElement.querySelector(selector),
    querySelectorAll: (selector) => doc.documentElement.querySelectorAll(selector),
    contains: (node) => doc.documentElement.contains(node),
  };
  doc.documentElement = element('html');
  doc.body = element('body');
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  return doc;
}
