# Spec-004: Prepare a sample

Status: Implemented. Generated acceptance checks pass. S004-AC08 waits for
spec-006. Listening review of real sources is open.

## Outcome

A user starts preparation for a sample with an incorrect tempo or pitch. The
interface stays usable until a validated new file is ready.

## Scope and dependencies

Necessary earlier results: [003](spec-003-use-compatible-audio.md) and M1
conversion evidence. This slice includes the job record, background processing,
progress, cancellation, retries and completion of new files. It does not add a
musical instrument or effect rack.

[PRODUCT.md](../../PRODUCT.md) gives the conversion and audio-protection rules.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

A Worker does tasks independently of the primary browser thread. Latency is the
time between input and output. An audio tail continues after the primary sound
ends. A derivative is a new audio file made from source audio. Transposition
moves musical pitches by the same interval. A semitone is one step in the
twelve-note musical scale.

## Product rules

- Convert all unsupported rhythmic tempos to 90 or 180 BPM, including other
  multiples of 45 BPM.
- Make necessary tempo and pitch changes asynchronously before `ready` status.
- Keep the sound and duration of unpitched one-shots unchanged. Do not
  pitch-shift key-neutral loops.
- Keep major, mixed-key and uncertain material in review.
- Write new audio only in the selected sample folder, at new paths.
- Do not delete or change existing audio, including partial and unused output.

## Implemented behavior

### Job record and states

The user starts preparation from the sample inspector. The application then
saves the job in `ravefold-preparation.manifest.json` in the sample folder. It
saves the job before processing starts. The interface shows queued, analysis,
conversion, validation, ready, review, failed and cancelled states. It also
shows progress, the plan and the output path.

The job ID is a hash of the source content, region and processing parameters. An
equal request uses the existing job, also for a copy at a different path. A
change of parameters gives a new job and a new output path.

### Plan selection

The plan uses measured tempo, beat count and key only. Declared values cannot
start a job. The target is the supported tempo with the smallest absolute
logarithmic ratio to the source tempo. Equal ratios select 180 BPM. The output
keeps the source beat count. These selection rules stay recommendations.

A minor phrase in another key moves to C by the nearest semitone shift. Equal
distances use the downward shift. Analysis identifies another minor key only
when one root establishes a complete minor form. The first and last measured
notes must also be that root. A set of pitch classes cannot separate a minor key
from its relative major. Thus, this tonic rule is necessary.

Only measured loops can get a plan. Ready samples, one-shots, major material,
mixed-key material and uncertain material cannot start a job. Key-neutral loops
always have a pitch change of zero.

Stereo channels must agree on the source key and pitch change. Conflicting
channel measurements keep the source in review.

### Processing

A Worker decodes the source and analyzes it again. The current analysis must
give the saved plan. A time-stretch kernel then changes the duration at constant
pitch. A resampler changes pitch by an exact rate ratio. A resampler calculates
audio samples at a different rate. Thus, pitch and duration change
independently.

The kernel processes stereo channels together. The adapter removes the kernel
output latency from the output. It reads each loop as a continuous signal. Thus,
the tail of the last beat continues into the first beat.

Source preview has priority. The Worker waits between processing blocks while a
preview plays or loads. One job operates at a time.

### Validation and writes

The Worker validates all of the new file before the application writes it. It
decodes the encoded bytes and analyzes them again with the job tempo. The output
must be `ready` at the target tempo. It must have the source beat count and the
exact frame count. Its measured notes must be in the transposed source notes. A
key-neutral loop must stay key-neutral. A failed check sets the review state.

Output files use 32-bit float samples. This format keeps peaks above full scale
without clipping. A peak above +12 dBFS sets the review state because it shows a
processing fault. The unit dBFS gives decibels relative to full scale.

The application writes each output to a new path under `RaveFold prepared/` in
the sample folder. It never opens a writer for an existing file. If a path has a
file, the application selects the next path number. After the write, it reads
the file and compares its hash with the validated bytes. It then saves the
output analysis and sets `ready`.

A prepared file appears in the library. The inspector can play it. A later
analysis of that file uses the job tempo only when the file hash agrees with the
job output.

The library compares the current analysis hash with the preparation source hash.
A changed source cannot keep the previous result after analysis.

### Cancellation, failure and recovery

Cancellation stops the Worker. A result that arrives after cancellation cannot
change the job. Partial files stay on disk. The job keeps their paths, and a
retry uses a new path. The user can retry failed and cancelled jobs.

An active job has a session lease that expires after 30 seconds. A lease is a
time-limited claim on a job. The session renews the lease during work. Another
session requeues a job after its lease expires. The next attempt checks folder
access and the source hash. It then uses a new output path.

A session that loses a job claim reads the current job state before it tries
another job. It waits while the other session holds the lease.

The application does not continue processing after the tab closes. It shows the
browser warning when the user closes a tab during preparation. A failed write
shows the cause and a retry control. A failed manifest write cannot delete
audio.

A manifest save failure stops the local queue and shows its cause. The user can
restore access or disk space, then recover preparation. Recovery reads the saved
manifest before it resumes work. A Worker startup failure also shows an error
and permits a retry.

The close warning includes queued jobs and the initial source read. It does not
depend on the first Worker progress message.

