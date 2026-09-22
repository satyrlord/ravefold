# Spec 012: Change appearance

Status: Draft. Interview: Not authorized.

## Outcome

The user selects any of the six required skins and keeps the same controls and
musical project. The selected appearance returns after settings access returns.

## Scope and dependencies

This slice depends on `spec-002` and `spec-006`. It uses the selected settings
folder and playable workspace. Repeat its checks against later flows as they
become available. It does not defer basic accessibility in earlier slices.

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

- Use one typed skin registry with fixed defaults and each reference patch.
- Keep layout, controls, focus and sound-role meanings consistent across skins.
- Save skin selection as a user preference, outside musical project state.
- Give each skin Full, Reduced and Static effects settings.
- Use CSS surfaces without the material renderer in Static mode.
- Select Static for a reduced-motion preference unless the user changes it.
- Preserve the audio engine and playback when the skin changes.
- Keep text and waveforms legible over every surface.
- Use an available fallback if the material renderer cannot operate.

## Acceptance checks

All checks are proposed. No check has been executed.

- **S012-AC01:** Select each of the six reference skins. Appearance matches its
  private reference. Controls retain their meaning and layout.
- **S012-AC02:** Given active playback, change the skin and effects setting. The
  audio engine remains the same. Playback meets the accepted audio criteria.
- **S012-AC03:** Select Static for each skin. CSS surfaces remain usable, and
  the material renderer is not mounted.
- **S012-AC04:** Given a reduced-motion preference, start without a saved
  override. The accepted reduced-motion behavior applies before animated
  surfaces appear.
- **S012-AC05:** Change the appearance, close the session and restore folder
  access. Settings return from the settings folder. Browser storage contains no
  settings values.
- **S012-AC06:** Remove material-rendering capability or simulate its loss. The
  accepted fallback keeps controls usable without an uncaught application error.
- **S012-AC07:** Use keyboard controls, tooltips and 200% zoom in every skin.
  Labels, focus and content remain usable under the agreed accessibility
  criteria.
- **S012-AC08:** Run the available setup, editing, preparation and save flows.
  Repeat later for recovery and export. Appearance changes preserve each flow's
  state.

## Deferred decisions

- **Effects and defaults:** The product owner reviews Full, Reduced and Static
  behavior and the initial skin. Verify settings precedence and reduced motion.
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
