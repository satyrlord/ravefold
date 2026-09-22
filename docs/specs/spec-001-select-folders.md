# Spec-001: Select folders and enter the library

Status: Interview complete. Product choices resolved. Implementation is not
authorized. Proposed technical behavior still needs implementation evidence.

## Outcome

A user selects their sample folder and a settings folder. The application shows
the library only after the entry conditions pass. A subsequent session can use
saved folder references after a permission check.

## Scope and dependencies

This slice includes the main menu, setup window, folder discovery, entry state
and remembered folder references. It shows discovered file names without playing
or preparing audio. M0 defines validation fixtures for the approved formats.

[PRODUCT.md](../../PRODUCT.md) owns the approved folder and storage rules.
[The index](spec-000-index.md) supplies the shared rules and test boundary.
Source audition and tags belong to [002](spec-002-find-a-sample.md).

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

## Proposed behavior

1. Open the main menu without starting the editor or audio engine.
2. Restore saved folder references, if present.
3. Examine current permissions before reading or writing a selected folder.
4. Use an explicit user action for folder selection or another permission
   request.
5. Find a supported file in the sample folder or its subfolders.
6. Show the selected folders and their current access state.
7. Enable library entry only after both folder requirements pass.

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

Use filesystem fixtures and permission-state tests. Do tests of the real picker
integration on the supported production build through the full gate. A simulated
folder adapter alone does not prove permission behavior.

## Interview decisions

| ID       | Decision                                     | Decision status                                                         | Verifier                              |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| S001-Q01 | Resolved: settings-folder entry requirement. | Approved: require both folders before entry.                            | S001-AC13 and S001-AC14.              |
| S001-Q02 | Resolved: initial sample formats.            | Approved: WAV PCM16/24 and float32, mono or stereo. MP3 is export-only. | S001-AC15 and M0/M1 decoder evidence. |

Both interview branches are resolved. Detector choice, confidence and musical
conversion are outside this slice. The developer records folder API and format
evidence before implementation acceptance. Browser-version support still follows
the M1 decision process.

## Out of scope

No sample playback, conversion, clip editing, project opening or song rendering.
No later specification interview is part of this session.
