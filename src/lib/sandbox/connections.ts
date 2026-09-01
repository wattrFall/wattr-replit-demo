/**
 * Connection topology and its rules.
 *
 * Pure functions over the layout — no store, no rendering — so the rules can be
 * reasoned about (and later tested) on their own.
 *
 * The heat path runs one way: racks make heat, cooling units take it from
 * racks, and chillers reject what the cooling units collect. Sensors observe a
 * rack. Links are therefore directed, and the direction is part of the rule:
 *
 *     CRAC    -> rack        chiller -> CRAC
 *     CDU     -> rack        chiller -> CDU
 *     sensor  -> rack
 *
 * Anything else is refused with a reason the user can act on, because a silent
 * no-op reads as a broken UI.
 */
import { CATALOGUE } from "./catalogue";
import type { ComponentKind, Connection, SandboxItem } from "./types";

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

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
  items: SandboxItem[],
  connections: Connection[],
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

  return { ok: true };
}

/** Every link touching an item, for the inspector's connection list. */
export function connectionsFor(connections: Connection[], itemId: string): Connection[] {
  return connections.filter((c) => c.fromId === itemId || c.toId === itemId);
}

/** What this item is allowed to feed, used to hint the connect affordance. */
export function targetsFor(kind: ComponentKind): ComponentKind[] {
  return ALLOWED.filter(([a]) => a === kind).map(([, b]) => b);
}
