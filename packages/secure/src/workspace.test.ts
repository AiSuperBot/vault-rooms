import { describe, expect, it } from "vitest";
import { b64u } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { SecureError } from "./errors.js";
import { randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, JOIN_EXPIRY_SLACK_MS, newInvite, parseJoinRecord, verifyJoinRecord, type JoinRecord } from "./invite.js";
import { keyCommitment, newRoomKey, sealRoomName } from "./keys.js";
import { createRoom, fold, founder, invite, newDevice, step, type TestDevice } from "./testkit.js";
import { concurrentReductions, LIMITS, nextVersion, parseSignedVersion, rebaseChange, roleIn, signVersion, verifyGenesis, versionHash, type WorkspaceState } from "./workspace.js";

function forbidden(chain: WorkspaceChain, device: TestDevice, change: (state: WorkspaceState) => void, joins: JoinRecord[] = [], now = Date.now()): string {
  try {
    nextVersion(chain.workspaceId, chain.head, device.sign, change, now, joins);
  } catch (error) {
    if (error instanceof SecureError) return `${error.code}:${error.message}`;
    throw error;
  }
  return "allowed";
}

describe("genesis", () => {
  it("names the founder as the only admin and is self-verifying", () => {
    const { chain, ws, admin } = founder();
    expect(chain.workspaceId).toBe(ws);
    expect(chain.state.users[admin.userId]).toEqual({ name: "Ana", admin: true });
    expect(verifyGenesis(chain.head)).toBe(ws);
  });
  it("rejects a tampered genesis", () => {
    const { chain } = founder();
    const tampered = structuredClone(chain.head);
    tampered.body.state.name = "Other";
    expect(() => verifyGenesis(tampered)).toThrow(/bad_signature/);
  });
  it("round-trips through the strict parser", () => {
    const { chain } = founder();
    expect(parseSignedVersion(JSON.parse(JSON.stringify(chain.head)))).toEqual(chain.head);
    const extra = JSON.parse(JSON.stringify(chain.head));
    extra.body.state.users[Object.keys(extra.body.state.users)[0]!].isOwner = true;
    // Unknown fields are refused, naming the field.
    expect(() => parseSignedVersion(extra)).toThrow(/\.isOwner$/);
  });
});

describe("rooms", () => {
  it("only admins create rooms by default", () => {
    const { chain, admin } = founder();
    const { joiner } = invite(chain, admin);
    const roomId = randomId("r");
    const key = newRoomKey();
    expect(
      forbidden(chain, joiner, (state) => {
        state.rooms[roomId] = { creator: joiner.userId, name: sealRoomName(chain.workspaceId, roomId, 1, key, "Mine"), members: { [joiner.userId]: "manage" }, epochs: [{ n: 1, commit: keyCommitment(chain.workspaceId, roomId, 1, key) }] };
      })
    ).toBe("forbidden:room_create:" + roomId);
    step(chain, admin, (state) => {
      state.roomCreation = "members";
    });
    expect(() => createRoom(chain, joiner, "Mine")).not.toThrow();
  });

  it("managers change membership; admins who aren't managers can't add themselves", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    // Ben can't create rooms; Ana creates one, makes Ben its manager, then leaves it.
    const { roomId } = createRoom(chain, admin, "Finance", {});
    step(chain, admin, (state) => {
      state.rooms[roomId]!.members[ben.userId] = "manage";
    });
    step(chain, admin, (state) => {
      delete state.rooms[roomId]!.members[admin.userId];
    });
    expect(roleIn(chain.state, roomId, admin.userId)).toBeUndefined();
    // Ana is still an admin, but no longer a manager of Finance: she can't put herself back.
    expect(forbidden(chain, admin, (state) => (state.rooms[roomId]!.members[admin.userId] = "read"))).toBe(`forbidden:room_members:${roomId}`);
    // Ben, the manager, can.
    step(chain, ben, (state) => (state.rooms[roomId]!.members[admin.userId] = "read"));
    expect(roleIn(chain.state, roomId, admin.userId)).toBe("read");
  });

  it("writers may rotate the key but nothing else; readers may not rotate", () => {
    const { chain, admin } = founder();
    const { joiner: writer } = invite(chain, admin, { userName: "Wen" });
    const { joiner: reader } = invite(chain, admin, { userName: "Rae" });
    const { roomId } = createRoom(chain, admin, "Docs", { [writer.userId]: "write", [reader.userId]: "read" });
    const rotate = (state: WorkspaceState) => {
      const key = newRoomKey();
      state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(chain.workspaceId, roomId, 2, key) });
    };
    expect(forbidden(chain, reader, rotate)).toBe(`forbidden:room_rotate:${roomId}`);
    step(chain, writer, rotate);
    expect(chain.state.rooms[roomId]!.epochs).toHaveLength(2);
    expect(forbidden(chain, writer, (state) => (state.rooms[roomId]!.members[reader.userId] = "write"))).toBe(`forbidden:room_members:${roomId}`);
    // Epochs are append-only, even for managers.
    expect(forbidden(chain, admin, (state) => state.rooms[roomId]!.epochs.pop())).toBe(`forbidden:room_epochs:${roomId}`);
  });

  it("anyone may leave, but the last manager can't", () => {
    const { chain, admin } = founder();
    const { joiner } = invite(chain, admin);
    const { roomId } = createRoom(chain, admin, "Docs", { [joiner.userId]: "read" });
    step(chain, joiner, (state) => delete state.rooms[roomId]!.members[joiner.userId]);
    expect(forbidden(chain, admin, (state) => delete state.rooms[roomId]!.members[admin.userId])).toBe(`forbidden:no_manager:${roomId}`);
  });

  it("a deleted room stays deleted", () => {
    const { chain, admin } = founder();
    const { roomId } = createRoom(chain, admin);
    step(chain, admin, (state) => (state.rooms[roomId]!.deleted = true));
    expect(forbidden(chain, admin, (state) => delete state.rooms[roomId]!.deleted)).toBe(`forbidden:room_gone:${roomId}`);
    expect(forbidden(chain, admin, (state) => delete state.rooms[roomId])).toBe(`forbidden:room_deleted:${roomId}`);
  });
});

