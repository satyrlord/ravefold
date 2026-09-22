# Spec 007: Edit arrangement sections

Status: Draft. Interview: No approval.

## Outcome

The user edits a group of clips across tracks. One undo command puts the
arrangement back in its previous state.

## Scope and dependencies

Necessary earlier result: `spec-006`. This slice extends a playable arrangement
with group edits. Track changes, trim and repeat controls are proposed
additions.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these rules with user approval:

- Users select clips across tracks and move, copy or delete them together.
- Group edits keep relative timing and support one-step undo.
- An invalid placement leaves the whole group unchanged.
- Select-all and delete remove all clips. There is no Clear arrangement command.
- Clip deletion does not delete sample files.
- Tooltips are the only form of product help.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval.

- Support pointer and keyboard selection, movement, copying, deletion and undo.
- Keep the relative distances between selected clips' tracks when the user moves
  or copies the group.
- Validate each affected clip before you apply a group command.
- Keep tracks and mixer settings when select-all and delete remove the clips.
- Support redo and an exit command that cancels an unfinished edit.
- Give trim and repeat different controls. Keep their source audio unchanged.
- Add controls to add tracks. Add controls to remove tracks. Add controls to
  change the track sequence.
- Reject overlaps unless the user gives an explicit replacement command.
- Keep New project and clip deletion as different commands.

## Acceptance checks

All checks are proposals. No check has been done.

- **S007-AC01:** Given clips on more than one track, move or copy the selection.
  The clips keep their relative timing. One undo puts the arrangement back in
  its previous state.
- **S007-AC02:** Given a group with one invalid destination, apply the edit.
  Each clip and the command history stay unchanged.
- **S007-AC03:** Given selected clips on more than one track, delete the
  selection. One undo puts each selected clip back in its initial position.
- **S007-AC04:** Use select-all in an arrangement with clips. Then delete the
  selection. The arrangement has no clips. Audio files stay unchanged. No Clear
  arrangement command exists.
- **S007-AC05:** Do the accepted group operations again with a pointer and
  keyboard. The two methods give the same arrangement and undo result.
- **S007-AC06:** Given an unfinished edit, cancel it. The arrangement stays
  unchanged. Focus goes back to the applicable control.
- **S007-AC07:** If trim and repeat are accepted, operate each control
  independently. Playback follows the selected boundaries. Source file hashes
  stay unchanged.
- **S007-AC08:** If track editing is accepted, add tracks. Remove tracks. Change
  the track sequence. Each operation follows the agreed clip, mixer and undo
  rules.

## Deferred decisions

- **Overlap and replacement:** The product owner decides during this slice's
  review with user approval. The plan is a recommendation. Do tests with
  conflicting placements of individual clips and groups.
- **Track changes, trim and repeat:** The product owner gives the controls and
  their results during this slice's review. Do tests of boundary cases and undo.
- **Editing capacity:** The developer proposes limits from M1 measurements. The
  product owner gives approval for them. Do tests of the built application with
  the agreed clip and track workloads.

## Out of scope

This slice does not add recording, synthesis, automation or sample-file edits.
Project saving belongs to `spec-009`.
