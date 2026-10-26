import { describe, expect, it } from "vitest";
import { b64u, fromB64u, utf8 } from "./bytes.js";
import { canonicalJson, parseCanonical } from "./canonical.js";
import {
  hashTagged,
  newAgreementKeyPair,
  newSigningKeyPair,
  open,
  openFromDevice,
  randomBytes,
  seal,
  sealToDevice,
  sign,
  signingKeyPairFromSeed,
  verify
} from "./crypto.js";
import { SecureError } from "./errors.js";
import { deviceIdFor, isId, randomId } from "./ids.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecureError ? error.code : `other:${String(error)}`;
  }
  return "no error";
};

describe("canonical JSON", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  });
  it("refuses anything that wouldn't serialize the same everywhere", () => {
    for (const bad of [1.5, NaN, Infinity, undefined, 10n, new Date(0), new Map(), new Uint8Array(1), () => 0, Symbol("x")]) {
      expect(code(() => canonicalJson({ v: bad }))).toMatch(/^canonical_/);
    }
    // eslint-disable-next-line no-sparse-arrays
    expect(code(() => canonicalJson([1, , 3]))).toBe("canonical_sparse_array");
  });
  it("parses only canonical text", () => {
    expect(parseCanonical('{"a":1}')).toEqual({ a: 1 });
    expect(code(() => parseCanonical('{ "a": 1 }'))).toBe("not_canonical");
    expect(code(() => parseCanonical('{"b":1,"a":2}'))).toBe("not_canonical");
    expect(code(() => parseCanonical('{"a":1,"a":2}'))).toBe("not_canonical");
    expect(code(() => parseCanonical("{"))).toBe("bad_json");
  });
});

describe("base64url", () => {
  it("round-trips and rejects non-canonical spellings", () => {
    const bytes = randomBytes(33);
    expect(fromB64u(b64u(bytes))).toEqual(bytes);
    expect(code(() => fromB64u("AB=="))).toBe("bad_base64url");
    expect(code(() => fromB64u("AB+/"))).toBe("bad_base64url");
    expect(code(() => fromB64u("AQ", 2))).toBe("bad_length");
    // "AR" decodes to the same byte as "AQ" (unused low bits set): not canonical.
    expect(code(() => fromB64u("AR"))).toBe("bad_base64url");
  });
});

describe("signatures", () => {
  const keys = newSigningKeyPair();
  const message = utf8("hello");
  const sig = sign(keys.secretKey, "test", message);
  it("verify the message, purpose and key they were made for", () => {
    expect(verify(keys.publicKey, "test", message, sig)).toBe(true);
    expect(verify(keys.publicKey, "other-purpose", message, sig)).toBe(false);
    expect(verify(keys.publicKey, "test", utf8("hellO"), sig)).toBe(false);
    expect(verify(newSigningKeyPair().publicKey, "test", message, sig)).toBe(false);
  });
  it("return false rather than throw on garbage", () => {
    expect(verify("not a key", "test", message, sig)).toBe(false);
    expect(verify(keys.publicKey, "test", message, "short")).toBe(false);
    expect(verify(keys.publicKey, "test", message, b64u(new Uint8Array(64)))).toBe(false);
  });
  it("derive the same key from the same seed", () => {
    const seed = randomBytes(32);
    expect(signingKeyPairFromSeed(seed)).toEqual(signingKeyPairFromSeed(seed));
  });
});

describe("AEAD", () => {
  const key = randomBytes(32);
  const aad = utf8("room-1/doc-1");
  it("opens only with the same key and associated data", () => {
    const sealed = seal(key, utf8("secret text"), aad);
    expect(Buffer.from(open(key, sealed, aad)).toString()).toBe("secret text");
    expect(code(() => open(key, sealed, utf8("room-2/doc-1")))).toBe("decrypt_failed");
    expect(code(() => open(randomBytes(32), sealed, aad))).toBe("decrypt_failed");
    const tampered = fromB64u(sealed.ct);
    tampered[0] = tampered[0]! ^ 1;
    expect(code(() => open(key, { nonce: sealed.nonce, ct: b64u(tampered) }, aad))).toBe("decrypt_failed");
    expect(code(() => open(key, { nonce: sealed.nonce, ct: "AA" }, aad))).toBe("decrypt_failed");
  });
  it("uses a fresh nonce every time", () => {
    const a = seal(key, utf8("x"), aad);
    const b = seal(key, utf8("x"), aad);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("sealed boxes to a device", () => {
  it("only the recipient can open them, and only in context", () => {
    const recipient = newAgreementKeyPair();
    const box = sealToDevice(recipient.publicKey, "wrap", utf8("room key"), utf8("ctx"));
    expect(Buffer.from(openFromDevice(recipient, "wrap", box, utf8("ctx"))).toString()).toBe("room key");
    expect(code(() => openFromDevice(newAgreementKeyPair(), "wrap", box, utf8("ctx")))).toBe("decrypt_failed");
    expect(code(() => openFromDevice(recipient, "other", box, utf8("ctx")))).toBe("decrypt_failed");
    expect(code(() => openFromDevice(recipient, "wrap", box, utf8("other ctx")))).toBe("decrypt_failed");
  });
  it("refuse a low-order public key instead of encrypting under a known key", () => {
    const zero = b64u(new Uint8Array(32));
    expect(code(() => sealToDevice(zero, "wrap", utf8("k"), utf8("ctx")))).not.toBe("no error");
  });
});

describe("ids and tagged hashes", () => {
  it("derive device ids from keys", () => {
    const keys = newSigningKeyPair();
    expect(isId(deviceIdFor(keys.publicKey), "d")).toBe(true);
    expect(deviceIdFor(keys.publicKey)).toBe(deviceIdFor(keys.publicKey));
    expect(isId(randomId("r"), "r")).toBe(true);
    expect(isId(randomId("r"), "u")).toBe(false);
  });
  it("length-prefix their parts", () => {
    expect(b64u(hashTagged("t", utf8("ab"), utf8("c")))).not.toBe(b64u(hashTagged("t", utf8("a"), utf8("bc"))));
    expect(b64u(hashTagged("t", utf8("ab")))).not.toBe(b64u(hashTagged("u", utf8("ab"))));
  });
});
