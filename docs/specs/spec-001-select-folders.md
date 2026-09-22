# Spec-001: Main menu and tracker entry

Status: Scope expansion approved. Interview complete. Implementation is not
authorized. Technical proposals still need implementation evidence.

## Outcome

A user opens a fully styled main menu, selects a theme and completes folder
setup. They start a new project, open a project or select available recovery
work. The tracker receives the selected project only after entry checks pass.

## Scope and dependencies

This slice owns the complete interface before tracker entry. It includes the
main menu, settings, folder setup, six themes, project selection and recovery
selection. It includes loading, cancellation, failure and retry states. The main
menu is a finished product surface, not a temporary setup screen.

M0 defines the project-read contract, settings schema and validation fixtures.
Spec-001 does not depend on a later project writer or audio engine. M1 supplies
the required folder and material-rendering evidence before implementation
acceptance.

[PRODUCT.md](../../PRODUCT.md) owns the approved folder and storage rules.
[The index](spec-000-index.md) supplies the shared rules and test boundary.
Source audition and tags belong to [002](spec-002-find-a-sample.md). Manual
saving belongs to [009](spec-009-save-and-reopen.md). Recovery writes belong to
[010](spec-010-recover-work.md). Tracker appearance checks belong to
[012](spec-012-change-appearance.md).

## Product rules

- A valid sample folder has read/write access and at least one supported audio
  file. Files in subfolders count.
- Supported samples are WAV PCM16/24 or float32, with mono or stereo channels.
  MP3 and other formats do not satisfy folder validity or enter sample
  preparation.
- Entry requires both a valid sample folder and a writable settings folder.
  Preparation does not have to finish before entry.
- Users select a dedicated RaveFold folder inside Documents for settings.
- The browser stores only folder-access references. Permission still applies
  after restart. Settings values stay in the selected settings folder.
- Setup never deletes or changes audio. No sample assets ship with the app.
- Cancellation, denied access and missing capabilities leave the main menu
  usable.
- Tooltips are the only help. Setup labels and status messages remain available.
- The main menu and application-owned dialogs use the required material
  interface and all six reference skins.
- New project, Open project and available recovery copies are complete entry
  flows. Each flow obeys both folder requirements.
- Appearance settings are available before tracker entry. Theme changes keep
  selected folders and the pending project intact.

## Proposed behavior

1. Open the main menu without starting the editor or audio engine.
2. Restore saved folder references, if present.
3. Examine current permissions before reading or writing a selected folder.
4. Use an explicit user action for folder selection or another permission
   request.
5. Find a supported file in the sample folder or its subfolders.
6. Show the selected folders and their current access state.
7. Enable tracker entry only after both folder requirements pass.
8. Send the validated project selection after an explicit entry action.

Use a Documents starting location for the settings picker. This is a location
suggestion, not proof of the selected folder's absolute path. Do not infer a
machine path from a displayed folder name. Do not add a local helper.

Count a file only after its header and available data pass the selected format
checks. A filename extension alone is insufficient. Musical readiness is a
separate result owned by spec-003. A valid file that needs conversion can
satisfy folder validity without being available for arrangement.

Keep discovery responsive and cancellable. Continue catalog discovery after a
valid file permits entry. Show inaccessible child folders as incomplete results.
An inaccessible sample root cannot pass validation. A changed selection must
invalidate results still arriving from the earlier folder.

Keep sample and settings folders separate. Reject the same folder and known
ancestor relationships. Do not use an audio write to prove write access. A
manifest write can test sample-folder access without touching audio.

Remember references only after a successful selection. If browser persistence is
unavailable, keep this session usable and report that selection must repeat.
Clearing browser data must not remove any files in the selected folders.

## Main menu and entry controls

Use the menu to prepare a music session. Give project entry the primary visual
position. Keep folder state and appearance controls directly accessible. Use
RaveFold's own labels and layout with the reference material treatment.

| Area              | Controls and result                                                                    |
| ----------------- | -------------------------------------------------------------------------------------- |
| Main menu         | New project and Open project. Show recovery selection when valid copies are available. |
| Folder setup      | Select or change each folder, examine access status and retry a failed check.          |
| Appearance        | Select any reference skin, theme mode and effects level. Apply changes immediately.    |
| Project selection | Show the selected project and validation state. Cancel or replace a pending selection. |
| Entry status      | Show the unmet condition and the controls that can resolve it.                         |

Folder selection alone does not enter the tracker. New project requests an empty
arrangement. Open project selects and validates a project file. Recovery
selection validates a metadata-only copy from the settings folder. Cancelled or
invalid input must not replace the last valid pending selection.

Project selection can occur while folder setup is incomplete. Keep the pending
selection in memory. Recheck both folders before entry. Do not mount the tracker
or start an audio engine while the user is still in the menu.

