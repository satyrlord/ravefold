# RaveFold

## Platform

The application uses a web browser. The first release supports full editing on
desktop and laptop computers with a keyboard and pointer. Full tablet and phone
editing are outside this release.

Official support is limited to Chromium-based desktop browsers. Other browsers
must open and operate without browser-related errors. An unavailable feature
must not cause the rest of the application to fail.

## Product purpose

RaveFold is a music project for web browsers. Users make hardcore electronic
music using their own samples.

## User requirements

- The application name is RaveFold.
- The project tempo is 180 BPM and the musical key is C minor.
- Natural, harmonic and melodic minor are compatible forms of C minor. Uncertain
  key results keep the `needs-review` status.
- Rhythmic samples with the `ready` status have a tempo of 90 or 180 BPM.
- The import process changes all other tempos to 90 or 180 BPM before the sample
  gets the `ready` status. This includes other multiples of 45 BPM.
- A background process does the necessary time stretching and pitch shifting. A
  sample gets the `ready` status only after the process is complete without
  errors.
- Unpitched one-shots keep their source sound and duration. Tempo and key
  conversion are not necessary. Their start position uses the arrangement grid.
- Unpitched drum and noise loops are key-neutral. They use 90 or 180 BPM without
  pitch shifting. Tuned percussion uses the tonal rules.
- Major or mixed-key imports keep the `needs-review` status. Only compatible
  sections can get the `ready` status in the first release. The first release
  does not change individual notes to change a sample's musical mode.
- The interface has six skins.
- The first release lets users import samples and edit clips in an arrangement.
  Users can adjust a basic mix, save and reopen projects, and export stereo WAV.
- Recording, sound synthesis and automation are outside the first release.

## Open product decisions

The target audience, supported browser versions and capacity limits are not yet
set.
