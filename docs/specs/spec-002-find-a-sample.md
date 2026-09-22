# Spec-002: Find, tag and audition a sample

Status: Draft. Interview not authorized. Implementation has not started.

## Outcome

A user finds a file in their sample folder, hears its source audio and adds
tags. The tags are available after the next session.

## Scope and dependencies

Requires [001](spec-001-select-folders.md). This slice adds folder browsing,
search, tag filters, source preview and waveform inspection. Source preview does
not make a sample ready for arrangement.

[PRODUCT.md](../../PRODUCT.md) owns the sample-folder and tag requirements.
[The index](spec-000-index.md) supplies the shared rules and test boundary.

## Product rules

- Browse the selected sample folder and its subfolders.
- Keep editable tags in a sample-folder manifest.
- Tag edits do not rename, move, delete or change audio files.
- Keep audio buffers in memory only. Never persist them outside the sample
  folder.
- Use tooltips only for help. Give controls accessible names and keyboard
  access.

## Proposed behavior

Show file names, relative folders, tags, format and preparation state. Show
waveforms on demand. Keep source category information separate from editable
tags. Do not decode the full catalog to display its rows.

Search file names and tags across folders. A filter changes the visible result,
not the stored library. Keep favorites as manifest metadata if that proposed
feature is accepted. Source history belongs in the inspector.

Start preview after an explicit user command. Play one preview at a time.
Starting another preview stops the earlier one. Mark source preview separately
from prepared-sample preview. Source audition does not bypass musical checks.

A failed tag write must show an unsaved state. It must not claim that the edit
is durable. Preserve the last valid manifest after an interrupted write. The
manifest writer must prevent conflicting app writes to the same record.

## Acceptance checks

| ID        | Given and action                                    | Expected result                                                               |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| S002-AC01 | Browse two subfolders containing the same filename. | Each row resolves to its own relative path and audio file.                    |
| S002-AC02 | Add a tag, reload and filter by that tag.           | The saved tag identifies the same file without moving it.                     |
| S002-AC03 | Deny access during a tag save.                      | An unsaved state appears. The previous valid record is kept.                  |
| S002-AC04 | Preview one source, then another.                   | Only the latest preview plays. Neither receives `ready` status from audition. |
| S002-AC05 | Open a large metadata catalog.                      | File rows appear without decoding the full audio library.                     |
| S002-AC06 | Inspect writes and compare audio hashes.            | Tags use manifests. Audio and browser-storage boundaries remain intact.       |
| S002-AC07 | Use search, tags and preview with a keyboard.       | Focus, control labels and preview status remain available.                    |

## Deferred decisions

| Choice                                     | Owner and reason                                                                     | Verifier                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Search matching, tag syntax and favorites  | Product owner, future slice review. These details are recommendations.               | A small library with duplicate names and several tags.    |
| Preview timing during arrangement playback | Product owner and audio developer, future slice review. Playback is not yet present. | Compare immediate and bar-aligned preview after spec-006. |
| Memory and catalog limits                  | Developer, M1 evidence. No capacity measurements exist.                              | Record catalog size, memory use and response times.       |

## Out of scope

No readiness decision, waveform editing, conversion or audio-file management.
