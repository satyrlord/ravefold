# Spec-003: Use compatible audio

Status: Implemented. Generated acceptance checks pass. Real-source precision
review is open.

## Outcome

A user selects an existing sample. The application validates it and shows if the
user can add it to an arrangement without musical conversion.

## Scope and dependencies

Necessary earlier result: [002](spec-002-find-a-sample.md). This slice gives
source analysis, musical classification, file validation and the meaning of
`ready`. Conversion belongs to [004](spec-004-prepare-a-sample.md). Use
[005](spec-005-review-a-sample.md) for uncertain cases.

[PRODUCT.md](../../PRODUCT.md) gives the musical rules with user approval.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

BPM means beats per minute. A one-shot is a sample for one playback. A loop is a
sample for playback again and again. A tonal sample has a musical pitch.
Conversion to the project key is not necessary for key-neutral samples. A split
stereo pair contains the left and right audio channels in two files.

The `ready` status means that a sample passed file and musical analysis. A
confidence threshold is the minimum detector confidence value for automatic
acceptance.

## Product rules

- The arrangement is 180 BPM in C minor.
- Ready rhythmic samples have a tempo of 90 or 180 BPM.
- Natural, harmonic and melodic minor are compatible forms of C minor.
- Unpitched one-shots keep their source sound and duration. Tempo or key
  conversion is not necessary. Their placement uses the arrangement grid.
- Unpitched drum and noise loops are key-neutral. Their tempo must be 90 or 180
  BPM.
- Tuned percussion uses the tonal rules. Uncertain key results stay in review.
- Review is necessary for major and mixed-key sources. Only compatible sections
  can be ready.
- Every source must pass file and musical analysis before it can be ready.
- The official OG collection declaration is source information. It cannot make
  an individual source ready without analysis.

## Implemented behavior

The application checks WAV bytes, channels, duration, finite audio values and
optional loop markers. A Worker analyzes decoded audio after file validation.
The analysis measures rhythm, pitch evidence, spectral content and one-shot
decay. The app shows a reason when a file needs conversion or review.

A sample becomes `ready` only after analysis and a successful manifest save. The
writer checks the current source hash again before it saves a result. The
manifest stores declared values, measured values and user corrections in
separate fields. No correction controls are available in this slice.

An OG source record binds a relative file path, byte count and SHA-256 hash to
the declared 180 BPM and C-minor values. Archive import creates source records
for its output. The local registration tool checks the user-vouched source
folder and creates records without changing WAV files. The application checks
the current file hash before it uses a source record.

Source-backed results still require audio checks. A source-backed loop needs a
180 BPM duration grid, measured attack timing, active audio and no strong tonal
conflict. A source-backed one-shot needs measured early attack and decay. These
results do not claim a detected source key or minor form. A one-shot gets no
invented BPM or key.

The user explicitly selects left and right mono files before a split-stereo
check. The Worker checks file identity, format, frame length, loop markers and
attack alignment. It analyzes both channels before pair readiness. The pair
manifest references both unchanged files. User selection does not prove the
historical source association or audible phase quality.

Current analysis supports source files up to 100 MiB and five minutes. Musical
analysis reviews a source above 30 seconds. Stereo analysis supports 100 MiB
across both files. These limits are technical bounds, not measured capacity
claims. Arrangement placement and audio conversion remain in later slices.

## Acceptance checks

| ID        | Given and action                                                    | Expected result                                                                                                           |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| S003-AC01 | Analyze labeled 90 and 180 BPM C-minor fixtures.                    | Compatible files can become ready after analysis without a speed change.                                                  |
| S003-AC02 | Validate natural, harmonic and melodic C-minor phrases.             | Each approved form can pass the compatibility rule.                                                                       |
| S003-AC03 | Validate an unpitched one-shot.                                     | Sound and duration stay unchanged. No invented tempo or key is stored.                                                    |
| S003-AC04 | Validate an unpitched 90 BPM drum loop.                             | It can pass without pitch shifting.                                                                                       |
| S003-AC05 | Validate tuned percussion, major, mixed-key and uncertain fixtures. | Tonal rules and review holds apply. None bypasses classification.                                                         |
| S003-AC06 | Supply truncated, corrupt or invalid-channel input.                 | Validation fails without `ready` status or changed source bytes.                                                          |
| S003-AC07 | Compare correct and incorrect split-stereo candidates.              | Only pairs with supporting evidence pass alignment checks.                                                                |
| S003-AC08 | Analyze labeled files with correct, absent and false declarations.  | Each file receives analysis before `ready`. Record correct-ready, incorrect-ready, review and unusable counts separately. |

## Deferred decisions

| Choice                        | Owner and reason                                                   | Verification                                       |
| ----------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Detector threshold changes    | Audio developer proposes after labeled source and listening tests. | Classification counts and incorrect-ready cases.   |
| Larger source and pair limits | Developer proposes after memory and time measurements.             | Browser workloads with representative large files. |
| User correction controls      | Product owner, future review slice.                                | Stored corrections and repeat analysis checks.     |

## Verification record

Generated, labeled tests cover 13 files. They report six correct-ready, zero
incorrect-ready, three review, three unusable and one conversion result. Tests
also check incompatible tempo, major and mixed-key phrases, false declarations,
short attacks, silence, invalid WAV data and split-stereo pairs.

The local OG folder has 1,277 WAV files. A source hash matched each source
record during evaluation. Analysis reported 1,023 ready files and 254 review
files, for 80.11 percent ready coverage. This result measures coverage. It does
not establish correct-ready counts for each real file without independent labels
and listening review.

The evaluator used Node.js 24.19.0 on Windows. It decoded and analyzed
438,737,268 WAV bytes in sequence. The run took 92.9 seconds and reported zero
processing failures. The headless Chromium suite passed 57 tests. Strict type
checks, 253 unit tests, Markdown checks, formatting and the production build
also passed.

## Out of scope

No time stretching, pitch shifting, note-level mode conversion or arrangement
playback.
