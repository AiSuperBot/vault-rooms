// Two branches of the workspace record made at the same moment (computers apart): random changes by random members,
// the chain picks the winner, and every computer works out what the losing branch took away (concurrentReductions, as
// MeshService.reapply does). Checked for each computer: the record it starts from is left as it is; what it makes can
// be signed by it; it only takes away (nothing comes back, is added or goes up); a room neither branch changed, apart
// from deleting it, keeps its members; and a removal, revocation, demotion or lower role the losing branch made, by
// someone who still has the standing for it, is made again wherever this computer may make it.
// FUZZ_SEEDS=500 for a longer run; FUZZ_SEED=n runs the seed a failure names.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import type { WorkspaceChain } from "./chain.js";
import { createRoom, founder, invite, step, type TestDevice } from "./testkit.js";
import { activeDevice, concurrentReductions, nextVersion, roleIn, ROLES, versionHash, type Role, type SignedVersion, type WorkspaceState } from "./workspace.js";

/** mulberry32: the same numbers for the same seed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const rank = (role: Role | undefined) => (role === undefined ? 0 : ROLES.indexOf(role) + 1);
type Change = (state: WorkspaceState) => void;
type Label = (id: string) => string;

/** A random change `by` might make (the record refuses most of those it may not make). */
function change(rand: () => number, state: WorkspaceState, by: TestDevice, label: Label): { what: string; apply: Change } {
  const user = pick(rand, Object.keys(state.users));
  const device = pick(rand, Object.keys(state.devices));
  const room = pick(rand, Object.keys(state.rooms));
  const role = pick(rand, ROLES);
  const name = `PC ${Math.floor(rand() * 1000)}`;
  switch (Math.floor(rand() * 9)) {
    case 0: return { what: `revokes ${label(device)}`, apply: (s) => void (s.devices[device]!.revoked = true) };
    case 1: return { what: `removes ${label(user)}`, apply: (s) => void (s.users[user]!.removed = true) };
    case 2: return { what: `demotes ${label(user)}`, apply: (s) => void (s.users[user]!.admin = false) };
    case 3: return { what: `makes ${label(user)} an admin`, apply: (s) => void (s.users[user]!.admin = true) };
    case 4: return { what: `makes ${label(user)} ${role} in ${label(room)}`, apply: (s) => void (s.rooms[room]!.members[user] = role) };
    case 5: return { what: `takes ${label(user)} out of ${label(room)}`, apply: (s) => void delete s.rooms[room]!.members[user] };
    case 6: return { what: `deletes ${label(room)}`, apply: (s) => void (s.rooms[room]!.deleted = true) };
    case 7: return { what: `leaves ${label(room)}`, apply: (s) => void delete s.rooms[room]!.members[by.userId] };
    default: return { what: "renames their computer", apply: (s) => void (s.devices[by.id]!.name = name) };
  }
}

/** S founds the workspace; A (an admin, with a second computer), B, C and D join; three rooms with random members. */
function setup(rand: () => number) {
  const { chain, ws, admin: s } = founder("Team", "S");
  const people: TestDevice[] = [s];
  const names = new Map<string, string>([[s.userId, "S"], [s.id, "S's PC"]]);
  for (const name of ["A", "B", "C", "D"]) {
    const { joiner } = invite(chain, s, { userName: name });
    people.push(joiner);
    names.set(joiner.userId, name).set(joiner.id, `${name}'s PC`);
  }
  const { joiner: laptop } = invite(chain, people[1]!, { forUser: people[1]! });
  people.push(laptop);
  names.set(laptop.id, "A's laptop");
  step(chain, s, (state) => {
    state.users[people[1]!.userId]!.admin = true;
    for (const p of people.slice(2, 5)) if (rand() < 0.4) state.users[p.userId]!.admin = true;
  });
  for (const name of ["R1", "R2", "R3"]) {
    const members: Record<string, Role> = {};
    for (const p of people.slice(1, 5)) if (rand() < 0.7) members[p.userId] = pick(rand, ROLES);
    const { roomId } = createRoom(chain, s, name, members);
    names.set(roomId, name);
    // S leaves some of the rooms others manage, so not every room is S's.
    if (Object.values(members).includes("manage") && rand() < 0.4) step(chain, s, (state) => void delete state.rooms[roomId]!.members[s.userId]);
  }
  return { chain, ws, people, label: (id: string) => names.get(id) ?? id };
}

