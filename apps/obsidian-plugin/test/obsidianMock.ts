export class Notice {
  constructor(
    readonly message?: string,
    readonly timeout?: number
  ) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export class TFile {
  constructor(readonly path: string) {}
  get extension(): string {
    return this.path.includes(".") ? this.path.split(".").pop() ?? "" : "";
  }
}

export class TFolder {
  constructor(readonly path: string) {}
}

/** Obsidian's searchable list: what it offers, each item's text, and what is chosen. */
export class FuzzySuggestModal<T> {
  constructor(readonly app?: unknown) {}
  setPlaceholder(_text: string): void {}
  open(): void {}
  close(): void {}
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T): void {}
}
