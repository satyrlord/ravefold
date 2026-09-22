# RaveFold product slices

Status: Draft specifications. Application implementation has not started.

## Authority and review boundary

[PRODUCT.md](../../PRODUCT.md) owns approved product requirements.
[The plan](../plan.md) owns delivery stages, technical proposals and evidence
targets. Each specification below owns one user outcome and its acceptance
checks. Proposed behavior is not a new product approval.

The authorized spec-001 interview is complete. Do not start an interview for
another specification without express user approval. An answer for spec-001 does
not approve later specifications. This split does not authorize implementation.

## Slice order

Each slice includes the interface, logic and storage necessary for its outcome.
Dependencies identify earlier outcomes, not separate technical layers. Test each
slice through its user flow as well as its pure logic.

| Specification                           | User outcome                                           | Depends on                    | Interview      |
| --------------------------------------- | ------------------------------------------------------ | ----------------------------- | -------------- |
| [001](spec-001-select-folders.md)       | Select folders and enter the library                   | M0 folder and format contract | Complete       |
| [002](spec-002-find-a-sample.md)        | Find, tag and audition a source sample                 | 001                           | Not authorized |
| [003](spec-003-use-compatible-audio.md) | Make compatible audio ready for arrangement            | 002, M1 analysis evidence     | Not authorized |
| [004](spec-004-prepare-a-sample.md)     | Prepare a sample at the supported tempo and key        | 003, M1 conversion evidence   | Not authorized |
| [005](spec-005-review-a-sample.md)      | Resolve an uncertain sample or select a usable section | 003, 004                      | Not authorized |
| [006](spec-006-arrange-and-play.md)     | Place ready clips and play a short arrangement         | 003, M1 playback evidence     | Not authorized |
| [007](spec-007-edit-sections.md)        | Move, copy, repeat and remove song sections            | 006                           | Not authorized |
| [008](spec-008-mix-tracks.md)           | Adjust and hear a basic mix                            | 006                           | Not authorized |
| [009](spec-009-save-and-reopen.md)      | Save a project and reopen available clips              | 006                           | Not authorized |
| [010](spec-010-recover-work.md)         | Recover unsaved arrangement work                       | 009                           | Not authorized |
| [011](spec-011-render-song.md)          | Render the mix to a selected folder                    | 008, 009                      | Not authorized |
| [012](spec-012-change-appearance.md)    | Change skin without changing the music                 | 002, 006                      | Not authorized |

The order is a dependency map. It does not permit a later interview. Slices 004
and 005 can follow the initial arrangement slice once its inputs are ready.
Slice 012 starts from the six-skin prototype in M1.

## Rules inherited by every slice

- Keep the product at 180 BPM and C minor. Apply all approved sample classes.
- Accept WAV samples only. Export supports WAV and MP3. MP3 is not a sample
  format.
- Supply no samples or demo songs. OG project import is excluded permanently.
  Recording, synthesis and automation are outside the first release.
- Use the selected sample folder for all persistent library audio. Never delete
  or change existing audio, including partial files and files made by the app.
- Add new audio only at new paths. Manifests can change or be deleted. Neither
  operation gives permission to change audio files.
- Keep settings and metadata-only recovery in the selected Documents subfolder.
  Browser persistence contains folder-access references only.
- Project files contain arrangement data and sample paths, with no audio. Each
  rendered song requires a user-selected destination folder.
- Entry requires a valid sample folder and a writable settings folder. Missing
  individual project samples use the approved red bubbles after folder setup
  succeeds.
- Support desktop keyboard and pointer use. Official browser support is limited
  to Chromium. Missing capabilities must cause controlled states, not errors.
- Use tooltips as the only help. Give controls accessible names and focus
  states. Errors, progress and required status messages are functional
  information.
- Apply accessibility to each slice. Do not defer keyboard use to slice 012.
- Use the required typed stack and six reference skins. The plan and private
  technology record give their implementation details.

## Evidence and acceptance

Acceptance IDs use the form `S001-AC01`. Keep each ID with its owning slice. The
checks describe future evidence. No application check has run.

M0 defines the corpus and acceptance criteria for product-owner approval. M1
supplies measurements before the full workspace implementation. The split does
not bypass either stage. Browser versions, capacity, detector confidence and
processing tools still need their recorded evidence and decisions.

Use generated signals or material with distribution permission in public tests.
Keep private source fixtures out of the application and public test assets.
Compare file hashes when testing audio protection. Audit persistent writes for
each flow that touches storage.

Browser tests belong only in `quality:full`, and only for UI changes. Add this
gate with the first real browser suite. It must include quick checks, a build
and headless tests of that build. Documentation changes use `quality:quick` and
`git diff --check`. These checks do not prove browser or audio behavior.

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
| Project format, missing files and relinking            | 009                    |
| Recovery writes and interrupted sessions               | 010                    |
| Export destination, encoding and audio tails           | 011                    |
| Six skins, effects levels and saved appearance         | 012                    |
| Corpus, numerical criteria and tool feasibility        | M0 and M1 in the plan  |
| Combined load, production hosting and release evidence | M5 in the plan         |

Each later specification lists its open choices. These are records for a future
review, not questions for the current session.
