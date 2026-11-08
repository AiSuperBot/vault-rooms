// Files of a room on two computers written, edited, deleted, renamed (to a new name, or to the name of one deleted just
// before) and moved out of the room at random, while now and then a computer is cut off, refused every change of the
// room's file list (its storage full), or hasn't read that list (another program held its journal at start). Each file
// holds its own tag on its first line. Checked after every settle: a file only ever stands at a name someone gave its
// content (or that name told apart from a clashing one), never at another file's; and no tag is in two files (copies
// aside). At the end, once nothing is refused or cut off: both computers hold the same files, and every file nobody
// deleted or moved out is still there, as a copy at least. Ids are random, so a seed may need a few runs to fail again.
// FUZZ_SEEDS=300 for a longer run; FUZZ_SEED=n runs the seed a failure names; FUZZ_TRACE=1 prints every step and the
// folders' logs. FUZZ_BUSY=1 lets steps follow each other while a folder is still busy with earlier ones: a known
// limit fails there (the same name deleted twice in one deletion wait, a file renamed onto it in between, is one
// deletion: see RoomFolder.deletions).
import { describe, expect, it, vi } from "vitest";
import { INDEX_DOC, MeshNode, RoomReplica, WorkspaceChain, wrapRoomKey } from "@vault-rooms/secure";
import { createRoom, founder, invite, Network, type TestDevice } from "@vault-rooms/secure/testkit";
import { RoomFolder, type RoomFolderState } from "../../src/mesh/roomFolder.js";
import { MemoryVault } from "./memoryVault.js";

const STEPS = 40;

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

interface Pc {
  name: string;
  node: MeshNode;
  replica: RoomReplica;
  vault: MemoryVault;
  folder: RoomFolder;
  /** Every change of the room's file list is refused here (see toggle). */
  refused?: { mockRestore(): void };
  /** The room's file list isn't read here (see toggle). */
  unread: boolean;
}

/** Ana and Cy, who may both write, in step on an empty room. */
async function start() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { roomId, key } = createRoom(chain, ana, "Team", { [cy.userId]: "write" });
  const net = new Network();
  const make = (device: TestDevice, name: string): Pc => {
    let pc!: Pc;
    const changed = (env: { k: string; doc?: string; author?: string; id?: string }) => {
      if (env.k === "b") pc.folder.blobArrived(`${env.author}/${env.id}`);
      else pc.folder.remoteChanged(env.doc);
    };
    const node = new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
      envelope: (env) => {
        pc.replica.receive(env);
        changed(env);
      },
      stored: changed,
      wraps: () => {
        if (pc.replica.refreshKeys()) pc.folder.remoteChanged();
      }
    });
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, { clash: (docId, version) => pc.folder.noteClashed(docId, version) });
    const vault = new MemoryVault();
    const saved: { state: RoomFolderState | null; saves: unknown } = { state: null, saves: null };
    const folder = new RoomFolder({
      folder: "Team",
      replica,
      vault,
      deviceName: `${name} PC`,
      isBound: () => false,
      loadState: async () => saved.state,
      saveState: async (state) => void (saved.state = structuredClone(state)),
      loadSaves: async () => saved.saves,
      saveSaves: async (saves) => void (saved.saves = structuredClone(saves)),
      notify: () => {},
      confirmDeletions: async () => true,
      log: (message) => process.env.FUZZ_TRACE && console.log(`[${name}] ${message}`),
      now: () => new Date("2026-10-26T12:30:00Z")
    });
    vault.listener = {
      write: (path) => void folder.onLocalWrite(path),
      delete: (path) => void folder.onLocalDelete(path),
      rename: (from, to) => void folder.onLocalRename(from, to)
    };
    pc = { name, node, replica, vault, folder, unread: false };
    node.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: device.id, agree: device.agree.publicKey }, ana.sign));
    replica.refreshKeys();
    return pc;
  };
  const pcs = [make(ana, "Ana"), make(cy, "Cy")];
  for (const pc of pcs) await pc.folder.start();
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      net.pump();
      for (const pc of pcs) await pc.folder.settled();
    }
  };
  return { roomId, net, pcs, settle };
}

