# Spec-003: Use compatible audio

Status: Draft. No approval for an interview. Implementation has not started.

## Outcome

A user selects an existing sample. The application validates it and shows if the
user can add it to an arrangement without musical conversion.

## Scope and dependencies

Necessary earlier results: [002](spec-002-find-a-sample.md) and M1 analysis
evidence. This slice gives musical classification, file validation and the
meaning of `ready`. Conversion belongs to [004](spec-004-prepare-a-sample.md).
Use [005](spec-005-review-a-sample.md) for uncertain cases.

[PRODUCT.md](../../PRODUCT.md) gives the musical rules with user approval.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

BPM means beats per minute. A one-shot is a sample for one playback. A loop is a
sample for playback again and again. A tonal sample has a musical pitch.
Conversion to the project key is not necessary for key-neutral samples. A split
stereo pair contains the left and right audio channels in two files.

The `ready` status means that a sample passed file and musical validation. A
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

## Proposed behavior

Validate source bytes, channels, duration, finite audio values and loop
boundaries. Record declared metadata, measured values and user corrections
independently. A folder name or filename alone is not evidence for tempo, key or
stereo pairing.

Give validated compatible input a manifest record that references the existing
file. Do not make an audio copy that is not necessary. A file can pass format
checks and fail musical validation. Keep confidence thresholds as proposals
until M1 evidence is available.

Show the reason when conversion or review is necessary for a sample. Do not give
unpitched one-shots a detected BPM or key. A detector can run without errors and
give an incorrect result.

Validate split stereo pairs with channel alignment and source evidence. Keep the
source files unchanged. If a combined file is necessary, use the rules for new
file paths in spec-004. Do not silently pair equal filenames.

## Acceptance checks

| ID        | Given and action                                                    | Expected result                                                                        |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| S003-AC01 | Validate labeled 90 and 180 BPM C-minor fixtures.                   | Compatible files can become ready without a speed change.                              |
| S003-AC02 | Validate natural, harmonic and melodic C-minor phrases.             | Each approved form can pass the compatibility rule.                                    |
| S003-AC03 | Validate an unpitched one-shot.                                     | Sound and duration stay unchanged. No invented tempo or key is stored.                 |
| S003-AC04 | Validate an unpitched 90 BPM drum loop.                             | It can pass without pitch shifting.                                                    |
| S003-AC05 | Validate tuned percussion, major, mixed-key and uncertain fixtures. | Tonal rules and review holds apply. None bypasses classification.                      |
| S003-AC06 | Supply truncated, corrupt or invalid-channel input.                 | Validation fails without `ready` status or changed source bytes.                       |
| S003-AC07 | Compare correct and incorrect split-stereo candidates.              | Only pairs with supporting evidence pass alignment checks.                             |
| S003-AC08 | Do tests with the labeled corpus that has approval.                 | Correct-ready, incorrect-ready, review and unusable counts are recorded independently. |

## Deferred decisions

| Choice                             | Owner and reason                                                              | Verification                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Detector and confidence thresholds | Audio developer proposes after M1. Product owner accepts against M0 criteria. | Approved labeled corpus and classification counts.            |
| Pairing and file limits            | Developer, M0/M1. Filenames and estimated limits are not sufficient evidence. | Channel fixtures, measured memory and source-pair records.    |
| Detailed status labels             | Product owner, future slice review. No review interface is approved yet.      | Keyboard and pointer flow from selected file to usable state. |

## Out of scope

No time stretching, pitch shifting, note-level mode conversion or arrangement
playback.
