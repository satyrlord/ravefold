# Spec-006: Arrange and play ready clips

Status: Draft. Interview not authorized. Implementation has not started.

## Outcome

A user places ready samples on tracks and hears a short arrangement. They can
move or remove a clip and control playback without changing source audio.

## Scope and dependencies

Requires [003](spec-003-use-compatible-audio.md) and M1 playback evidence.
Converted inputs also use spec-004. This slice includes initial tracks, clip
placement, snap, single-clip edits, transport and audible scheduling.

[PRODUCT.md](../../PRODUCT.md) owns tempo, readiness and audio protection.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

## Product rules

- Arrange at 180 BPM in C minor.
- Place ready samples only. Unpitched one-shot starts use the arrangement grid.
- A 90 BPM loop keeps its source speed. Four source beats occupy eight
  arrangement beats without pitch or speed changes.
- Use keyboard and pointer editing. Keep sample files unchanged after clip
  edits.

## Proposed behavior

Start with eight tracks and 4/4 time. Use 960 integer ticks per quarter note.
Offer bar, beat and sixteenth-note snap. These are recommendations, not approved
capacity or interaction limits.

Place clips by pointer or keyboard. Show an insertion outline. Reject overlaps
on a track and keep the prior arrangement unchanged. Explicit replacement is a
separate proposed command. Provide undo and redo for arrangement edits.

Give play, pause, stop, seek and loop-region controls. Schedule from absolute
audio time, not UI frames. Cancel stale voices after seek or edits. Keep source
speed for prepared samples. Never accumulate rounded clip lengths as timing.

Resume audio after an explicit user command. Show suspended audio as a status.
The plan recommends pausing when the page becomes hidden. That behavior remains
open for this slice's future review.

If root-folder access fails, return to setup while keeping project state.
Missing individual file handling after project loading belongs to spec-009.

## Acceptance checks

| ID        | Given and action                                   | Expected result                                                           |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| S006-AC01 | Place ready clips with pointer and keyboard.       | Both methods produce the same track and snapped position.                 |
| S006-AC02 | Try to place a review or partial sample.           | No playable arrangement clip is made.                                     |
| S006-AC03 | Place a four-beat 90 BPM loop.                     | It occupies eight arrangement beats at its natural speed.                 |
| S006-AC04 | Play, pause, seek and repeat a loop region.        | Playback follows the agreed transport positions without stale voices.     |
| S006-AC05 | Move or delete a clip, then undo.                  | The prior arrangement returns and source hashes stay unchanged.           |
| S006-AC06 | Place an overlapping clip under the proposed rule. | The edit is rejected without changing existing clips.                     |
| S006-AC07 | Play synthetic impulses through loops and seeks.   | Onset measurements meet the M0-approved M1 timing criteria.               |
| S006-AC08 | Lose root access during playback.                  | Playback stops safely and setup returns without discarding project state. |

## Deferred decisions

| Choice                              | Owner and reason                                                                                        | Verifier                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Snap, overlap and transport details | Product owner, future slice review. Current interactions are recommendations.                           | Clip-boundary and transport scenarios.                  |
| Hidden-page behavior                | Product owner and audio developer, future slice review. Continuous background playback is not promised. | Production-build visibility and suspended-audio tests.  |
| Track, voice and timing limits      | Developer, M1, with product-owner approval. No measurements exist.                                      | Documented workloads, onset error and listening review. |

## Out of scope

No group editing, mix adjustments, project persistence or rendered output. Those
outcomes have separate slices and remain necessary for release.
