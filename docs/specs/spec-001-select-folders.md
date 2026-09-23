# Spec-001: Main menu and tracker entry

Status: Implemented and accepted by the user after successful tests. The
interview is completed. Hardware measurements remain incomplete.

## Outcome

A user opens a main menu with all appearance settings. The user selects a theme
and completes folder setup. The user starts a new project, opens a project or
selects available recovery work. The tracker receives the selected project only
after entry checks pass. The tracker is the main view for arrangement editing.

## Scope and dependencies

This slice gives the full interface before tracker entry. It includes the main
menu, settings, folder setup, six themes, project selection and recovery
selection. It includes loading, cancellation, failure and retry states. The main
menu is a finished part of the product, not a temporary setup screen.

M0 gives the contract for project reading, the settings schema and validation
fixtures. Spec-001 does not depend on a subsequent project writer or audio
engine. M1 supplies the necessary evidence for folders and material rendering
before implementation acceptance.

[The file contracts](spec-001-contracts.md) give the implemented schemas and
entry result. This slice uses generated metadata and WAV fixtures. Subsequent
slices give audio classification, conversion and playback criteria.

[PRODUCT.md](../../PRODUCT.md) gives the folder and storage rules with user
approval. [The index](spec-000-index.md) supplies the shared rules and test
boundary. Source audition and tags belong to [002](spec-002-find-a-sample.md).
Manual saving belongs to [009](spec-009-save-and-reopen.md). Recovery writes
belong to [010](spec-010-recover-work.md). Tracker appearance checks belong to
[012](spec-012-change-appearance.md).

## Product rules

- A valid sample folder has read/write access and at least one supported audio
  file. Files in subfolders count.
- Supported samples are WAV PCM16/24 or float32, with mono or stereo channels.
  MP3 and other formats do not satisfy folder validity or enter sample
  preparation.
- A valid sample folder and a writable settings folder are necessary for entry.
  Preparation does not have to finish before entry.
- Users select a dedicated RaveFold folder in Documents for settings.
- The browser stores only folder-access references. Permission applies after the
  application starts again. Settings values stay in the selected settings
  folder.
- Setup does not delete or change audio. The app includes no bundled samples.
- Cancellation, denied access and missing capabilities leave the main menu
  usable.
- Tooltips are the only help. Setup labels and status messages stay available.
- The main menu and application-owned dialogs use the necessary material
  interface and all six reference skins.
- New project, Open project and available recovery copies have full entry flows.
  Each flow obeys the two folder requirements.
- Appearance settings are available before tracker entry. Theme changes keep
  selected folders and the pending project unchanged.

PCM means pulse-code modulation, a method of digital audio encoding. PCM16/24
uses 16-bit or 24-bit integer values. Float32 uses 32-bit floating-point values.
A schema gives the necessary structure of data.

A skin is a set of appearance settings. A material renderer draws surfaces with
effects such as light, depth and transparency. A registry contains the named
skin definitions. A fallback supplies a different usable interface when the
usual renderer is unavailable.

## Proposed behavior

1. Open the main menu without starting the editor or audio engine.
2. Load saved folder references, if available.
3. Examine current permissions before you read or write a selected folder.
4. Use an explicit user action for folder selection or a new permission request.
5. Find a supported file in the sample folder or its subfolders.
6. Show the selected folders and their current access state.
7. Let the user enter the tracker only after the two folder requirements pass.
8. Send the validated project selection after an explicit entry action.

Use Documents as the starting location for the settings picker. This is a
location suggestion, not proof of the selected folder's absolute path. Do not
infer a machine path from a displayed folder name. The browser uses its native
folder picker.

Count a file only after its header and available data pass the selected format
checks. A filename extension alone is not sufficient. Spec-003 gives musical
readiness as a different result. A valid file can satisfy folder validity when
conversion is necessary before arrangement use.

Keep discovery responsive. Let the user cancel discovery. Continue catalog
discovery after a valid file makes entry possible. Show inaccessible child
folders as incomplete results. An inaccessible sample root cannot pass
validation. When the selection changes, ignore results from the earlier folder.

Keep sample and settings folders different. Reject the same folder for the two
uses. Reject a folder that is known to contain the other folder. Do not use an
audio write to prove write access. A manifest write can show access without
changing audio in the sample folder.

Save references only after a successful selection. If browser persistence is
unavailable, keep this session usable. Tell the user to select the folders
again. Clearing browser data must not remove any files in the selected folders.

An embedded host can deny file-system access after folder selection. Report that
host limit when the permission result is denied. Keep entry blocked and keep
files unchanged. Do not bypass browser permissions. Embedded views keep their
host permission limits.

## Main menu and entry controls

