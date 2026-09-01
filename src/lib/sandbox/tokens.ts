/**
 * The sandbox token values, mirrored for consumers that cannot read CSS
 * variables — three.js materials take colours as numbers or strings, not
 * `var(...)`.
 *
 * These MUST stay in step with the `--sbx-*` block in index.css. That file is
 * the source of truth for the DOM; this is the source of truth for the canvas.
 */
export const SBX = {
  surface0: "#05090E",
  surface1: "#071019",
  surface2: "#0A121B",
  surface3: "#0D1520",

  primary: "#70A0D0",
  primaryBright: "#9EBFDF",
  healthy: "#2DD4BF",
  caution: "#F59E0B",
  heat: "#FF6A3D",

  gridLine: "#1A3050",
  gridLineMajor: "#27405F",
} as const;

/** Grid cell size in world units. One cell is one floor tile. */
export const CELL = 1;

/** Linear blend between two #rrggbb strings. */
function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const to = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${to(ar + (br - ar) * t)}${to(ag + (bg - ag) * t)}${to(ab + (bb - ab) * t)}`;
}

/**
 * Heat overlay colour for a normalised temperature, where 1.0 is the rack's own
 * inlet limit. Runs cool blue -> healthy teal -> caution amber -> heat, so a
 * floor can be read at a glance without a legend.
 */
export function heatColour(fraction: number): string {
  const f = Math.max(0, Math.min(1.2, fraction));
  if (f < 0.6) return mix(SBX.primary, SBX.healthy, f / 0.6);
  if (f < 0.85) return mix(SBX.healthy, SBX.caution, (f - 0.6) / 0.25);
  return mix(SBX.caution, SBX.heat, Math.min(1, (f - 0.85) / 0.15));
}
