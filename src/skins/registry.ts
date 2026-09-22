import type { Appearance } from "../domain/settings.ts";

export type SkinId = Appearance["skin"];

export interface ReferenceSettings {
  mood: "tidal" | "ember" | "aurora";
  theme: "dark" | "light" | "auto";
  blend: number;
  refraction: number;
  dispersion: number;
  rim: number;
  radius: number;
  tint: string;
  opacity: number;
  frost: number;
  elevation: number;
  panelColors: boolean;
  viscosity: number;
  stretch: number;
  flow: number;
  rimStyle: "iridescent" | "color" | "tint";
  rimHex: string;
  rimWidth: number;
  highlight: number;
  edgeLine: number;
  shimmer: number;
  glow: number;
  wash: number;
  grain: number;
  backgroundBlur: number;
  smoothness: number;
  pointerDrop: boolean;
  pointerPull: boolean;
  ambientDrops: boolean;
  grid: number;
  magnet: number;
}

// The copied settings retain their required notice in third-party-notices.txt.
export const REFERENCE_DEFAULTS: Readonly<ReferenceSettings> = Object.freeze({
  mood: "tidal",
  theme: "dark",
  blend: 40,
  refraction: 1,
  dispersion: 1,
  rim: 1,
  radius: 26,
  tint: "#ffffff",
  opacity: 0,
  frost: 0,
  elevation: 0.35,
  panelColors: false,
  viscosity: 0.5,
  stretch: 1,
  flow: 0,
  rimStyle: "iridescent",
  rimHex: "#9ff3e4",
  rimWidth: 1,
  highlight: 1,
  edgeLine: 1,
  shimmer: 1,
  glow: 1,
  wash: 1,
  grain: 1,
  backgroundBlur: 0,
  smoothness: 1,
  pointerDrop: true,
  pointerPull: true,
  ambientDrops: false,
  grid: 24,
  magnet: 40,
});

export const SKINS = Object.freeze([
  {
    id: "reference-1",
    label: "Lumen",
    swatch: "#87e4d4",
  },
  {
    id: "reference-2",
    label: "Studio",
    swatch: "#446a70",
  },
  {
    id: "reference-3",
    label: "Slate",
    swatch: "#66798d",
  },
  {
    id: "reference-4",
    label: "Aqua",
    swatch: "#83cbdc",
  },
  {
    id: "reference-5",
    label: "Neon",
    swatch: "#ff2d95",
  },
  {
    id: "reference-6",
    label: "Entropy",
    swatch: "#c88ee1",
  },
] as const satisfies readonly {
  id: SkinId;
  label: string;
  swatch: string;
}[]);

export function getSkinSettings(id: SkinId): Readonly<ReferenceSettings> {
  return Object.freeze({ ...REFERENCE_DEFAULTS, ...SKIN_PATCHES[id] });
}

export function getMaterialProps(
  appearance: Appearance,
  resolvedMode: "light" | "dark",
) {
  const s = getSkinSettings(appearance.skin);
  const reduced = appearance.effects === "reduced";
  return {
    mood: s.mood,
    theme: resolvedMode,
    blend: s.blend,
    refraction: s.refraction,
    dispersion: s.dispersion,
    rim: s.rim,
    radius: s.radius,
    tint:
      resolvedMode === "light" && s.opacity >= 0.55
        ? appearance.skin === "reference-5"
          ? "#f4dcea"
          : appearance.skin === "reference-3"
            ? "#dae4eb"
            : "#edf3f4"
        : s.tint,
    opacity: s.opacity,
    frost: s.frost,
    elevation: s.elevation,
    viscosity: reduced ? Math.max(s.viscosity, 0.8) : s.viscosity,
    stretch: reduced ? s.stretch * 0.2 : s.stretch,
    flow: reduced ? s.flow * 0.15 : s.flow,
    rimColor: s.rimStyle === "color" ? s.rimHex : s.rimStyle,
    rimWidth: s.rimWidth,
    highlight: s.highlight,
    edgeLine: s.edgeLine,
    shimmer: s.shimmer,
    shimmerSpeed: reduced ? 0.2 : 1,
    glow: s.glow,
    wash: s.wash,
    grain: s.grain,
    backgroundBlur: s.backgroundBlur,
    smoothness: s.smoothness,
    pointerDrop: reduced ? false : s.pointerDrop,
    pointerPull: reduced ? false : s.pointerPull,
    ambientDrops: reduced ? false : s.ambientDrops,
    grid: s.grid,
    magnet: s.magnet,
    maxSurfaces: 8,
    quality: reduced ? 1 : 1.25,
    formIn: false,
    formOut: false,
  };
}

