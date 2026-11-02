import { agreementKeyPairFromSecret, createTlsIdentity, fingerprintOfPem, fromB64u, newAgreementKeyPair, newSigningKeyPair, parseJoinRecord, signingKeyPairFromSeed, type JoinRecord, type KeyPair, type TlsIdentity } from "@vault-rooms/secure";

/**
 * Device secrets (signing key, key-agreement key, TLS private key) live in Obsidian's secret storage, which keeps
 * them encrypted with the operating system's per-user protection and outside the vault, so copying a vault folder
 * doesn't copy the device's identity. Only public parts (the TLS certificate) go into the plugin's settings.
 */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
  remove(id: string): void;
}

interface ObsidianSecretStorage {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  deleteSecret?(id: string): void;
}

export function obsidianSecrets(storage: ObsidianSecretStorage): SecretStore {
  return {
    get: (id) => {
      const value = storage.getSecret(id);
      return value ? value : null;
    },
    set: (id, value) => storage.setSecret(id, value),
    // deleteSecret exists but isn't in the public typings yet; clearing the value is the documented fallback.
    remove: (id) => (typeof storage.deleteSecret === "function" ? storage.deleteSecret(id) : storage.setSecret(id, ""))
  };
}

export interface DeviceSecrets {
  sign: KeyPair;
  agree: KeyPair;
  tls: TlsIdentity;
}

function ids(scope: string) {
  return { sign: `vault-rooms-${scope}-sign`, agree: `vault-rooms-${scope}-agree`, tls: `vault-rooms-${scope}-tls`, join: `vault-rooms-${scope}-join` };
}

/** `scope` keeps several vaults (or workspaces) on one computer apart: lowercase letters, digits and dashes. */
export function isScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{8,24}$/.test(value);
}

export async function createDeviceSecrets(): Promise<{ secrets: DeviceSecrets; certPem: string }> {
  const sign = newSigningKeyPair();
  const agree = newAgreementKeyPair();
  const tls = await createTlsIdentity();
  return { secrets: { sign, agree, tls }, certPem: tls.certPem };
}

/** Publish an attempt's credentials only once its workspace record is safely stored. */
export function saveDeviceSecrets(store: SecretStore, scope: string, secrets: DeviceSecrets): void {
  const id = ids(scope);
  store.set(id.sign, secrets.sign.secretKey);
  store.set(id.agree, secrets.agree.secretKey);
  store.set(id.tls, secrets.tls.keyPem);
}

/** Null if any part is missing, e.g. the vault was copied from another computer. */
export function loadDeviceSecrets(store: SecretStore, scope: string, certPem: string): DeviceSecrets | null {
  const id = ids(scope);
  const signSeed = store.get(id.sign);
  const agreeSecret = store.get(id.agree);
  const keyPem = store.get(id.tls);
  if (!signSeed || !agreeSecret || !keyPem) return null;
  try {
    return readSecrets(signSeed, agreeSecret, keyPem, certPem);
  } catch {
    return null;
  }
}

function readSecrets(signSeed: string, agreeSecret: string, keyPem: string, certPem: string): DeviceSecrets {
  return { sign: signingKeyPairFromSeed(fromB64u(signSeed, 32)), agree: agreementKeyPairFromSecret(agreeSecret), tls: { keyPem, certPem, fingerprint: fingerprintOfPem(certPem) } };
}

/** One resumable attempt, isolated from the active identity and saved before any peer can consume its invite. */
export function saveJoinAttempt(store: SecretStore, scope: string, secrets: DeviceSecrets, join: JoinRecord): void {
  parseJoinRecord(join);
  store.set(ids(scope).join, JSON.stringify({ signSeed: secrets.sign.secretKey, agreeSecret: secrets.agree.secretKey, keyPem: secrets.tls.keyPem, certPem: secrets.tls.certPem, join }));
}

export function loadJoinAttempt(store: SecretStore, scope: string): { secrets: DeviceSecrets; join: JoinRecord } | null {
  const raw = store.get(ids(scope).join);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    const secrets = readSecrets(saved.signSeed, saved.agreeSecret, saved.keyPem, saved.certPem);
    const join = parseJoinRecord(saved.join);
    if (join.body.device.sign !== secrets.sign.publicKey || join.body.device.agree !== secrets.agree.publicKey || join.body.device.tls !== secrets.tls.fingerprint) throw new Error("keys don't match");
    return { secrets, join };
  } catch {
    // Unreadable (an older build's invalid name, damage): a fresh attempt instead, rather than no join ever again. If a
    // peer did take this one, its invite is used up and a new one is needed.
    clearJoinAttempt(store, scope);
    return null;
  }
}

export function clearJoinAttempt(store: SecretStore, scope: string): void {
  store.remove(ids(scope).join);
}

export function forgetDeviceSecrets(store: SecretStore, scope: string): void {
  const id = ids(scope);
  for (const key of Object.values(id)) store.remove(key);
}
