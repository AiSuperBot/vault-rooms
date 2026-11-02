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
