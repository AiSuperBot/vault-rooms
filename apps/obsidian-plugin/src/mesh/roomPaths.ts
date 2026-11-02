import { createHash } from "node:crypto";
import { isWithin, MAX_PATH, MAX_SEGMENT, safeRoomPath } from "@vault-rooms/secure";

/** Names and paths of a room's files: pure helpers, shared by the room folder and the editor binding. */

/**
 * The file types a room shares. Anything else (programs, scripts, shortcuts, web pages, documents that can carry
 * macros) is neither shared from this computer nor written to it when someone else adds one, so a member can't plant
 * something that runs when opened.
 */
export const SHARED_EXTENSIONS = new Set([
  "md", "canvas", "base", "txt", "csv", "tsv", "json",
  "pdf", "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic",
  "mp3", "wav", "m4a", "ogg", "oga", "opus", "flac", "mp4", "m4v", "webm", "mov", "mkv", "ogv",
  "zip"
]);

/**
 * Why a vault folder can't be (or become) a room's folder: a name some computers can't use (a dot folder anywhere in it
 * included), or inside, around or the same as one of `others` (the folders of the rooms shown here), compared as the
 * disk compares names. Used both to offer folders and to share one.
 */
export function folderProblem(path: string, others: string[]): string | null {
  if (safeRoomPath(path) === null) return `"${path}" can't be shared (dot folders and some characters can't be used).`;
  const clash = others.find((folder) => isWithin(path, folder) || isWithin(folder, path));
  return clash === undefined ? null : `"${path}" overlaps the folder of another room ("${clash}").`;
}

export function isShareable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 && SHARED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Notes are compared and shared with "\n" line endings, as Obsidian's editor holds them (and saves them, once edited). */
export function normalizeNote(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("base64url");
}

function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

/** A portable suffixed name, shortened to fit; use the room root when its directory leaves no space. */
export function suffixed(path: string, tag: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const { stem, ext } = splitName(path.slice(slash + 1));
  const suffix = ` (${tag})`;
  const room = Math.min(MAX_SEGMENT, MAX_PATH - dir.length) - suffix.length - ext.length;
  if (room < 1) return dir ? suffixed(path.slice(slash + 1), tag) : null;
  // Never half of a character made of two (a surrogate pair).
  const cut = stem.slice(0, room).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return (cut ? safeRoomPath(`${dir}${cut}${suffix}${ext}`) : null) ?? (dir ? suffixed(path.slice(slash + 1), tag) : null);
}
