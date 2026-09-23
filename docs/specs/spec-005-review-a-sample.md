# Spec-005: Review an uncertain sample

Status: Draft. No approval for an interview. Implementation has not started.

## Outcome

A user sees why a sample is held for review. The user corrects source
information or selects a compatible section. The user sends that input for
validation again.

## Scope and dependencies

Necessary earlier results: [003](spec-003-use-compatible-audio.md) and
[004](spec-004-prepare-a-sample.md). This slice connects source audition, review
fields, region selection and preparation results.

[PRODUCT.md](../../PRODUCT.md) gives compatibility and review requirements.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

## Product rules

- Uncertain key results stay in review.
- Only compatible sections of major and mixed-key sources can get `ready`
  status.
- The first release does not change individual notes to change musical mode.
- Source files stay unchanged. Prepared sections use new sample-folder files.
- Source audition does not give approval to use material without `ready` status
  in an arrangement.

## Proposed behavior

Show measured values, their uncertainty and the reason for review. Let the user
hear the source without a status change. Give source BPM, tonal class, key and
region controls only where they apply.

Record corrections independently of measured and declared source values. Do an
analysis of a selected region again before conversion. A manual correction does
not disable file or output validation. Keep an unusable result in review with
its reason.

Keep region coordinates relative to the unchanged source. A subsequent change
makes a new preparation request. Do not replace an earlier audio derivative.
Show which prepared result the current review action produced.

## Acceptance checks

| ID        | Given and action                                  | Expected result                                                                                   |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S005-AC01 | Open an uncertain sample.                         | The reason for review and source audition are available without `ready` status.                   |
| S005-AC02 | Correct source BPM. Send the input again.         | The record identifies the correction independently of the detector result. Validation runs again. |
| S005-AC03 | Select a compatible section from mixed-key audio. | Only the selected, validated section can become ready.                                            |
| S005-AC04 | Select an incompatible or empty region.           | It cannot become ready or overwrite a previous derivative.                                        |
| S005-AC05 | Change the region while preparation is active.    | A late result cannot identify the new region as its input.                                        |
| S005-AC06 | Complete review using a keyboard.                 | Fields, region controls and result status are accessible.                                         |
| S005-AC07 | Examine source and output files.                  | Source hashes stay unchanged. New audio stays in the sample folder.                               |

## Deferred decisions

| Choice                              | Owner and reason                                                                                                                 | Verification                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Correction authority and confidence | Product owner and audio developer, future review after M1. The risk of incorrect `ready` status makes source evidence necessary. | Disputed detector cases in labeled source tests. |
| Region controls and minimum length  | Product owner and developer, future slice review. No detailed editing interaction is approved.                                   | Pointer and keyboard region-selection fixtures.  |

## Out of scope

No manual override of `ready` status, full waveform editor or conversion of
notes from major to minor. Review of the proposed correction policy is necessary
before implementation.
