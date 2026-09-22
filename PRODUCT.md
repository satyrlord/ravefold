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
- RaveFold supplies no samples to users. Users select their own sample folder in
  a setup window.
- The main view cannot start without a valid sample folder. The user stays in
  the main menu until folder setup is complete.
- The application reads samples from the selected folder. It saves new or
  prepared samples only inside that folder. Samples never enter browser storage
  or the user settings folder.
- The application must not delete or change existing audio files in the sample
  folder. This includes audio files that the application added.
- The application can add new samples and manifests to the sample folder. It
  can change or delete manifest files.
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
- Application and user settings use a separate folder in the operating system's
  user area. That folder contains no samples.
- Each song render requires a destination folder selected by the user. The
  application must not automatically save rendered songs in the user or
  settings folder.
- Project files contain arrangement data and sample paths, but no audio data.
  They do not embed samples or prepared audio.
- A project with missing sample paths loads with its available samples. A red
  bubble marks each missing sample at its position in the tracker view.
  The project keeps those paths and clip positions when saved again.
- Recording, sound synthesis and automation are outside the first release.

## Open product decisions

The target audience, supported browser versions and capacity limits are not yet
set. The settings folder and its access method are not yet set. Folder
validation, sample-path format and project-file destinations also need decisions.
