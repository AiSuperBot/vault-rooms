/**
 * Paths inside a room, as stored in the room index. Every path a peer sends is checked here before anything touches
 * the disk: a room member who can write may only ever create or change files inside the room's folder, never in
 * Obsidian's configuration (".obsidian", where plugins live) or anywhere else on the computer.
 */

const MAX_PATH = 400;
const MAX_SEGMENT = 120;
// Names Windows refuses (with or without an extension).
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Returns the path in NFC form if it is safe to use relative to a room folder on Windows, macOS and Linux, or null.
 * Rejected: absolute paths, drive letters, "..", empty or dot-leading segments (".obsidian", ".trash", ".git"),
 * backslashes, characters Windows forbids, reserved device names, trailing dots or spaces, control characters.
 */
export function safeRoomPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const normalized = path.normalize("NFC");
  if (normalized.length === 0 || normalized.length > MAX_PATH || hasControl(normalized)) return null;
  if (/[\\:*?"<>|]/.test(normalized)) return null;
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT) return null;
    if (segment.startsWith(".")) return null;
    if (segment.endsWith(".") || segment.endsWith(" ") || segment !== segment.trimStart()) return null;
    if (RESERVED.test(segment)) return null;
  }
  return normalized;
}

/** Case- and form-insensitive key: two paths with equal keys are the same file on Windows and macOS. */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}
