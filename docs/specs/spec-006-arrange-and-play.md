# Spec-006: Arrange and play ready clips

Status: Draft. No approval for an interview. Implementation has not started.

## Outcome

A user places ready samples on tracks and hears a short arrangement. They can
move or remove a clip and control playback without changing source audio.

## Scope and dependencies

Necessary earlier results: [003](spec-003-use-compatible-audio.md) and M1
playback evidence. Converted inputs also use spec-004. This slice includes
initial tracks, clip placement, snap, edits to individual clips, transport and
scheduled playback that you can hear.

[PRODUCT.md](../../PRODUCT.md) gives tempo, readiness and audio protection.
[The index](spec-000-index.md) supplies shared rules and evidence requirements.

A tick is the smallest musical time unit in the arrangement. Snap puts clip
positions on the selected time grid. Transport controls start, stop and move
playback. A voice is one active playback of a sample. An onset is the start of a
sound.

## Product rules

- Arrange at 180 BPM in C minor.
- Put only samples with `ready` status in the arrangement. Unpitched one-shot
  starts use the arrangement grid.
- A 90 BPM loop keeps its source speed. Four source beats occupy eight
  arrangement beats without pitch or speed changes.
- Use keyboard and pointer editing. Keep sample files unchanged after clip
  edits.

## Proposed behavior

Start with eight tracks and 4/4 time. Use 960 integer ticks for each quarter
note. Give bar, beat and sixteenth-note snap controls. These are
recommendations, not approved capacity or interaction limits.

Put clips in the arrangement with a pointer or keyboard. Show an insertion
outline. Reject overlaps on a track. After an overlap rejection, keep the
previous arrangement unchanged. Explicit replacement is a different proposed
command. Give undo and redo for arrangement edits.

Give play, pause, stop, seek and loop-region controls. Use absolute audio time
for scheduling. Do not use UI frames for scheduling. Cancel stale voices after
seek or edits. Keep source speed for prepared samples. Do not add rounded clip
lengths to calculate timing.

Continue audio playback after an explicit user command. Show suspended audio as
a status. The plan recommends pausing when the page becomes hidden. The product
owner will decide that behavior during this slice's future review.

If root-folder access fails, open setup. Keep the project state. Spec-009 gives
the rules for missing individual files after a project loads.

## Acceptance checks

| ID        | Given and action                                                                              | Expected result                                                            |
| --------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S006-AC01 | Put ready clips in the arrangement with a pointer and keyboard.                               | The two methods give the same track and snapped position.                  |
| S006-AC02 | Try to put a sample in review or a partial sample in the arrangement.                         | No playable arrangement clip is made.                                      |
| S006-AC03 | Put a four-beat 90 BPM loop in the arrangement.                                               | It occupies eight arrangement beats at its natural speed.                  |
| S006-AC04 | Play a loop region. Pause playback. Seek to a different position. Play the loop region again. | Playback follows the agreed transport positions without stale voices.      |
| S006-AC05 | Move or delete a clip. Then use undo.                                                         | The previous arrangement is available again. Source hashes stay unchanged. |
| S006-AC06 | Put an overlapping clip in the arrangement with the proposed rule.                            | The edit is rejected without changing existing clips.                      |
| S006-AC07 | Play synthetic impulses through loops and seeks.                                              | Onset measurements agree with the M1 timing criteria approved during M0.   |
| S006-AC08 | Remove root-folder access during playback.                                                    | Playback stops safely. Setup opens without removal of project state.       |

## Deferred decisions

| Choice                              | Owner and reason                                                                                        | Verification                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Snap, overlap and transport details | Product owner, future slice review. Current interactions are recommendations.                           | Clip-boundary and transport scenarios.                  |
| Hidden-page behavior                | Product owner and audio developer, future slice review. Continuous background playback is not promised. | Production-build visibility and suspended-audio tests.  |
| Track, voice and timing limits      | Developer, M1, with product-owner approval. No measurements exist.                                      | Documented workloads, onset error and listening review. |

## Out of scope

No group editing, mix adjustments, project persistence or rendered output. Those
results have different slices and stay necessary for release.
