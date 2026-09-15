/**
 * Facility builds: the saved layout format and its contract.
 *
 * A build is the sandbox layout — zones, equipment and connections — which the
 * thermal kernel and the renderer already read, with parameters at facility
 * scale (see paramSpec in the catalogue).
 *
 * Pure: no React, no three.js, no database. The server and the Builder page
 * share it.
 */
import { CATALOGUE, paramSpec } from "@/lib/sandbox/catalogue";
import { checkConnection } from "@/lib/sandbox/connections";
import { MAX_ZONES, SITE, ZONE_LIMITS } from "@/lib/sandbox/geometry";
import { validateLayout, type Finding, type ValidationResult } from "@/lib/sandbox/validate";
import type { ComponentKind, ParamSpec, SandboxLayout, ZoneKind } from "@/lib/sandbox/types";

export type FacilityLayout = SandboxLayout;

/** How big a saved build may be. Generous for a demo, bounded for storage. */
export const FACILITY_LIMITS = {
  items: 240,
  connections: 720,
  nameLength: 40,
} as const;

/** Ids follow the graph spec's component id pattern. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const ZONE_KINDS: readonly ZoneKind[] = ["compute", "cooling", "plant"];

/** Parameters a component may carry beyond its catalogue entries. */
const EXTRA_PARAMS: Partial<Record<ComponentKind, readonly string[]>> = {
  // Loop temperature rise across the CDU, part of the SFO-01 reference model.
  cdu: ["loopDeltaK"],
};

/** A catalogue parameter with its facility-scale range applied. */
export function facilityParamSpec(kind: ComponentKind, spec: ParamSpec): ParamSpec {
  return paramSpec(kind, spec, "facility");
}

export class FacilityLayoutError extends RangeError {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new FacilityLayoutError(`Invalid facility layout: ${message}`);
};

/**
 * The structural contract for a saved build: shape, sizes, ids, references and
 * parameter ranges — what must hold before a layout is stored at all. Whether
 * the design would actually cool is a separate question, answered by
 * validateFacilityLayout.
 */
