# Spec-005: Review an uncertain sample

Status: Implemented. Generated acceptance checks pass. The correction policy is
a proposal. Its review by the product owner and audio developer is open.

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

A region is a section of the source audio between two frame positions. A frame
is one sample position in all channels. A hypothesis is a value that analysis
compares with measurements.

## Product rules

- Uncertain key results stay in review.
- Only compatible sections of major and mixed-key sources can get `ready`
  status.
- The first release does not change individual notes to change musical mode.
- Source files stay unchanged. Prepared sections use new sample-folder files.
- Source audition does not give approval to use material without `ready` status
  in an arrangement.

## Implemented behavior

### Review information

The inspector shows a Review section for a sample without `ready` status. It
also shows this section when a saved correction exists. The section shows the
reason for review, the attack tempo estimate and the detector scores. The
interface states that detector scores are not probabilities.

The user can play the unchanged source or one section of it. Playback does not
change a status and writes no file. The waveform shows the region that the user
enters.

### Correction policy

The user can correct the source tempo, the tonal class and the source key. Each
correction is a hypothesis for analysis. A correction can select one reading
that the measurements support. It cannot change a detector limit or replace a
measurement.

- A corrected tempo of 90 or 180 BPM selects one reading when the duration fits
  both grids. Another corrected tempo must agree with the measured attacks
  within 1.5 BPM.
- A corrected minor key selects its root when the measured notes give a complete
  minor form on that root. This resolves a relative-major case of spec-004. A
  corrected major key keeps tonal material in review.
- A corrected tonal class must agree with the measured class.

A correction that does not agree with the measurements keeps the sample in
review. The result then gives the conflict. A correction does not resolve other
review reasons. For these results, the interface gives the measured reason and
states that the correction did not resolve it.

Review validation does not use the source record of spec-003. The correction is
the hypothesis under test. The tempo field is not available for measured
one-shots. The key field is not available for key-neutral material.

### Records

The analysis manifest keeps the detector result in `measured`. It keeps user
input in `corrected` and the validation result in `reviewed`. The `corrected`
record contains the tempo, key, tonal class and region. Records from spec-003
without these fields stay valid.

A new selection of the sample validates a saved correction again. This occurs
only when the source hash agrees with the record. A changed source loses the
correction. Empty input removes the correction and the review result.

A whole-source review result sets the source status. A region result never
changes the source status.

### Regions

The region uses frame coordinates of the unchanged source. The minimum length is
0.1 seconds. The analysis of a region uses only the region audio. The user
enters start and end times in seconds. The interface keeps six decimals, so the
same frames return when the user sends the input again.

Only a new file from a validated region can become ready. A region that is ready
or that needs conversion gives a preparation plan. The plan includes the region
and the correction. Thus, a change to either value gives a new job and a new
output path. Earlier output files stay unchanged.

The Worker analyzes the region again with the saved correction before
conversion. The result must give the saved plan. A ready region at its exact
length is copied without conversion. Only measured loop sections can be prepared
at this time.

Output validation does not use a corrected key. A corrected tempo that selected
a reading applies again to the output because the output has the same tempo
ambiguity. All other output checks of spec-004 apply. A section output has this
name: `<name> section <start>-<end> s <tempo> BPM.wav`. It is in the
`RaveFold prepared/` folder.

### Late results

Each review request cancels the previous request. A late analysis result cannot
change the current review or the manifest. The review section shows only the job
for the current plan. Other section jobs appear in a list with their regions. A
late job result keeps the region of its own job.

### Keyboard use

All fields are native controls with labels. The review result has a status role.
Input problems have an alert role. Controls stay available during validation.
Thus, keyboard focus stays on the control that the user operated.

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

| Choice                              | Owner and reason                                                                                                                                        | Verification                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Correction authority and confidence | Product owner and audio developer, future review after M1. The implemented policy is a proposal. The risk of incorrect `ready` status needs evidence.   | Disputed detector cases in labeled source tests. |
| Region controls and minimum length  | Product owner and developer, future slice review. Start and end times in seconds and a 0.1 second minimum are proposals. No pointer selection is given. | Pointer and keyboard region-selection fixtures.  |
| Prepared one-shot sections          | Product owner, future slice review. Only loop sections can be prepared at this time.                                                                    | Labeled one-shot section fixtures.               |

## Verification record

Unit tests use generated signals. A 90 or 180 BPM correction resolves an
ambiguous eight-note phrase. A 120 BPM correction keeps it in review. An A-minor
correction resolves a relative-major phrase to a +3 semitone plan. A major or
incomplete key keeps it in review. Tonal class conflicts keep a sample in
review.

S005-AC01 tests show the reason and section playback. No status or manifest
changes. S005-AC02 tests show `measured`, `corrected` and `reviewed` as separate
records. A later selection analyzes the saved correction again. Empty input
removes it. A corrected key gives a transposed file with measured C-minor notes.

S005-AC03 tests use four C-minor beats, then four D-major beats. The first
section becomes a new ready file with the exact source frames. The source stays
in review. A corrected 90 BPM section keeps output validation at 90 BPM.
S005-AC04 tests show that the D-major section and empty or short regions give no
job. An equal request uses the existing job and writes no audio.

S005-AC05 tests change the region during conversion. The late result keeps its
own region, and the new region has no job. A late review analysis cannot replace
a newer input. S005-AC07 tests record every write. Source hashes stay unchanged.
New audio goes only to `RaveFold prepared/`.

The headless Chromium suite does the review with the keyboard only. It prepares
a section and does an automated accessibility check of the inspector. It also
tests empty and incompatible regions and a saved tempo correction.

The implementation run used Node.js 24.19.0 on Windows. Strict type checks, 297
unit tests, Markdown checks, formatting and the production build passed. All 68
headless Chromium tests passed. The local OG evaluation gave the same result as
spec-004. It reported 1,023 ready files, 254 review files and zero processing
failures. Thus, analysis without a correction did not change.

No real source has a labeled correction or a listening review. The correction
policy has evidence from generated signals only. Pointer selection of a region
on the waveform is not available.

## Out of scope

No manual override of `ready` status, full waveform editor or conversion of
notes from major to minor.
