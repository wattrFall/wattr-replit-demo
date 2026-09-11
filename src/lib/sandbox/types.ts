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
 * What an area of the site is for. The kind gates what can be placed in it, so
 * a layout stays legible: racks only ever sit in a compute hall and chillers
 * only in a plant area, and a refusal names the right place. These mirror the
 * Compute, Cooling and Plant zones of the Unity Forge editor.
 */
export type ZoneKind = "compute" | "cooling" | "plant";

/**
 * A named, positionable, resizable area of the site, in tiles.
 *
 * Zones are axis-aligned and never overlap. Equipment belongs to the zone it
 * sits in and moves with it, and a zone cannot be shrunk, retyped or deleted in
 * a way that would strand what it holds.
 */
export interface ZoneSpec {
  id: string;
  name: string;
  kind: ZoneKind;
  /** Top-left tile of the zone on the site grid. */
  x: number;
  z: number;
  /** Size in tiles. */
  w: number;
  d: number;
}

/** A cell on the site grid. */
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
  | { type: "connecting"; fromId: string }
  /** Moving one end of an existing connection to a different unit. */
  | { type: "rewiring"; connectionId: string; end: "from" | "to" };

/** The full authored layout — everything needed to reproduce a scene. */
export interface SandboxLayout {
  items: SandboxItem[];
  connections: Connection[];
  zones: ZoneSpec[];
}

/**
 * What the thermal model reads: equipment and how it is wired. Zone geometry
 * only places things on screen, so the kernel never depends on it.
 */
export type SimLayout = Pick<SandboxLayout, "items" | "connections">;

/** A named starting layout offered to first-time visitors. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  layout: SandboxLayout;
}
