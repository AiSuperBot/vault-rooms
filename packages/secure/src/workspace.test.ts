import { describe, expect, it } from "vitest";
import { WorkspaceChain } from "./chain.js";
import { SecureError } from "./errors.js";
import { randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, JOIN_EXPIRY_SLACK_MS, newInvite, type JoinRecord } from "./invite.js";
import { keyCommitment, newRoomKey, sealRoomName } from "./keys.js";
import { createRoom, fold, founder, invite, newDevice, step, type TestDevice } from "./testkit.js";
import { nextVersion, parseSignedVersion, roleIn, signVersion, verifyGenesis, type WorkspaceState } from "./workspace.js";

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
    const forBen = newInvite(admin.userId, {}, Date.now() + 3_600_000, ben.userId);
    expect(forbidden(chain, admin, (state) => (state.invites[forBen.inviteId] = forBen.record))).toBe(`forbidden:invite_device:${forBen.inviteId}`);
  });

  it("a user adds another device of their own through their own invite", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    const own = newInvite(ben.userId, {}, Date.now() + 3_600_000, ben.userId);
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
    const sneaky = newInvite(admin.userId, { [roomId]: "read" }, Date.now() + 3_600_000);
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

  it("any member may record a proven join, and nobody can fill someone else's invite", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const { roomId } = createRoom(chain, admin, "Docs", { [ben.userId]: "write" });
    const { join } = invite(chain, admin, { rooms: { [roomId]: "read" }, fold: false });
    fold(chain, ben, join); // Ben isn't an admin, but the proof is all that's needed.
    expect(roleIn(chain.state, roomId, join.body.user.id)).toBe("read");
    // Ben's own-device invite: Ana (admin) doesn't know its secret, so she can't fill it with her device.
    const own = newInvite(ben.userId, {}, Date.now() + 3_600_000, ben.userId);
    step(chain, ben, (state) => (state.invites[own.inviteId] = own.record));
    const anasDevice = newDevice(ben.userId, "Ana's spare");
    const forged = createJoinRecord({ workspaceId: chain.workspaceId, inviteId: own.inviteId, secret: newInvite(ben.userId, {}, 0).secret, user: { id: ben.userId, name: "Ben" }, deviceName: anasDevice.name, deviceKey: anasDevice.sign, agreementPublicKey: anasDevice.agree.publicKey, tlsFingerprint: anasDevice.tls });
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

  it("rejects a version whose signature doesn't match its signer", () => {
    const { chain, admin } = founder();
    const { joiner: ben } = invite(chain, admin, { userName: "Ben" });
    const forged = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Renamed"));
    const reSigned = signVersion({ ...forged.body, by: ben.id }, admin.sign);
    expect(chain.offer([reSigned])).toEqual({ status: "rejected", reason: "bad_signature:bad_signature" });
  });
});
