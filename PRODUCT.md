# RaveFold

## Platform

The application uses a web browser. The first release supports full editing on
desktop and laptop computers with a keyboard and pointer. The first release does
not include full editing on tablets or phones.

RaveFold supports Chromium-based desktop browsers only. Other browser engines
are outside the product scope. An unavailable feature must not cause the rest of
the application to fail in a supported browser.

## Product purpose

RaveFold is a new interpretation of sample-based music software for web
browsers. Users make hardcore electronic music with their own samples.

A sample is an audio file or a selected section of that file. A clip is a timed
use of a sample on a track. An arrangement gives the position and duration of
each clip. A skin is a set of interface appearance settings.

## User requirements

- The application name is RaveFold.
- RaveFold does not import OG project files. Compatibility with those projects
  is not a product feature. This limit applies to all future releases.
- RaveFold contains no sample audio. Users select their own sample folder in a
  setup window.
- The main menu has an OG archive import action. It converts PXD files from the
  external ISO into WAV files in the selected Samples folder.
- The archive action is available before folder setup. It lets users select an
  empty writable folder when no Samples folder is selected.
- The action shows import progress. It reports completion only after it
  validates the resulting sample folder. It does not change existing audio
  files.
- A valid sample folder and a writable settings folder are necessary before the
  main view opens. The user stays in the main menu until the two folder
  requirements pass.
- A valid sample folder is readable and writable. It contains at least one
  supported audio file in that folder or its subfolders. Sample preparation can
  continue after the main view opens.
- Sample input supports WAV only: 16-bit or 24-bit PCM, or 32-bit floating-point
  audio, in mono or stereo. MP3 is an export format, not a sample format.
- The application reads samples from the selected folder. It saves new or
  prepared samples only in that folder. The application does not save samples in
  browser storage or the user settings folder.
- The application must not delete or change existing audio files in the sample
  folder. This includes audio files that the application added.
- The application can add new samples and manifests to the sample folder. It can
  change or delete manifest files.
- The project tempo is 180 BPM and the musical key is C minor. BPM means beats
  per minute.
- Natural, harmonic and melodic minor are compatible forms of C minor. Samples
  with uncertain key results keep the `needs-review` status.
- Rhythmic samples with the `ready` status have a tempo of 90 or 180 BPM.
- A 90 BPM loop keeps its source speed by default. Four source beats occupy
  eight beats in the 180 BPM arrangement.
- The import process changes all other tempos to 90 or 180 BPM before the sample
  gets the `ready` status. This includes other multiples of 45 BPM.
- A background process does the necessary time stretching and pitch shifting. A
  sample gets the `ready` status only after the process is completed without
  errors.
- Unpitched one-shots keep their source sound and duration. A one-shot is a
  sound for one playback, not a loop. Tempo and key conversion are not
  necessary. Their start position uses the arrangement grid.
- Unpitched drum and noise loops are key-neutral, with no musical key. They use
  90 or 180 BPM without pitch shifting. Tuned percussion uses the tonal rules.
- Major or mixed-key imports keep the `needs-review` status. Only compatible
  sections can get the `ready` status in the first release. The first release
  does not change individual notes to change a sample's musical mode.
- The interface has six skins.
- The main menu, settings and setup dialogs use the full interface with all six
  skins before the tracker opens. Users can change appearance from the main
  menu.
- The main menu has New project, Open project and selection of available
  recovery copies. The application validates the project before the tracker
  opens.
- Tooltips are the only form of product help. A tooltip is short help text for a
  control. Do not include help pages, command-reference panels or tutorials.
- The first release lets users import samples and edit clips in an arrangement.
  Users can adjust a basic mix, save and reopen projects, and export stereo WAV
  or MP3.
- The first-release mixer has track volume, pan, mute, solo, meters and master
  volume. The first release does not include reverb, delay, EQ or distortion.
  Effect sounds are usable as ordinary samples.
- Users can select clips across tracks and move, copy or delete them as one
  group. Group edits keep relative timing. One undo reverses a group edit. An
  invalid placement leaves the full group unchanged.
- Users clear an arrangement with select-all and delete. There is no Clear
  arrangement command. Clip deletion does not delete sample files.
- Users browse sample folders and filter samples with editable tags. Tags stay
  in a manifest in the sample folder. A manifest is a file that contains sample
  metadata. Tag edits do not rename or move audio files.
- Application and user settings use a dedicated RaveFold folder in Documents.
  Users select this folder during setup. That folder contains no samples.
- The browser remembers only folder-access references between sessions. It
  stores no audio or settings values. Saved references do not bypass folder
  permissions. A folder-access reference identifies a selected folder for
  subsequent access.
- Before each song render, the user selects a destination folder. The
  application must not automatically save rendered songs in the user or settings
  folder.
- Project files contain arrangement data and sample paths, but no audio data.
  They do not embed samples or prepared audio.
- The user saves the main project file manually. The application saves automatic
  recovery copies in the settings folder. Recovery copies contain only
  arrangement data and sample paths, with no audio or rendered songs.
- A project with missing sample paths loads with its available samples. A red
  bubble marks each missing sample at its position in the tracker view. The
  project keeps those paths and clip positions when the user saves it again.
- The first release does not include recording, sound synthesis or automation.

## Open product decisions

Supported browser versions and capacity limits are not set at this time.
