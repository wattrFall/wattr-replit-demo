/**
 * Where links attach to equipment, what they carry, and the route they take.
 *
 * Every link leaves and enters a unit at a named port on its top face and runs
 * overhead in straight segments with square corners, the way pipe and cable
 * trays are laid, rather than arcing freely through the air. Port names follow
 * the Unity Forge editor and the graph spec: `a` is an inlet and `b` an outlet.
 *
 * Pure geometry over the layout: no store, no rendering.
 */
import { CATALOGUE } from "./catalogue";
import { cellToWorld } from "./geometry";
import type { ComponentKind, Connection, SandboxItem } from "./types";

export type Point3 = [number, number, number];

/** What a link carries. It decides how the link is drawn and how many may share a port. */
export type LinkMedium = "chilled-water" | "coolant" | "air" | "signal";

export interface MediumStyle {
  label: string;
  /** Colour of the supply pipe, or of the single path for air and sensor links. */
  supply: string;
  /** Colour of the return pipe, or null when the medium has no return path. */
  return: string | null;
}

/**
 * Supply runs cold blue and return runs warm orange, so a pipe's colour says
 * which way the heat is going.
 */
export const MEDIUM_STYLE: Record<LinkMedium, MediumStyle> = {
  "chilled-water": { label: "Chilled-water loop", supply: "#38BDF8", return: "#FB923C" },
  coolant: { label: "Coolant loop", supply: "#22D3EE", return: "#F59E0B" },
  air: { label: "Cooling air", supply: "#2DD4BF", return: null },
  signal: { label: "Sensor reading", supply: "#FBBF24", return: null },
};

/** The medium a link between two kinds carries. Assumes the pairing is allowed. */
export function linkMedium(from: ComponentKind, to: ComponentKind): LinkMedium {
  if (from === "sensor") return "signal";
  if (from === "chiller") return "chilled-water";
  if (from === "cdu" || to === "cdu") return "coolant";
  return "air";
}

export type PortName = "a" | "b";

/** A port on the unit's top face: the inlet left of centre, the outlet right of it. */
export function portPosition(item: SandboxItem, port: PortName): Point3 {
  const [x, , z] = cellToWorld(item.cell, item.kind);
  const { footprint, height } = CATALOGUE[item.kind];
  const spread = Math.min(0.24, footprint.w * 0.24);
  return [x + (port === "a" ? -spread : spread), height, z];
}

/** Clearance above the taller of the two units a pipe joins. */
export const TRAY_CLEARANCE = 0.55;

/** The return pipe runs this far above its supply, so the pair reads as two pipes. */
export const RETURN_LIFT = 0.18;

const samePoint = (a: Point3, b: Point3) =>
  Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;

/** Drop repeated corners, which appear when two ports already line up. */
const withoutRepeats = (points: Point3[]) =>
  points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));

/**
 * An overhead route between two ports: up from the first, across in x, along
 * in z, then down into the second. Straight runs and square corners only.
 */
export function trayRoute(start: Point3, end: Point3, height: number): Point3[] {
  return withoutRepeats([
    start,
    [start[0], height, start[2]],
    [end[0], height, start[2]],
    [end[0], height, end[2]],
    end,
  ]);
}

export type PathRole = "supply" | "return" | "air" | "signal";

export interface LinkPath {
  role: PathRole;
  colour: string;
  /** Corner points, in the direction the medium flows. */
  points: Point3[];
}

/**
 * The paths drawn for one connection, each in flow direction.
 *
 * A fluid loop is two pipes: supply from the source's outlet to the target's
 * inlet, and return from the target's outlet back to the source's inlet, laid
 * as a matched pair one above the other. Cooling air is a single run across the
 * floor to the rack, and a sensor link a single low line to the rack it reads.
 */
export function linkPaths(connection: Connection, items: readonly SandboxItem[]): LinkPath[] {
  const from = items.find((item) => item.id === connection.fromId);
  const to = items.find((item) => item.id === connection.toId);
  if (!from || !to) return [];
  const medium = linkMedium(from.kind, to.kind);
  const style = MEDIUM_STYLE[medium];

  if (style.return) {
    const tray = Math.max(CATALOGUE[from.kind].height, CATALOGUE[to.kind].height) + TRAY_CLEARANCE;
    const supply = trayRoute(portPosition(from, "b"), portPosition(to, "a"), tray);
    // Laid along the same corners as the supply and then reversed, so the pair
    // runs together instead of taking two different routes.
    const back = trayRoute(portPosition(from, "a"), portPosition(to, "b"), tray + RETURN_LIFT).reverse();
    return [
      { role: "supply", colour: style.supply, points: supply },
      { role: "return", colour: style.return, points: back },
    ];
  }

  const [fx, , fz] = cellToWorld(from.cell, from.kind);
  const [tx, , tz] = cellToWorld(to.cell, to.kind);
  const y = medium === "air" ? 0.05 : 0.22;
  const points = withoutRepeats([
    [fx, y, fz],
    [tx, y, fz],
    [tx, y, tz],
  ]);
  return [{ role: medium === "air" ? "air" : "signal", colour: style.supply, points }];
}

/** Total length of a polyline, for pacing flow markers along it. */
export function pathLength(points: readonly Point3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az] = points[i - 1];
    const [bx, by, bz] = points[i];
    length += Math.hypot(bx - ax, by - ay, bz - az);
  }
  return length;
}