export const SKIN_PATCHES: Readonly<
  Record<SkinId, Readonly<Partial<ReferenceSettings>>>
> = Object.freeze({
  "reference-1": Object.freeze({
    mood: "tidal",
    tint: "#ffffff",
    opacity: 0,
    frost: 0,
    panelColors: false,
    rimStyle: "iridescent",
    rimHex: "#9ff3e4",
    rim: 1,
    rimWidth: 1,
    highlight: 1,
    shimmer: 1,
    glow: 1,
    wash: 1,
    grain: 1,
    backgroundBlur: 0,
    edgeLine: 1,
    viscosity: 0.5,
    stretch: 1,
    flow: 0,
    blend: 40,
    refraction: 1,
    dispersion: 1,
    smoothness: 1,
    elevation: 0.35,
    ambientDrops: false,
  }),
  "reference-2": Object.freeze({
    mood: "tidal",
    tint: "#000000",
    opacity: 0.55,
    frost: 0.85,
    panelColors: false,
    rimStyle: "iridescent",
    rim: 0.25,
    rimWidth: 0.7,
    highlight: 0.4,
    shimmer: 0.6,
    glow: 0.5,
    wash: 1,
    grain: 1,
    backgroundBlur: 0,
    edgeLine: 0.8,
    viscosity: 0.7,
    stretch: 0.4,
    flow: 0,
    blend: 32,
    refraction: 0.6,
    dispersion: 0.4,
    smoothness: 1,
    elevation: 0.2,
    ambientDrops: false,
  }),
  "reference-3": Object.freeze({
    mood: "tidal",
    tint: "#1c2733",
    opacity: 1,
    frost: 0,
    panelColors: false,
    rimStyle: "color",
    rimHex: "#3d4c5c",
    rim: 0.5,
    rimWidth: 0.6,
    highlight: 0,
    shimmer: 0,
    glow: 0,
    wash: 0,
    grain: 0.4,
    backgroundBlur: 0,
    edgeLine: 0.6,
    viscosity: 0.6,
    stretch: 0,
    flow: 0,
    blend: 40,
    refraction: 0,
    dispersion: 0,
    smoothness: 1,
    elevation: 0.12,
    ambientDrops: false,
  }),
  "reference-4": Object.freeze({
    mood: "tidal",
    tint: "#ffffff",
    opacity: 0,
    frost: 0,
    panelColors: false,
    rimStyle: "iridescent",
    rimHex: "#9ff3e4",
    rim: 0,
    shimmer: 0,
    glow: 0,
    wash: 0,
    grain: 0,
    highlight: 0,
    edgeLine: 0.35,
    rimWidth: 1,
    backgroundBlur: 0,
    viscosity: 0.35,
    stretch: 1,
    flow: 0.4,
    blend: 40,
    refraction: 1.5,
    dispersion: 1.6,
    smoothness: 1,
    elevation: 0,
    ambientDrops: false,
  }),
  "reference-5": Object.freeze({
    mood: "ember",
    tint: "#160b1e",
    opacity: 0.75,
    frost: 0.2,
    panelColors: false,
    rimStyle: "color",
    rimHex: "#ff2d95",
    rim: 1.6,
    rimWidth: 1.3,
    highlight: 0.6,
    shimmer: 1.4,
    glow: 1.4,
    wash: 1,
    grain: 1,
    backgroundBlur: 0,
    edgeLine: 1.4,
    viscosity: 0.15,
    stretch: 1.2,
    flow: 0,
    blend: 40,
    refraction: 1,
    dispersion: 2,
    smoothness: 1,
    elevation: 0.55,
    ambientDrops: false,
  }),
  "reference-6": Object.freeze({
    mood: "aurora",
    tint: "#ffffff",
    opacity: 0,
    frost: 0.25,
    panelColors: false,
    rimStyle: "iridescent",
    rim: 1.3,
    rimWidth: 1.4,
    highlight: 1,
    shimmer: 1.6,
    glow: 1.4,
    wash: 1,
    grain: 1,
    backgroundBlur: 0,
    edgeLine: 1,
    viscosity: 0,
    stretch: 2.5,
    flow: 2,
    blend: 56,
    refraction: 1.4,
    dispersion: 2.2,
    smoothness: 1,
    elevation: 0.5,
    ambientDrops: true,
  }),
});
