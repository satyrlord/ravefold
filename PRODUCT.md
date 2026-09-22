# RaveFold

## Platform

The application uses a web browser. The first release supports full editing on
desktop and laptop computers with a keyboard and pointer. Full tablet and phone
editing are outside this release.

Official support is limited to Chromium-based desktop browsers. Other browsers
must open and operate without browser-related errors. An unavailable feature
must not cause the rest of the application to fail.

## Product purpose

RaveFold is a new interpretation of sample-based music software for web
browsers. Users make hardcore electronic music using their own samples.

## User requirements

- The application name is RaveFold.
- RaveFold does not import OG project files. Compatibility with those projects
  is outside the product scope, including future releases.
- RaveFold supplies no samples to users. Users select their own sample folder in
  a setup window.
- The main view requires a valid sample folder and a writable settings folder.
  The user stays in the main menu until both folder requirements pass.
- A valid sample folder is readable and writable. It contains at least one
  supported audio file, including files in subfolders. Sample preparation can
  continue after the main view opens.
- Sample input supports WAV only: 16-bit or 24-bit PCM, or 32-bit floating-point
  audio, in mono or stereo. MP3 is an export format, not a sample format.
- The application reads samples from the selected folder. It saves new or
  prepared samples only inside that folder. Samples never enter browser storage
  or the user settings folder.
- The application must not delete or change existing audio files in the sample
  folder. This includes audio files that the application added.
- The application can add new samples and manifests to the sample folder. It can
  change or delete manifest files.
- The project tempo is 180 BPM and the musical key is C minor.
- Natural, harmonic and melodic minor are compatible forms of C minor. Uncertain
  key results keep the `needs-review` status.
- Rhythmic samples with the `ready` status have a tempo of 90 or 180 BPM.
- A 90 BPM loop keeps its source speed by default. Four source beats occupy
  eight beats in the 180 BPM arrangement.
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
- The main menu, settings and setup dialogs use the complete six-skin interface
  before tracker entry. Users can change appearance from the main menu.
- The main menu supports New project, Open project and selection of available
  recovery copies. Project validation occurs before tracker entry.
- Tooltips are the only form of product help. Do not include help pages,
  command-reference panels or tutorials.
- The first release lets users import samples and edit clips in an arrangement.
  Users can adjust a basic mix, save and reopen projects, and export stereo WAV
  or MP3.
- The first-release mixer has track volume, pan, mute, solo, meters and master
  volume. Reverb, delay, EQ and distortion are outside the first release. Effect
  sounds remain usable as ordinary samples.
- Users can select clips across tracks and move, copy or delete them as one
  group. Group edits keep relative timing and support one-step undo. An invalid
  placement leaves the whole group unchanged.
- Users clear an arrangement with select-all and delete. There is no separate
  Clear arrangement command. Clip deletion does not delete sample files.
- Users browse sample folders and filter samples with editable tags. Tags stay
  in a sample-folder manifest. Tag edits do not rename or move audio files.
- Application and user settings use a dedicated RaveFold folder inside
  Documents. Users select this folder during setup. That folder contains no
  samples.
- The browser remembers only folder-access references between sessions. It
  stores no audio or settings values. Saved references do not bypass folder
  permissions.
- Before each song render, the user selects a destination folder. The
  application must not automatically save rendered songs in the user or settings
  folder.
- Project files contain arrangement data and sample paths, but no audio data.
  They do not embed samples or prepared audio.
- Normal project saving is manual. The application saves automatic recovery
  copies in the settings folder. Recovery copies contain only arrangement data
  and sample paths, with no audio or rendered songs.
- A project with missing sample paths loads with its available samples. A red
  bubble marks each missing sample at its position in the tracker view. The
  project keeps those paths and clip positions when saved again.
- Recording, sound synthesis and automation are outside the first release.

## Open product decisions

Supported browser versions and capacity limits are not yet set.
