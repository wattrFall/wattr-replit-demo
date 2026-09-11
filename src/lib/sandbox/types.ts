/**
 * Sandbox domain types.
 *
 * Pure data — no React, no three.js. The simulation model (Phase 5) and the
 * renderer both read these, which is what keeps the model swappable for a real
 * backend later.
 */

/** The fixed catalogue of placeable equipment. */
export type ComponentKind = "rack" | "crac" | "cdu" | "chiller" | "sensor";

/**
 * The two areas of the site, which take different equipment.
 *
 * The hall is the raised floor: racks and the cooling that serves them
 * directly. The plant yard is outside it, where heat is rejected. Keeping them
 * apart is what makes the topology rules legible on the floor rather than only
 * in the connection refusals.
 */
export type Zone = "hall" | "plant";

/** A cell on the floor plan. Integer coordinates spanning hall, gap and plant. */
export interface GridCell {
  x: number;
  z: number;
}

/** Editable parameter descriptor, driving both the inspector UI and clamping. */
export interface ParamSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown in the inspector to explain what the parameter actually does. */
  hint: string;
}

/** A placed piece of equipment. */
export interface SandboxItem {
  id: string;
  kind: ComponentKind;
  cell: GridCell;
  /** Values keyed by ParamSpec.key. Always populated from defaults on create. */
  params: Record<string, number>;
}

/** A directed link, e.g. a CRAC cooling a rack. */
export interface Connection {
  id: string;
  fromId: string;
  toId: string;
}

/** Why a proposed connection was refused, surfaced verbatim to the user. */
export interface ConnectionRefusal {
  reason: string;
}

/** Baseline control vs the Wattr controller — the comparison the page exists for. */
export type ControlMode = "baseline" | "wattr";

/** What a pointer click currently means. */
export type InteractionMode =
  | { type: "idle" }
  | { type: "placing"; kind: ComponentKind }
  | { type: "connecting"; fromId: string };

/**
 * Floor dimensions, in tiles.
 *
 * The plant yard sits to the +x side of the hall with a walkway between them,
 * so a single cell coordinate space covers both and the gap columns simply
 * take nothing.
 */
export interface FloorSpec {
  hallW: number;
  hallD: number;
  plantW: number;
}

/** The full authored layout — everything needed to reproduce a scene. */
export interface SandboxLayout {
  items: SandboxItem[];
  connections: Connection[];
  floor: FloorSpec;
}

/**
 * What the thermal model reads: equipment and how it is wired. Floor and zone
 * geometry only place things on screen, so the kernel never depends on them.
 */
export type SimLayout = Pick<SandboxLayout, "items" | "connections">;

/** A named starting layout offered to first-time visitors. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  layout: SandboxLayout;
}