### Current limits

Analysis gives conversion results only for measured loops. A 180 BPM source with
an even count of eight or more beats stays in review. The spec-003 rule for 90
and 180 BPM aliases causes this result. Some loops with more than one hit in
each beat also stay in review at unsupported tempos. The review slice owns these
sources.

## Acceptance checks

| ID        | Given and action                                                      | Expected result                                                                         |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S004-AC01 | Prepare labeled 45, 135 and 270 BPM loops.                            | Each output is 90 or 180 BPM with the agreed beat count.                                |
| S004-AC02 | Prepare a minor phrase in a key other than C.                         | Output agrees with approved pitch and duration criteria independently.                  |
| S004-AC03 | Prepare a key-neutral loop.                                           | Tempo changes without a pitch shift that is not necessary.                              |
| S004-AC04 | Cancel during conversion. Then let a late result arrive.              | No cancelled output becomes ready. Existing and partial audio stay.                     |
| S004-AC05 | Reload after an interrupted write.                                    | Recovery validates inputs and access. It then uses a new output path.                   |
| S004-AC06 | Retry with an existing destination when disk space is not sufficient. | Existing audio is unchanged. The interface shows the failure and lets the user recover. |
| S004-AC07 | Examine writes during conversion and retry.                           | Audio stays in the sample folder. Job state uses manifests only.                        |
| S004-AC08 | Convert during playback after spec-006 exists.                        | The combined workload agrees with approved M1 limits and listening criteria.            |

## Deferred decisions

| Choice                            | Owner and reason                                                                                         | Verification                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Processor, concurrency and limits | Audio developer, M1. Generated-signal results exist. Memory, listening and combined-load results do not. | Listening review, memory and combined-load results.           |
| Target tempo and pitch controls   | Product owner, future slice review. Current rules are proposals.                                         | Labeled conversions with explicit source and target values.   |
| Latency and tail rules            | Audio developer, then owning slice review. Generated fixtures pass. Real-source results do not exist.    | Impulse, sustained-tone, loop-boundary and listening results. |
| Tonic rule for other minor keys   | Audio developer proposes after labeled real sources. The rule can hold compatible phrases in review.     | Correct, incorrect and review counts for each source key.     |
| Output level above full scale     | Product owner with the mixer slice. Float output keeps these peaks.                                      | Mixer headroom and export checks.                             |

## Verification record

Unit tests use generated signals. S004-AC01 prepares 45, 135 and 270 BPM loops
to 90, 180 and 180 BPM. Each output keeps eight beats and the exact frame count.
S004-AC02 prepares D minor at 90 BPM and F-sharp minor at 135 BPM. The first
sustained note is within 5 cents of C4. The frame count agrees with the target
beats. S004-AC03 prepares a 135 BPM key-neutral loop with a pitch ratio of
exactly 1.

S004-AC04 tests show that cancellation stops the work. A stale reply that
resolves later cannot set `ready`. A cancelled write keeps its empty partial
file, and a retry writes the next path. S004-AC05 tests show that a job with a
live lease stays with its session. After the lease expires, recovery requeues
the job. The next attempt uses a new path and keeps the partial file unchanged.
A changed source fails the input check. Denied access stops recovery.

S004-AC06 tests fail audio writes with a quota error. The failed job keeps the
existing destination file unchanged and shows the cause. A retry writes a new
path. S004-AC07 tests record every write. Audio writes go only to
`RaveFold prepared/`. Other writes go only to manifests and reservation
registers.

DSP tests measure these generated-signal results. Output length is exact. An
impulse moves by 1 ms or less after latency compensation. Sustained tones from
41.2 Hz to 1,760 Hz stay within 5 cents. Stereo channels keep their delay and
level ratio. Loop edges keep their level.

The headless Chromium suite tests the user flow on the production build. It
tests tempo conversion, transposition, cancellation during a write, retry and a
quota failure. It also does an automated accessibility check of the inspector.

The initial implementation run used Node.js 24.19.0 on Windows. Strict type
checks, 276 unit tests, Markdown checks, formatting and the production build
passed. The headless Chromium suite passed 61 tests. The local OG evaluation
gave the same result as spec-003 after the analysis changes. It reported 1,023
ready files, 254 review files and zero processing failures.

Review repair tests cover 8 kHz conversion and conflicting stereo keys. They
also cover concurrent job claims, failed manifest saves and late phase saves.
The concurrency fixture uses two queues in one process. It does not establish
results for separate browser tabs.

Browser regression tests cover changed source content, the close warning before
Worker progress, manifest recovery and rejected WASM startup. The close test
checks the event handler while a source read waits. It does not open the native
browser confirmation dialog. Storage failures use controlled fixtures.

The repair run used Node.js 24.19.0 on Windows. Strict type checks, 282 unit
tests, Markdown checks, formatting and the production build passed. All 65
headless Chromium tests passed. An independent code review found no blocking
issues in the seven repairs. The local OG evaluation was not repeated.

S004-AC08 is not verified. Spec-006 playback does not exist. No listening
review, memory measurement or combined-load measurement exists.

## Out of scope

No cleanup of existing audio, live insert effects or processing after the app
closes.
