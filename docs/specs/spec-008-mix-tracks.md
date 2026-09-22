# Spec 008: Mix tracks

Status: Draft. Interview: Not authorized.

## Outcome

The user hears the arrangement change when track and master controls change.
Meters show the signal without changing the sound.

## Scope and dependencies

This slice depends on `spec-006`. It adds the approved mixer controls to a
playable arrangement. `spec-009` saves implemented mixer state. `spec-011`
checks that rendered audio uses the same mix.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these approved rules:

- The mixer has track volume, pan, mute, solo and meters.
- The mixer has master volume.
- Reverb, delay, EQ and distortion are outside the first release.
- Effect sounds remain usable as ordinary samples.
- Tooltips are the only form of product help.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals.

- Use native gain and pan controls in the audio graph.
- Apply volume changes smoothly during playback.
- Show the master signal and a clipping indication.
- Keep audio scheduling independent of meter display updates.
- Give each control a label and a visible keyboard focus indicator.
- Do not announce each meter update through accessibility status messages.
- Use the same mixer behavior for playback and rendered audio.
- Keep mixer values separate from appearance settings.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S008-AC01:** Given a known signal on one track, change its volume and pan.
  Measured output follows the accepted control ranges and channel behavior.
- **S008-AC02:** Given several playing tracks, operate mute and solo. Audible
  tracks match the accepted mute and solo rules.
- **S008-AC03:** Given a playing arrangement, change master volume. The combined
  output follows the accepted master range.
- **S008-AC04:** Given constant audio, change the meter display update rate. The
  audio signal and scheduled onsets remain unchanged.
- **S008-AC05:** Given a signal above the accepted clipping threshold, play it.
  The clipping indication follows the accepted measurement rule.
- **S008-AC06:** Operate the controls with a pointer and keyboard. Values,
  accessible names and focus remain available through both methods.
- **S008-AC07:** Given rapid volume changes during playback, capture the output.
  Changes follow the accepted smoothing rule without unplanned signal steps.
- **S008-AC08:** Examine the available controls and a library effect sample. The
  sample remains playable. No excluded processing effect is added.

## Deferred decisions

- **Control behavior:** The product owner approves ranges, defaults and the
  interaction between mute and solo during this slice's review. Verify known
  signals and combined control states.
- **Meter behavior:** The audio developer proposes measurement points, scales
  and clipping thresholds. The product owner reviews the proposal. Verify
  calibrated signals and accessible control states.
- **Playback load:** The developer proposes voice and resource limits after M1.
  The product owner approves them. Verify playback, preparation and UI work
  together on documented hardware.

## Out of scope

This slice does not add effects processing, automation, recording or synthesis.
It does not select release limits without measurements.
