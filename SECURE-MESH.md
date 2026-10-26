# Vault Rooms secure mesh: design

Status: draft 1 (2026-10-26). This fork replaces Vault Rooms' single relay host with an end-to-end encrypted peer mesh. It keeps the plugin's Obsidian integration (live editing in the editor, cursors, room folders, panel and modals) and replaces the server, identity, sync and storage layers.

## 1. Requirements

- Several people, each on their own Windows PC, co-edit notes live on an **offline LAN**. No internet, no cloud account, no CouchDB.
- **No PC is always on.** Whoever is online works together; a PC that comes back catches up by itself.
- **Per-folder permissions.** A room is a folder; each room has its own members and roles.
- **End-to-end encryption.** A PC only ever holds readable content for rooms its user belongs to. Content of other rooms passes through or is stored only as ciphertext.
- **Security is the top priority**: a stranger's device on the LAN can neither read nor change anything; a member can't read rooms they aren't in, can't write where they may only read, and can't plant code (`.obsidian/`, plugins) on other PCs; a lost or stolen PC exposes only that user's rooms.
- Obsidian 1.14.5 desktop on Windows is the reference platform.

## 2. Why a mesh instead of an elected host

Upstream Vault Rooms has one host that holds the only database, merges edits, writes Markdown, assigns versions and enforces permissions on plaintext. With end-to-end encryption the host can do none of that, so its remaining job would be forwarding ciphertext. Electing and replacing such a host adds a leader election, database replication and split-brain handling for little benefit.

Instead every PC is an equal **peer**:
- Peers find each other on the LAN and connect directly over mutually authenticated TLS.
- Each peer keeps an encrypted copy of everything the workspace shares (all rooms, as ciphertext), so whoever is online can serve whoever arrives.
- Changes are CRDT updates identified by `(author device, counter)`, so peers can exchange them in any order, more than once, and through any path. Catching up is a version-vector comparison, not a replay of a host's sequence.

What this needs from the network: every PC accepts inbound TCP on one port (TLS) from the local subnet, and UDP for discovery. A pair of PCs that can't reach each other still syncs through any third peer, because peers forward what they receive.

## 3. Identities and trust

- **Device keys.** Each Obsidian install generates an Ed25519 signing key and an X25519 key-agreement key, plus a TLS key and self-signed certificate. Private keys live in Obsidian's `secretStorage` (encrypted by Windows for the user), never in `data.json` or the vault.
- **Workspace.** Created by a founder. Its identity is the hash of its signed genesis record (`workspaceId`). Invites carry the `workspaceId`; every check chains back to it.
- **Workspace record** (`packages/secure/src/workspace.ts`, `chain.ts`) is one linear chain of signed, full-state versions (`v`, `prev` hash, state, signing device, signature). It lists users (name, admin flag, removed), devices (signing, key-agreement and TLS-certificate keys, owner, revoked), open invites, and rooms (encrypted name, members with roles `read`/`write`/`manage`, and key epochs, each a commitment to a room key). Version *n+1* is valid only if a device active in version *n* signed it and its user may make every change it contains (`authorize`):
  - Admins change workspace settings, add and remove users, revoke devices, and create invites for new people.
  - A device is only ever added through an invite marked used in the same version. A new device for an existing user needs an invite that user created, so nobody (not even an admin) can register a device under someone else's name and receive their room keys.
  - Room membership changes only by that room's managers. An admin's invite can grant only rooms the admin manages, and an admin who isn't a manager can't add themselves. Anyone may leave a room; writers may add a key epoch (rotate the key); key epochs are append-only.
  - Users may rename themselves and revoke their own devices. Revocations and removals are permanent. There is always at least one admin, and every room keeps a manager.
