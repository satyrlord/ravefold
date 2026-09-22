# Spec 009: Save and reopen an arrangement

Status: Draft. Interview: Not authorized.

## Outcome

The user manually saves an arrangement and opens it again. Missing samples keep
their references and positions while available samples remain usable.

## Scope and dependencies

This slice depends on `spec-006`. It saves every implemented arrangement and
mixer value. Repeat its checks when `spec-007` or `spec-008` adds state.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these approved rules:

- Project files contain arrangement data and sample paths, with no audio.
- Normal project saving is manual.
- Projects with missing sample paths load with their available samples.
- A red bubble marks each missing sample at its position in the tracker view.
- Saving again keeps missing paths and clip positions.
- A valid sample folder is necessary before the main view can start.
- RaveFold does not import OG projects, including in future releases.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals.

- Use a versioned `.ravefold` JSON file with stable project, track and clip IDs.
- Let the user select the main project file for manual saving.
- Store sample paths relative to the selected sample folder.
- Reject references that escape that folder. Reject embedded audio.
- Validate project documents before replacing the current project state.
- Give each missing-sample bubble a text label that identifies the sample.
- Keep missing clips' track, duration and original reference.
- Keep skin selection outside musical project state.
- Offer file relinking within the selected sample folder.
- Define unsaved-project handling before adding New project or replacement
  loads.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S009-AC01:** Given an arrangement, save and reopen it in a clean browser
  profile. After folder selection, all implemented project values match the
  saved values.
- **S009-AC02:** Examine a saved project file and browser persistence. The file
  contains no audio. Browser persistence contains only folder references.
- **S009-AC03:** Given one missing sample, open an otherwise valid project.
  Available clips load. A labeled red bubble marks the missing clip's position.
- **S009-AC04:** Save and reopen the project with a missing sample. Its original
  path, track, position and duration remain intact.
- **S009-AC05:** Given an embedded-audio or escaping-path fixture, open the
  file. Validation rejects the unsafe content without replacing the current
  project.
- **S009-AC06:** Given denied access or a failed manual write, save the project.
  The application reports the failure and does not report a successful save.
- **S009-AC07:** If relinking is accepted, select a replacement sample. The
  reference remains inside the selected sample folder.
- **S009-AC08:** Given unavailable sample-folder access, open a project. Folder
  setup remains available. The main view stays blocked until access is valid.

## Deferred decisions

- **File format and migrations:** The developer proposes the schema and version
  rules during this slice's review. Verify round trips and incompatible files.
- **Unsaved work and failed saves:** The product owner decides replacement-load,
  New project and interrupted-write behavior. Verify each cancellation and
  failure.
- **Relinking:** The product owner decides whether to include this recommended
  command. Verify path containment and preservation of clip positions.

## Out of scope

Automatic recovery belongs to `spec-010`. Song rendering belongs to `spec-011`.
Project archives with audio and OG project import remain excluded.
