---
name: RaveFold
description: Six reference skins with one set of music controls.
colors:
  bg: "#04111c"
  text: "#eef4f6"
  muted: "#b9cdd3"
  focus: "#9ff3e4"
  accent: "#9ff3e4"
  on: "#def8f2"
  on-text: "#062a29"
  plate: "rgb(6 16 22 / 84%)"
  surface: "rgb(8 28 37 / 80%)"
  edge: "rgb(172 232 227 / 28%)"
  danger: "#ff9ba8"
  success: "#a3e4c3"
typography:
  headline:
    fontFamily: '"Space Grotesk Variable", sans-serif'
    fontSize: "36px"
    fontWeight: 500
    lineHeight: 1.16
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"Space Grotesk Variable", sans-serif'
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.02em"
  body:
    fontFamily: '"Space Grotesk Variable", sans-serif'
    fontSize: "13px"
    lineHeight: 1.5
  label:
    fontFamily: '"Space Grotesk Variable", sans-serif'
    fontSize: "14px"
rounded:
  field: "8px"
  button: "9px"
  project-action: "12px"
  dialog: "16px"
  panel: "26px"
spacing:
  control-gap: "12px"
  field-gap: "16px"
  panel-gap: "24px"
  panel-padding: "30px"
components:
  button:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-primary:
    backgroundColor: "{colors.on}"
    textColor: "{colors.on-text}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  project-action-primary:
    backgroundColor: "{colors.on}"
    textColor: "{colors.on-text}"
    rounded: "{rounded.project-action}"
    padding: "18px"
  select:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "8px"
  panel-static:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-padding}"
  dialog:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "28px"
---

## Overview

Users do music tasks with clear controls and six reference skins. The menu gives
priority to task completion. The skins change material, color and motion. Layout
and control meanings stay the same.

This document records the implemented menu system. The
[skin registry](src/skins/registry.ts) gives the six fixed reference presets.
[Skin styles](src/skins/skins.css) give theme colors. These source definitions
stay the source for each skin and mode. [Menu styles](src/ui/menu.css) give the
layout and control measurements.

## Colors

The tokens above record the base dark colors. CSS means Cascading Style Sheets.
CSS custom properties store theme values for the interface.

Use the corresponding CSS custom properties so skin and light-mode changes apply
to each control. The `on` and `on-text` pair identifies primary actions. Control
text uses the `plate` background. Static panels use the `surface` and `edge`
pair. Status text appears with success and error colors.

| Skin        | Material appearance                                     |
| ----------- | ------------------------------------------------------- |
| Reference 1 | Transparent surfaces with colored edges                 |
| Reference 2 | Dark frosted surfaces                                   |
| Reference 3 | Surfaces that are not transparent, with reduced effects |
| Reference 4 | Transparent surfaces with refraction                    |
| Reference 5 | Dark surfaces with pink edges                           |
| Reference 6 | Transparent surfaces with increased motion              |

Reference 2 is the initial skin. Light, dark and system modes use the same
control structure. Do not replace the reference definitions with new palettes.

## Typography

Headings, labels and status text use the supplied variable font. The headline
size decreases to 30px at the narrow breakpoint. The wordmark uses 24px type
with weight 600. Status text uses the body role. Timing values use tabular
numerals. Users can see labels without tooltips.

## Layout

The menu has a maximum width of 1160px. Its two columns use a 1.65:1 ratio, with
a minimum width of 320px for the appearance column. Panel gaps use the spacing
tokens. The main shell has 38px vertical separation and 5vw horizontal padding.

At 860px or less, panels form one column with a maximum width of 660px. The
shell padding becomes 24px. The skin selector changes from three columns to six
columns. At 540px or less, it returns to three columns. Panel padding becomes
22px, and entry controls form a vertical group.

The minimum page width is 320px. Dialogs let users scroll vertically and keep a
16px horizontal viewport margin. These menu changes do not specify a phone
editor.

## Elevation & Depth

The registered primary panels use one material renderer. Static mode does not
mount that renderer. An unavailable renderer uses the selected theme with CSS
surfaces. The registry sets the renderer limit to eight surfaces.

Static panels use a thin inset edge and a skin-dependent shadow. Reference 3
keeps only the edge. Native modal dialogs use themed backgrounds that are not
transparent, a shadow and a blurred backdrop. A second material renderer is not
necessary.

## Shapes

Primary panels use the registry radius. Controls use smaller corners from the
tokens above. Status dots are circular. The outlined brand symbol and control
icons use the current text color.

## Components

Project actions are large buttons with a minimum height of 112px. Standard
buttons have a minimum height of 44px. Select controls have a minimum height of
42px. Disabled buttons keep their position and use 0.45 opacity. Keyboard focus
uses a 3px outline with a 5px offset.

The skin selector uses six labeled radio controls. A selected preview has an
outline and a check mark. Folder rows show the name, status text and state dot.
Tooltips appear on pointer hover or keyboard focus. A mouse click does not keep
a tooltip open. Pointer exit closes a pointer tooltip. Escape or loss of
keyboard focus also closes it. Only one tooltip can appear at a time. The
tooltip uses the top layer and stays inside the viewport.

The top layer places content above dialogs and other page elements.

Native dialogs keep keyboard focus. When a dialog closes, its opening control
receives focus again. Full effects use the reference settings. Reduced effects
decrease motion but can still animate. Static effects disable animation and
transitions.

## Interface rules

- Use the six registry definitions and shared theme properties.
- Keep labels, focus and status clear in each skin.
- Keep layout and control meanings stable across skins.
- Do not add material surfaces to each row or control.
- Do not use color alone to show a state.
- Do not replace native modal behavior with a decorative panel.
