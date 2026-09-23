# Spec-013: Import OG archive samples

Status: Implemented and accepted by the user on 2026-09-23. Chromium checks
pass. The local Firefox runtime cannot create a test page, so the full quality
gate is not green.

## Outcome

A user starts the archive import from the main menu. The application gets PXD
files from the external OG ISO and converts them to supported WAV files. The
selected Samples folder holds the output.

PXD is the source audio format in the ISO. WAV is the supported sample format in
RaveFold. The external archive exposes the ISO files through its contents list.
The browser reads those members without storing the full ISO.

## Behavior

- Keep the import action in the menu in all six skins.
- Let the user start import before either folder is valid.
- Use the selected Samples folder when one is available.
- Ask the user to select a folder when no Samples folder is selected. Accept an
  empty folder if it is writable.
- Reject a Samples folder that overlaps the Settings folder.
- Read the ISO contents list. Get each PXD file from that list.
- Convert each PXD file in a worker. Write mono PCM16 WAV files at 44,100 Hz.
- Preserve the source folder structure in a dedicated Samples subfolder. Do not
  put source PXD files or ISO data in browser storage.
- Do not replace an existing WAV file. On retry, accept an existing file only
  when its bytes equal the new WAV result.
- Keep an empty output file after an interrupted browser write. A later run uses
  an unused name for that sample and does not change the empty file.
- Show file-count progress and a stop control. Keep completed WAV files after a
  stop or failure. A later run can use them again.
- Validate the selected Samples folder after conversion. Report success only if
  the folder is valid. Keep tracker entry closed until both folder checks pass.
- Keep the import action available after success, failure and cancellation.

The source list and file requests depend on the external archive. A failed
network request shows an error and leaves completed audio unchanged. The action
does not infer redistribution rights from archive availability.

## Checks

| ID        | Action                                             | Expected result                                           |
| --------- | -------------------------------------------------- | --------------------------------------------------------- |
| S013-AC01 | Start with no Samples folder. Select an empty one. | WAV output makes the selected folder valid.               |
| S013-AC02 | Import into a selected valid Samples folder.       | The import uses that folder and keeps existing audio.     |
| S013-AC03 | Start the import a second time.                    | Identical output files stay unchanged.                    |
| S013-AC04 | Put a different WAV at an output path.             | Import stops without replacing that file.                 |
| S013-AC05 | Stop or lose network access during import.         | Progress stops. Completed files remain. Retry is usable.  |
| S013-AC06 | Check output and entry state.                      | WAV files pass format checks. Entry still needs Settings. |

Use generated PXD fixtures in public tests. Do not add source audio or ISO data
to the repository. Run the full quality gate for the menu change.

## Implementation evidence

Strict type checks, unit tests, document checks and the production build passed.
The headless Chromium suite passed 39 tests. These tests include an empty
folder, stop and retry, existing audio protection, and native editor import.

Two Firefox fallback tests failed before the browser created a page. Playwright
reported `browserContext.newPage` with an undefined `_page`. The test runner did
not exit after these failures and was stopped. These failures do not show an
application error, but they leave cross-browser operation unverified.

Four local PXD/WAV pairs matched byte for byte. A local sweep decoded all 3,147
installed PXD files. The requested ISO has 1,279 listed PXD members. A complete
live import from that ISO was not part of the automated checks.

## User acceptance

On 2026-09-23, the user declared this slice complete.
