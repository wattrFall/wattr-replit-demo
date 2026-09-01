import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import { RotateCcw } from "lucide-react";
import { CATALOGUE, GRID_D, GRID_W, PALETTE_ORDER } from "@/lib/sandbox/catalogue";
import { useSandboxStore } from "@/lib/sandbox/store";
import { demoScenario } from "@/lib/demoScenario";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { SButton } from "./primitives/SButton";
import { SToggle } from "./primitives/SToggle";
import { Palette } from "./panels/Palette";
import { Inspector } from "./panels/Inspector";
import { Telemetry } from "./panels/Telemetry";
import { useSandboxSimulation } from "./useSandboxSimulation";

/**
 * The 3D bundle is fetched only once this shell has mounted, so three.js never
 * sits on the critical path for first paint.
 */
const SandboxCanvas = lazy(() => import("./SandboxCanvas"));

export function SandboxShell() {
  const reducedMotion = useReducedMotion();
  // Runs the thermal model for as long as the sandbox is mounted.
  useSandboxSimulation();
  const telemetry = useSandboxStore((s) => s.telemetry);
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const selectedId = useSandboxStore((s) => s.selectedId);
  const remove = useSandboxStore((s) => s.remove);
  const mode = useSandboxStore((s) => s.mode);
  const notice = useSandboxStore((s) => s.notice);
  const controlMode = useSandboxStore((s) => s.controlMode);
  const setControlMode = useSandboxStore((s) => s.setControlMode);
  const beginPlacing = useSandboxStore((s) => s.beginPlacing);
  const setMode = useSandboxStore((s) => s.setMode);
  const reset = useSandboxStore((s) => s.reset);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  /**
   * Global shortcuts: 1-5 arm a palette entry, Escape disarms, Delete removes
   * the selection. Ignored while a
   * text field or slider has focus so typing is never hijacked.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Escape") {
        setMode({ type: "idle" });
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        // Backspace would otherwise navigate back in some browsers.
        if (selectedIdRef.current) {
          event.preventDefault();
          remove(selectedIdRef.current);
        }
        return;
      }
      const index = PALETTE_ORDER.findIndex((kind) => CATALOGUE[kind].shortcut === event.key);
      if (index >= 0) {
        event.preventDefault();
        beginPlacing(PALETTE_ORDER[index]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [beginPlacing, setMode, remove]);

  /**
   * Text equivalent of the canvas, announced politely. The 3D view is
   * aria-hidden, so this is the only description assistive tech receives.
   */
  const sceneSummary = useMemo(() => {
    if (items.length === 0) {
      return `Empty floor plan, ${GRID_W} by ${GRID_D} tiles. No equipment placed yet.`;
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

    return `Floor plan ${GRID_W} by ${GRID_D} tiles containing ${parts.join(", ")}. ${linkPart}${readout}`;
  }, [items, connections, telemetry, controlMode]);

  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  const connectSource = mode.type === "connecting" ? items.find((i) => i.id === mode.fromId) : null;

  const statusLine =
    mode.type === "placing"
      ? `Placing ${CATALOGUE[mode.kind].label} — click a tile, or press Escape to cancel.`
      : connectSource
        ? `Connecting from ${CATALOGUE[connectSource.kind].label} — click a highlighted target, or press Escape to cancel.`
        : selectedItem
          ? `${CATALOGUE[selectedItem.kind].label} selected at tile ${selectedItem.cell.x + 1}, ${selectedItem.cell.z + 1}. Press Delete to remove it. ${sceneSummary}`
          : sceneSummary;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6">
      {/* The product window: a darker surface inset into the marketing page. */}
      <div className="overflow-hidden rounded-[14px] border border-[var(--sbx-border-strong)] bg-[var(--sbx-surface-1)] font-[family-name:var(--sbx-font-sans)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--sbx-border)] px-4 py-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[13px] font-medium tracking-[-0.01em] text-[var(--sbx-text)]">
              Cooling sandbox
            </h2>
            <p className="text-[11px] text-[var(--sbx-text-faint)]">Illustrative model — not measured performance</p>
          </div>

          <div className="flex items-center gap-2">
            <SToggle
              label="Control mode"
              value={controlMode}
              onChange={setControlMode}
              options={[
                { value: "baseline", label: "Baseline" },
                { value: "wattr", label: "Wattr control" },
              ]}
            />
            <SButton variant="ghost" size="sm" onClick={reset} aria-label="Reset the sandbox">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset
            </SButton>
          </div>
        </header>

        <div className="flex flex-col gap-3 p-3 lg:flex-row">
          <div className="lg:w-[210px]">
            <Palette />
          </div>

          <div className="relative min-h-[340px] flex-1 overflow-hidden rounded-[10px] border border-[var(--sbx-border)] sm:min-h-[440px] lg:min-h-[520px]">
            <Suspense
              fallback={
                <div className="absolute inset-0 grid place-items-center bg-[var(--sbx-surface-0)]">
                  <p className="text-[11px] tracking-[0.14em] text-[var(--sbx-text-faint)]">
                    LOADING SCENE
                  </p>
                </div>
              }
            >
              <SandboxCanvas reducedMotion={reducedMotion} />
            </Suspense>
          </div>

          <div className="flex flex-col gap-3 lg:w-[260px]">
            <Telemetry />
            <Inspector />
          </div>
        </div>

        <footer className="border-t border-[var(--sbx-border)] px-4 py-2.5">
          <p
            role="status"
            aria-live="polite"
            className="font-[family-name:var(--sbx-font-mono)] text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]"
          >
            {notice ?? statusLine}
          </p>
        </footer>
      </div>

      {/* Model scope and limitations travel with the sandbox, as they did with
          the walkthrough this page replaces. */}
      <div className="mt-4 grid gap-3 text-[11px] leading-[1.6] text-[var(--sbx-text-faint)] sm:grid-cols-2">
        <p>{demoScenario.modelScope}</p>
        <ul className="space-y-1">
          {demoScenario.limitations.map((limitation) => (
            <li key={limitation}>· {limitation}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
