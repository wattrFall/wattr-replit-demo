import { ArrowRight, Link2, Trash2, X } from "lucide-react";
import { CATALOGUE } from "@/lib/sandbox/catalogue";
import { connectionsFor, targetsFor } from "@/lib/sandbox/connections";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SButton } from "../primitives/SButton";
import { SSlider } from "../primitives/SSlider";
import { SKbd, SPanel } from "../primitives/SPanel";

/**
 * Details of the current selection: what it is, what can be tuned on it, and
 * what it is connected to.
 *
 * The panel scrolls internally rather than growing the page, so the 3D view
 * never gets pushed out of the viewport by a component with many parameters.
 */
export function Inspector() {
  const selectedId = useSandboxStore((s) => s.selectedId);
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const mode = useSandboxStore((s) => s.mode);
  const remove = useSandboxStore((s) => s.remove);
  const setParam = useSandboxStore((s) => s.setParam);
  const beginConnecting = useSandboxStore((s) => s.beginConnecting);
  const disconnect = useSandboxStore((s) => s.disconnect);

  const item = items.find((i) => i.id === selectedId) ?? null;

  if (!item) {
    return (
      <SPanel as="aside" title="Inspector">
        <p className="px-3.5 py-4 text-[12px] leading-[1.6] text-[var(--sbx-text-faint)]">
          Select a component in the scene to inspect it.
        </p>
      </SPanel>
    );
  }

  const entry = CATALOGUE[item.kind];
  const links = connectionsFor(connections, item.id);
  const canFeed = targetsFor(item.kind);
  const connecting = mode.type === "connecting" && mode.fromId === item.id;

  return (
    <SPanel as="aside" title="Inspector">
      <div className="flex items-start gap-2.5 border-b border-[var(--sbx-border-hairline)] px-3.5 py-3">
        <span
          aria-hidden="true"
          className="mt-0.5 h-7 w-1 shrink-0 rounded-full"
          style={{ background: entry.accent }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium text-[var(--sbx-text)]">{entry.label}</h3>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
            Tile {item.cell.x + 1}, {item.cell.z + 1}
          </p>
        </div>
      </div>

      <div className="border-b border-[var(--sbx-border-hairline)] px-3.5 py-3">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--sbx-text-faint)]">
          Connections
        </h4>

        {links.length === 0 ? (
          <p className="mt-2 text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
            {canFeed.length > 0
              ? `Not connected. This can feed ${canFeed.map((k) => CATALOGUE[k].label).join(" or ")}.`
              : "Not connected. Connect a CRAC unit or CDU to this rack."}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {links.map((link) => {
              const outgoing = link.fromId === item.id;
              const other = items.find((i) => i.id === (outgoing ? link.toId : link.fromId));
              if (!other) return null;
              return (
                <li
                  key={link.id}
                  className="flex items-center gap-2 rounded-[6px] bg-[var(--sbx-surface-3)] px-2 py-1.5"
                >
                  <ArrowRight
                    className={`h-3 w-3 shrink-0 text-[var(--sbx-text-faint)] ${outgoing ? "" : "rotate-180"}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--sbx-text-muted)]">
                    {outgoing ? "to" : "from"} {CATALOGUE[other.kind].label}
                  </span>
                  <button
                    type="button"
                    onClick={() => disconnect(link.id)}
                    aria-label={`Disconnect ${CATALOGUE[other.kind].label}`}
                    className="rounded p-0.5 text-[var(--sbx-text-faint)] transition-colors duration-[var(--sbx-motion)] hover:text-[var(--sbx-heat)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)]"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {canFeed.length > 0 && (
          <SButton
            variant={connecting ? "primary" : "ghost"}
            size="sm"
            className="mt-2 w-full"
            onClick={() => beginConnecting(item.id)}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            {connecting ? "Pick a target…" : "Connect"}
          </SButton>
        )}
      </div>
      <div className="max-h-[42vh] overflow-y-auto lg:max-h-[360px]">
        <div className="divide-y divide-[var(--sbx-border-hairline)]">
          {entry.params.map((spec) => (
            <SSlider
              key={spec.key}
              label={spec.label}
              unit={spec.unit}
              hint={spec.hint}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={item.params[spec.key] ?? spec.default}
              onChange={(value) => setParam(item.id, spec.key, value)}
            />
          ))}
        </div>

      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--sbx-border-hairline)] px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--sbx-text-faint)]">
          <SKbd>Del</SKbd> to remove
        </span>
        <SButton variant="danger" size="sm" onClick={() => remove(item.id)}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </SButton>
      </div>
    </SPanel>
  );
}