Use the menu to prepare a music session. Give project entry the primary visual
position. Keep folder state and appearance controls directly accessible. Use
RaveFold's own labels and layout with the material appearance from the
reference.

| Area              | Controls and result                                                                    |
| ----------------- | -------------------------------------------------------------------------------------- |
| Main menu         | New project and Open project. Show recovery selection when valid copies are available. |
| Folder setup      | Select or change each folder. Examine access status. Retry a failed check.             |
| Appearance        | Select any reference skin, theme mode and effects level. Apply changes immediately.    |
| Project selection | Show the selected project and validation state. Cancel or replace a pending selection. |
| Entry status      | Show the unmet condition and the controls that can resolve it.                         |

Folder selection alone does not open the tracker. New project requests an empty
arrangement. Open project selects and validates a project file. Recovery
selection validates a copy with metadata only from the settings folder.
Cancelled or invalid input must not replace the last valid pending selection.

Project selection can occur while folder setup is incomplete. Keep the pending
selection in memory. Validate the two folders again before entry. Do not mount
the tracker or start an audio engine while the user is in the menu.

Do not copy the demo's documentation page, component gallery or developer
controls. Do not add accounts, help pages, tutorials or decorative audio
playback. [Spec-013](spec-013-import-og-archive.md) owns the OG archive action.
All menu actions that the user can see must operate.

## Full appearance support

