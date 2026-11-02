import { fail } from "./errors.js";

/** The only values that may be signed: JSON without floats, so every implementation serializes them identically. */
export type Canonical = null | boolean | number | string | Canonical[] | { readonly [key: string]: Canonical };

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace, safe integers only.
 * Anything else (undefined, floats, NaN, bigint, Dates, Maps, typed arrays, sparse arrays) is rejected
 * rather than silently coerced, so a signature always covers exactly the data that was meant.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 32;

/** Objects frozen whole by freezeDeep: they can't change. */
const deeplyFrozen = new WeakSet<object>();
/**
 * Of those, the ones whose encoding is kept (see keepEncoding), with the depth below them, so the depth limit still holds
 * wherever one is met again: records shared by many versions of the workspace are encoded once.
 */
const keep = new WeakSet<object>();
const encoded = new WeakMap<object, { json: string; height: number }>();
/** The deepest level reached so far by the encoding under way (see encode). */
let reached = 0;

/** Freeze a value and everything in it, for good: what is frozen so is encoded once (see canonicalJson). */
export function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || deeplyFrozen.has(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  deeplyFrozen.add(value);
  return value;
}

/** Keep the encoding of a deeply frozen value once it is made (a value shared widely, not each one: memory). */
export function keepEncoding(value: object): void {
  if (deeplyFrozen.has(value)) keep.add(value);
}

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) fail("canonical_too_deep");
  reached = Math.max(reached, depth);
  if (typeof value === "object" && value !== null && keep.has(value)) {
    const known = encoded.get(value);
    if (known) {
      if (depth + known.height > MAX_DEPTH) fail("canonical_too_deep");
      reached = Math.max(reached, depth + known.height);
      return known.json;
    }
    const outer = reached;
    reached = depth;
    const json = encodeNow(value, depth);
    encoded.set(value, { json, height: reached - depth });
    reached = Math.max(outer, reached);
    return json;
  }
  return encodeNow(value, depth);
}

function encodeNow(value: unknown, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) fail("canonical_not_integer");
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) fail("canonical_sparse_array");
          items.push(encode(value[i], depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) fail("canonical_not_plain_object");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(",")}}`;
    }
    default:
      return fail("canonical_bad_type");
  }
}

/** Parse untrusted JSON and require that it is already in canonical form (no duplicate keys, floats, padding). */
export function parseCanonical(text: string): Canonical {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("bad_json");
  }
  if (canonicalJson(parsed) !== text) fail("not_canonical");
  return parsed as Canonical;
}
