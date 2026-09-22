# Spec 011: Render a stereo song

Status: Draft. Interview: Not authorized.

## Outcome

The user selects a destination and exports the arrangement as stereo WAV or MP3.
The rendered song follows the arrangement timing and mixer state.

## Scope and dependencies

This slice depends on `spec-008` and `spec-009`. It renders an open project
using available prepared samples. It inherits the M0/M1 audio evidence
requirements.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these approved rules:

- The first release exports stereo WAV and MP3. MP3 is for export only, not
  samples.
- The user selects a destination folder before each song render.
- The application does not automatically save songs in the user or settings
  folder.
- Project saving and recovery contain no audio or rendered songs.
- Existing audio in the sample folder must not be changed or deleted.
- The mix includes track volume, pan, mute, solo and master volume.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals.

- Use the same audio graph rules and clip timing for playback and rendering.
- Render offline and encode the selected export format in a Worker.
- Propose 44.1 kHz, 16-bit WAV with dither for review.
- Define the render range and audio-tail rule before implementation.
- Use a new filename if the destination already contains that name.
- Prevent an export write after destination cancellation or denied access.
- Give clipping warnings without claiming an unimplemented limiter.
- Keep musical timing unchanged when converting between sample rates.
- Measure cancellation and memory use before proposing a maximum song length.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S011-AC01:** Given an open arrangement, start each render request. A
  destination-folder selection occurs before rendering starts.
- **S011-AC02:** Cancel destination selection or deny write access. No exported
  song is written. The project remains available.
- **S011-AC03:** Given known onset positions, render the accepted range. WAV
  timing meets the approved M0/M1 criteria without increasing timing error.
- **S011-AC04:** Given known track and master settings, render the song.
  Measured output matches playback volume, pan, mute and solo behavior.
- **S011-AC05:** Given assets at different sample rates, render them together.
  Musical positions and durations remain unchanged after sample-rate conversion.
- **S011-AC06:** Given an existing destination filename, request an export. The
  accepted naming rule applies. Existing sample-folder audio remains unchanged.
- **S011-AC07:** Given cancellation or insufficient disk space, render a song.
  The application reports the result and follows the accepted partial-output
  rule.
- **S011-AC08:** Examine the generated file and all persistent writes. The file
  matches the selected WAV or MP3 format. No automatic export appears in the
  settings folder.
- **S011-AC09:** Export MP3, then examine it with an independent decoder.
  Channel count, duration and sound meet the agreed encoding criteria.
- **S011-AC10:** Present an exported MP3 to sample discovery. It cannot satisfy
  sample-folder validity or enter sample preparation.

## Deferred decisions

- **Encoding, range and tails:** The product owner reviews the audio developer's
  proposal during an expressly authorized review. WAV settings, MP3 encoder,
  bitrate and delay handling remain open. Verify headers, decoded duration and
  final audio for both formats.
- **Missing samples and failures:** The product owner decides render behavior
  for missing clips, cancellation and partial output. Verify each state before
  claiming a complete song export.
- **Render limits:** The developer proposes limits after M1 and
  built-application measurements. The product owner approves them. Verify peak
  memory and cancellation on the proposed minimum hardware.

## Out of scope

This slice does not add other export formats, stems, processing effects or
limiting. Song rendering does not replace project saving or recovery. The MP3
scope update does not authorize this specification's interview.
