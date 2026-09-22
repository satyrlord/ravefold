# Spec 008: Mix tracks

Status: Draft. Interview: No approval.

## Outcome

The user hears the arrangement change when track and master controls change.
Meters show the signal without changing the sound.

## Scope and dependencies

Necessary earlier result: `spec-006`. This slice adds the approved mixer
controls to a playable arrangement. `spec-009` saves implemented mixer state.
`spec-011` includes checks that rendered audio uses the same mix.

Gain controls the signal level. Pan controls the division of a signal between
left and right channels. Clipping occurs when a signal exceeds the level that an
audio format or output can represent.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these rules with user approval:

- The mixer has track volume, pan, mute, solo and meters.
- The mixer has master volume.
- The first release does not include reverb, delay, EQ or distortion.
- Effect sounds stay usable as ordinary samples.
- Tooltips are the only form of product help.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval.

- Use native gain and pan controls in the audio graph.
- Apply volume changes smoothly during playback.
- Show the master signal and a clipping indication.
- Schedule audio independently of meter display updates.
- Give each control a label and a keyboard focus indicator that the user can
  see.
- Do not announce each meter update through accessibility status messages.
- Use the same mixer behavior for playback and rendered audio.
- Keep mixer values apart from appearance settings.

## Acceptance checks

All checks are proposals. No check has been done.

- **S008-AC01:** Use a known signal on one track. Change its volume. Change its
  pan. Measured output follows the accepted control ranges and channel behavior.
- **S008-AC02:** Use more than one playing track. Operate mute. Operate solo.
  Tracks that you can hear agree with the accepted mute and solo rules.
- **S008-AC03:** Given a playing arrangement, change master volume. The combined
  output follows the accepted master range.
- **S008-AC04:** Given constant audio, change the meter display update rate. The
  audio signal and scheduled onsets stay unchanged.
- **S008-AC05:** Given a signal above the accepted clipping threshold, play it.
  The clipping indication follows the accepted measurement rule.
- **S008-AC06:** Operate the controls with a pointer and keyboard. Values,
  accessible names and focus stay available through the two methods.
- **S008-AC07:** Given fast volume changes during playback, capture the output.
  Changes follow the accepted smoothing rule without unplanned signal steps.
- **S008-AC08:** Examine the available controls and a library effect sample. The
  sample stays playable. No excluded processing effect is added.

## Deferred decisions

- **Control behavior:** The product owner gives approval for ranges, defaults
  and the interaction between mute and solo during this slice's review. Do tests
  with known signals and combined control states.
- **Meter behavior:** The audio developer proposes measurement points, scales
  and clipping thresholds. The product owner examines the proposal. Do tests
  with calibrated signals and control states that support accessibility.
- **Playback load:** The developer proposes voice and resource limits after M1.
  The product owner gives approval for them. Do tests with playback, preparation
  and UI operations at the same time on documented hardware.

## Out of scope

This slice does not add effects processing, automation, recording or synthesis.
It does not select release limits without measurements.
