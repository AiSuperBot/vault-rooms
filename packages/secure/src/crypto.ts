import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject
} from "node:crypto";
import { b64u, concatBytes, fromB64u, u32, utf8 } from "./bytes.js";
import { fail } from "./errors.js";

/** Raw 32-byte keys, base64url. `secretKey` is the private seed; it belongs in Obsidian's secret storage only. */
export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

/** Ciphertext of an AEAD seal; `ct` carries the 16-byte GCM tag at its end. */
export interface Sealed {
  nonce: string;
  ct: string;
}

/** A message encrypted to one device's X25519 key (ephemeral-static ECDH + HKDF + AES-256-GCM). */
export interface SealedBox extends Sealed {
  epk: string;
}

const PREFIX = "vault-rooms/v1/";

// DER wrappers turning raw 32-byte keys into the PKCS#8 / SPKI structures Node imports.
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

const keyCache = new Map<string, KeyObject>();

function cachedKey(cacheKey: string, build: () => KeyObject): KeyObject {
  let key = keyCache.get(cacheKey);
  if (!key) {
    if (keyCache.size >= 512) keyCache.clear();
    key = build();
    keyCache.set(cacheKey, key);
  }
  return key;
}

function privateKeyFrom(prefix: Buffer, secretKey: string, kind: string): KeyObject {
  return cachedKey(`${kind}:s:${secretKey}`, () =>
    createPrivateKey({ key: Buffer.concat([prefix, fromB64u(secretKey, 32)]), format: "der", type: "pkcs8" })
  );
}

function publicKeyFrom(prefix: Buffer, publicKey: string, kind: string): KeyObject {
  return cachedKey(`${kind}:p:${publicKey}`, () =>
    createPublicKey({ key: Buffer.concat([prefix, fromB64u(publicKey, 32)]), format: "der", type: "spki" })
  );
}

function rawPublic(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return b64u(new Uint8Array(der.subarray(der.length - 32)));
}

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

/** SHA-256 over a purpose tag and length-prefixed parts, so different inputs can never collide by concatenation. */
export function hashTagged(purpose: string, ...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256").update(utf8(PREFIX + purpose)).update(new Uint8Array([0]));
  for (const part of parts) hash.update(u32(part.length)).update(part);
  return new Uint8Array(hash.digest());
}

export function hmacTagged(key: Uint8Array, purpose: string, ...parts: Uint8Array[]): Uint8Array {
  const mac = createHmac("sha256", key).update(utf8(PREFIX + purpose)).update(new Uint8Array([0]));
  for (const part of parts) mac.update(u32(part.length)).update(part);
  return new Uint8Array(mac.digest());
}

export function hkdf(ikm: Uint8Array, salt: Uint8Array, purpose: string, length = 32): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", ikm, salt, utf8(PREFIX + purpose), length));
}

// ---- Ed25519 signatures ----

export function signingKeyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) fail("bad_seed");
  const secretKey = b64u(seed);
  return { publicKey: rawPublic(privateKeyFrom(ED25519_PKCS8, secretKey, "ed")), secretKey };
}

export function newSigningKeyPair(): KeyPair {
  return signingKeyPairFromSeed(randomBytes(32));
}

function signedMessage(purpose: string, message: Uint8Array): Uint8Array {
  return concatBytes(utf8(`${PREFIX}sig/${purpose}`), new Uint8Array([0]), message);
}

export function sign(secretKey: string, purpose: string, message: Uint8Array): string {
  return b64u(new Uint8Array(nodeSign(null, signedMessage(purpose, message), privateKeyFrom(ED25519_PKCS8, secretKey, "ed"))));
}

/** False for any malformed key or signature, never throws on attacker input. */
export function verify(publicKey: string, purpose: string, message: Uint8Array, signature: string): boolean {
  try {
    const sig = fromB64u(signature, 64);
    return nodeVerify(null, signedMessage(purpose, message), publicKeyFrom(ED25519_SPKI, publicKey, "ed"), sig);
  } catch {
    return false;
  }
}

// ---- AES-256-GCM ----

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed {
  if (key.length !== 32) fail("bad_key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64u(nonce), ct: b64u(new Uint8Array(ct)) };
}

export function open(key: Uint8Array, sealed: Sealed, aad: Uint8Array): Uint8Array {
  if (key.length !== 32) fail("bad_key");
  const nonce = fromB64u(sealed.nonce, 12);
  const data = fromB64u(sealed.ct);
  if (data.length < 16) fail("decrypt_failed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - 16));
    return new Uint8Array(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]));
  } catch {
    return fail("decrypt_failed");
  }
}

// ---- X25519 sealed boxes ----

export function newAgreementKeyPair(): KeyPair {
  const secretKey = b64u(randomBytes(32));
  return { publicKey: rawPublic(privateKeyFrom(X25519_PKCS8, secretKey, "x")), secretKey };
}

function sharedSecret(secretKey: string, publicKey: string): Uint8Array {
  const shared = new Uint8Array(
    diffieHellman({ privateKey: privateKeyFrom(X25519_PKCS8, secretKey, "x"), publicKey: publicKeyFrom(X25519_SPKI, publicKey, "x") })
  );
  // A low-order public key yields the all-zero secret; refuse it rather than encrypt under a known key.
  if (shared.every((byte) => byte === 0)) fail("weak_key");
  return shared;
}

function boxKey(shared: Uint8Array, epk: string, recipient: string, purpose: string): Uint8Array {
  return hkdf(shared, concatBytes(fromB64u(epk, 32), fromB64u(recipient, 32)), `box/${purpose}`);
}

export function sealToDevice(recipientAgreementKey: string, purpose: string, plaintext: Uint8Array, aad: Uint8Array): SealedBox {
  const ephemeral = newAgreementKeyPair();
  const key = boxKey(sharedSecret(ephemeral.secretKey, recipientAgreementKey), ephemeral.publicKey, recipientAgreementKey, purpose);
  return { epk: ephemeral.publicKey, ...seal(key, plaintext, aad) };
}

export function openFromDevice(recipient: KeyPair, purpose: string, box: SealedBox, aad: Uint8Array): Uint8Array {
  const key = boxKey(sharedSecret(recipient.secretKey, box.epk), box.epk, recipient.publicKey, purpose);
  return open(key, box, aad);
}
