import { fail } from "./errors.js";

/** Messages on a peer connection: a 4-byte big-endian length, then that many bytes of UTF-8 JSON. */

export const MAX_FRAME = 64 << 20;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME) fail("frame_too_large");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Collects bytes from a stream and yields whole frames. Throws on an oversized frame or bad JSON. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(private readonly maxFrame = MAX_FRAME) {}

  push(chunk: Buffer): unknown[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const out: unknown[] = [];
    for (;;) {
      if (this.buffered < 4) return out;
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      this.chunks = [all];
      const length = all.readUInt32BE(0);
      if (length > this.maxFrame) fail("frame_too_large");
      if (all.length < 4 + length) return out;
      const body = all.subarray(4, 4 + length);
      const rest = all.subarray(4 + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        fail("bad_frame");
      }
    }
  }
}
