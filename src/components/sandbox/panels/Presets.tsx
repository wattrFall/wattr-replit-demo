import { PRESETS } from "@/lib/sandbox/presets";
import { useSandboxStore } from "@/lib/sandbox/store";

/**
 * Prebuilt halls, offered as the starting point rather than an empty grid.
 *
 * Each one is complete and passes validation, so a first visit can hit Run
 * immediately and see the comparison without building anything first.
 */
export function Presets() {
  const loadLayout = useSandboxStore((s) => s.loadLayout);
  const activePresetId = useSandboxStore((s) => s.activePresetId);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--sbx-border)] px-4 py-2.5">
      <span className="mr-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--sbx-text-faint)]">
        Start from
      </span>
      {PRESETS.map((preset) => {
        const active = preset.id === activePresetId;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={active}
            title={preset.description}
            onClick={() => loadLayout(preset.layout, preset.id)}
            className={
              "rounded-[6px] border px-2.5 py-1 text-[11px] font-medium transition-colors " +
              "duration-[var(--sbx-motion)] ease-[var(--sbx-ease)] focus-visible:outline-none " +
              "focus-visible:ring-2 focus-visible:ring-[var(--sbx-focus)] focus-visible:ring-offset-1 " +
              "focus-visible:ring-offset-[var(--sbx-surface-1)] " +
              (active
                ? "border-[var(--sbx-border-strong)] bg-[var(--sbx-primary)]/20 text-[var(--sbx-primary-bright)]"
                : "border-[var(--sbx-border)] text-[var(--sbx-text-muted)] hover:bg-[var(--sbx-surface-3)]")
            }
          >
            {preset.name}
          </button>
        );
      })}
    </div>
  );
}
