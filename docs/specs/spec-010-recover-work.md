# Spec 010: Recover interrupted work

Status: Draft. Interview: No approval.

## Outcome

The user can recover arrangement work after an interrupted session without
changing the manually saved project.

## Scope and dependencies

Necessary earlier result: `spec-009`. This slice adds automatic recovery copies
using the shared project contract. Spec-001 gives discovery, selection and
validation of available recovery copies before tracker entry.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these rules with user approval:

- Usual project saving is manual.
- Automatic recovery copies stay in the selected settings folder.
- Recovery copies contain arrangement data and sample paths only.
- Recovery copies contain no audio or rendered songs.
- The settings folder is a dedicated RaveFold folder in Documents.
- Browser persistence contains only folder-access references.
- Existing audio files must stay unchanged.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval.

- Keep automatic recovery writes apart from the manually saved file.
- Keep the last valid recovery copy if a new write fails.
- Show unavailable access to the settings folder and unsaved recovery state.
- Do not use a different folder or browser storage as a recovery fallback.
- Use spec-001 validation and selection to restore a recovery copy.
- Apply the same behavior for missing samples as a usual project load.
- Restore arrangement state without starting playback or a song render.
- Prevent concurrent writes to the same project or recovery destination.

## Acceptance checks

All checks are proposals. No check has been done.

- **S010-AC01:** After a project edit, cause the accepted recovery trigger. Only
  the selected settings folder receives a recovery copy.
- **S010-AC02:** Examine the recovery file and all persistent writes. The copy
  contains metadata and sample paths. The application writes no audio or
  rendered song.
- **S010-AC03:** Given an existing valid recovery copy, interrupt the next
  write. The previous valid copy stays available for recovery.
- **S010-AC04:** Given revoked settings-folder access, edit the project. The
  application shows unsaved recovery state and uses no storage fallback.
- **S010-AC05:** Use a manually saved project. Make more than one recovery copy.
  The manually saved file stays unchanged.
- **S010-AC06:** Use a valid recovery copy. Start the application again. Accept
  recovery. The arrangement loads without automatic playback or song rendering.
- **S010-AC07:** Given a recovery copy with missing samples, restore it.
  Available clips load. Red bubbles continue to identify missing paths and
  positions.
- **S010-AC08:** Try to write from two tabs with the same recovery destination.
  The accepted concurrency rule prevents conflicting writes.

## Deferred decisions

- **Recovery lifecycle:** The product owner decides which copies to keep and
  when writes occur during this slice's review. Menu selection belongs to
  spec-001. Do tests of application startup after a closed session. Do tests of
  multiple interruptions.
- **Write protection:** The developer proposes a replacement and concurrency
  design. The plan does not prove its safety. Do tests of failures during each
  write phase. Examine the filesystem results.
- **Recovery frequency:** The developer proposes timing after measuring write
  cost. The product owner gives approval for it. Do tests of recovery during
  playback and editing.

## Out of scope

This slice does not recover audio files or complete preparation after tab
closure. It does not add cloud storage, project synchronization or song export.
