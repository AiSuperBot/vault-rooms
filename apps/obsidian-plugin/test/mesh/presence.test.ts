import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { newRoomKey, newSigningKeyPair, randomId, sealPresence, utf8, type KeyPair } from "@vault-rooms/secure";
import { founder } from "@vault-rooms/secure/testkit";
import { RoomPresence } from "../../src/mesh/presence.js";

describe("cursors of others", () => {
  it("shows a member's newest cursor, in the room's notes only, within limits, coloured from the user id", () => {
    const { ws } = founder();
    const [room, fileId] = [randomId("r"), randomId("f")];
    const key = newRoomKey();
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText("content"), 2));
    const [ana, bob] = [newSigningKeyPair(), newSigningKeyPair()];
    const users = new Map<string, { id: string; name: string }>();
    const replica = { keyFor: () => key, index: new Map([[fileId, {}]]) };
    const presence = new RoomPresence({ workspaceId: ws, roomId: room, replica: replica as never, me: newSigningKeyPair(), publish: () => {}, userOf: (device) => users.get(device) ?? null });
    const cursor = (author: KeyPair, at: number, client = 1, file = fileId) =>
      sealPresence({ ws, room, n: 1, key, author }, at, utf8(JSON.stringify({ d: file, c: client, a: position, h: position })));
    const first = cursor(ana, 2_000);
    users.set(first.author, { id: "uANA", name: "Ana" });
    users.set(cursor(bob, 1).author, { id: "uANA", name: "Ana on her laptop" });

    presence.receive(first);
    expect([...presence.statesOf(fileId).keys()]).toEqual([1]);
    // Older than the newest taken from that device: not shown.
    presence.receive(cursor(ana, 1_000, 2));
    expect([...presence.statesOf(fileId).keys()]).toEqual([1]);
    // A file not in the room's index: nothing kept for it.
    const other = randomId("f");
    presence.receive(cursor(ana, 3_000, 3, other));
    expect(presence.statesOf(other).size).toBe(0);
    // At most 50 cursors in a note.
    for (let client = 10; client < 70; client++) presence.receive(cursor(ana, 4_000 + client, client));
    expect(presence.statesOf(fileId).size).toBe(50);
    // The same person on another device: the same colour, whatever name the device gives.
    presence.receive(cursor(bob, 5_000, 99));
    const states = [...presence.statesOf(fileId).values()];
    expect(new Set(states.map((state) => state.user.color)).size).toBe(1);
    presence.destroy();
  });
});
