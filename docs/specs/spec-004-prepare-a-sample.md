# Spec-004: Prepare a sample

Status: Draft. Interview not authorized. Implementation has not started.

## Outcome

A user starts preparation for a sample that needs a tempo or pitch change. The
interface stays usable until a validated new file is ready.

## Scope and dependencies

Requires [003](spec-003-use-compatible-audio.md) and M1 conversion evidence.
This slice includes the manifest job, background processing, progress, cancel,
retry and new-file publication. It does not add a musical instrument or effect
rack.

[PRODUCT.md](../../PRODUCT.md) owns the conversion and audio-protection rules.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

## Product rules

- Convert all unsupported rhythmic tempos to 90 or 180 BPM, including other
  multiples of 45 BPM.
- Make necessary tempo and pitch changes asynchronously before `ready` status.
- Preserve unpitched one-shots. Do not pitch-shift key-neutral loops.
- Keep major, mixed-key and uncertain material in review.
- Write new audio only inside the selected sample folder, at new paths.
- Never delete or change existing audio, including partial and unused output.

## Proposed behavior

Persist the job in a sample-folder manifest before processing. Show queued,
analysis, conversion, validation, ready, review, failed and cancelled states.
Deduplicate equivalent jobs by source content, region and processing parameters.

Recommend the supported tempo with the smallest absolute logarithmic ratio to
the source tempo. Prefer 180 BPM on a tie. Keep source beat count. Transpose
minor material toward C with the nearest semitone shift, subject to validation.
These selection details remain recommendations.

Use a Worker for analysis and conversion. Give playback resource priority.
Process stereo channels together. Account for processing latency, output length
and tails. Keep pitch and duration controls independent.

Validate the complete new file before publishing `ready`. A stale result after
cancellation must not become ready. Keep partial files after failure or cancel.
Retry with a new path after access returns. Do not promise work after tab
closure.

Use one writer for each output path. A collision must select another path, never
truncate the existing file. A failed manifest write cannot delete audio.

## Acceptance checks

| ID        | Given and action                                                | Expected result                                                       |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| S004-AC01 | Prepare labeled 45, 135 and 270 BPM loops.                      | Each output is 90 or 180 BPM with the agreed beat count.              |
| S004-AC02 | Prepare a minor phrase outside C.                               | Output meets approved pitch and duration criteria independently.      |
| S004-AC03 | Prepare a key-neutral loop.                                     | Tempo changes without an unnecessary pitch shift.                     |
| S004-AC04 | Cancel during conversion, then allow a late result.             | No cancelled output becomes ready. Existing and partial audio remain. |
| S004-AC05 | Reload after an interrupted write.                              | Recovery checks inputs and access, then uses a new output path.       |
| S004-AC06 | Retry with an existing destination and insufficient disk space. | Existing audio is unchanged. Failure is visible and recoverable.      |
| S004-AC07 | Audit writes during conversion and retry.                       | Audio stays in the sample folder. Job state uses manifests only.      |
| S004-AC08 | Convert during playback after spec-006 exists.                  | Combined workload meets approved M1 limits and listening criteria.    |

## Deferred decisions

| Choice                                     | Owner and reason                                                               | Verifier                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Processor, concurrency and resource limits | Audio developer, M1. No processing measurements exist.                         | Worker, quality, memory and combined-load results.          |
| Target tempo and pitch controls            | Product owner, future slice review. Current rules are proposals.               | Labeled conversions with explicit source and target values. |
| Latency and tail rules                     | Audio developer, M1, then owning slice review. Output needs measured behavior. | Impulse, sustained-tone and loop-boundary fixtures.         |

## Out of scope

No existing-audio cleanup, live insert effects or processing after the app
closes.
