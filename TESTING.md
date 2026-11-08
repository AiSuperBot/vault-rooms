# Testing Vault Rooms

## Automatic tests

```sh
npx pnpm@11.7.0 typecheck
npx pnpm@11.7.0 test
```

The suite runs in about two minutes. Three seeded fuzz tests are part of it. Each one makes random scenarios from a seed and checks rules that must always hold:

| Test | What it varies | What it checks |
| --- | --- | --- |
| `apps/obsidian-plugin/test/mesh/clashFuzz.test.ts` | Notes saved outside the editor on several computers at once | The same note everywhere, no saved line lost or mixed with another |
| `packages/secure/src/forkFuzz.test.ts` | Two branches of the workspace record made at the same moment, some by a stolen computer | What the losing branch took away is taken again, and nothing else: nobody gains a role, a room nobody changed keeps its members |
| `apps/obsidian-plugin/test/mesh/folderFuzz.test.ts` | Files written, edited, deleted, renamed and moved out on two computers, with refusals, unread file lists and lost connections | A file never stands at another file's name, its text is never in two files, both computers agree at the end, nothing is lost |

Environment variables for the fuzz tests:

- `FUZZ_SEEDS=500` runs more seeds (the default is a few dozen).
- `FUZZ_SEED=n` runs only the seed a failure names. Ids are random, so a seed may need a few runs to fail again.
- `FUZZ_TRACE=1` (room folder test) prints every step, what each computer holds after it, and the folders' logs.
- `FUZZ_BUSY=1` (room folder test) lets steps follow each other while a folder is still busy. It shows one known limit: a name deleted twice within one deletion wait, with a shared file renamed onto it in between, counts as one deletion.

When you fix a bug, add a test that fails without the fix. Check that by running the test on the old code (`git stash`, or `git show HEAD:<file>`), and restore the file after.

## Manual checks in Obsidian

Some things only real Obsidian and a real network show: the editor, Windows file locks, the firewall and sleep. Run these before a release, on two or three Windows computers (or several vaults on one computer). Each step says what to do and what you should see.

### Everyday use

1. **Typing together.** Open the same note on two computers. Type at the same time, with emoji and accented letters. Both show the same text, and no character is lost or doubled.
2. **Offline edits.** Disconnect one computer. Edit the same note in the editor on both. Reconnect. The note has both edits, and no conflict copy appears.
3. **Edits outside Obsidian.** Close Obsidian on both. Change the same line of a note in Notepad on each. Start Obsidian on both. One line stays, and the other is kept as `name (conflict …).md`, which both computers get.
4. **Readers.** As someone who may only read, delete a file, rename one and edit one. Each is put back, with a notice. Your edited version stays as `(your copy …)` on your computer only.
5. **Restart during work.** Close Obsidian on one computer while the other is typing. Start it again. Nothing typed is lost on either side.
6. **Sleep.** Put a computer to sleep for ten minutes while the other edits. Wake it. It reconnects and catches up within a minute.
7. **Firewall.** On a new computer without the inbound rule for Obsidian, the others can't reach it, and the panel shows that it is offline. With the rule (see the README), they connect.

### Checks for the audit 50 fixes

8. **Delete, then rename onto the name.** Delete `A.md`, and within two seconds rename `B.md` to `A.md`. On both computers, `A.md` has B's text and B is gone. Do it once more as a reader: both files are put back, each with its own text.
9. **Rename, then delete.** Rename a file and delete it right after. It is deleted on both computers and doesn't come back.
10. **A very large note.** With a note open in the editor, paste a block of about 1 MB of text again and again, until the file is over 12 MB on disk. The others get the whole note. No `(your copy …)` files pile up on a reader's computer. No computer lists the note as held back, or says it couldn't be shared.
11. **A journal held at start.** Close Obsidian. In PowerShell, lock the room's file list:

    ```powershell
    $f = [System.IO.File]::Open("<vault>\.obsidian\plugins\vault-rooms\mesh\<workspace>\docs\<room>\index.jsonl", 'Open', 'Read', 'None')
    ```

    Start Obsidian. Delete a file, add one and rename one in that room. The notices say the computer hasn't read the room's file list yet, not that the storage is full. The deleted file doesn't come back, and the rename is undone. Release the lock with `$f.Close()`. Within a few seconds, the deletion and the new file reach the other computer.
12. **A key started on two computers at once.** Disconnect two managers of a room. Each removes a different member, which starts a new room key on each. Reconnect, and type in a note on both right away. Within a few seconds both show all the text.
13. **A room deleted while losing a race.** Use three computers: the founder's, another admin's, and a third one. Disconnect the founder's computer, and have it revoke some computer. On the admin's computer, delete a room. Let the third computer sync with the admin's, then disconnect the admin's computer. Connect the founder's computer with the third one. The founder's change wins, and on both the room stays with every member it had. Once the admin's computer is back, it deletes the room again.
14. **Joining through two addresses.** On a computer with a VPN and the local network, make an invite, and check that the link lists both addresses. Withdraw the invite, then try to join with it: you are told the link was refused. Make a new invite and join: it works.

A name clash that comes back once settled (audit 50, 6) can't be made by hand on Windows: the automatic tests cover it.