/** Up to `length` versions on top of `base`: `first`, then random changes by `only` (or by any active member). */
function branch(rand: () => number, base: WorkspaceChain, people: TestDevice[], length: number, label: Label, first?: { by: TestDevice; what: string; apply: Change }, only?: TestDevice): { versions: SignedVersion[]; log: string[] } {
  const chain = base.prefix(base.length);
  const versions: SignedVersion[] = [];
  const log: string[] = [];
  try {
    if (first) versions.push(step(chain, first.by, first.apply));
    if (first) log.push(`${label(first.by.id)} ${first.what}`);
  } catch {
    // Not allowed (it would leave a room without a manager, say): random changes only.
  }
  for (let tries = 0; versions.length < length && tries < 100; tries++) {
    const by = only ?? pick(rand, people.filter((p) => activeDevice(chain.state, p.id)));
    const { what, apply } = change(rand, chain.state, by, label);
    try {
      versions.push(step(chain, by, apply));
      log.push(`${label(by.id)} ${what}`);
    } catch {
      // Not allowed: another change.
    }
  }
  return { versions, log };
}

/** `out` only takes away from `current`: nothing comes back, is added or goes up. */
function takesOnly(current: WorkspaceState, out: WorkspaceState, at: string, label: Label): void {
  const same = (a: unknown, b: unknown, what: string) => expect(canonicalJson(a), `${at}: ${what}`).toBe(canonicalJson(b));
  same([out.name, out.roomCreation, out.invites], [current.name, current.roomCreation, current.invites], "settings and invites");
  for (const kind of ["users", "devices", "rooms"] as const) same(Object.keys(out[kind]).sort(), Object.keys(current[kind]).sort(), kind);
  for (const [userId, { removed, admin, ...rest }] of Object.entries(out.users)) {
    const { removed: wasRemoved, admin: wasAdmin, ...was } = current.users[userId]!;
    same(rest, was, label(userId));
    expect((removed || !wasRemoved) && (!admin || wasAdmin), `${at}: ${label(userId)} came back or went up`).toBe(true);
  }
  for (const [deviceId, { revoked, ...rest }] of Object.entries(out.devices)) {
    const { revoked: wasRevoked, ...was } = current.devices[deviceId]!;
    same(rest, was, label(deviceId));
    expect(revoked || !wasRevoked, `${at}: ${label(deviceId)} came back`).toBe(true);
  }
  for (const [roomId, { members, ...rest }] of Object.entries(out.rooms)) {
    const { members: wasMembers, ...was } = current.rooms[roomId]!;
    same(rest, was, label(roomId));
    for (const [userId, role] of Object.entries(members)) expect(rank(role) <= rank(wasMembers[userId]), `${at}: ${label(userId)} went up in ${label(roomId)}`).toBe(true);
  }
}