Do not reproduce the demo's documentation page, component gallery or developer
controls. Do not add accounts, sample downloads, help pages, tutorials or
decorative audio playback. All visible menu actions must work.

## Complete appearance support

Use the six definitions in the
[private reference](../research/local-research.md#binding-technology-requirements).
Match their material behavior, background, surface edges, depth, color and
motion. Use the actual material renderer where supported. A color change alone
does not satisfy reference fidelity.

Style the main menu, setup, appearance controls, dialogs, statuses and tooltips
as one interface. Use themed semantic controls with visible focus and selected
states. Operating system file pickers keep their native appearance. Keep text
readable over material surfaces and dialog backgrounds.

Build one typed skin registry from fixed defaults and each reference patch. Do
not retain values from the previous skin. Keep layout and control meanings
stable. Use a shared renderer where practical. Spec-012 consumes this system
instead of supplying it for the first time.

These defaults and controls are explicit implementation proposals:

- Start with Reference 2 when no saved preference is available.
- Offer light, dark and system theme modes within the six-skin system.
- Offer Full, Reduced and Static effects for every skin.
- Start in Static for system reduced motion, without a saved explicit override.
- Use CSS surfaces without a running material renderer in Static mode.
- Use the themed static fallback if renderer capability is absent or lost.

Skin, theme mode and effects level are separate settings. Full uses the selected
reference effects. Reduced lowers motion without promising zero animation.
Static stops material animation. The fallback keeps the selected colors and
usable controls.

Appearance controls work before folder access. Keep those changes in session
memory only. After settings access returns, load saved values for untouched
fields. A newer explicit session choice takes precedence for that field. Save
the merged choices only in the selected settings folder.

Show unsaved state after a failed settings write. Preserve the last valid file.
For corrupt settings, use defaults and show a recoverable status without
automatic file replacement. Theme changes must not restart discovery or lose
dialog focus. Never persist settings values in browser storage.

## Project-read and entry contract

M0 defines a versioned metadata-only project schema with generated fixtures.
Spec-001 owns read validation and the entry contract. Later writers use the same
contract. Functional Open and recovery selection must not wait for spec-009 or
spec-010 implementation.

The entry result contains the mode, validated project metadata, folder access
references and unresolved sample references. Modes are new, open and recover.
Use paths relative to the selected sample folder. Reject embedded audio, paths
outside that folder and unsupported schema versions. Do not read audio from
arbitrary project paths.

Missing individual samples do not invalidate an otherwise valid project. Keep
their paths, tracks, positions and durations in the entry result. Spec-009 adds
red tracker bubbles and confirms the save/reopen result. An unavailable sample
root still prevents entry.

Read recovery choices after settings access succeeds. Show validated copies
without automatic restoration. Selection must not delete copies, write projects,
render audio or start playback. Empty recovery results leave New project and
Open project available.

Spec-001 owns menu transitions and cancellation before entry. Spec-009 owns
unsaved-work decisions when leaving or replacing an active tracker project.
Spec-010 owns recovery generation, retention and concurrent writes. Neither is a
prerequisite for entry tests with generated project and recovery fixtures.

## Menu states and accessibility

| State                       | Required result                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------- |
| First visit                 | Fully styled menu and all themes. No tracker before folder setup.                       |
| Returning visit             | Restore permitted references and available settings. Wait for an explicit entry action. |
| Discovery or validation     | Show progress and permit cancellation. Ignore results from an older request.            |
| Folder unavailable          | Keep retry and selection controls usable. Do not bypass either folder requirement.      |
| Invalid project or recovery | Show the reason. Keep the prior valid selection and files unchanged.                    |
| Settings unavailable        | Keep appearance choices in memory. Block entry until writable settings access returns.  |
| Renderer unavailable        | Use the themed static interface with the same functional controls.                      |
| Ready                       | Recheck access and transfer the selected project once, without playback.                |

Use keyboard access throughout. Dialogs must manage focus and return it to their
opening control. Tooltips work on hover and focus without replacing labels. At
200% zoom, keep entry and correction controls reachable. Small viewports can
scroll without hiding the action that resolves a blocked state.

## Acceptance checks

| ID        | Given and action                                                                           | Expected result                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| S001-AC01 | Start with no saved references.                                                            | Main menu and setup are usable. The main view is closed.                                                          |
| S001-AC02 | Select an empty or read-only sample folder.                                                | Entry stays disabled with a specific status. No audio is changed.                                                 |
| S001-AC03 | Select a writable folder with valid audio in a subfolder.                                  | Sample-folder validity passes. Entry still requires a writable settings folder.                                   |
| S001-AC04 | Select corrupt files with supported extensions only.                                       | They do not satisfy validity. Setup stays usable.                                                                 |
| S001-AC05 | Cancel selection or deny permission.                                                       | The app stays usable without an uncaught error or hidden fallback storage.                                        |
| S001-AC06 | Reload with saved references and then revoke access.                                       | Current permissions control entry. A stale reference cannot grant access.                                         |
| S001-AC07 | Remove folder-picker capability.                                                           | A capability status appears. No editor starts and no browser-related failure occurs.                              |
| S001-AC08 | Inspect writes after setup and reload.                                                     | Browser storage contains references only. No audio or settings values are present there.                          |
| S001-AC09 | Change the folder while discovery is active.                                               | Late results cannot replace the new selection or enable entry incorrectly.                                        |
| S001-AC10 | Compare audio hashes before and after setup.                                               | No existing audio is missing or changed.                                                                          |
| S001-AC11 | Clear browser storage, then select the folders again.                                      | Folder files remain intact and access can be restored.                                                            |
| S001-AC12 | Use setup with a keyboard and pointer.                                                     | Selection, retry and entry are usable with labeled controls and visible focus.                                    |
| S001-AC13 | Select valid samples, then cancel or deny settings-folder access.                          | Entry stays disabled. Setup remains usable without a temporary storage mode.                                      |
| S001-AC14 | Select a valid sample folder and a writable settings folder.                               | Entry becomes available before musical preparation finishes.                                                      |
| S001-AC15 | Select folders containing supported WAV variants, MP3 only, or another unsupported format. | Only validated supported WAV files satisfy folder validity. MP3 and other formats never enter sample preparation. |

### Main menu and appearance checks

| ID        | Given and action                                                      | Expected result                                                                                                  |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| S001-AC16 | Open the menu without folder access and select all six skins.         | Complete menu surfaces and dialogs use each reference style. Entry remains gated.                                |
| S001-AC17 | Change skin, theme mode and effects with a dialog open.               | Controls, focus, folder state and pending selection remain intact.                                               |
| S001-AC18 | Change appearance before access, then load saved settings.            | Explicit session choices win for changed fields. Other fields use saved values. No browser settings are written. |
| S001-AC19 | Save appearance, close the session and restore access.                | Choices return from the settings folder. Failed writes remain visibly unsaved.                                   |
| S001-AC20 | Load corrupt settings or revoke access during a write.                | Controls remain usable. The previous file is not silently replaced.                                              |
| S001-AC21 | Select Static or remove renderer capability.                          | Every skin has a usable static form without a running material renderer.                                         |
| S001-AC22 | Start with reduced motion and no explicit override.                   | The proposed Static default applies before animated material appears.                                            |
| S001-AC23 | Use New project after both folder checks pass.                        | One validated empty-project entry result is emitted without playback.                                            |
| S001-AC24 | Open valid, corrupt, unsupported-version and embedded-audio fixtures. | Valid metadata can enter. Invalid input preserves the prior pending selection.                                   |
| S001-AC25 | Open a valid project with missing sample paths.                       | Entry retains those paths and clip positions. Missing individual files do not block it.                          |
| S001-AC26 | Select recovery, then cancel or accept.                               | Cancellation changes no files. Acceptance transfers valid metadata without writes or playback.                   |
| S001-AC27 | Revoke either folder grant immediately before entry.                  | No tracker entry occurs. Selection remains available for retry.                                                  |
| S001-AC28 | Operate each menu and dialog at 200% zoom with a keyboard.            | Actions, labels, status, tooltips and focus remain reachable in every skin.                                      |
| S001-AC29 | Complete every entry mode in the production build.                    | All visible actions work. Theme state reaches the tracker without a reset.                                       |

Use filesystem fixtures and permission-state tests. Do tests of the real picker
integration on the supported production build through the full gate. A simulated
folder adapter alone does not prove permission behavior. Before the tracker
exists, verify entry results through a maintained integration test interface.
Spec-006 later confirms the tracker transition with the same result.

Compare screenshots of menu, setup and dialogs with the fixed reference
definitions in all six skins. Include static fallback and keyboard states. M1
measures material workload and folder access on the production build. No such
screenshots, browser results or performance measurements exist yet.

## Interview decisions

| ID       | Decision                                     | Decision status                                                         | Verifier                              |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| S001-Q01 | Resolved: settings-folder entry requirement. | Approved: require both folders before entry.                            | S001-AC13 and S001-AC14.              |
| S001-Q02 | Resolved: initial sample formats.            | Approved: WAV PCM16/24 and float32, mono or stereo. MP3 is export-only. | S001-AC15 and M0/M1 decoder evidence. |

The scope expansion also has explicit approval: New project, Open project,
recovery selection, folder settings and all six themes before tracker entry.
Menu appearance ownership moves from spec-012 into this specification.

The interview branches are resolved. Detector choice, confidence and musical
conversion are outside this slice. The developer records folder API and format
evidence before implementation acceptance. Browser-version support still follows
the M1 decision process.

## Out of scope

No tracker editing, sample audition, conversion, manual project saving, recovery
generation or song rendering. Project and recovery selection before entry are in
scope. No later specification interview is part of this session.
