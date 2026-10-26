# Security

The design, with every check and its reasons, is in [SECURE-MESH.md](SECURE-MESH.md). This page is the short version.

## Threat model

Who we defend against, on the local network:

- **A stranger's device** (a guest laptop, a compromised printer): it can neither read nor change anything. Every connection is TLS 1.3 to a certificate pinned in the signed workspace record, and both ends authenticate with their device keys over that very TLS session.
- **A member** can't read rooms they aren't in (they only ever receive those rooms as ciphertext), can't write where they may only read (every change is signed, and peers drop changes from anyone who isn't currently a writer), can't touch anything outside a room's folder or inside `.obsidian` (every path is checked before any file is written), and can't give themselves access to a room: only a room's managers change its membership, and nobody, admins included, can register a computer under someone else's name.
- **A revoked computer or a removed person** is disconnected by every peer, and the keys of their rooms are replaced; they keep only what they already had.
- **A lost or stolen computer** exposes that user's rooms only. Its keys are in Obsidian's secret storage, encrypted by the operating system for that user, and stay with that computer: copying a vault doesn't copy them.

Out of scope: someone controlling a member's computer while it is unlocked (they are that member), and availability (a malicious peer can refuse to pass things on; it can't forge or read them).

## What is protected, and how

| What | How |
|---|---|
| Room content, file names, room names, cursors | AES-256-GCM per room key epoch; associated data binds each message to its room, document, author and counter |
| Who may do what | A signed, hash-chained workspace record; every version is checked against what its signer may change |
| Room keys | Random per epoch; delivered to each entitled device as an X25519-sealed, signed key wrap, checked against a commitment in the record |
| Connections | TLS 1.3, exact certificate pinning, signatures over the session's exported keying material |
| Invites | A one-time secret from which a signing key is derived; joiners prove it without revealing it |
| Device secrets | Obsidian secret storage (OS-encrypted, outside the vault) |

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/AiSuperBot/vault-rooms/security/advisories/new) on this repository rather than a public issue. Include what an attacker needs (network position, membership, role) and what they get.
