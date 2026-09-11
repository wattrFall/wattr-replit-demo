/**
 * Site grid <-> world coordinates, and zone geometry.
 *
 * One source of truth for the mapping, so zones, the placement ghost and the
 * placed equipment cannot drift apart.
 *
 * The site is a fixed grid of SITE tiles centred on the world origin, and zones
 * are rectangles on it. Keeping the grid fixed, rather than deriving it from
 * whichever zones exist, means moving or resizing one zone never shifts
 * anything else on screen.
 */
import { CATALOGUE, ZONE_CATALOGUE } from "./catalogue";
import { CELL } from "./tokens";
import type { ComponentKind, GridCell, ZoneKind, ZoneSpec } from "./types";

/** The whole site, in tiles. Zones are placed anywhere inside it. */
export const SITE = { w: 48, d: 32 } as const;

/** Limits for a zone's size, in tiles. */
export const ZONE_LIMITS = {
  w: { min: 3, max: 32 },
  d: { min: 3, max: 24 },
} as const;

/** Most zones one site may hold. */
export const MAX_ZONES = 8;

/** A tile rectangle: x0/z0 inclusive, x1/z1 exclusive. */
export interface Bounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const zoneRect = (zone: ZoneSpec): Bounds => ({
  x0: zone.x,
  z0: zone.z,
  x1: zone.x + zone.w,
  z1: zone.z + zone.d,
});

/** The tiles covered by every zone, or the middle of the site when there are none. */
export function zoneBounds(zones: readonly ZoneSpec[]): Bounds {
  if (zones.length === 0) {
    const x = Math.floor(SITE.w / 2);
    const z = Math.floor(SITE.d / 2);
    return { x0: x - 6, z0: z - 4, x1: x + 6, z1: z + 4 };
  }
  return {
    x0: Math.min(...zones.map((zone) => zone.x)),
    z0: Math.min(...zones.map((zone) => zone.z)),
    x1: Math.max(...zones.map((zone) => zone.x + zone.w)),
    z1: Math.max(...zones.map((zone) => zone.z + zone.d)),
  };
}

/** World-space centre and size of a tile rectangle. */
export function boundsToWorld(bounds: Bounds): { x: number; z: number; w: number; d: number } {
  return {
    x: ((bounds.x0 + bounds.x1) / 2 - SITE.w / 2) * CELL,
    z: ((bounds.z0 + bounds.z1) / 2 - SITE.d / 2) * CELL,
    w: (bounds.x1 - bounds.x0) * CELL,
    d: (bounds.z1 - bounds.z0) * CELL,
  };
}

/** True when two rectangles share a tile. Touching edges do not overlap. */
export function zonesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

/** The zone containing a cell, if any. */
export function zoneAt(zones: readonly ZoneSpec[], cell: GridCell): ZoneSpec | null {
  return (
    zones.find(
      (zone) =>
        cell.x >= zone.x && cell.x < zone.x + zone.w && cell.z >= zone.z && cell.z < zone.z + zone.d,
    ) ?? null
  );
}

/** Whether a zone of this kind takes this equipment. */
export function zoneAccepts(zoneKind: ZoneKind, kind: ComponentKind): boolean {
  return CATALOGUE[kind].zones.includes(zoneKind);
}

/** Every cell of a footprint placed at `cell`. */
export function footprintCells(kind: ComponentKind, cell: GridCell): GridCell[] {
  const { w, d } = CATALOGUE[kind].footprint;
  const cells: GridCell[] = [];
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x: cell.x + x, z: cell.z + z });
  return cells;
}

/**
 * The zone a footprint sits wholly inside, or null.
 *
 * Checked per cell, not per origin: a two-tile chiller with its origin at the
 * edge of a plant area has half of itself outside it.
 */
export function zoneOfFootprint(
  zones: readonly ZoneSpec[],
  kind: ComponentKind,
  cell: GridCell,
): ZoneSpec | null {
  const home = zoneAt(zones, cell);
  if (!home) return null;
  return footprintCells(kind, cell).every((c) => zoneAt(zones, c)?.id === home.id) ? home : null;
}

/** Whether two placed footprints share a tile. */
export function footprintsOverlap(
  aKind: ComponentKind,
  aCell: GridCell,
  bKind: ComponentKind,
  bCell: GridCell,
): boolean {
  const a = CATALOGUE[aKind].footprint;
  const b = CATALOGUE[bKind].footprint;
  return (
    aCell.x < bCell.x + b.w && aCell.x + a.w > bCell.x && aCell.z < bCell.z + b.d && aCell.z + a.d > bCell.z
  );
}

/** World-space centre of the footprint a component of `kind` occupies at `cell`. */
export function cellToWorld(cell: GridCell, kind: ComponentKind): [number, number, number] {
  const { w, d } = CATALOGUE[kind].footprint;
  return [(cell.x + w / 2 - SITE.w / 2) * CELL, 0, (cell.z + d / 2 - SITE.d / 2) * CELL];
}

/**
 * The cell under a world-space point on the floor plane.
 *
 * Returns the cell the pointer is over, which is the footprint's ORIGIN cell —
 * multi-cell equipment extends right and forward from it. Callers must still
 * validate; this does no bounds or zone checking.
 */
export function worldToCell(x: number, z: number): GridCell {
  return {
    x: Math.floor(x / CELL + SITE.w / 2),
    z: Math.floor(z / CELL + SITE.d / 2),
  };
}

/** Same cell? Used to skip re-renders while the pointer moves within one tile. */
export function sameCell(a: GridCell | null, b: GridCell | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.z === b.z;
}

/**
 * Where a new zone of `kind` fits, at its default size, leaving a one-tile
 * walkway to every other zone. Beside the existing zones if there is room,
 * otherwise the first clear spot on the site.
 */
export function freeZoneSpot(
  zones: readonly ZoneSpec[],
  kind: ZoneKind,
): { x: number; z: number; w: number; d: number } | null {
  const { w, d } = ZONE_CATALOGUE[kind].defaultSize;
  const fits = (x: number, z: number) =>
    x >= 0 &&
    z >= 0 &&
    x + w <= SITE.w &&
    z + d <= SITE.d &&
    zones.every((zone) => !zonesOverlap({ x0: x - 1, z0: z - 1, x1: x + w + 1, z1: z + d + 1 }, zoneRect(zone)));

  if (zones.length === 0) {
    const x = Math.floor((SITE.w - w) / 2);
    const z = Math.floor((SITE.d - d) / 2);
    return { x, z, w, d };
  }
  const bounds = zoneBounds(zones);
  const beside: Array<[number, number]> = [
    [bounds.x1 + 1, bounds.z0],
    [bounds.x0, bounds.z1 + 1],
    [bounds.x0 - w - 1, bounds.z0],
    [bounds.x0, bounds.z0 - d - 1],
  ];
  for (const [x, z] of beside) if (fits(x, z)) return { x, z, w, d };
  for (let z = 0; z + d <= SITE.d; z++) {
    for (let x = 0; x + w <= SITE.w; x++) if (fits(x, z)) return { x, z, w, d };
  }
  return null;
}
