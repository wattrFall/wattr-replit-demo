/**
 * Grid <-> world coordinate helpers, and the zone layout.
 *
 * One source of truth for the mapping, so the floor, the placement ghost and
 * the placed objects cannot drift apart.
 *
 * The site is one continuous cell grid running left to right:
 *
 *     |<----- hallW ----->|<-gap->|<- plantW ->|
 *     |       hall        |       |   plant    |
 *
 * A single coordinate space keeps picking and placement simple; the walkway
 * columns between the two just belong to no zone, so nothing can be dropped
 * there. The whole grid is centred on the origin, so the camera orbits the
 * middle of the site rather than the middle of the hall.
 */
import { CATALOGUE } from "./catalogue";
import { CELL } from "./tokens";
import type { ComponentKind, FloorSpec, GridCell, Zone } from "./types";

/** Walkway between hall and plant, in tiles. Not placeable. */
export const GAP_COLS = 1;

/** Limits for the resize controls. */
export const FLOOR_LIMITS = {
  hallW: { min: 6, max: 22 },
  hallD: { min: 4, max: 14 },
  plantW: { min: 2, max: 8 },
} as const;

export const DEFAULT_FLOOR: FloorSpec = { hallW: 12, hallD: 8, plantW: 4 };

/** Total grid size, in tiles, including the walkway. */
export const gridW = (floor: FloorSpec) => floor.hallW + GAP_COLS + floor.plantW;
export const gridD = (floor: FloorSpec) => floor.hallD;

/** Total site size, in world units. */
export const floorW = (floor: FloorSpec) => gridW(floor) * CELL;
export const floorD = (floor: FloorSpec) => gridD(floor) * CELL;

/** Which zone a cell belongs to, or null for the walkway and anything outside. */
export function zoneAt(floor: FloorSpec, cell: GridCell): Zone | null {
  if (cell.z < 0 || cell.z >= gridD(floor)) return null;
  if (cell.x < 0) return null;
  if (cell.x < floor.hallW) return "hall";
  if (cell.x < floor.hallW + GAP_COLS) return null;
  if (cell.x < gridW(floor)) return "plant";
  return null;
}

/** Every cell of a footprint placed at `cell`. */
export function footprintCells(kind: ComponentKind, cell: GridCell): GridCell[] {
  const { w, d } = CATALOGUE[kind].footprint;
  const cells: GridCell[] = [];
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x: cell.x + x, z: cell.z + z });
  return cells;
}

/** World-space centre of the footprint a component of `kind` occupies at `cell`. */
export function cellToWorld(
  floor: FloorSpec,
  cell: GridCell,
  kind: ComponentKind,
): [number, number, number] {
  const { w, d } = CATALOGUE[kind].footprint;
  return [
    -floorW(floor) / 2 + (cell.x + w / 2) * CELL,
    0,
    -floorD(floor) / 2 + (cell.z + d / 2) * CELL,
  ];
}

/**
 * The cell under a world-space point on the floor plane.
 *
 * Returns the cell the pointer is over, which is the footprint's ORIGIN cell —
 * multi-cell equipment extends right and forward from it. Callers must still
 * validate; this does no bounds or zone checking.
 */
export function worldToCell(floor: FloorSpec, x: number, z: number): GridCell {
  return {
    x: Math.floor((x + floorW(floor) / 2) / CELL),
    z: Math.floor((z + floorD(floor) / 2) / CELL),
  };
}

/** Same cell? Used to skip re-renders while the pointer moves within one tile. */
export function sameCell(a: GridCell | null, b: GridCell | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.z === b.z;
}
