import { useMemo } from "react";
import { CATALOGUE, ZONE_CATALOGUE } from "@/lib/sandbox/catalogue";
import { describeConnection } from "@/lib/sandbox/connections";
import { useSandboxStore } from "@/lib/sandbox/store";

/**
 * The scene's text equivalent, and what to announce about it.
 *
 * The canvas is aria-hidden, so `sceneSummary` is the description assistive
 * tech receives. It is readable on demand but never announced, because it
 * carries PUE, inlet temperatures and power that republish ten times a second.
 *
 * `announcement` is only the short, event-driven half: what the pointer will do
 * next, or why something was refused. A polite live region holding the
 * telemetry made a screen reader recite numbers continuously while the model
 * settled.
 */
export function useSceneDescription(): { sceneSummary: string; announcement: string } {
  const telemetry = useSandboxStore((s) => s.telemetry);
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const zones = useSandboxStore((s) => s.zones);
  const selectedId = useSandboxStore((s) => s.selectedId);
  const selectedZoneId = useSandboxStore((s) => s.selectedZoneId);
  const selectedConnectionId = useSandboxStore((s) => s.selectedConnectionId);
  const mode = useSandboxStore((s) => s.mode);
  const notice = useSandboxStore((s) => s.notice);
  const controlMode = useSandboxStore((s) => s.controlMode);

  const sceneSummary = useMemo(() => {
    const site =
      zones.length === 0
        ? "no zones"
        : `${zones.length} zone${zones.length > 1 ? "s" : ""}: ${zones
            .map((zone) => `${zone.name}, a ${zone.w} by ${zone.d} tile ${ZONE_CATALOGUE[zone.kind].label.toLowerCase()}`)
            .join("; ")}`;
    if (items.length === 0) {
      return `Site with ${site}. No equipment placed yet.`;
    }
    const counts = new Map<string, number>();
    for (const item of items) {
      const label = CATALOGUE[item.kind].label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([label, n]) => `${n} ${label}${n > 1 ? "s" : ""}`);
    const linkPart =
      connections.length === 0
        ? "No connections."
        : `${connections.length} connection${connections.length > 1 ? "s" : ""}.`;

    const readout =
      telemetry && telemetry.pue !== null && telemetry.maxInletC !== null
        ? ` PUE ${telemetry.pue.toFixed(3)}, peak inlet ${telemetry.maxInletC.toFixed(1)} degrees, ${telemetry.totalPowerKw.toFixed(0)} kilowatts total, under ${controlMode === "wattr" ? "Wattr control" : "baseline control"}.`
        : "";

    return `Site with ${site}. It contains ${parts.join(", ")}. ${linkPart}${readout}`;
  }, [items, connections, telemetry, controlMode, zones]);

  const selectedItem = items.find((i) => i.id === selectedId) ?? null;
  const selectedZone = zones.find((zone) => zone.id === selectedZoneId) ?? null;
  const selectedConnection = connections.find((c) => c.id === selectedConnectionId) ?? null;
  const connectSource = mode.type === "connecting" ? items.find((i) => i.id === mode.fromId) : null;
  const rewiringConnection =
    mode.type === "rewiring" ? connections.find((c) => c.id === mode.connectionId) ?? null : null;

  // What the pointer will do next, if anything, else what is selected.
  const modeHint =
    mode.type === "placing"
      ? `Placing ${CATALOGUE[mode.kind].label} — click a tile, or press Escape to cancel.`
      : connectSource
        ? `Connecting from ${CATALOGUE[connectSource.kind].label} — click a highlighted target, or press Escape to cancel.`
        : mode.type === "rewiring" && rewiringConnection
          ? `Moving the ${mode.end === "from" ? "source" : "target"} of the ${describeConnection(items, rewiringConnection)} — click a highlighted unit, or press Escape to cancel.`
          : selectedItem
            ? `${CATALOGUE[selectedItem.kind].label} selected at tile ${selectedItem.cell.x + 1}, ${selectedItem.cell.z + 1}. Press Delete to remove it.`
            : selectedConnection
              ? `${describeConnection(items, selectedConnection)} selected. Press Delete to disconnect it.`
              : selectedZone
                ? `${selectedZone.name} selected. Edit it in the Zones panel, or press Delete to remove it once it is empty.`
                : null;

  return { sceneSummary, announcement: notice ?? modeHint ?? "" };
}
