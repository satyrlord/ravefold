# Spec 011: Render a stereo song

Status: Draft. Interview: No approval.

## Outcome

The user selects a destination and exports the arrangement as stereo WAV or MP3.
The rendered song follows the arrangement timing and mixer state.

## Scope and dependencies

Necessary earlier results: `spec-008` and `spec-009`. This slice renders an open
project using available prepared samples. The M0/M1 audio evidence requirements
apply to this slice.

An encoder changes rendered audio to the selected file format. Dither adds
low-level noise before a decrease in audio bit depth. Bit depth is the number of
bits for each audio value.

## Product rules

[PRODUCT.md](../../PRODUCT.md) gives these rules with user approval:

- The first release exports stereo WAV and MP3. MP3 is for export only, not
  samples.
- The user selects a destination folder before each song render.
- The application does not automatically save songs in the user or settings
  folder.
- Project saving and recovery contain no audio or rendered songs.
- Existing audio in the sample folder must not be changed or deleted.
- The mix includes track volume, pan, mute, solo and master volume.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval.

- Use the same audio graph rules and clip timing for playback and rendering.
- Render offline. Encode the selected export format in a Worker.
- Propose 44.1 kHz, 16-bit WAV with dither for review.
- Give the render range and the rule for audio tails before implementation.
- Use a new filename if the destination already contains that name.
- Prevent an export write after destination cancellation or denied access.
- Give clipping warnings. Do not claim that a limiter is available without its
  implementation.
- Keep musical timing unchanged during conversion between sample rates.
- Measure cancellation and memory use before you propose a maximum song length.

## Acceptance checks

All checks are proposals. No check has been done.

- **S011-AC01:** Given an open arrangement, start each render request. A
  destination-folder selection occurs before rendering starts.
- **S011-AC02:** Cancel destination selection or deny write access. The
  application writes no exported song. The project stays available.
- **S011-AC03:** Given known onset positions, render the accepted range. WAV
  timing agrees with the approved M0/M1 criteria. Timing error does not
  increase.
- **S011-AC04:** Given known track and master settings, render the song.
  Measured output agrees with playback volume, pan, mute and solo behavior.
- **S011-AC05:** Given assets at different sample rates, render them together.
  Musical positions and durations stay unchanged after sample-rate conversion.
- **S011-AC06:** Given an existing destination filename, request an export. The
  accepted naming rule applies. Existing sample-folder audio stays unchanged.
- **S011-AC07:** Given cancellation or disk space that is not sufficient, render
  a song. The application shows the result and follows the accepted
  partial-output rule.
- **S011-AC08:** Examine the generated file and all persistent writes. The file
  agrees with the selected WAV or MP3 format. The application does not
  automatically export to the settings folder.
- **S011-AC09:** Export MP3. Then examine it with a different decoder. Channel
  count, duration and sound agree with the accepted encoding criteria.
- **S011-AC10:** Supply an exported MP3 to sample discovery. It cannot satisfy
  sample-folder validity or enter sample preparation.

## Deferred decisions

- **Encoding, range and tails:** The product owner examines the audio
  developer's proposal during a review with explicit user approval. WAV
  settings, MP3 encoder, bitrate and delay handling stay open. Do checks of
  headers, decoded duration and completed audio for the two formats.
- **Missing samples and failures:** The product owner decides render behavior
  for missing clips, cancellation and partial output. Do tests of each state
  before you claim a completed song export.
- **Render limits:** The developer proposes limits after M1 and
  built-application measurements. The product owner gives approval for them.
  Measure peak memory on the proposed minimum hardware. Do cancellation tests on
  that hardware.

## Out of scope

This slice does not add other export formats, stems, processing effects or
limiting. Song rendering does not replace project saving or recovery. The MP3
scope update does not give approval for this specification's interview.
