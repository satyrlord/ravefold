# Spec 007: Edit arrangement sections

Status: Draft. Interview: Not authorized.

## Outcome

The user edits a group of clips across tracks and restores the previous state
with one undo command.

## Scope and dependencies

This slice depends on `spec-006`. It extends a playable arrangement with group
edits. Track changes, trim and repeat controls are proposed additions.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these approved rules:

- Users select clips across tracks and move, copy or delete them together.
- Group edits keep relative timing and support one-step undo.
- An invalid placement leaves the whole group unchanged.
- Select-all and delete remove all clips. There is no Clear arrangement command.
- Clip deletion does not delete sample files.
- Tooltips are the only form of product help.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals.

- Support pointer and keyboard selection, movement, copying, deletion and undo.
- Keep relative track spacing when a group moves or is copied.
- Validate every affected clip before applying a group command.
- Keep tracks and mixer settings when select-all and delete remove the clips.
- Support redo and an exit command that cancels an unfinished edit.
- Give trim and repeat different controls. Keep their source audio unchanged.
- Add controls to add, remove and reorder tracks.
- Reject overlaps unless the user gives an explicit replacement command.
- Keep New project separate from clip deletion.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S007-AC01:** Given clips on several tracks, move or copy the selection. The
  clips keep their relative timing. One undo restores the previous state.
- **S007-AC02:** Given a group with one invalid destination, apply the edit.
  Every clip and the command history remain unchanged.
- **S007-AC03:** Given selected clips on several tracks, delete the selection.
  One undo restores every selected clip and its original position.
- **S007-AC04:** Given a populated arrangement, use select-all and delete. No
  clips remain. Audio files remain unchanged. No Clear arrangement command
  exists.
- **S007-AC05:** Repeat the accepted group operations with a pointer and
  keyboard. Both methods produce the same arrangement and undo result.
- **S007-AC06:** Given an unfinished edit, cancel it. The arrangement remains
  unchanged, and focus returns to the relevant control.
- **S007-AC07:** If trim and repeat are accepted, operate each control
  separately. Playback follows the selected boundaries. Source file hashes
  remain unchanged.
- **S007-AC08:** If track editing is accepted, add, remove and reorder tracks.
  Each operation follows the agreed clip, mixer and undo rules.

## Deferred decisions

- **Overlap and replacement:** The product owner decides during this slice's
  authorized review. The plan is a recommendation. Verify with conflicting
  single-clip and group placements.
- **Track changes, trim and repeat:** The product owner defines the controls and
  consequences during this slice's review. Verify boundary cases and undo.
- **Editing capacity:** The developer proposes limits from M1 measurements. The
  product owner approves them. Verify the built application with the agreed clip
  and track workloads.

## Out of scope

This slice does not add recording, synthesis, automation or sample-file edits.
Project saving belongs to `spec-009`.