/** One fork; false when there was none (both branches began with the same change). */
function run(seed: number): boolean {
  const rand = random(seed);
  const { chain, ws, people, label } = setup(rand);
  // Some seeds are a stolen computer: S's or A's (they rank first, so their branch can win) makes changes of its own
  // while another admin revokes it, or demotes or removes its user. What it granted at that moment is taken back.
  const thief = rand() < 0.4 ? pick(rand, people.slice(0, 2)) : undefined;
  let first: { by: TestDevice; what: string; apply: Change } | undefined;
  if (thief) {
    const by = thief === people[0] ? pick(rand, [people[1]!, people[5]!]) : people[0]!;
    first = pick(rand, [
      { by, what: `revokes ${label(thief.id)}`, apply: (s: WorkspaceState) => void (s.devices[thief.id]!.revoked = true) },
      { by, what: `demotes ${label(thief.userId)}`, apply: (s: WorkspaceState) => void (s.users[thief.userId]!.admin = false) },
      { by, what: `removes ${label(thief.userId)}`, apply: (s: WorkspaceState) => void (s.users[thief.userId]!.removed = true) }
    ]);
  }
  const a = branch(rand, chain, people, 1 + Math.floor(rand() * 4), label, first);
  const b = branch(rand, chain, people, 1 + Math.floor(rand() * 3) + (thief ? 1 : 0), label, undefined, thief);
  if (versionHash(a.versions[0]!) === versionHash(b.versions[0]!)) return false;
  const holder = chain.prefix(chain.length);
  holder.offer(a.versions);
  const offered = holder.offer(b.versions);
  const ctx = `seed ${seed} (FUZZ_SEED=${seed}): [${a.log.join("; ")}] against [${b.log.join("; ")}]`;
  expect(offered.status === "replaced" || (offered.status === "rejected" && offered.reason === "loses"), `${ctx}: ${JSON.stringify(offered)}`).toBe(true);
  const [lost, won] = offered.status === "replaced" ? [a.versions, b.versions] : [b.versions, a.versions];
  const winner = chain.prefix(chain.length);
  winner.offer(won);
  const fork = chain.state;
  const current = winner.state;
  const lostEnd = lost[lost.length - 1]!.body.state;
  const start = canonicalJson(current);
  for (const actor of people.filter((p) => activeDevice(current, p.id))) {
    const at = `${ctx}, ${offered.status === "replaced" ? "the second" : "the first"} won, worked out by ${label(actor.id)}`;
    const out = concurrentReductions(fork, lost, won, current, { user: actor.userId, device: actor.id }, ws);
    expect(canonicalJson(current), `${at}: the record it started from changed`).toBe(start);
    const end = out ?? current;
    if (out) {
      expect(() => nextVersion(ws, winner.head, actor.sign, (state) => void Object.assign(state, structuredClone(out))), at).not.toThrow();
      takesOnly(current, out, at, label);
    }
    for (const [roomId, room] of Object.entries(current.rooms)) {
      const states = [fork, ...lost.map((v) => v.body.state), ...won.map((v) => v.body.state)];
      if (room.deleted || !states.every((state) => state.rooms[roomId]!.deleted || canonicalJson(state.rooms[roomId]!.members) === canonicalJson(room.members))) continue;
      expect(end.rooms[roomId]!.members, `${at}: ${label(roomId)}, which neither branch changed, lost members`).toEqual(room.members);
    }

    // What the losing branch took away, by someone who still stands, is taken away wherever this computer may.
    const may = (apply: Change) => {
      try {
        nextVersion(ws, winner.head, actor.sign, (state) => {
          Object.assign(state, structuredClone(end));
          apply(state);
        });
        return true;
      } catch {
        return false;
      }
    };
    const stands = (version: SignedVersion | undefined) => (version ? activeDevice(current, version.body.by) : null);
    let prev = fork;
    for (const version of lost) {
      const next = version.body.state;
      const signer = stands(version);
      const admin = signer !== null && current.users[signer.user]!.admin;
      for (const [userId, user] of Object.entries(next.users)) {
        if (!admin || !user.removed || prev.users[userId]!.removed || end.users[userId]!.removed) continue;
        expect(may((s) => void (s.users[userId]!.removed = true)), `${at}: ${label(userId)} wasn't removed again`).toBe(false);
      }
      for (const [deviceId, device] of Object.entries(next.devices)) {
        if (!signer || !(admin || signer.user === device.user) || !activeDevice(prev, deviceId) || !device.revoked || next.users[device.user]!.removed || end.devices[deviceId]!.revoked) continue;
        expect(may((s) => void (s.devices[deviceId]!.revoked = true)), `${at}: ${label(deviceId)} wasn't revoked again`).toBe(false);
      }
      prev = next;
    }
    // Demotions and lower roles count when they still hold at the end of the losing branch (of a room: when it was
    // last live there), as the last change that made them left them.
    for (const [userId, user] of Object.entries(fork.users)) {
      if (!user.admin || lostEnd.users[userId]!.admin || lostEnd.users[userId]!.removed || !end.users[userId]!.admin) continue;
      let by: SignedVersion | undefined;
      let before = fork;
      for (const version of lost) {
        if (before.users[userId]!.admin && !version.body.state.users[userId]!.admin) by = version;
        before = version.body.state;
      }
      const signer = stands(by);
      if (!signer || !current.users[signer.user]!.admin) continue;
      expect(may((s) => void (s.users[userId]!.admin = false)), `${at}: ${label(userId)} wasn't demoted again`).toBe(false);
    }
    for (const [roomId, room] of Object.entries(fork.rooms)) {
      if (room.deleted || end.rooms[roomId]!.deleted) continue;
      const live = [fork, ...lost.map((v) => v.body.state)].filter((state) => !state.rooms[roomId]!.deleted).pop()!;
      for (const [userId, role] of Object.entries(room.members)) {
        const after = live.rooms[roomId]!.members[userId];
        const now = end.rooms[roomId]!.members[userId];
        if (rank(after) >= rank(role) || now === undefined || rank(now) <= rank(after)) continue;
        let by: SignedVersion | undefined;
        let before = fork;
        for (const version of lost) {
          const there = version.body.state.rooms[roomId]!;
          if (!there.deleted && rank(there.members[userId]) < rank(before.rooms[roomId]!.members[userId])) by = version;
          before = version.body.state;
        }
        const signer = stands(by);
        if (!signer || !(roleIn(current, roomId, signer.user) === "manage" || (after === undefined && signer.user === userId))) continue;
        const lower = (s: WorkspaceState) => void (after === undefined ? delete s.rooms[roomId]!.members[userId] : (s.rooms[roomId]!.members[userId] = after));
        expect(may(lower), `${at}: ${label(userId)} wasn't lowered again in ${label(roomId)}`).toBe(false);
      }
    }
  }
  return true;
}

const one = Number(process.env.FUZZ_SEED);
const seeds = Number.isInteger(one) && process.env.FUZZ_SEED ? [one] : Array.from({ length: Number(process.env.FUZZ_SEEDS) || 60 }, (_, i) => i + 1);

describe("fork rules fuzz", () => {
  it("takes away again what the losing branch took away, and nothing else", () => {
    const forks = seeds.filter(run).length;
    // Nearly every seed makes a fork: only two branches beginning with the same change make none.
    expect(forks).toBeGreaterThanOrEqual(Math.ceil(seeds.length * 0.9));
  }, 60_000 + seeds.length * 1_000);
});
