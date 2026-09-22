# Spec-002: Find, tag and audition a sample

Status: Draft. No approval for an interview. Implementation has not started.

## Outcome

A user finds a file in their sample folder, hears its source audio and adds
tags. The tags stay available when the next session starts.

## Scope and dependencies

Necessary earlier result: [001](spec-001-select-folders.md). This slice adds
folder browsing, search, tag filters, source preview and waveform inspection.
Source preview does not make a sample ready for arrangement.

[PRODUCT.md](../../PRODUCT.md) gives the sample-folder and tag requirements.
[The index](spec-000-index.md) supplies the shared rules and test boundary.

A waveform shows the sound level at each time position. A tag is an editable
label that helps the user find a sample.

## Product rules

- Browse the selected sample folder and its subfolders.
- Keep editable tags in a sample-folder manifest.
- Tag edits do not rename, move, delete or change audio files.
- Keep audio buffers in memory only. Do not save them in storage other than the
  sample folder.
- Use tooltips only for help. Give controls accessible names and keyboard
  access.

## Proposed behavior

Show file names, relative folders, tags, format and preparation state. Show
waveforms when requested. Keep source category information apart from editable
tags. Do not decode the full catalog to show its rows.

Let the user find samples by file name or tag across folders. A filter changes
the result on the screen, not the stored library. Keep favorites as manifest
metadata if that proposed feature is accepted. Source history belongs in the
inspector.

Start preview after an explicit user command. Play one preview at a time.
Starting a different preview stops the earlier one. Give source preview and
prepared-sample preview different labels. Source audition does not bypass
musical checks. Source audition means listening to the unchanged source audio.

After an unsuccessful tag write, show an unsaved state. Do not show the edit as
saved. Keep the last valid manifest after an interrupted write. The manifest
writer must prevent conflicting app writes to the same record.

## Acceptance checks

| ID        | Given and action                                       | Expected result                                                                     |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| S002-AC01 | Browse two subfolders containing the same filename.    | Each row resolves to its own relative path and audio file.                          |
| S002-AC02 | Add a tag. Reload the application. Filter by that tag. | The saved tag identifies the same file without moving it.                           |
| S002-AC03 | Deny access during a tag save.                         | The interface shows an unsaved state. The previous valid record is kept.            |
| S002-AC04 | Preview one source. Then preview a different source.   | Only the latest preview plays. Audition does not give either source `ready` status. |
| S002-AC05 | Open a large metadata catalog.                         | The interface shows file rows without decoding the full audio library.              |
| S002-AC06 | Examine writes. Compare audio hashes.                  | Tags use manifests. Audio and browser-storage boundaries stay unchanged.            |
| S002-AC07 | Use search, tags and preview with a keyboard.          | Focus, control labels and preview status stay available.                            |

## Deferred decisions

| Choice                                     | Owner and reason                                                                     | Verification                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Search matching, tag syntax and favorites  | Product owner, future slice review. These details are recommendations.               | A small library with duplicate names and some tags.       |
| Preview timing during arrangement playback | Product owner and audio developer, future slice review. Playback is not yet present. | Compare immediate and bar-aligned preview after spec-006. |
| Memory and catalog limits                  | Developer, M1 evidence. No capacity measurements exist.                              | Record catalog size, memory use and response times.       |

## Out of scope

No readiness decision, waveform editing, conversion or audio-file management.
