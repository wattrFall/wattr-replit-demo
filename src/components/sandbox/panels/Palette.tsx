import { CATALOGUE, PALETTE_ORDER } from "@/lib/sandbox/catalogue";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SKbd, SPanel } from "../primitives/SPanel";
import { SButton } from "../primitives/SButton";

/**
 * The equipment palette. Selecting an entry arms placement mode; selecting the
 * armed entry again disarms it. The number-key shortcuts are shown rather than
 * hidden, so the keyboard path is discoverable instead of secret.
 */
export function Palette() {
  const mode = useSandboxStore((s) => s.mode);
  const beginPlacing = useSandboxStore((s) => s.beginPlacing);
  const armedKind = mode.type === "placing" ? mode.kind : null;

  return (
    <SPanel as="aside" title="Equipment" className="shrink-0">
      <ul className="flex flex-col p-1.5 lg:flex-col">
        {PALETTE_ORDER.map((kind) => {
          const entry = CATALOGUE[kind];
          const armed = armedKind === kind;
          return (
            <li key={kind}>
              <button
                type="button"
                onClick={() => beginPlacing(kind)}
                aria-pressed={armed}
                aria-label={armed ? `${entry.label} armed. Click again, or press Escape, to stop placing.` : `Place ${entry.label}`}
                className={
                  "group flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left " +
                  "transition-colors duration-[var(--sbx-motion)] ease-[var(--sbx-ease)] " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)] " +
                  "focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--sbx-surface-2)] " +
                  (armed
                    ? "bg-[var(--sbx-primary)]/22 ring-1 ring-inset ring-[var(--sbx-border-strong)]"
                    : "hover:bg-[var(--sbx-surface-3)]")
                }
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-1 shrink-0 rounded-full transition-opacity duration-[var(--sbx-motion)]"
                  style={{ background: entry.accent, opacity: armed ? 1 : 0.5 }}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      "block truncate text-[12px] font-medium transition-colors duration-[var(--sbx-motion)] " +
                      (armed ? "text-[var(--sbx-text)]" : "text-[var(--sbx-text-muted)]")
                    }
                  >
                    {entry.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-[1.45] text-[var(--sbx-text-faint)]">
                    {entry.blurb}
                  </span>
                </span>
                {armed ? <SKbd>Esc</SKbd> : <SKbd>{entry.shortcut}</SKbd>}
              </button>
            </li>
          );
        })}
      </ul>

      {armedKind && (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--sbx-border-hairline)] px-2.5 py-2">
          <span className="text-[11px] leading-[1.4] text-[var(--sbx-text-faint)]">
            Placing {CATALOGUE[armedKind].label}
          </span>
          <SButton size="sm" variant="ghost" onClick={() => beginPlacing(armedKind)}>
            Cancel
          </SButton>
        </div>
      )}
    </SPanel>
  );
}
