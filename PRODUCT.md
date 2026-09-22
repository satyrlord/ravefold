# RaveFold

## Platform

The application uses a web browser.

## Product purpose

RaveFold is a music project for web browsers. Users make hardcore electronic
music using their own samples.

## User requirements

- The application name is RaveFold.
- The project tempo is 180 BPM and the musical key is C minor.
- Rhythmic samples with the `ready` status have a tempo of 90 or 180 BPM.
- The import process changes all other tempos to 90 or 180 BPM before the sample
  gets the `ready` status. This includes other multiples of 45 BPM.
- A background process does the necessary time stretching and pitch shifting. A
  sample gets the `ready` status only after the process is complete without
  errors.
- Major or mixed-key imports keep the `needs-review` status. Only compatible
  sections can get the `ready` status in the first release. The first release
  does not change individual notes to change a sample's musical mode.
- The interface has six skins.

## Open product decisions

The target audience, release limits, browser support and non-tonal audio rules
are not yet set.
