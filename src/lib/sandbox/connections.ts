/**
 * Connection topology and its rules.
 *
 * Pure functions over the layout — no store, no rendering — so the rules can be
 * reasoned about (and tested) on their own.
 *
 * The heat path runs one way: racks make heat, cooling units take it from
 * racks, and chillers reject what the cooling units collect. Sensors observe a
 * rack. Links are therefore directed, and the direction is part of the rule:
 *
 *     CRAC    -> rack        chiller -> CRAC
 *     CDU     -> rack        chiller -> CDU
 *     sensor  -> rack
 *
 * Links also land on ports, and a port takes only so many. A rack's liquid
 * inlet is a single stub, so it takes coolant from one CDU. A CDU's or
 * chiller's supply header fans out to at most MANIFOLD_FAN_OUT branches, the
 * widest manifold in the Unity Forge acceptance topology.
 *
 * Anything else is refused with a reason the user can act on, because a silent
 * no-op reads as a broken UI.
 */
import { CATALOGUE } from "./catalogue";
import { MEDIUM_STYLE, linkMedium } from "./routing";
import type { ComponentKind, Connection, SandboxItem } from "./types";

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

/** A supply header fans out to at most this many branches. */
export const MANIFOLD_FAN_OUT = 8;

/** A sensor reports on at most this many racks. */
export const SENSOR_COVERAGE = 8;

/** Directed pairs the model accepts. */
const ALLOWED: ReadonlyArray<readonly [ComponentKind, ComponentKind]> = [
  ["crac", "rack"],
  ["cdu", "rack"],
  ["chiller", "crac"],
  ["chiller", "cdu"],
  ["sensor", "rack"],
];

function isAllowed(from: ComponentKind, to: ComponentKind): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

/**
 * Why this particular pairing is wrong.
 *
 * Ordered most-specific first: a reversed link gets told to turn around, a
 * plausible-but-wrong link gets told what the right shape is, and only then do
 * we fall back to a generic refusal.
 */
function explain(from: ComponentKind, to: ComponentKind): string {
  const fromLabel = CATALOGUE[from].label;
  const toLabel = CATALOGUE[to].label;

  // The user drew a valid link backwards.
  if (isAllowed(to, from)) {
    return `Connect the ${toLabel} to the ${fromLabel}, not the other way round — heat flows from the rack outwards.`;
  }
  if (from === "rack" && to === "rack") {
    return "Racks do not feed each other. Connect a CRAC unit or CDU to a rack instead.";
  }
  if (from === "chiller" && to === "rack") {
    return "A chiller rejects heat collected by a CRAC unit or CDU, not from a rack directly.";
  }
  if (from === "rack") {
    return `A rack is a heat source, so it does not feed a ${toLabel}. Connect the ${toLabel} to the rack instead.`;
  }
  if (to === "sensor") {
    return "A sensor reads a rack. Connect the sensor to the rack, not the reverse.";
  }
  if (from === "sensor") {
    return `A sensor reads a rack's inlet, so it cannot attach to a ${toLabel}.`;
  }
  return `A ${fromLabel} does not connect to a ${toLabel}.`;
}

/** Whether `fromId` may feed `toId`, given what is already connected. */
export function checkConnection(
  items: readonly SandboxItem[],
  connections: readonly Connection[],
  fromId: string,
  toId: string,
): ConnectionCheck {
  if (fromId === toId) {
    return { ok: false, reason: "A component cannot connect to itself." };
  }

  const from = items.find((i) => i.id === fromId);
  const to = items.find((i) => i.id === toId);
  if (!from || !to) {
    return { ok: false, reason: "That component is no longer on the floor." };
  }

  // Treat an existing link as a duplicate in either direction: the pair is
  // already related, and a reversed second link would be nonsense.
  const duplicate = connections.some(
    (c) =>
      (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId),
  );
  if (duplicate) {
    return {
      ok: false,
      reason: `That ${CATALOGUE[from.kind].label} and ${CATALOGUE[to.kind].label} are already connected.`,
    };
  }

  if (!isAllowed(from.kind, to.kind)) {
    return { ok: false, reason: explain(from.kind, to.kind) };
  }

  const kindOf = (id: string) => items.find((i) => i.id === id)?.kind;
  const medium = linkMedium(from.kind, to.kind);

  if (medium === "coolant" && connections.some((c) => c.toId === toId && kindOf(c.fromId) === "cdu")) {
    return {
      ok: false,
      reason: "That rack's liquid inlet already takes coolant from a CDU. A rack has one coolant supply, so disconnect the other CDU first.",
    };
  }

  if (medium === "coolant" || medium === "chilled-water") {
    const branches = connections.filter((c) => {
      const target = kindOf(c.toId);
      return c.fromId === fromId && target !== undefined && linkMedium(from.kind, target) === medium;
    }).length;
    if (branches >= MANIFOLD_FAN_OUT) {
      const label = CATALOGUE[from.kind].label;
      return {
        ok: false,
        reason: `A ${label}'s supply header takes at most ${MANIFOLD_FAN_OUT} branches. Add another ${label} for more.`,
      };
    }
  }

  if (medium === "signal" && connections.filter((c) => c.fromId === fromId).length >= SENSOR_COVERAGE) {
    return {
      ok: false,
      reason: `A sensor reports on at most ${SENSOR_COVERAGE} racks. Place another sensor for more.`,
    };
  }

  return { ok: true };
}

/**
 * Whether one end of an existing connection may move to `itemId`.
 *
 * The connection is judged as if drawn fresh between its new ends, without
 * itself counting against a port's limit — otherwise a rack could never have
 * its one coolant supply moved to a different CDU.
 */
export function checkRewire(
  items: readonly SandboxItem[],
  connections: readonly Connection[],
  connectionId: string,
  end: "from" | "to",
  itemId: string,
): ConnectionCheck {
  const connection = connections.find((c) => c.id === connectionId);
  if (!connection) return { ok: false, reason: "That connection no longer exists." };
  const fromId = end === "from" ? itemId : connection.fromId;
  const toId = end === "to" ? itemId : connection.toId;
  if (fromId === connection.fromId && toId === connection.toId) {
    return { ok: false, reason: "The connection already runs there. Pick a different unit, or press Escape." };
  }
  return checkConnection(
    items,
    connections.filter((c) => c.id !== connectionId),
    fromId,
    toId,
  );
}

/** Every link touching an item, for the inspector's connection list. */
export function connectionsFor(connections: readonly Connection[], itemId: string): Connection[] {
  return connections.filter((c) => c.fromId === itemId || c.toId === itemId);
}

/** What this item is allowed to feed, used to hint the connect affordance. */
export function targetsFor(kind: ComponentKind): ComponentKind[] {
  return ALLOWED.filter(([a]) => a === kind).map(([, b]) => b);
}

/** A readable name for a connection, such as "Coolant loop: CDU to GPU rack". */
export function describeConnection(items: readonly SandboxItem[], connection: Connection): string {
  const from = items.find((i) => i.id === connection.fromId);
  const to = items.find((i) => i.id === connection.toId);
  if (!from || !to) return "Connection";
  return `${MEDIUM_STYLE[linkMedium(from.kind, to.kind)].label}: ${CATALOGUE[from.kind].label} to ${CATALOGUE[to.kind].label}`;
}
