# Spec 012: Keep appearance stable during tracker use

Status: Draft. Interview: No approval.

## Outcome

The user keeps the menu's selected appearance in the tracker. Skin changes
during editing, preparation and playback keep controls and musical state
unchanged.

## Scope and dependencies

Necessary earlier results: `spec-001`, `spec-002` and `spec-006`. Spec-001 gives
the skin registry, theme controls, settings persistence and menu fallback. This
slice connects that system to the playable workspace. Do its checks again with
subsequent flows when they are available. Complete menu styling and basic
accessibility before this slice.

## Product rules

[PRODUCT.md](../../PRODUCT.md) and the project instructions give these rules
with user approval:

- The interface has all six reference skins.
- The interface uses the necessary programming language, framework and material
  library.
- Application and user settings stay in the selected RaveFold folder in
  Documents.
- Browser persistence contains folder-access references only, without settings
  values.
- Tooltips are the only form of product help.
- Other browsers must operate without browser-related application errors.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). These
recommendations do not give new product approval. The private specification
supplies the reference definitions and necessary license evidence.

- Use the skin registry and appearance state from spec-001.
- Keep layout, controls, focus and sound-role meanings the same across skins.
- Use spec-001 preference persistence and effects behavior without a second
  store.
- Apply the same static surfaces to tracker panels and overlays.
- Keep the audio engine and playback unchanged when the skin changes.
- Keep text and waveforms readable on each surface.
- Use an available fallback if the material renderer cannot operate.

## Acceptance checks

All checks are proposals. No check has been done.

- **S012-AC01:** Enter the tracker in each reference skin. The menu selection
  stays active. Tracker controls keep their meaning and layout.
- **S012-AC02:** Given active playback, change the skin and effects setting. The
  audio engine stays the same. Playback agrees with the accepted audio criteria.
- **S012-AC03:** Select Static for each skin. CSS surfaces stay usable, and the
  material renderer is not mounted.
- **S012-AC04:** Enter the tracker with the menu in Static mode. Tracker panels
  apply that mode before animated surfaces show.
- **S012-AC05:** Change appearance in the tracker. Then open the tracker again
  through the menu. The shared settings flow restores the choice without browser
  settings storage.
- **S012-AC06:** Remove material-rendering capability or simulate its loss. The
  accepted fallback keeps controls usable without an uncaught application error.
- **S012-AC07:** Use keyboard controls, tooltips and 200% zoom in each skin.
  Labels, focus and content stay usable under the agreed accessibility criteria.
- **S012-AC08:** Run the available setup, editing, preparation and save flows.
  Do the checks again when recovery and export are available. Appearance changes
  keep each flow's state unchanged.

## Deferred decisions

- **Tracker material layout:** The developer proposes surface boundaries for
  this slice's review. Menu defaults and effects belong to spec-001. Do tests of
  timeline scrolling, overlays and waveform contrast in each skin.
- **Material workload:** The developer proposes rendering limits after M1
  measurements. The product owner gives approval for them. Do tests of all six
  skins during playback and preparation on documented hardware.
- **Browser range and fallback:** The developer proposes support from M1
  evidence. The product owner gives approval for the version range. Do tests of
  the production build with unavailable capabilities and renderer loss. Do the
  agreed accessibility checks.

## Out of scope

This slice does not add help pages, tutorials, user-authored skins or mobile
editing. It does not change musical behavior or promise unmeasured graphics
processing unit (GPU) performance.
