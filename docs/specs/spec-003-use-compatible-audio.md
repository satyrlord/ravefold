# Spec-003: Use compatible audio

Status: Draft. Interview not authorized. Implementation has not started.

## Outcome

A user selects an existing sample. The application validates it and reports
whether it can enter an arrangement without musical conversion.

## Scope and dependencies

Requires [002](spec-002-find-a-sample.md) and M1 analysis evidence. This slice
owns musical classification, file validation and the meaning of `ready`.
Conversion belongs to [004](spec-004-prepare-a-sample.md). Uncertain cases use
[005](spec-005-review-a-sample.md).

[PRODUCT.md](../../PRODUCT.md) owns the approved musical rules.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

## Product rules

- The arrangement is 180 BPM in C minor.
- Ready rhythmic samples have a tempo of 90 or 180 BPM.
- Natural, harmonic and melodic minor are compatible forms of C minor.
- Unpitched one-shots keep their source sound and duration. They need no tempo
  or key conversion. Their placement still uses the arrangement grid.
- Unpitched drum and noise loops are key-neutral. They still need 90 or 180 BPM.
- Tuned percussion uses the tonal rules. Uncertain key results stay in review.
- Major and mixed-key sources require review. Only compatible sections can be
  ready.

## Proposed behavior

Validate source bytes, channels, duration, finite audio values and loop bounds.
Keep declared metadata, measured values and user corrections separate. A folder
or filename must not prove tempo, key or stereo pairing.

Give validated compatible input a manifest record that references the existing
file. Do not make an unnecessary audio copy. File validity alone does not imply
musical readiness. Keep confidence thresholds provisional until M1 evidence.

Show the reason when a sample needs conversion or review. Never invent a BPM or
key for unpitched one-shots. A successful detector call does not prove its
result correct.

Validate split stereo pairs with channel alignment and source evidence. Keep the
source files unchanged. If a combined file is needed, use the new-file path
rules in spec-004. Do not silently pair equal filenames.

## Acceptance checks

| ID        | Given and action                                                    | Expected result                                                                     |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| S003-AC01 | Validate labeled 90 and 180 BPM C-minor fixtures.                   | Compatible files can become ready without a speed change.                           |
| S003-AC02 | Validate natural, harmonic and melodic C-minor phrases.             | Each approved form can pass the compatibility rule.                                 |
| S003-AC03 | Validate an unpitched one-shot.                                     | Sound and duration stay unchanged. No invented tempo or key is stored.              |
| S003-AC04 | Validate an unpitched 90 BPM drum loop.                             | It can pass without pitch shifting.                                                 |
| S003-AC05 | Validate tuned percussion, major, mixed-key and uncertain fixtures. | Tonal rules and review holds apply. None bypasses classification.                   |
| S003-AC06 | Supply truncated, corrupt or invalid-channel input.                 | Validation fails without `ready` status or changed source bytes.                    |
| S003-AC07 | Compare true and false split-stereo candidates.                     | Only evidence-backed pairs pass alignment checks.                                   |
| S003-AC08 | Run the approved labeled corpus.                                    | Correct-ready, incorrect-ready, review and unusable counts are recorded separately. |

## Deferred decisions

| Choice                             | Owner and reason                                                              | Verifier                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Detector and confidence thresholds | Audio developer proposes after M1. Product owner accepts against M0 criteria. | Approved labeled corpus and classification counts.            |
| Pairing and file limits            | Developer, M0/M1. Filenames and estimated limits are insufficient evidence.   | Channel fixtures, measured memory and source-pair records.    |
| Detailed status labels             | Product owner, future slice review. No review interface is approved yet.      | Keyboard and pointer flow from selected file to usable state. |

## Out of scope

No time stretching, pitch shifting, note-level mode conversion or arrangement
playback.