- **Concurrent edits.** Two admins changing things while cut off from each other produce competing branches. Every peer picks the same winner: a branch that revokes or removes a signer of the other wins (so a device about to be revoked can't race its own branch past the revocation), otherwise the branch whose first version has the lower hash. The losing device re-applies its change on top.
- **Room keys** (`keys.ts`). A random 256-bit key per key epoch. It is delivered to each entitled device as a key wrap (X25519 ECIES with HKDF-SHA256 and AES-256-GCM), signed by the wrapping device. Any device already holding the key may wrap it for an entitled device, so a new device of an existing member gets keys from whoever is online. Recipients check the unwrapped key against the commitment, so a member can't hand out a wrong key. Removing a reader or revoking a device starts a new key epoch; new content uses the newest key.

## 4. What is encrypted

Everything inside a room: note text (Yjs updates and snapshots), attachments and other files (encrypted blobs), file names and folder structure (the room index), the room's name, and cursor positions. AES-256-GCM with a random 96-bit nonce; the associated data binds each ciphertext to its room, document, author, counter and key epoch, so it can't be replayed elsewhere.

Peers can see: which devices are online, which rooms exist (as random ids), how many documents a room has, update sizes and timing, and who authored each update.

## 5. Room content model

- **Index document** (one Yjs doc per room, encrypted like any other): `fileId -> {path, kind, deleted, binary version}`. Renames, creates and deletes are edits to the index, so concurrent changes merge instead of fighting.
- **Notes** (`.md`): one Yjs document per file, bound to the editor with y-codemirror (reused from upstream).
- **Other files**: whole-file versions stored as encrypted blobs. A blob's id is a keyed hash of its plaintext (`HMAC-SHA256(room key, bytes)`), so any member can re-upload it and receivers can verify it. Two concurrent versions of the same file: one wins in the index, and the device whose version lost writes it as a conflict copy.
- **Updates** are signed by the author device and numbered per document per author. Peers verify the signature and that the author's user had `write` in the room when they accept it; read-only members' updates are dropped.
- **Snapshots** compact a document: a writer encrypts the full state and lists the update counters it covers; peers that verify the snapshot contains what they hold may prune covered updates.

## 6. Sync protocol between two peers

1. TLS connect; the dialling peer pins the other's certificate fingerprint from the workspace state.
2. Both sign a challenge bound to the TLS channel (exported keying material) with their device keys, which authenticates the dialler too and defeats relayed handshakes.
3. Exchange workspace and room state heads; the side behind fetches newer versions.
4. Exchange per-room digests; for rooms that differ, per-document version vectors; send the missing updates, snapshots and blobs.
5. Stay connected: live updates and cursor positions are pushed as they happen and forwarded to other connected peers that don't have them yet.

Discovery: signed UDP announcements (workspace, device, port, time) to a multicast group and the subnet broadcast; peers with a known address are also dialled directly. Unauthenticated packets only ever trigger a TLS dial that must then pass steps 1–2.

## 7. Joining

(`invite.ts`) An admin creates an invite: a random 32-byte secret from which both sides derive an Ed25519 "invite key". Its public half, the expiry (at most 30 days), and the rooms and roles it grants go into the workspace record. The link (`obsidian://vault-rooms?mode=join-secure&ws=…&i=…&s=…&p=…`) carries the workspace id, the secret and a few current peer addresses; it must reach the new person privately.

The new device makes a join record (its user name, its public keys) signed with both the invite key and its own device key, so the secret never travels and nobody who sees the record can reuse the invite. Peers treat a valid, unexpired join of an unused invite as membership straight away: the signed record plus such joins is what they act on. If two devices race for one invite, every peer picks the join with the lowest hash. Room members' devices then wrap the room keys for the new device, and the next admin online records the join in the chain. No admin needs to be online at the moment of joining. A user adds another device of their own the same way, with an invite they create for themselves.

## 8. Local storage

Per workspace under the plugin folder: the state chains, the encrypted update logs and snapshots (append-only files per document), and encrypted blobs. Decrypted Yjs state for the user's own rooms is cached for fast startup; the vault files themselves are the readable copy. Nothing from `.obsidian/` is ever synced; incoming paths are validated (no `..`, no dot-segments, no drive letters or reserved names, must stay inside the room folder) before anything touches the disk.

## 9. Limits and known residual risks

- A removed member keeps whatever they had already synced.
- A malicious peer can withhold updates or delay a newer state version for peers that only talk to it; it can't forge or read them.
- A removed writer colluding with another peer could try to backdate updates to before their removal; peers order removal by the room state version they have seen.
- Two people offline from each other with conflicting binary edits get a conflict copy; notes always merge.
- Desktop only.
