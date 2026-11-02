/** Small DOM/Obsidian surface for exercising UI updates without launching the desktop app. */
export const doc = { activeElement: null as UiElement | null, created: 0, createElement: (tag: string) => new UiElement(tag) };

class UiText {
  nodeType = 3;
  nodeName = "#text";
  parentNode: UiElement | null = null;
  constructor(public nodeValue: string) {}
  get textContent() { return this.nodeValue; }
  get nextSibling(): UiNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
}
type UiNode = UiElement | UiText;

export class UiElement {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  parentNode: UiElement | null = null;
  childNodes: UiNode[] = [];
  ownerDocument = doc;
  attrs = new Map<string, string>();
  dataset: Record<string, string>;
  onclick: ((event: { currentTarget: UiElement }) => unknown) | null = null;
  oninput: (() => void) | null = null;
  onchange: (() => void) | null = null;
  disabled = false;
  value = "";
  style: Record<string, string> = {};
  selectionStart = 0;
  selectionEnd = 0;
  constructor(tag: string) {
    doc.created++;
    this.nodeName = this.tagName = tag.toUpperCase();
    this.dataset = new Proxy({}, { get: (_, key) => this.attrs.get(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`), set: (_, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value)); return true; } });
  }
  get firstChild(): UiNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): UiNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get textContent(): string { return this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(text: string) { this.empty(); this.insertBefore(new UiText(text), null); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); if (name === "disabled") this.disabled = true; }
  removeAttribute(name: string) { this.attrs.delete(name); if (name === "disabled") this.disabled = false; }
  toggleAttribute(name: string, on: boolean) { if (on) this.setAttribute(name, ""); else this.removeAttribute(name); }
  addClass(name: string) { this.setAttribute("class", `${this.getAttribute("class") ?? ""} ${name}`.trim()); }
  setText(text: string) { this.textContent = text; }
  contains(node: UiElement): boolean { return this === node || this.childNodes.some((child) => child instanceof UiElement && child.contains(node)); }
  insertBefore(node: UiNode, before: UiNode | null) {
    node.parentNode?.removeChild(node);
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: UiNode) {
    if (node instanceof UiElement && doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = null;
    this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null;
  }
  empty() { for (const child of [...this.childNodes]) this.removeChild(child); }
  focus() { doc.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  createEl(tag: string, options: { text?: string; cls?: string } = {}) {
    const element = new UiElement(tag);
    if (options.text) element.textContent = options.text;
    if (options.cls) element.addClass(options.cls);
    this.insertBefore(element, null);
    return element;
  }
  createDiv(options?: { text?: string; cls?: string }) { return this.createEl("div", options); }
  createSpan(options?: { text?: string; cls?: string }) { return this.createEl("span", options); }
  querySelectorAll(selector: string): UiElement[] {
    const all = this.childNodes.flatMap((child) => child instanceof UiElement ? [child, ...child.querySelectorAll("*")] : []);
    return selector === "*" ? all : selector === "[data-focus-key]" ? all.filter((element) => element.hasAttribute("data-focus-key")) : all.filter((element) => element.tagName === selector.toUpperCase());
  }
  click() { return this.onclick?.({ currentTarget: this }); }
  addEventListener() {}
}

export class UiModal {
  titleEl = new UiElement("h2");
  contentEl = new UiElement("div");
  closed = false;
  constructor(public app: unknown) {}
  onOpen() {}
  onClose() {}
  open() { this.onOpen(); }
  close() { this.closed = true; this.onClose(); }
}

export class UiSetting {
  settingEl: UiElement;
  constructor(parent: UiElement) { this.settingEl = parent.createDiv(); }
  setName(name: string) { this.settingEl.createSpan({ text: name }); return this; }
  setDesc(desc: string) { this.settingEl.createSpan({ text: desc }); return this; }
  addText(build: (field: any) => void) {
    const inputEl = this.settingEl.createEl("input");
    const field = { inputEl, setValue(value: string) { inputEl.value = value; return field; }, onChange(fn: (value: string) => void) { inputEl.oninput = () => fn(inputEl.value); return field; } };
    build(field); return this;
  }
  addDropdown(build: (field: any) => void) {
    const selectEl = this.settingEl.createEl("select");
    const field = { selectEl, setValue(value: string) { selectEl.value = value; return field; }, addOption() { return field; }, onChange(fn: (value: string) => void) { selectEl.onchange = () => fn(selectEl.value); return field; } };
    build(field); return this;
  }
  addButton(build: (button: any) => void) {
    const buttonEl = this.settingEl.createEl("button");
    const button = { buttonEl, setButtonText(text: string) { buttonEl.textContent = text; return button; }, setDisabled(value: boolean) { buttonEl.disabled = value; return button; }, setWarning() { return button; }, setCta() { return button; }, onClick(fn: () => unknown) { buttonEl.onclick = fn; return button; } };
    build(button); return this;
  }
}
