# Spec-005: Review an uncertain sample

Status: Draft. Interview not authorized. Implementation has not started.

## Outcome

A user sees why a sample is held for review. They correct source information or
select a compatible section, then submit that input for validation again.

## Scope and dependencies

Requires [003](spec-003-use-compatible-audio.md) and
[004](spec-004-prepare-a-sample.md). This slice connects source audition, review
fields, region selection and preparation results.

[PRODUCT.md](../../PRODUCT.md) owns compatibility and review requirements.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

## Product rules

- Uncertain key results stay in review.
- Major and mixed-key sources can contribute only compatible sections.
- The first release does not change individual notes to change musical mode.
- Source files remain unchanged. Prepared sections use new sample-folder files.
- Source audition is not permission to place unready material in an arrangement.

## Proposed behavior

Show measured values, their uncertainty and the reason for review. Let the user
audition the source without changing its status. Provide source BPM, tonal
class, key and region controls only where they apply.

Store corrections separately from measured and declared source values. Reanalyze
a selected region before conversion. A manual correction does not disable file
or output validation. Keep an unusable result in review with its reason.

Keep region coordinates relative to the unchanged source. A later change makes a
new preparation request. Never replace an earlier audio derivative. Show which
prepared result the current review action produced.

## Acceptance checks

| ID        | Given and action                                  | Expected result                                                                  |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| S005-AC01 | Open an uncertain sample.                         | The hold reason and source audition are available without `ready` status.        |
| S005-AC02 | Correct source BPM and submit again.              | The correction remains distinct from the detector result. Validation runs again. |
| S005-AC03 | Select a compatible section from mixed-key audio. | Only the selected, validated section can become ready.                           |
| S005-AC04 | Select an incompatible or empty region.           | It cannot become ready or overwrite a previous derivative.                       |
| S005-AC05 | Change the region while preparation is active.    | A late result cannot claim to match the new region.                              |
| S005-AC06 | Complete review using a keyboard.                 | Fields, region controls and result status are accessible.                        |
| S005-AC07 | Audit source and output files.                    | Source hashes stay unchanged. New audio stays inside the sample folder.          |

## Deferred decisions

| Choice                              | Owner and reason                                                                                   | Verifier                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Correction authority and confidence | Product owner and audio developer, future review after M1. False-ready risk needs corpus evidence. | Disputed detector cases against M0 criteria.    |
| Region controls and minimum length  | Product owner and developer, future slice review. No detailed editing interaction is approved.     | Pointer and keyboard region-selection fixtures. |

## Out of scope

No manual ready override, full waveform editor or major-to-minor note
conversion. The proposed correction policy requires review before
implementation.
