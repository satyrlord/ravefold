# Spec 010: Recover interrupted work

Status: Draft. Interview: Not authorized.

## Outcome

The user can recover arrangement work after an interrupted session without
changing the manually saved project.

## Scope and dependencies

This slice depends on `spec-009`. It uses that slice's project validation and
sample-path rules. It adds automatic recovery copies and a recovery choice.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these approved rules:

- Normal project saving is manual.
- Automatic recovery copies stay in the selected settings folder.
- Recovery copies contain arrangement data and sample paths only.
- Recovery copies contain no audio or rendered songs.
- The settings folder is a dedicated RaveFold folder inside Documents.
- Browser persistence contains only folder-access references.
- Existing audio files must remain unchanged.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals.

- Keep automatic recovery writes separate from the manually saved file.
- Keep the last valid recovery copy if a new write fails.
- Report unavailable settings-folder access and unsaved recovery state.
- Do not use another folder or browser storage as a recovery fallback.
- Validate a recovery copy before offering to restore it.
- Apply the same missing-sample behavior as a normal project load.
- Restore arrangement state without starting playback or a song render.
- Prevent concurrent writes to the same project or recovery destination.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S010-AC01:** Given edited project state, reach the accepted recovery
  trigger. A recovery copy appears only in the selected settings folder.
- **S010-AC02:** Examine the recovery file and all persistent writes. The copy
  contains metadata and sample paths. No audio or song render is written.
- **S010-AC03:** Given an existing valid recovery copy, interrupt the next
  write. The previous valid copy remains available for recovery.
- **S010-AC04:** Given revoked settings-folder access, edit the project. The
  application reports unsaved recovery state and uses no storage fallback.
- **S010-AC05:** Given a manually saved project, create several recovery copies.
  The manually saved file remains unchanged.
- **S010-AC06:** Given a valid recovery copy, restart and accept recovery. The
  arrangement returns without automatic playback or song rendering.
- **S010-AC07:** Given a recovery copy with missing samples, restore it.
  Available clips load. Missing paths and positions retain their red bubbles.
- **S010-AC08:** Given two tabs with the same recovery destination, attempt
  writes. The accepted concurrency rule prevents conflicting writes.

## Deferred decisions

- **Recovery interaction:** The product owner decides trigger timing, retained
  copies and restore-or-dismiss behavior during this slice's review. Verify
  restart, dismissal and repeated interruptions.
- **Write protection:** The developer proposes a replacement and concurrency
  design. The plan does not prove its safety. Verify failures during each write
  phase with filesystem results.
- **Recovery frequency:** The developer proposes timing after measuring write
  cost. The product owner approves it. Verify recovery during playback and
  editing.

## Out of scope

This slice does not recover audio files or complete preparation after tab
closure. It does not add cloud storage, project synchronization or song export.
