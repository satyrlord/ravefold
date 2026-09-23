# RaveFold product slices

Status: Specs 001, 002 and 013 are implemented. The user accepted spec-013.
Other specifications stay drafts. Browser support and tests are limited to
Chromium.

## Authority and review boundary

[PRODUCT.md](../../PRODUCT.md) gives the product requirements with user
approval. [The plan](../plan.md) gives delivery stages, technical proposals and
evidence targets. Each specification below gives one user result and its
acceptance checks. Proposed behavior does not have new product approval.

The increase in spec-001 menu scope has user approval. Its interview is
completed. The user also requested spec-013 archive import. On 2026-09-23, the
user authorized spec-002 implementation after a full tracker mockup request.
Other slices do not have implementation approval.

## Terms

- A product slice contains the work necessary for one usable product result.
- An acceptance check shows if a result agrees with a requirement.
- A contract gives the data or behavior that components share.
- A fixture is test input with known expected results.
- Metadata is information about other data.
- A manifest is a file with sample metadata and preparation state.
- A corpus is a set of audio samples for tests.
- Persistence saves data so that it stays after a session ends.
- Validation compares data with specified rules. A valid file passes these
  checks.
- A file hash is a value calculated from file bytes to detect changes.
- A buffer holds data in memory while the application operates.

## Slice order

Each slice includes the interface, logic and storage necessary for its result.
Dependencies identify earlier results, not different technical layers. Do tests
of each slice through its user flow. Also do tests of its logic independently.

| Specification                           | User outcome                                           | Depends on                         | Interview                 |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------- | ------------------------- |
| [001](spec-001-select-folders.md)       | Use the full main menu and enter the tracker           | M0 entry contracts, M1 UI evidence | Completed                 |
| [002](spec-002-find-a-sample.md)        | Find, tag and audition a source sample                 | 001                                | Implementation authorized |
| [003](spec-003-use-compatible-audio.md) | Make compatible audio ready for arrangement            | 002, M1 analysis evidence          | No approval               |
| [004](spec-004-prepare-a-sample.md)     | Prepare a sample at the supported tempo and key        | 003, M1 conversion evidence        | No approval               |
| [005](spec-005-review-a-sample.md)      | Resolve an uncertain sample or select a usable section | 003, 004                           | No approval               |
| [006](spec-006-arrange-and-play.md)     | Place ready clips and play a short arrangement         | 003, M1 playback evidence          | No approval               |
| [007](spec-007-edit-sections.md)        | Move, copy, repeat and remove song sections            | 006                                | No approval               |
| [008](spec-008-mix-tracks.md)           | Adjust and hear a basic mix                            | 006                                | No approval               |
| [009](spec-009-save-and-reopen.md)      | Save a project and reopen available clips              | 006                                | No approval               |
| [010](spec-010-recover-work.md)         | Recover unsaved arrangement work                       | 009                                | No approval               |
| [011](spec-011-render-song.md)          | Render the mix to a selected folder                    | 008, 009                           | No approval               |
| [012](spec-012-change-appearance.md)    | Keep themes stable during tracker use                  | 001, 002, 006                      | No approval               |
| [013](spec-013-import-og-archive.md)    | Import OG archive samples as WAV files                 | 001                                | Completed                 |

The order shows dependencies. It does not give approval for a subsequent
interview. Slices 004 and 005 can follow the initial arrangement slice after its
inputs are ready.

Slice 001 supplies the full menu and appearance system after M0/M1 evidence.
Slice 012 applies that system to tracker flows and includes tests of playback
continuity. M0 supplies fixtures for project reading. Slice 001 does not depend
on subsequent components that write projects.

## Rules inherited by each slice

- Keep the product at 180 BPM and C minor. Apply all sample classes with user
  approval.
- Accept WAV samples only. Export supports WAV and MP3. MP3 is not a sample
  format.
- Bundle no samples or demo songs. OG project import is excluded permanently.
  The first release does not include recording, synthesis or automation.
- Use the selected sample folder for all persistent library audio. Do not delete
  or change existing audio, including partial files and files made by the app.
- Add new audio only at new paths. Manifests can change or be deleted. These
  operations do not give permission to change audio files.
- Keep settings and recovery files with metadata only in the selected Documents
  subfolder. Browser storage contains folder-access references only.
- Project files contain arrangement data and sample paths, with no audio. A
  destination folder selected by the user is necessary for each rendered song.
- A valid sample folder and a writable settings folder are necessary for entry.
  Red bubbles identify missing individual project samples after successful
  folder setup.
- Support desktop keyboard and pointer use. Browser support and tests are
  limited to Chromium. The application must handle unavailable capabilities in
  supported browsers without errors.
- Use tooltips as the only help. Give controls accessible names and focus
  states. Errors, progress and required status messages are functional
  information.
- Apply accessibility to each slice. Give keyboard support before slice 012.
- Use the necessary programming language, framework, interface library and six
  reference skins. The plan and private technology record give their
  implementation details.

## Evidence and acceptance

Acceptance IDs use the form `S001-AC01`. Keep each ID with the slice that gives
it. Record completed evidence and remaining limits with the owning slice.

M0 gives the corpus and acceptance criteria for approval by the product owner.
M1 supplies measurements before implementation of the full workspace. The
specification division does not bypass either stage. Recorded evidence and
decisions are necessary for browser versions, capacity, detector confidence and
processing tools.

Use generated signals or material with distribution permission in public tests.
Keep private source fixtures out of the application and public test assets.
Compare file hashes during tests of audio protection. Examine persistent writes
for each flow that uses storage.

Browser tests belong only in `quality:full`, and only for user interface (UI)
changes. Add this gate with the first real browser suite. It must include quick
checks, a build and browser tests of that build without windows on the screen.
Documentation changes use `quality:quick` and `git diff --check`. These checks
do not prove browser or audio behavior.

## Coverage and shared evidence

| Plan subject                                           | Owning slices or stage |
| ------------------------------------------------------ | ---------------------- |
| Folder access, settings and browser capability states  | 001                    |
| Library, source preview, tags and source history       | 002                    |
| Musical readiness, file validation and stereo pairing  | 003                    |
| Background transformation, cancellation and retry      | 004                    |
| Manual review and compatible source sections           | 005                    |
| Timing, transport and initial editing                  | 006                    |
| Group editing, track changes, trim and repeat          | 007                    |
| Basic mixer and meters                                 | 008                    |
| Project writing, missing-file display and relinking    | 009                    |
| Recovery writes and interrupted sessions               | 010                    |
| Export destination, encoding and audio tails           | 011                    |
| Six skins, effects levels and saved appearance         | 001                    |
| Project-read contract and pre-entry recovery selection | 001, M0                |
| Tracker appearance and playback continuity             | 012                    |
| Corpus, numerical criteria and tool feasibility        | M0 and M1 in the plan  |
| Combined load, production hosting and release evidence | M5 in the plan         |

Each subsequent specification gives its open choices. These are records for a
future review. They are not questions for the current session.
