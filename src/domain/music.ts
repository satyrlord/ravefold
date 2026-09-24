export const SUPPORTED_BPMS = [90, 180] as const;
export type SupportedBpm = (typeof SUPPORTED_BPMS)[number];

/** Give the shift to C in [-6, 5]. Equal distances use the downward shift. */
export function nearestShiftToC(root: number): number {
  const up = (12 - root) % 12;
  return up > 5 ? up - 12 : up;
}

/** Use the smallest absolute logarithmic tempo ratio. Equal ratios use 180 BPM. */
export function nearestSupportedBpm(bpm: number): SupportedBpm {
  const slow = Math.abs(Math.log(90 / bpm));
  const fast = Math.abs(Math.log(180 / bpm));
  return slow < fast - 1e-12 ? 90 : 180;
}
