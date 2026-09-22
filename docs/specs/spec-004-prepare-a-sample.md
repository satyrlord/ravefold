# Spec-004: Prepare a sample

Status: Draft. No approval for an interview. Implementation has not started.

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

## Proposed behavior

Save the job in a manifest in the sample folder before processing. Show queued,
analysis, conversion, validation, ready, review, failed and cancelled states.
Use source content, region and processing parameters to prevent duplicate jobs.

Recommend the supported tempo with the smallest absolute logarithmic ratio to
the source tempo. Select 180 BPM if the ratios are equal. Keep source beat
count. Transpose minor material to C with the nearest semitone shift, subject to
validation. These selection details stay recommendations.

Use a Worker for analysis and conversion. Give playback priority for resources.
Process stereo channels together. Include processing latency, output length and
audio tails in the calculation. Change pitch and duration independently.

Validate all of the new file before you set `ready` status. An old result that
arrives after cancellation must not get `ready` status. Keep partial files after
failure or cancellation. Retry with a new path after access is available again.
Do not promise continued processing after the tab closes.

Use one writer for each output path. If that path has a file, select a different
path. Do not truncate the existing file. A failed manifest write cannot delete
audio.

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

| Choice                                     | Owner and reason                                                                              | Verification                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Processor, concurrency and resource limits | Audio developer, M1. No processing measurements exist.                                        | Worker, quality, memory and combined-load results.          |
| Target tempo and pitch controls            | Product owner, future slice review. Current rules are proposals.                              | Labeled conversions with explicit source and target values. |
| Latency and tail rules                     | Audio developer, M1, then owning slice review. Measurements of output behavior are necessary. | Impulse, sustained-tone and loop-boundary fixtures.         |

## Out of scope

No cleanup of existing audio, live insert effects or processing after the app
closes.
