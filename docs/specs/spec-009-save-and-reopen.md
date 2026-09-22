# Spec 009: Save and reopen an arrangement

Status: Draft. Interview: No approval.

## Outcome

The user manually saves an arrangement and opens it again. Missing samples keep
their references and positions while available samples stay usable.

## Scope and dependencies

Necessary earlier result: `spec-006`. This slice saves each implemented
arrangement and mixer value. Do its checks again when `spec-007` or `spec-008`
adds state. Spec-001 gives project selection, read validation and tracker entry.
This slice uses that shared contract for manual saving, subsequent opening and
display of missing files.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these rules with user approval:

- Project files contain arrangement data and sample paths, with no audio.
- Usual project saving is manual.
- Projects with missing sample paths load with their available samples.
- A red bubble marks each missing sample at its position in the tracker view.
- Saving again keeps missing paths and clip positions.
- A valid sample folder is necessary before the main view can start.
- RaveFold does not import OG projects, including in future releases.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval.

- Use a versioned `.ravefold` JSON file with stable project, track and clip IDs.
- Let the user select the main project file for manual saving.
- Store sample paths relative to the selected sample folder.
- Reject references to files that are not in that folder. Reject embedded audio.
- Use spec-001 validation before you replace the current project state.
- Give each missing-sample bubble a text label that identifies the sample.
- Keep missing clips' track, duration and initial reference.
- Do not include skin selection in musical project state.
- Give file relinking controls for the selected sample folder.
- Give rules for unsaved projects when the user leaves or replaces an active
  tracker project. Spec-001 gives initial menu entry.

## Acceptance checks

All checks are proposals. No check has been done.

- **S009-AC01:** Save an arrangement. Open it again in a clean browser profile.
  After folder selection, all implemented project values agree with the saved
  values.
- **S009-AC02:** Examine a saved project file and browser persistence. The file
  contains no audio. Browser persistence contains only folder references.
- **S009-AC03:** Open a project with one missing sample and no other invalid
  data. Available clips load. A labeled red bubble marks the missing clip's
  position.
- **S009-AC04:** Save the project with a missing sample. Open it again. Its
  initial path, track, position and duration stay unchanged.
- **S009-AC05:** Open a fixture with embedded audio or a path that is not in the
  sample folder. Validation rejects that content without replacement of the
  current project.
- **S009-AC06:** Given denied access or a failed manual write, save the project.
  The application shows the failure and does not show a successful save.
- **S009-AC07:** If relinking is accepted, select a replacement sample. The
  reference stays in the selected sample folder.
- **S009-AC08:** Given unavailable sample-folder access, open a project. Folder
  setup stays available. The main view stays blocked until access is valid.

## Deferred decisions

- **Write format and migrations:** Use the M0 schema and spec-001 contract for
  reading. The developer proposes writer and migration rules during this slice's
  review. Do tests of saving and subsequent opening. Do tests with incompatible
  files.
- **Unsaved work and failed saves:** The product owner decides behavior for an
  active tracker's unsaved state and interrupted writes. Do tests of
  cancellation and failure. Keep responsibility for initial menu entry in
  spec-001.
- **Relinking:** The product owner decides if this recommended command will be
  included. Make sure that paths stay in the sample folder. Make sure that clip
  positions stay unchanged.

## Out of scope

Automatic recovery belongs to `spec-010`. Song rendering belongs to `spec-011`.
Project archives with audio and OG project import stay excluded.
