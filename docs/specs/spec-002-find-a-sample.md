# Spec-002: Find, tag and audition a sample

Status: Implemented. Chromium verification is recorded below.

The user requested the full tracker view design and an image mockup before
implementation on 2026-09-23. The subsequent request authorized this slice.

## Outcome

A user finds a file in their sample folder, hears its source audio and adds
tags. The tags stay available when the next session starts.

## Scope and dependencies

Necessary earlier result: [001](spec-001-select-folders.md). This slice adds
folder browsing, search, tag filters, source preview and waveform inspection.
Source preview does not make a sample ready for arrangement.

This slice also defines the full tracker view design. The
[tracker design proposal](../../design/tracker-view.md) includes the image
mockup, panel layout, controls and state requirements. Arrangement, preparation,
mix and export behavior stays in its respective specification. The mockup does
not give implementation approval for those features.

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

## Implemented behavior

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

### Tracker workspace

The validated menu entry opens the tracker. The workspace contains the sample
browser, arrangement overview, sample inspector, transport and mixer overview.
The existing six skins, color modes and effects levels apply to these panels.

The arrangement shows stored clip references, track order and missing-sample
bubbles. Timeline zoom and scrolling operate on this overview. The mixer shows
stored values without active meters. Arrangement edits, playback, mix changes,
project save and export remain in their respective slices. Their controls are
unavailable with explanatory tooltips. No example song or audio is supplied.

At widths of 1280 pixels or less, the inspector closes automatically. The user
can reopen it. At widths of 760 pixels or less, separate views contain Samples,
Arrangement and Mixer. The inspector follows the selected view. Keyboard focus
and labels remain available. Folder-access loss returns the user to setup and
keeps the selected project.

### Catalog and search

Catalog discovery reads directory entries without audio decoding. Relative paths
identify rows. Each row shows its name, folder, WAV format, tags and preparation
state. File selection validates the WAV format and shows detailed source values.
Unsupported or unreadable sources show an error without changing their files.

Discovery does not determine musical readiness. Each source has the
`not-prepared` state. No prepared preview is available in this slice. Source
category and history remain separate fields. They show no recorded value when
source evidence is absent.

Search uses text fragments in the filename or a saved tag. Letter case does not
affect matching. A folder filter includes its subfolders. A tag filter matches
one complete tag. Search, folder and tag filters apply together. Reset filters
restores the complete catalog. Results use pages of 100 rows.

### Tags and conflicts

Tag edits remain drafts until the user selects Save tags. Drafts belong to
relative sample paths and survive selection changes. An unsaved state remains
after a failed write. Retry tag save repeats the write. Reload saved tags
discards that sample's draft and reads its stored values. Departure from the
tracker requires a choice when tag drafts remain.

The sample folder contains `ravefold-tags.manifest.json`. Its version-1 schema
contains `schemaVersion`, `revision` and `samples`. Each `samples` key is a
validated relative WAV path. Each record contains only a `tags` array.

Tags contain 1 to 40 characters after removal of outer spaces. Each file permits
32 tags. Commas and control characters are not permitted. Duplicate tags with
different letter case become one tag. The manifest size limit is 4 MiB.
Malformed or unsupported manifests remain unchanged.

The writer preserves the last valid file until commit. App writes use shared
reservation manifests in the sample folder. This protocol coordinates browser
and native sessions. Web Locks provide additional ordering within one browser
origin. The [tag write protocol](../tag-write-protocol.md) gives the contract,
recovery procedure and verification limits.

Each draft retains the saved tags from the time of its first edit. A save
rejects changes to the same stored record. It merges independent records. Native
folder access also restricts tag writes to the named root manifest. Audio files
cannot be changed through this operation.

### Source audio

Play source starts unchanged audio after an explicit user command. Starting a
new preview cancels the previous preview, including an incomplete decode. Only
the latest command can start audio. Stop preview cancels pending playback.
Leaving the tracker closes its audio context.

Show waveform decodes only the selected source and calculates its amplitude
peaks. It does not start playback. Selection changes cancel obsolete waveform
results. The preview module keeps no decoded catalog cache and writes no audio.

The current source limits are 100 MiB and five minutes for each preview or
waveform request. These limits use the delivery plan's recommendations. They are
not measured capacity claims. A larger file remains in the catalog with an
explicit preview error. Native decoding cannot be interrupted, but an obsolete
result cannot start playback.

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
| Favorites                                  | Product owner, future slice review. This feature is not implemented.                 | Compare folder and tag use with a representative library. |
| Preview timing during arrangement playback | Product owner and audio developer, future slice review. Playback is not yet present. | Compare immediate and bar-aligned preview after spec-006. |
| Memory and catalog limits                  | Developer, M1 evidence. No capacity measurements exist.                              | Record catalog size, memory use and response times.       |

## Out of scope

No readiness decision, waveform editing, conversion or audio-file management.

## Verification record

Verification date: 2026-09-23. Runtime: Node.js 24.19.0 on Windows. Browser
tests use the production build and run without visible windows. Browser support
and tests are limited to Chromium. No Firefox or Safari tests remain.

`npm run quality:full` passed with 191 unit tests and 48 Chromium tests. One
POSIX-specific unit test was skipped on Windows. The gate also passed strict
compiler checks, Markdown checks, formatting and the application/extension
build. `git diff --check` passed after validation.

| Check     | Evidence                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| S002-AC01 | Duplicate filenames resolve to distinct relative paths and decoded source hashes in `tests/browser/library.spec.ts`.                       |
| S002-AC02 | Tags survive reload, removal and subsequent search or filtering. Browser and native-folder cases pass.                                     |
| S002-AC03 | Denied commits preserve prior tags and show unsaved status. Browser and native re-entry preserve drafts after permission loss.             |
| S002-AC04 | Browser instrumentation records at most one active preview. Unit tests cover stale decode, resume, stop and disposal.                      |
| S002-AC05 | A 1,203-file browser catalog remains searchable without decoding. A 10,000-entry unit catalog performs no audio reads.                     |
| S002-AC06 | Browser and native checks compare audio hashes. Tag writes and reservation records stay in sample-folder manifests.                        |
| S002-AC07 | Keyboard search, tag edits, preview and waveform requests pass. All six skins pass automated accessibility checks in dark and light modes. |

Layout checks cover 1440 by 960, 1280 by 720 and the 640 by 360 layout at 200%
zoom equivalence. Visual inspection confirmed panel separation and preview
control access. The inspector closes before the arrangement loses width.

Independent code review found and verified corrections for stale metadata,
permission recovery, reservation cleanup and temporary Windows file conflicts.
The final scoped review found no blocking findings. The design detector reported
only advisory differences from the earlier menu type and radius definitions.
DESIGN.md now records the tracker values. Existing design-tool metadata drift
was not repaired as part of this slice.

Source audition uses generated WAV fixtures. These checks do not establish
listening quality, real-library memory limits or combined playback capacity. The
mixed storage test uses a browser-style disk adapter and actual native hosts.
Actual Chromium file-handle contention with a native host remains unmeasured.
The [protocol record](../tag-write-protocol.md) explains this limit.
