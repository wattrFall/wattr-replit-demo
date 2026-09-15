import { Plus, Trash2 } from "lucide-react";
import { ZONE_CATALOGUE } from "@/lib/sandbox/catalogue";
import { SITE, ZONE_LIMITS } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";
import type { ZoneKind } from "@/lib/sandbox/types";
import { SButton } from "../primitives/SButton";
import { SPanel } from "../primitives/SPanel";
import { SSlider } from "../primitives/SSlider";

const ZONE_KINDS: ZoneKind[] = ["compute", "cooling", "plant"];

const fieldClass =
  "mt-1 block w-full rounded-[6px] border border-[var(--sbx-border)] bg-[var(--sbx-surface-3)] px-2 py-1.5 " +
  "text-[12px] text-[var(--sbx-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)]";

/**
 * The site's zones: add compute halls, cooling rooms and plant areas, then
 * rename, retype, move and resize them.
 *
 * Every change goes through the store, which refuses rather than destroys: a
 * zone will not overlap another, and will not shrink, retype or disappear in a
 * way that strands equipment. Moving a zone carries its equipment with it.
 */
export function Zones() {
  const zones = useSandboxStore((s) => s.zones);
  const selectedZoneId = useSandboxStore((s) => s.selectedZoneId);
  const selectZone = useSandboxStore((s) => s.selectZone);
  const addZone = useSandboxStore((s) => s.addZone);
  const updateZone = useSandboxStore((s) => s.updateZone);
  const removeZone = useSandboxStore((s) => s.removeZone);

  const zone = zones.find((candidate) => candidate.id === selectedZoneId) ?? null;

  return (
    <SPanel as="aside" title="Zones">
      {zones.length === 0 ? (
        <p className="px-3.5 py-3 text-[12px] leading-[1.6] text-[var(--sbx-text-faint)]">
          No zones yet. Add a compute hall for racks and a plant area for chillers.
        </p>
      ) : (
        <ul className="flex flex-col p-1.5">
          {zones.map((candidate) => {
            const selected = candidate.id === selectedZoneId;
            const meta = ZONE_CATALOGUE[candidate.kind];
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => selectZone(selected ? null : candidate.id)}
                  className={
                    "flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-left " +
                    "transition-colors duration-[var(--sbx-motion)] focus-visible:outline-none " +
                    "focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)] " +
                    (selected
                      ? "bg-[var(--sbx-primary)]/20 ring-1 ring-inset ring-[var(--sbx-border-strong)]"
                      : "hover:bg-[var(--sbx-surface-3)]")
                  }
                >
                  <span aria-hidden="true" className="h-6 w-1 shrink-0 rounded-full" style={{ background: meta.accent }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--sbx-text-muted)]">
                      {candidate.name || meta.label}
                    </span>
                    <span className="block text-[11px] text-[var(--sbx-text-faint)]">
                      {meta.label} · {candidate.w} × {candidate.d} tiles
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--sbx-border-hairline)] px-2.5 py-2">
        {ZONE_KINDS.map((kind) => (
          <SButton
            key={kind}
            size="sm"
            variant="ghost"
            onClick={() => addZone(kind)}
            aria-label={`Add a ${ZONE_CATALOGUE[kind].label.toLowerCase()}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {ZONE_CATALOGUE[kind].short}
          </SButton>
        ))}
      </div>

      {zone && (
        <div className="border-t border-[var(--sbx-border-hairline)]">
          <div className="space-y-2.5 px-3.5 pt-3">
            <label className="block text-[11px] text-[var(--sbx-text-faint)]">
              Name
              <input
                className={fieldClass}
                value={zone.name}
                maxLength={40}
                onChange={(event) => updateZone(zone.id, { name: event.target.value })}
                onBlur={(event) => {
                  if (!event.target.value.trim()) updateZone(zone.id, { name: ZONE_CATALOGUE[zone.kind].label });
                }}
              />
            </label>
            <label className="block text-[11px] text-[var(--sbx-text-faint)]">
              Used for
              <select
                className={fieldClass}
                value={zone.kind}
                onChange={(event) => updateZone(zone.id, { kind: event.target.value as ZoneKind })}
              >
                {ZONE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {ZONE_CATALOGUE[kind].label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">{ZONE_CATALOGUE[zone.kind].hint}</p>
          </div>

          <div className="divide-y divide-[var(--sbx-border-hairline)]">
            <SSlider
              label="Width"
              unit="tiles"
              min={ZONE_LIMITS.w.min}
              max={ZONE_LIMITS.w.max}
              step={1}
              value={zone.w}
              onChange={(w) => updateZone(zone.id, { w })}
            />
            <SSlider
              label="Depth"
              unit="tiles"
              min={ZONE_LIMITS.d.min}
              max={ZONE_LIMITS.d.max}
              step={1}
              value={zone.d}
              onChange={(d) => updateZone(zone.id, { d })}
            />
            <SSlider
              label="Position across"
              unit="tile"
              hint="Equipment in the zone moves with it."
              min={0}
              max={SITE.w - zone.w}
              step={1}
              value={zone.x}
              onChange={(x) => updateZone(zone.id, { x })}
            />
            <SSlider
              label="Position along"
              unit="tile"
              min={0}
              max={SITE.d - zone.d}
              step={1}
              value={zone.z}
              onChange={(z) => updateZone(zone.id, { z })}
            />
          </div>

          <div className="flex justify-end border-t border-[var(--sbx-border-hairline)] px-3.5 py-2.5">
            <SButton variant="danger" size="sm" onClick={() => removeZone(zone.id)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete zone
            </SButton>
          </div>
        </div>
      )}
    </SPanel>
  );
}
