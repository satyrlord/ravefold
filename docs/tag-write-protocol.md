# Tag write protocol

## Contract

All application tag saves use one protocol in the selected sample folder. The
protocol applies across browser origins. Browser locks can reduce local
contention. They do not supply the shared guarantee.
[Private research](research/local-research.md) contains source evidence and
algorithm attribution.

A register is a small manifest that belongs to one write operation. Its name has
this form: `.ravefold-tags-lock-<uuid>.manifest.json`. A UUID is a randomly
generated unique identifier. The application does not reuse register names. Each
register contains its owner, a choice flag and an integer ticket.

Each writer changes only its own register. The application treats an empty
register as an unfinished ticket choice. Invalid registers prevent a save.
Register writes replace complete content when the file writer closes.

## Sequence

1. Create a unique register in the sample folder.
2. Publish the choice flag with ticket zero.
3. Read all current register tickets.
4. Select a ticket one greater than the largest ticket.
5. Publish the ticket with the choice flag cleared.
6. Wait for unfinished choices and all lower ticket priorities.
7. Read the current tag manifest.
8. Check the edited record against its expected saved tags.
9. Merge the edit with the other current records.
10. Check register ownership before the manifest commit.
11. Commit the complete tag manifest.
12. Remove only the register that the operation still owns.

Equal tickets use identifier order. Ticket arithmetic never wraps. A ticket
limit error prevents the save. A wait ends after three seconds or cancellation.
An expired wait does not remove another writer's register. Registers contain no
audio or private computer paths.

## Dynamic participant argument

Consider writer A after it publishes its ticket. Its next directory scan
examines every register that existed before that scan and still exists. A
register with an unfinished choice prevents A from entering the commit section.
A settled register with lower ticket priority also prevents entry.

Writer B can publish a new register during A's scan. The scan can omit that new
entry. However, A's register already exists before B starts its ticket scan. B
must observe A's ticket and select a greater ticket. B then waits for A. This
order also applies when A is already in the commit section.

Concurrent ticket choices can produce equal tickets. Identifier order gives one
priority. Both writers inspect the other's settled choice before entry. A
completed writer removes its register only after its manifest commit. A
cancelled writer removes its register without a commit. Thus, omission of a
concurrently removed register cannot permit two app commits.

The argument requires complete enumeration of stable entries and current file
reads. It does not require a directory snapshot or a particular entry order. The
browser file adapter supplies these operations. External tools that ignore the
protocol can still change files. Content checks detect such changes before
commit when observable.

## Recovery after an interrupted session

A stopped process can leave a reservation file. The application does not infer
ownership from elapsed time. It does not take an abandoned reservation. The
previous tag manifest remains available.

A live process retains an unsuccessful cleanup in memory. After access returns,
it retries only its own unchanged register in the confirmed same folder. Changed
or replaced registers remain in place.

1. Close all RaveFold browser tabs.
2. Open the selected sample folder in the operating system file manager.
3. Remove only abandoned `.ravefold-tags-lock-<uuid>.manifest.json` files.
4. Keep `ravefold-tags.manifest.json` and all audio files unchanged.
5. Open RaveFold and retry the tag save.

Do not remove reservations while any RaveFold session remains open. The register
pattern requires a UUID with hexadecimal groups of 8, 4, 4, 4 and 12 characters.
Other manifest names are outside this procedure.

## Verification

`tests/library-reservation.test.ts` checks simultaneous independent clients,
late entry, cancelled waits, abandoned registers and changed ownership. Its disk
test uses three independent browser-style disk adapters. The test starts with no
registry and checks that three edits survive.

This disk adapter test does not measure external updates through actual Chromium
file handles. That browser-origin contention check remains a verification limit.
The protocol argument requires current external file reads and complete
enumeration of stable entries from each adapter.

`tests/library-tags.test.ts` checks record conflicts, tag reload and interrupted
writes. Browser tests remain part of `quality:full`.