const isCopy = (path: string) => path.includes("(conflict ") || path.includes("(your copy ");
/** The names a file at `path` may have been given: that one, and it told apart from clashing ones ("Plan (a1b2).md"). */
function given(path: string): string[] {
  const names = [path];
  for (let name = path; /\s\([0-9A-Za-z_-]+\)\.[a-z]+$/.test(name); ) names.push((name = name.replace(/\s\([0-9A-Za-z_-]+\)(\.[a-z]+)$/, "$1")));
  return names;
}

async function run(seed: number): Promise<void> {
  const rand = random(seed);
  const { roomId, net, pcs, settle } = await start();
  const [a, c] = pcs as [Pc, Pc];
  let link: { cut: () => void } | null = net.link(a.node, c.node);
  /** The names someone gave each tag's file, in the room's folder. */
  const names = new Map<string, Set<string>>();
  /** Tags of files someone deleted or moved out of the room: those may be gone. */
  const dropped = new Set<string>();
  const log: string[] = [];
  let next = 0;
  const files = (pc: Pc) => [...pc.vault.files.keys()].filter((path) => path.startsWith("Team/")).map((path) => path.slice("Team/".length));
  const tagOf = (pc: Pc, path: string) => pc.vault.text(`Team/${path}`)!.split("\n")[0]!;
  // Files not shared yet (turned away while nothing could go out): one renamed onto a deleted file's name is taken, as
  // designed, for a program saving through a temporary file (the deleted file's new content), so it isn't moved so here.
  const waiting = (pc: Pc) => new Set((pc.folder.health().rejected ?? []).map((item) => item.path));
  const context = () => `seed ${seed} (FUZZ_SEED=${seed}): ${log.join("; ")}`;

  /** Checked whenever things are quiet: no file stands at another's name, and none is in two places (copies aside). */
  const check = () => {
    for (const pc of pcs) {
      const seen = new Map<string, string>();
      for (const path of files(pc).filter((path) => !isCopy(path))) {
        const tag = tagOf(pc, path);
        expect(given(path).some((name) => names.get(tag)?.has(name)), `${context()}: on ${pc.name}'s computer "${path}" holds "${tag}"`).toBe(true);
        expect(seen.get(tag), `${context()}: on ${pc.name}'s computer "${tag}" is in "${seen.get(tag)}" and "${path}"`).toBeUndefined();
        seen.set(tag, path);
      }
    }
  };
  const create = async (pc: Pc) => {
    const tag = `tag ${next}`;
    const name = `n${next++}.md`;
    names.set(tag, new Set([name]));
    log.push(`${pc.name} writes ${name}`);
    await pc.vault.writeText(`Team/${name}`, `${tag}\n`);
  };

  for (let i = 0; i < 3; i++) await create(a);
  await settle();
  for (let step = 0; step < STEPS; step++) {
    const pc = pick(rand, pcs);
    const here = files(pc).filter((path) => !isCopy(path));
    const choice = rand();
    try {
      if (choice < 0.14 || here.length === 0) await create(pc);
      else if (choice < 0.28) {
        const path = pick(rand, here);
        log.push(`${pc.name} edits ${path}`);
        await pc.vault.writeText(`Team/${path}`, `${pc.vault.text(`Team/${path}`)}line ${step}\n`);
      } else if (choice < 0.38) {
        const path = pick(rand, here);
        dropped.add(tagOf(pc, path));
        log.push(`${pc.name} deletes ${path}`);
        await pc.vault.trash(`Team/${path}`);
      } else if (choice < 0.5) {
        const path = pick(rand, here);
        const to = `r${next++}.md`;
        names.get(tagOf(pc, path))!.add(to);
        log.push(`${pc.name} renames ${path} to ${to}`);
        await pc.vault.rename(`Team/${path}`, `Team/${to}`);
      } else if (choice < 0.6 && here.length >= 2 && here.some((path) => !waiting(pc).has(path))) {
        const moved = pick(rand, here.filter((path) => !waiting(pc).has(path)));
        const gone = pick(rand, here.filter((path) => path !== moved));
        dropped.add(tagOf(pc, gone));
        names.get(tagOf(pc, moved))!.add(gone);
        log.push(`${pc.name} deletes ${gone} and renames ${moved} to its name`);
        await pc.vault.trash(`Team/${gone}`);
        await pc.vault.rename(`Team/${moved}`, `Team/${gone}`);
      } else if (choice < 0.66) {
        const path = pick(rand, here);
        dropped.add(tagOf(pc, path));
        log.push(`${pc.name} moves ${path} out of the room`);
        await pc.vault.rename(`Team/${path}`, `Out/${pc.name}/${path}`);
      } else if (choice < 0.74) {
        log.push(`${pc.name}'s room ${pc.refused ? "takes changes again" : "refuses every change of its file list"}`);
        if (pc.refused) {
          pc.refused.mockRestore();
          pc.refused = undefined;
          pc.folder.retryNow();
        } else pc.refused = vi.spyOn(pc.replica, "editIndex").mockReturnValue("refused");
      } else if (choice < 0.8) {
        pc.unread = !pc.unread;
        log.push(`${pc.name}'s file list ${pc.unread ? "isn't read" : "is read"}`);
        pc.node.store.setUnreadable(roomId, INDEX_DOC, pc.unread);
        // As when the journal is read late (see MeshService, disk.onLateRead).
        if (!pc.unread) pc.folder.remoteChanged(INDEX_DOC);
      } else if (choice < 0.86) {
        log.push(link ? "they part" : "they meet");
        if (link) {
          link.cut();
          link = null;
        } else link = net.link(a.node, c.node);
      } else {
        await settle();
        check();
      }
    } catch (error) {
      // A rename onto a name that is taken, or of a file gone meanwhile: refused as Obsidian does.
      if (!/^E(EXIST|NOENT) /.test((error as Error).message)) throw error;
      log.push("(refused by the vault)");
    }
    // The folders take in what was done before the next step (their own waits, a deletion's, still run), unless
    // FUZZ_BUSY=1: then steps follow each other while a folder is still busy with earlier ones.
    if (!process.env.FUZZ_BUSY) await new Promise((resolve) => setImmediate(resolve));
    // FUZZ_TRACE=1: each step, and what each computer holds after it.
    if (process.env.FUZZ_TRACE) console.log(`${step} ${log[log.length - 1]} | ${pcs.map((pc) => `${pc.name}: ${files(pc).map((path) => `${path}=${pc.vault.text(`Team/${path}`)!.split("\n")[0]}`).join(", ")}`).join(" | ")}`);
  }

  // Nothing is refused or cut off any more: everything settles.
  log.push("END");
  for (const pc of pcs) {
    pc.refused?.mockRestore();
    pc.refused = undefined;
    if (pc.unread) {
      pc.unread = false;
      pc.node.store.setUnreadable(roomId, INDEX_DOC, false);
      pc.folder.remoteChanged(INDEX_DOC);
    }
  }
  if (!link) link = net.link(a.node, c.node);
  for (let round = 0; round < 3; round++) {
    for (const pc of pcs) pc.folder.retryNow();
    await settle();
  }
  check();
  const shared = (pc: Pc) => Object.fromEntries(files(pc).filter((path) => !isCopy(path)).map((path) => [path, pc.vault.text(`Team/${path}`)]));
  expect(shared(c), `${context()}: the computers differ`).toEqual(shared(a));
  const kept = pcs.flatMap((pc) => files(pc).map((path) => pc.vault.text(`Team/${path}`)!));
  for (const tag of names.keys()) {
    if (dropped.has(tag)) continue;
    expect(kept.some((text) => text.startsWith(`${tag}\n`)), `${context()}: "${tag}" was lost`).toBe(true);
  }
}

const one = Number(process.env.FUZZ_SEED);
const seeds = Number.isInteger(one) && process.env.FUZZ_SEED ? [one] : Array.from({ length: Number(process.env.FUZZ_SEEDS) || 30 }, (_, i) => i + 1);

describe("room folder fuzz", () => {
  it("never gives a file another's name or content, and loses none, whatever is refused or cut off", async () => {
    for (const seed of seeds) await run(seed);
  }, 60_000 + seeds.length * 3_000);
});
