/**
 * Grid <-> world coordinate helpers.
 *
 * One source of truth for the mapping, so the floor, the placement ghost and
 * the placed objects cannot drift apart. The floor is centred on the origin:
 * cell (0,0) is the far-left corner, cell (GRID_W-1, GRID_D-1) the near-right.
 */
import { CATALOGUE, GRID_D, GRID_W } from "./catalogue";
import { CELL } from "./tokens";
import type { ComponentKind, GridCell } from "./types";

export const FLOOR_W = GRID_W * CELL;
export const FLOOR_D = GRID_D * CELL;

/** World-space centre of the footprint a component of `kind` occupies at `cell`. */
export function cellToWorld(cell: GridCell, kind: ComponentKind): [number, number, number] {
  const { w, d } = CATALOGUE[kind].footprint;
  return [
    -FLOOR_W / 2 + (cell.x + w / 2) * CELL,
    0,
    -FLOOR_D / 2 + (cell.z + d / 2) * CELL,
  ];
}

/**
 * The cell under a world-space point on the floor plane.
 *
 * Returns the cell the pointer is over, which is the footprint's ORIGIN cell —
 * multi-cell equipment extends right and forward from it. Callers must still
 * validate with canPlaceAt; this does no bounds checking.
 */
export function worldToCell(x: number, z: number): GridCell {
  return {
    x: Math.floor((x + FLOOR_W / 2) / CELL),
    z: Math.floor((z + FLOOR_D / 2) / CELL),
  };
}

/** Same cell? Used to skip re-renders while the pointer moves within one tile. */
export function sameCell(a: GridCell | null, b: GridCell | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.z === b.z;
}
