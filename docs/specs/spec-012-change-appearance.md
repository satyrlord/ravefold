# Spec 012: Keep appearance stable during tracker use

Status: Draft. Interview: Not authorized.

## Outcome

The user keeps the menu's selected appearance in the tracker. Skin changes
during editing, preparation and playback preserve controls and musical state.

## Scope and dependencies

This slice depends on `spec-001`, `spec-002` and `spec-006`. Spec-001 owns the
skin registry, theme controls, settings persistence and menu fallback. This
slice integrates that system with the playable workspace. Repeat its checks
against later flows as they become available. Do not delay menu styling or basic
accessibility until this slice.

## Product rules

[PRODUCT.md](../../PRODUCT.md) and the project instructions give these approved
rules:

- The interface has all six reference skins.
- The interface uses the required typed stack and material library.
- Application and user settings stay in the selected RaveFold folder in
  Documents.
- Browser persistence contains folder-access references only, without settings
  values.
- Tooltips are the only form of product help.
- Other browsers must operate without browser-related application errors.

## Proposed behavior

These recommendations come from [the delivery plan](../plan.md). They are not
additional product approvals. The private specification supplies the reference
definitions and necessary license evidence.

- Reuse the skin registry and appearance state from spec-001.
- Keep layout, controls, focus and sound-role meanings consistent across skins.
- Use spec-001 preference persistence and effects behavior without a second
  store.
- Apply the same static surfaces to tracker panels and overlays.
- Preserve the audio engine and playback when the skin changes.
- Keep text and waveforms legible over every surface.
- Use an available fallback if the material renderer cannot operate.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S012-AC01:** Enter the tracker in each reference skin. The menu selection
  remains active. Tracker controls retain their meaning and layout.
- **S012-AC02:** Given active playback, change the skin and effects setting. The
  audio engine remains the same. Playback meets the accepted audio criteria.
- **S012-AC03:** Select Static for each skin. CSS surfaces remain usable, and
  the material renderer is not mounted.
- **S012-AC04:** Enter the tracker with the menu in Static mode. Tracker panels
  apply that mode before animated surfaces appear.
- **S012-AC05:** Change appearance in the tracker, then reopen through the menu.
  The shared settings flow restores the choice without browser settings storage.
- **S012-AC06:** Remove material-rendering capability or simulate its loss. The
  accepted fallback keeps controls usable without an uncaught application error.
- **S012-AC07:** Use keyboard controls, tooltips and 200% zoom in every skin.
  Labels, focus and content remain usable under the agreed accessibility
  criteria.
- **S012-AC08:** Run the available setup, editing, preparation and save flows.
  Repeat later for recovery and export. Appearance changes preserve each flow's
  state.

## Deferred decisions

- **Tracker material layout:** The developer proposes surface boundaries for
  this slice's review. Menu defaults and effects belong to spec-001. Verify
  timeline scrolling, overlays and waveform contrast in each skin.
- **Material workload:** The developer proposes rendering limits after M1
  measurements. The product owner approves them. Verify all six skins during
  playback and preparation on documented hardware.
- **Browser range and fallback:** The developer proposes support from M1
  evidence. The product owner approves the version range. Verify the production
  build with absent capabilities, renderer loss and the agreed accessibility
  checks.

## Out of scope

This slice does not add help pages, tutorials, user-authored skins or mobile
editing. It does not change musical behavior or promise unmeasured GPU
performance.