export function assertFacilityLayout(value: unknown): asserts value is FacilityLayout {
  if (!isRecord(value)) fail("expected an object with zones, items and connections");
  const { zones, items, connections } = value as Record<string, unknown>;
  if (!Array.isArray(zones) || !Array.isArray(items) || !Array.isArray(connections)) {
    fail("zones, items and connections must be arrays");
  }
  const zoneList = zones as unknown[];
  const itemList = items as unknown[];
  const connectionList = connections as unknown[];
  if (zoneList.length > MAX_ZONES) fail(`a site holds at most ${MAX_ZONES} zones`);
  if (itemList.length > FACILITY_LIMITS.items) fail(`a build holds at most ${FACILITY_LIMITS.items} items`);
  if (connectionList.length > FACILITY_LIMITS.connections) {
    fail(`a build holds at most ${FACILITY_LIMITS.connections} connections`);
  }

  const ids = new Set<string>();
  const claim = (id: unknown, what: string): string => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return fail(`${what} has an invalid id`);
    if (ids.has(id)) return fail(`the id ${id} is used twice`);
    ids.add(id);
    return id;
  };

  for (const zone of zoneList) {
    if (!isRecord(zone)) fail("each zone must be an object");
    const z = zone as Record<string, unknown>;
    const id = claim(z.id, "a zone");
    if (typeof z.name !== "string" || z.name.length > FACILITY_LIMITS.nameLength) {
      fail(`zone ${id} needs a name of at most ${FACILITY_LIMITS.nameLength} characters`);
    }
    if (!ZONE_KINDS.includes(z.kind as ZoneKind)) fail(`zone ${id} has an unknown kind`);
    const [x, zPos, w, d] = [z.x, z.z, z.w, z.d];
    if (![x, zPos, w, d].every((n) => Number.isInteger(n))) fail(`zone ${id} must be placed and sized in whole tiles`);
    const [nx, nz, nw, nd] = [x, zPos, w, d] as number[];
    if (nw < ZONE_LIMITS.w.min || nw > ZONE_LIMITS.w.max || nd < ZONE_LIMITS.d.min || nd > ZONE_LIMITS.d.max) {
      fail(`zone ${id} is outside the allowed size`);
    }
    if (nx < 0 || nz < 0 || nx + nw > SITE.w || nz + nd > SITE.d) fail(`zone ${id} extends beyond the site`);
  }

  const itemIds = new Set<string>();
  for (const item of itemList) {
    if (!isRecord(item)) fail("each item must be an object");
    const it = item as Record<string, unknown>;
    const id = claim(it.id, "an item");
    itemIds.add(id);
    if (typeof it.kind !== "string" || !Object.prototype.hasOwnProperty.call(CATALOGUE, it.kind)) {
      fail(`item ${id} has an unknown kind`);
    }
    const kind = it.kind as ComponentKind;
    const cell = it.cell;
    if (
      !isRecord(cell) ||
      !Number.isInteger(cell.x) ||
      !Number.isInteger(cell.z) ||
      (cell.x as number) < 0 ||
      (cell.z as number) < 0 ||
      (cell.x as number) >= SITE.w ||
      (cell.z as number) >= SITE.d
    ) {
      fail(`item ${id} is not on the site`);
    }
    if (!isRecord(it.params)) fail(`item ${id} needs a params object`);
    const specs = new Map(CATALOGUE[kind].params.map((spec) => [spec.key, facilityParamSpec(kind, spec)]));
    for (const [key, raw] of Object.entries(it.params as Record<string, unknown>)) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) fail(`item ${id} parameter ${key} must be a finite number`);
      const spec = specs.get(key);
      if (spec) {
        if ((raw as number) < spec.min || (raw as number) > spec.max) {
          fail(`item ${id} ${spec.label.toLowerCase()} must be between ${spec.min} and ${spec.max} ${spec.unit}`);
        }
      } else if (!(EXTRA_PARAMS[kind] ?? []).includes(key)) {
        fail(`item ${id} has an unknown parameter ${key}`);
      }
    }
  }

  for (const connection of connectionList) {
    if (!isRecord(connection)) fail("each connection must be an object");
    const c = connection as Record<string, unknown>;
    const id = claim(c.id, "a connection");
    if (typeof c.fromId !== "string" || typeof c.toId !== "string" || !itemIds.has(c.fromId) || !itemIds.has(c.toId)) {
      fail(`connection ${id} must join two items in the build`);
    }
  }
}

/** The layout with only the fields a build stores, so extra keys never reach the database. */
export function normalizeFacilityLayout(layout: FacilityLayout): FacilityLayout {
  return {
    zones: layout.zones.map(({ id, name, kind, x, z, w, d }) => ({ id, name, kind, x, z, w, d })),
    items: layout.items.map(({ id, kind, cell, params }) => ({
      id,
      kind,
      cell: { x: cell.x, z: cell.z },
      params: { ...params },
    })),
    connections: layout.connections.map(({ id, fromId, toId }) => ({ id, fromId, toId })),
  };
}

/**
 * Design checks for a build. Everything the sandbox checks before a run, plus
 * the connection rules the editor enforces as links are drawn — pairings, one
 * coolant supply per rack, header fan-out — since a saved build can arrive
 * from somewhere other than the editor.
 */
export function validateFacilityLayout(layout: FacilityLayout): ValidationResult {
  const base = validateLayout(layout);
  const broken: Finding[] = [];
  for (const connection of layout.connections) {
    const others = layout.connections.filter((c) => c.id !== connection.id);
    const check = checkConnection(layout.items, others, connection.fromId, connection.toId);
    if (!check.ok) {
      broken.push({
        severity: "error",
        message: `Connection ${connection.id} breaks a wiring rule: ${check.reason}`,
        itemIds: [connection.fromId, connection.toId],
      });
    }
  }
  const findings = [...broken, ...base.findings];
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { findings, errors, warnings, ok: errors.length === 0 };
}