describe("devices and users", () => {
  it("admins can't slip a device under another user's name", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const fake = newDevice(ben.userId, "Not Ben's");
    expect(
      forbidden(chain, admin, (state) => {
        state.devices[fake.id] = { user: ben.userId, name: fake.name, sign: fake.sign.publicKey, agree: fake.agree.publicKey, tls: fake.tls };
      })
    ).toBe(`forbidden:device_add:${fake.id}`);
    // Nor through an invite "for" Ben that Ana makes herself.
    const forBen = newInvite({ user: admin.userId, device: admin.id }, {}, Date.now() + 3_600_000, ben.userId);
    expect(forbidden(chain, admin, (state) => (state.invites[forBen.inviteId] = forBen.record))).toBe(`forbidden:invite_device:${forBen.inviteId}`);
  });

  it("a user adds another device of their own through their own invite", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    const own = newInvite({ user: ben.userId, device: ben.id }, {}, Date.now() + 3_600_000, ben.userId);
    step(chain, ben, (state) => (state.invites[own.inviteId] = own.record));
    const laptop = newDevice(ben.userId, "Ben laptop");
    const join = createJoinRecord({ workspaceId: chain.workspaceId, inviteId: own.inviteId, secret: own.secret, user: { id: ben.userId, name: "Ben" }, deviceName: laptop.name, deviceKey: laptop.sign, agreementPublicKey: laptop.agree.publicKey, tlsFingerprint: laptop.tls });
    fold(chain, ben, join);
    expect(chain.state.devices[laptop.id]?.user).toBe(ben.userId);
    // The laptop is Ben's, so it has Ben's role.
    expect(roleIn(chain.state, roomId, chain.state.devices[laptop.id]!.user)).toBe("write");
  });

  it("joiners get exactly the rooms their invite grants", () => {
    const { chain, admin } = founder();
    const { roomId } = createRoom(chain, admin, "Docs");
    const { roomId: other } = createRoom(chain, admin, "Other");
    const { joiner } = invite(chain, admin, { rooms: { [roomId]: "write" } });
    expect(roleIn(chain.state, roomId, joiner.userId)).toBe("write");
    expect(roleIn(chain.state, other, joiner.userId)).toBeUndefined();
  });

  it("an invite can only grant rooms its creator manages", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "manage" });
    step(chain, admin, (state) => delete state.rooms[roomId]!.members[admin.userId]);
    const sneaky = newInvite({ user: admin.userId, device: admin.id }, { [roomId]: "read" }, Date.now() + 3_600_000);
    expect(forbidden(chain, admin, (state) => (state.invites[sneaky.inviteId] = sneaky.record))).toBe(`forbidden:invite_room:${sneaky.inviteId}`);
  });

  it("a fold can't add more than the invite grants", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "manage" });
    step(chain, admin, (state) => delete state.rooms[roomId]!.members[admin.userId]);
    const { join } = invite(chain, admin, { fold: false });
    expect(
      forbidden(
        chain,
        admin,
        (state) => {
          foldJoinInto(state, join);
          state.rooms[roomId]!.members[join.body.user.id] = "manage";
        },
        [join]
      )
    ).toBe(`forbidden:room_members:${roomId}`);
  });

  it("recording a join needs the joiner's proof, and only what it proves", () => {
    const { chain, admin } = founder();
    const { roomId } = createRoom(chain, admin, "Docs");
    const { join, inviteId } = invite(chain, admin, { rooms: { [roomId]: "write" }, fold: false });
    // Without the record.
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join))).toBe(`forbidden:invite_proof:${inviteId}`);
    // With the record, but the admin's own device keys put in its place.
    const swap = newDevice(join.body.user.id, "Swapped");
    expect(
      forbidden(
        chain,
        admin,
        (state) => {
          foldJoinInto(state, join);
          const device = state.devices[join.body.device.id]!;
          delete state.devices[join.body.device.id];
          state.devices[swap.id] = { ...device, sign: swap.sign.publicKey, agree: swap.agree.publicKey };
          state.invites[inviteId]!.used = swap.id;
        },
        [join]
      )
    ).toBe(`forbidden:invite_device:${inviteId}`);
    // Too late.
    const expires = chain.state.invites[inviteId]!.expires;
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join), [join], expires + JOIN_EXPIRY_SLACK_MS + 1)).toBe(`forbidden:invite_expired:${inviteId}`);
    // A stray record that this version doesn't use.
    const other = invite(chain, admin, { fold: false });
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join), [join, other.join])).toBe("forbidden:join_unused");
  });

  it("record time can't go backwards, so an expired invite can't be recorded by backdating", () => {
    const { chain, admin } = founder();
    const { join, inviteId } = invite(chain, admin, { fold: false, expires: Date.now() + 60_000 });
    const expires = chain.state.invites[inviteId]!.expires;
    // Someone moves the record's clock past the expiry with an unrelated change...
    step(chain, admin, (state) => (state.name = "Later"), expires + JOIN_EXPIRY_SLACK_MS + 1000);
    // ...after which no version may claim an earlier time, so the join can't be slipped in.
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join), [join], expires)).toBe(`forbidden:invite_expired:${inviteId}`);
    // Built by hand (nextVersion itself refuses), with a time before the previous version's.
    const state = structuredClone(chain.state);
    foldJoinInto(state, join);
    const backdated = signVersion({ kind: "vr-ws-v1", ws: chain.workspaceId, v: chain.head.body.v + 1, prev: versionHash(chain.head), by: admin.id, at: expires, state, joins: [join] }, admin.sign);
    expect(chain.offer([backdated])).toEqual({ status: "rejected", reason: "forbidden:time_backwards" });
  });

  it("any member may record a proven join, and nobody can fill someone else's invite", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    const { join } = invite(chain, admin, { rooms: { [roomId]: "read" }, fold: false });
    fold(chain, ben, join); // Ben isn't an admin, but the proof is all that's needed.
    expect(roleIn(chain.state, roomId, join.body.user.id)).toBe("read");
    // Ben's own-device invite: Ana (admin) doesn't know its secret, so she can't fill it with her device.
    const own = newInvite({ user: ben.userId, device: ben.id }, {}, Date.now() + 3_600_000, ben.userId);
    step(chain, ben, (state) => (state.invites[own.inviteId] = own.record));
    const anasDevice = newDevice(ben.userId, "Ana's spare");
    const forged = createJoinRecord({ workspaceId: chain.workspaceId, inviteId: own.inviteId, secret: newInvite({ user: ben.userId, device: ben.id }, {}, 0).secret, user: { id: ben.userId, name: "Ben" }, deviceName: anasDevice.name, deviceKey: anasDevice.sign, agreementPublicKey: anasDevice.agree.publicKey, tlsFingerprint: anasDevice.tls });
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, forged), [forged])).toBe(`forbidden:invite_proof:${own.inviteId}`);
  });

  it("removed users and revoked devices can't sign", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    step(chain, admin, (state) => (state.devices[ben.id]!.revoked = true));
    expect(forbidden(chain, ben, (state) => (state.users[ben.userId]!.name = "B"))).toBe("forbidden:signer");
    expect(forbidden(chain, admin, (state) => delete state.devices[ben.id]!.revoked)).toBe(`forbidden:device_restored:${ben.id}`);
    const { joiner: cy } = invite(chain, admin, { userName: "Cy" });
    step(chain, admin, (state) => (state.users[cy.userId]!.removed = true));
    expect(forbidden(chain, cy, (state) => (state.users[cy.userId]!.name = "C"))).toBe("forbidden:signer");
    expect(forbidden(chain, admin, (state) => delete state.users[cy.userId]!.removed)).toBe(`forbidden:user_restored:${cy.userId}`);
  });

  it("users rename themselves and revoke their own devices, not others'", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { joiner: cy } = invite(chain, admin, { userName: "Cy" });
    step(chain, ben, (state) => (state.users[ben.userId]!.name = "Benjamin"));
    expect(forbidden(chain, ben, (state) => (state.users[cy.userId]!.name = "X"))).toBe(`forbidden:user:${cy.userId}`);
    expect(forbidden(chain, ben, (state) => (state.users[ben.userId]!.admin = true))).toBe(`forbidden:user:${ben.userId}`);
    expect(forbidden(chain, ben, (state) => (state.devices[cy.id]!.revoked = true))).toBe(`forbidden:device:${cy.id}`);
    step(chain, ben, (state) => (state.devices[ben.id]!.revoked = true));
  });

  it("device keys never change and the last admin can't leave", () => {
    const { chain, admin } = founder();
    const other = newDevice(admin.userId);
    expect(forbidden(chain, admin, (state) => (state.devices[admin.id]!.agree = other.agree.publicKey))).toBe(`forbidden:device_keys:${admin.id}`);
    expect(forbidden(chain, admin, (state) => (state.users[admin.userId]!.admin = false))).toBe("forbidden:no_admin");
  });

  it("an invite dies with its creator's standing", () => {
    const { chain, ws, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    step(chain, admin, (state) => (state.users[ben.userId]!.admin = true));
    // Ben, an admin for now, invites someone; then Ana takes his admin rights away.
    const { join, inviteId } = invite(chain, ben, { fold: false });
    step(chain, admin, (state) => (state.users[ben.userId]!.admin = false));
    expect(() => verifyJoinRecord(chain.state, ws, join, Date.now())).toThrow(/join_creator/);
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join), [join])).toBe(`forbidden:invite_creator:${inviteId}`);
  });

  it("a stolen computer's invite for another device of its user stops working once it is revoked", () => {
    const { chain, ws, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { join, inviteId } = invite(chain, ben, { forUser: ben, fold: false });
    step(chain, admin, (state) => (state.devices[ben.id]!.revoked = true));
    expect(() => verifyJoinRecord(chain.state, ws, join, Date.now())).toThrow(/join_creator/);
    expect(forbidden(chain, admin, (state) => foldJoinInto(state, join), [join])).toBe(`forbidden:invite_creator:${inviteId}`);
  });

  it("an invite grants only the rooms its creator still manages, and their managers may withdraw it", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { joiner: cy } = invite(chain, admin, { userName: "Cy" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "manage" });
    const { roomId: kept } = createRoom(chain, admin, "Kept");
    const { join } = invite(chain, admin, { rooms: { [roomId]: "write", [kept]: "read" }, fold: false });
    // Ben, a manager of Docs, takes Ana's management of it away before the join is recorded.
    step(chain, ben, (state) => (state.rooms[roomId]!.members[admin.userId] = "read"));
    fold(chain, admin, join);
    expect(roleIn(chain.state, roomId, join.body.user.id)).toBeUndefined();
    expect(roleIn(chain.state, kept, join.body.user.id)).toBe("read");
    const { inviteId } = invite(chain, admin, { rooms: { [kept]: "read" }, fold: false });
    expect(forbidden(chain, cy, (state) => delete state.invites[inviteId])).toBe(`forbidden:invite_withdraw:${inviteId}`);
    step(chain, admin, (state) => (state.rooms[kept]!.members[cy.userId] = "manage"));
    // Managing one of an invite's rooms isn't enough to cancel what it grants in another.
    const { roomId: third } = createRoom(chain, admin, "Third");
    const both = invite(chain, admin, { rooms: { [kept]: "read", [third]: "read" }, fold: false });
    expect(forbidden(chain, cy, (state) => delete state.invites[both.inviteId])).toBe(`forbidden:invite_withdraw:${both.inviteId}`);
    step(chain, cy, (state) => delete state.invites[inviteId]);
  });

  it("one key epoch per version, and the last ones are kept for managers", () => {
    const { chain, admin } = founder();
    const { joiner: writer } = invite(chain, admin, { userName: "Wen" });
    const { roomId } = createRoom(chain, admin, "Docs", { [writer.userId]: "write" });
    const epoch = (state: WorkspaceState) => {
      const n = state.rooms[roomId]!.epochs.length + 1;
      state.rooms[roomId]!.epochs.push({ n, commit: keyCommitment(chain.workspaceId, roomId, n, newRoomKey()) });
    };
    expect(
      forbidden(chain, writer, (state) => {
        epoch(state);
        epoch(state);
      })
    ).toBe(`forbidden:room_epochs:${roomId}`);
    const saved = LIMITS.writerEpochs;
    LIMITS.writerEpochs = 3;
    try {
      step(chain, writer, epoch);
      step(chain, writer, epoch);
      expect(forbidden(chain, writer, epoch)).toBe(`forbidden:room_rotate_limit:${roomId}`);
      step(chain, admin, epoch);
    } finally {
      LIMITS.writerEpochs = saved;
    }
  });

  it("every version changes something, and no one user fills the invite table", () => {
    const { chain, admin } = founder();
    expect(forbidden(chain, admin, () => {})).toBe("forbidden:no_change");
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const own = () => newInvite({ user: ben.userId, device: ben.id }, {}, Date.now() + 3_600_000, ben.userId);
    for (let i = 0; i < LIMITS.invitesPerUser; i++) {
      const next = own();
      step(chain, ben, (state) => (state.invites[next.inviteId] = next.record));
    }
    const extra = own();
    expect(forbidden(chain, ben, (state) => (state.invites[extra.inviteId] = extra.record))).toBe(`forbidden:invite_limit:${extra.inviteId}`);
  });

  it("refuses keys of small order and room ids that differ only in case", () => {
    const { chain, admin } = founder();
    const { join } = invite(chain, admin, { fold: false });
    const weak = JSON.parse(JSON.stringify(join));
    weak.body.device.agree = b64u(new Uint8Array(32));
    expect(() => parseJoinRecord(weak)).toThrow(/join\.device\.agree/);
    const identity = JSON.parse(JSON.stringify(join));
    identity.body.device.sign = b64u(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)));
    expect(() => parseJoinRecord(identity)).toThrow(/join\.device\.sign/);
    const { roomId } = createRoom(chain, admin);
    const raw = JSON.parse(JSON.stringify(chain.head));
    const variant = roomId[0] + [...roomId.slice(1)].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
    raw.body.state.rooms[variant] = raw.body.state.rooms[roomId];
    expect(() => parseSignedVersion(raw)).toThrow(/\.id$/);
  });

  it("refuses versions dated far ahead of the receiver's clock", () => {
    const { chain, admin } = founder();
    const now = Date.now();
    const future = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Later"), now + 3_600_000);
    expect(chain.offer([future], now)).toEqual({ status: "rejected", reason: "forbidden:future" });
    expect(chain.offer([future], now + 3_600_000).status).toBe("appended");
  });

  it("re-applies a version lost in a fork on top of the winner, keeping the winner's changes", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs");
    const base = chain.state;
    const lost = structuredClone(base);
    lost.rooms[roomId]!.members[ben.userId] = "write";
    lost.name = "Lost name";
    const winner = structuredClone(base);
    winner.users[ben.userId]!.name = "Benjamin";
    const merged = rebaseChange(base, lost, winner);
    expect(merged.name).toBe("Lost name");
    expect(merged.users[ben.userId]!.name).toBe("Benjamin");
    expect(merged.rooms[roomId]!.members[ben.userId]).toBe("write");
    step(chain, admin, (state) => Object.assign(state, merged));
  });

  it("never makes someone an admin again, when re-applying, after the winner demoted them", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    step(chain, admin, (state) => (state.users[ben.userId]!.admin = true));
    const fork = chain.state;
    // The lost branch demoted Ben and made him an admin again; the winner demoted him.
    const demoted = structuredClone(fork);
    demoted.users[ben.userId]!.admin = false;
    const promoted = structuredClone(demoted);
    promoted.users[ben.userId]!.admin = true;
    expect(rebaseChange(demoted, promoted, structuredClone(demoted), fork).users[ben.userId]!.admin).toBe(false);
    // Where Ben wasn't an admin when the branches split, his promotion is made again as usual.
    expect(rebaseChange(demoted, promoted, structuredClone(demoted), demoted).users[ben.userId]!.admin).toBe(true);
  });

  it("re-applies a lost branch's own demotion and promotion in order, when the winner took nothing away", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    step(chain, admin, (state) => (state.users[ben.userId]!.admin = true));
    const fork = chain.state;
    const v1 = structuredClone(fork);
    v1.users[ben.userId]!.admin = false;
    v1.rooms[roomId]!.members[ben.userId] = "read";
    const v2 = structuredClone(v1);
    v2.users[ben.userId]!.admin = true;
    v2.rooms[roomId]!.members[ben.userId] = "write";
    const winner = structuredClone(fork);
    winner.name = "Renamed";
    // Made again one version at a time on top of the winner, as a device does after losing a race.
    const once = rebaseChange(fork, v1, winner, fork, winner);
    const twice = rebaseChange(v1, v2, once, fork, winner);
    expect(twice.users[ben.userId]!.admin).toBe(true);
    expect(twice.rooms[roomId]!.members[ben.userId]).toBe("write");
    expect(twice.name).toBe("Renamed");
  });

  it("never gives back, when re-applying, room standing the winner took away", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    const base = chain.state;
    const withRole = (role: "read" | "manage" | undefined) => {
      const state = structuredClone(base);
      if (role) state.rooms[roomId]!.members[ben.userId] = role;
      else delete state.rooms[roomId]!.members[ben.userId];
      return state;
    };
    const merged = (lost: "read" | "manage" | undefined, winner: "read" | undefined) => rebaseChange(base, withRole(lost), withRole(winner)).rooms[roomId]!.members[ben.userId];
    // The winner took Ben out: neither lowering nor raising him in the lost version brings him back.
    expect(merged("read", undefined)).toBeUndefined();
    expect(merged("manage", undefined)).toBeUndefined();
    // The winner lowered him: raising him again doesn't apply, taking him out does.
    expect(merged("manage", "read")).toBe("read");
    expect(merged(undefined, "read")).toBeUndefined();
  });

  it("adds up concurrent revocations, but not those of someone the winning branch revoked", () => {
    const { chain, admin: a } = founder();
    const { joiner: b } = invite(chain, a, { userName: "B" });
    const { joiner: c } = invite(chain, a, { userName: "C" });
    step(chain, a, (state) => {
      state.users[b.userId]!.admin = true;
      state.users[c.userId]!.admin = true;
    });
    const fork = chain.state;
    const won = nextVersion(chain.workspaceId, chain.head, a.sign, (state) => (state.devices[b.id]!.revoked = true));
    const byC = nextVersion(chain.workspaceId, chain.head, c.sign, (state) => (state.devices[a.id]!.revoked = true));
    const byB = nextVersion(chain.workspaceId, chain.head, b.sign, (state) => (state.devices[c.id]!.revoked = true));
    // C's revocation of A lost the race, but C still stands: it is made again. B's lost too, and B was revoked.
    expect(concurrentReductions(fork, [byC], [won], won.body.state, c.userId)!.devices[a.id]!.revoked).toBe(true);
    expect(concurrentReductions(fork, [byB], [won], won.body.state, c.userId)).toBeNull();
  });

  it("takes back what a device granted at the same moment it was revoked", () => {
    const { chain, admin: a } = founder();
    const { joiner: b } = invite(chain, a, { userName: "B" });
    const { joiner: e } = invite(chain, a, { userName: "E" });
    const { roomId } = createRoom(chain, a, "Docs", { [b.userId]: "manage" });
    step(chain, a, (state) => (state.users[b.userId]!.admin = true));
    const fork = chain.state;
    // B (its computer stolen) makes E an admin and gives E the room while A revokes B's computer; B's change wins.
    const won = nextVersion(chain.workspaceId, chain.head, b.sign, (state) => {
      state.users[e.userId]!.admin = true;
      state.rooms[roomId]!.members[e.userId] = "write";
    });
    const lost = nextVersion(chain.workspaceId, chain.head, a.sign, (state) => (state.devices[b.id]!.revoked = true));
    const after = concurrentReductions(fork, [lost], [won], won.body.state, a.userId)!;
    expect(after.devices[b.id]!.revoked).toBe(true);
    expect(after.users[e.userId]!.admin).toBe(false);
    expect(after.rooms[roomId]!.members[e.userId]).toBeUndefined();
  });

  it("rejects a version whose signature doesn't match its signer", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const forged = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Renamed"));
    const reSigned = signVersion({ ...forged.body, by: ben.id }, admin.sign);
    expect(chain.offer([reSigned])).toEqual({ status: "rejected", reason: "bad_signature:bad_signature" });
  });
});