Use the six definitions in the
[private reference](../research/local-research.md#binding-technology-requirements).
Make the material behavior, background, surface edges, depth, color and motion
agree with those definitions. Use the actual material renderer where supported.
A color change alone does not agree with the reference.

Style the main menu, setup, appearance controls, dialogs, statuses and tooltips
as one interface. Use controls with the selected theme and correct semantic
meaning. Show focus and selected states. Operating system file pickers keep
their native appearance. Keep text readable on material surfaces and dialog
backgrounds.

Make one typed skin registry from fixed defaults and each reference patch. Do
not keep values from the previous skin. Keep layout and control meanings stable.
Use a shared renderer where practical. Spec-012 uses this system instead of
supplying it for the first time.

These defaults and controls are explicit implementation proposals:

- Start with Entropy when no saved preference is available.
- Give light, dark and system theme modes in the six-skin system.
- Give Full, Reduced and Static effects for each skin.
- Start in Static if the system requests reduced motion and no saved explicit
  setting overrides it.
- Use CSS surfaces without a running material renderer in Static mode.
- Use the themed static fallback if renderer capability is absent or lost.

Skin, theme mode and effects level are different settings. Full uses the
selected reference effects. Reduced lowers motion without promising zero
animation. Static stops material animation. The fallback keeps the selected
colors and usable controls.

Appearance controls operate before folder access. Keep those changes in session
memory only. After settings access is available again, load saved values for
fields that did not change. A newer explicit choice in the session overrides the
saved value for that field. Save the merged choices only in the selected
settings folder.

Show unsaved state after a failed settings write. Keep the last valid file. For
corrupt settings, use defaults. Show a status that lets the user recover without
automatic file replacement. Theme changes must not restart discovery or remove
dialog focus. Do not save settings values in browser storage.

## Project-read and entry contract

M0 gives a versioned project schema with metadata only and generated fixtures.
Spec-001 gives read validation and the entry contract. Subsequent writers use
the same contract. Open project and recovery selection must operate without
waiting for spec-009 or spec-010 implementation.

The entry result contains the mode, validated project metadata, folder access
references and unresolved sample references. Modes are new, open and recover.
Use paths relative to the selected sample folder. Reject embedded audio, paths
that are not in that folder and unsupported schema versions. Do not read audio
from project paths without validation.

Missing individual samples do not make an otherwise valid project invalid. Keep
their paths, tracks, positions and durations in the entry result. Spec-009 adds
red tracker bubbles and confirms the save/reopen result. An unavailable sample
root folder prevents entry.

Read recovery choices after settings access succeeds. Show validated copies
without automatic recovery. Selection must not delete copies, write projects,
render audio or start playback. Empty recovery results leave New project and
Open project available.

Spec-001 gives menu transitions and cancellation before entry. Spec-009 gives
decisions about unsaved work when the user leaves or replaces an active tracker
project. Spec-010 gives rules to make and keep recovery files and control
concurrent writes. These specifications are not necessary for entry tests with
generated project and recovery fixtures.

## Menu states and accessibility

| State                       | Necessary result                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| First visit                 | Menu with all appearance settings and all themes. No tracker before folder setup.                   |
| Returning visit             | Load permitted references and available settings. Wait for an explicit entry action.                |
| Discovery or validation     | Show progress. Let the user cancel. Ignore results from an older request.                           |
| Folder unavailable          | Keep retry and selection controls usable. Do not bypass either folder requirement.                  |
| Invalid project or recovery | Show the reason. Keep the prior valid selection and files unchanged.                                |
| Settings unavailable        | Keep appearance choices in memory. Prevent entry until writable settings access is available again. |
| Renderer unavailable        | Use the themed static interface with the same functional controls.                                  |
| Ready                       | Validate access again. Send the selected project one time, without playback.                        |

Use keyboard access for all controls. Dialogs must manage focus and put it back
on their opening control. Tooltips show on hover and focus without replacement
of labels. At 200% zoom, keep entry and correction controls reachable. Small
viewports can scroll without hiding the action that corrects a blocked state.

Show only one tooltip at a time. A pointer click must not keep a tooltip open.
Close a pointer tooltip after the pointer leaves the control and tooltip. Keep
keyboard tooltips until focus moves or the user presses Escape. Place each
tooltip above dialog clipping and inside the visible viewport.

## Acceptance checks

| ID        | Given and action                                                                               | Expected result                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| S001-AC01 | Start with no saved references.                                                                | Main menu and setup are usable. The main view is closed.                                                           |
| S001-AC02 | Select an empty or read-only sample folder.                                                    | Entry stays disabled with a status for the error. No audio is changed.                                             |
| S001-AC03 | Select a writable folder with valid audio in a subfolder.                                      | Sample-folder validity passes. A writable settings folder is necessary for entry.                                  |
| S001-AC04 | Select corrupt files with supported extensions only.                                           | They do not satisfy validity. Setup stays usable.                                                                  |
| S001-AC05 | Cancel selection or deny permission.                                                           | The app stays usable without an uncaught error or hidden fallback storage.                                         |
| S001-AC06 | Reload with saved references. Then revoke access.                                              | Current permissions control entry. A stale reference cannot grant access.                                          |
| S001-AC07 | Remove folder-picker capability.                                                               | The interface shows capability status. No editor starts and no browser-related failure occurs.                     |
| S001-AC08 | Examine writes after setup and reload.                                                         | Browser storage contains references only. No audio or settings values are present there.                           |
| S001-AC09 | Change the folder while discovery is active.                                                   | Late results cannot replace the new selection or enable entry incorrectly.                                         |
| S001-AC10 | Compare audio hashes before and after setup.                                                   | No existing audio is missing or changed.                                                                           |
| S001-AC11 | Clear browser storage. Then select the folders again.                                          | Folder files stay unchanged and access can be given again.                                                         |
| S001-AC12 | Use setup with a keyboard and pointer.                                                         | Selection, retry and entry are usable with labeled controls and focus that the user can see.                       |
| S001-AC13 | Select valid samples. Then cancel or deny access to the settings folder.                       | Entry stays disabled. Setup stays usable without a temporary storage mode.                                         |
| S001-AC14 | Select a valid sample folder and a writable settings folder.                                   | Entry becomes available before musical preparation finishes.                                                       |
| S001-AC15 | Select folders containing supported WAV variants, MP3 only, or a different unsupported format. | Only validated supported WAV files satisfy folder validity. MP3 and other formats do not enter sample preparation. |

### Main menu and appearance checks

| ID        | Given and action                                                      | Expected result                                                                                                                         |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| S001-AC16 | Open the menu without folder access. Select all six skins.            | All menu surfaces and dialogs use each reference style. Folder requirements continue to prevent entry.                                  |
| S001-AC17 | Change skin, theme mode and effects with a dialog open.               | Controls, focus, folder state and pending selection stay unchanged.                                                                     |
| S001-AC18 | Change appearance before access. Then load saved settings.            | The application uses explicit session choices for changed fields. Other fields use saved values. No browser settings are written.       |
| S001-AC19 | Save appearance. Close the session. Give access again.                | The application loads choices from the settings folder. The interface shows writes that were not saved.                                 |
| S001-AC20 | Load corrupt settings or revoke access during a write.                | Controls stay usable. The previous file is not silently replaced.                                                                       |
| S001-AC21 | Select Static or remove renderer capability.                          | Each skin has a usable static form without a running material renderer.                                                                 |
| S001-AC22 | Start with reduced motion and no explicit override.                   | The proposed Static default applies before animated material shows.                                                                     |
| S001-AC23 | Use New project after the two folder checks pass.                     | The menu sends one validated entry result with an empty project and no playback.                                                        |
| S001-AC24 | Open valid, corrupt, unsupported-version and embedded-audio fixtures. | Valid metadata can enter. Invalid input keeps the prior pending selection.                                                              |
| S001-AC25 | Open a valid project with missing sample paths.                       | Entry keeps those paths and clip positions. Missing individual files do not block it.                                                   |
| S001-AC26 | Select recovery. Then cancel or accept.                               | Cancellation changes no files. Acceptance transfers valid metadata without writes or playback.                                          |
| S001-AC27 | Revoke either folder grant immediately before entry.                  | No tracker entry occurs. Selection stays available for retry.                                                                           |
| S001-AC28 | Operate each menu and dialog at 200% zoom with a keyboard.            | Actions, labels, status, tooltips and focus stay reachable in each skin.                                                                |
| S001-AC29 | Complete each entry mode in the production build.                     | All actions that the user can see operate. The entry result keeps the selected appearance. Spec-006 includes tests of tracker transfer. |

Use filesystem fixtures and permission-state tests. Do tests of the real picker
integration on the supported production build through the full gate. A simulated
folder adapter alone does not prove permission behavior. Before the tracker
exists, do checks of entry results through a maintained integration test
interface. Spec-006 subsequently confirms the tracker transition with the same
result.

Compare screenshots of menu, setup and dialogs with the fixed reference
definitions in all six skins. Include static fallback and keyboard states. M1
measures material workload and folder access on the production build. Record
these screenshots, browser results and performance measurements before
acceptance.

### Implementation evidence

On 2026-09-22, `quality:full` passed 107 unit tests and 38 headless browser
tests. One POSIX-only unit test was skipped on Windows. The gate also passed
strict compiler checks, document checks and the production build. Independent
source and visual reviews are complete. The visual review result is `ship` for
the menu scope. Build checks found no private path values or audio assets.

The application uses the file contracts linked above. The menu transfers one
checked entry result through its callback. Spec-002 supplies the tracker view.
Spec-006 will supply arrangement edits and playback.

The following tests use generated data:

| Subject                                        | Automated evidence                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| WAV data and file protection                   | `tests/wav.test.ts` and `tests/storage.test.ts`                              |
| Project and settings schemas                   | `tests/project.test.ts` and `tests/settings.test.ts`                         |
| Cancelled and superseded requests              | `tests/menu-controller.test.ts`                                              |
| Six fixed presets                              | `tests/skins.test.ts`                                                        |
| Entry, recovery, failed writes and permissions | `tests/browser/storage-flows.spec.ts`                                        |
| Native handle storage and reload               | `tests/browser/persistence.spec.ts`                                          |
| Native picker cancellation                     | `tests/browser/native-picker.spec.ts`                                        |
| Tooltip dismissal and viewport limits          | `tests/browser/tooltips.spec.ts`                                             |
| Embedded permission denial and file protection | `tests/browser/embedded-permissions.spec.ts`                                 |
| Appearance and keyboard access                 | `tests/browser/appearance.spec.ts` and `tests/browser/accessibility.spec.ts` |

The handle persistence test uses browser-owned fixture folders. It proves native
handle cloning and restoration. It does not prove native selection or disk
permission prompts. Headless native pickers cancel without a selection.

The user reported successful tests and accepted this slice. This acceptance does
not supply individual results for folder selection or permission revocation. The
supported browser version range still needs evidence. Compact viewport checks
test the layout size at 200% zoom, not the browser zoom control. Hardware
performance and combined audio work remain M1 tasks.

Chromium checks include Full, Reduced and Static effects. On 2026-09-23, the
user excluded other browser engines from support and tests. Earlier checks in
another engine are historical evidence only. Early headless runs had long
initial shader startup and input delays. Real hardware startup performance still
needs a check.

Application dialogs use native modal focus and themed CSS surfaces. They share
the selected colors and controls. They do not start another material renderer.
The plan permits this treatment until a second rendering pass has measurements.

## Interview decisions

| ID       | Decision                                     | Decision status                                                         | Verification                          |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| S001-Q01 | Resolved: settings-folder entry requirement. | Approved: the two folders are necessary before entry.                   | S001-AC13 and S001-AC14.              |
| S001-Q02 | Resolved: initial sample formats.            | Approved: WAV PCM16/24 and float32, mono or stereo. MP3 is export-only. | S001-AC15 and M0/M1 decoder evidence. |

The scope expansion also has explicit approval: New project, Open project,
recovery selection, folder settings and all six themes before tracker entry.
Menu appearance ownership moves from spec-012 into this specification.

The interview branches are resolved. This slice does not include detector
choice, confidence or musical conversion. The developer records folder API and
format evidence before implementation acceptance. Browser-version support
follows the M1 decision process.

## Out of scope

No tracker editing, sample audition, general sample preparation, manual project
saving, recovery generation or song rendering. Spec-013 owns PXD conversion for
archive import. Project and recovery selection before entry are in scope.
