import { Component, Suspense, lazy, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Crosshair, Play, RotateCcw } from "lucide-react";
import { CATALOGUE, PALETTE_ORDER, ZONE_CATALOGUE } from "@/lib/sandbox/catalogue";
import { useSandboxStore } from "@/lib/sandbox/store";
import { demoScenario } from "@/lib/demoScenario";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { SButton } from "./primitives/SButton";
import { SToggle } from "./primitives/SToggle";
import { Palette } from "./panels/Palette";
import { Zones } from "./panels/Zones";
import { Inspector } from "./panels/Inspector";
import { Telemetry } from "./panels/Telemetry";
import { ResultsOverlay } from "./ResultsOverlay";
import { Presets } from "./panels/Presets";
import { OPENING_PRESET } from "@/lib/sandbox/presets";
import { useSandboxSimulation } from "./useSandboxSimulation";

/**
 * The 3D bundle is fetched only once this shell has mounted, so three.js never
 * sits on the critical path for first paint.
 */
const SandboxCanvas = lazy(() => import("./SandboxCanvas"));

type CanvasErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

type CanvasErrorBoundaryState = {
  hasError: boolean;
};

class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  state: CanvasErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function SandboxShell() {
  const reducedMotion = useReducedMotion();
  // Runs the thermal model for as long as the sandbox is mounted.
  useSandboxSimulation();
  const telemetry = useSandboxStore((s) => s.telemetry);
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const zones = useSandboxStore((s) => s.zones);
  const selectedId = useSandboxStore((s) => s.selectedId);
  const selectedZoneId = useSandboxStore((s) => s.selectedZoneId);
  const remove = useSandboxStore((s) => s.remove);
  const removeZone = useSandboxStore((s) => s.removeZone);
  const mode = useSandboxStore((s) => s.mode);
  const notice = useSandboxStore((s) => s.notice);
  const controlMode = useSandboxStore((s) => s.controlMode);
  const setControlMode = useSandboxStore((s) => s.setControlMode);
  const beginPlacing = useSandboxStore((s) => s.beginPlacing);
  const setMode = useSandboxStore((s) => s.setMode);
  const reset = useSandboxStore((s) => s.reset);
  const resetView = useSandboxStore((s) => s.resetView);
  const runSimulation = useSandboxStore((s) => s.runSimulation);
  const loadLayout = useSandboxStore((s) => s.loadLayout);

  /**
   * Open on a working hall rather than an empty grid. A first visitor should
   * see a data centre reacting within a second or two, not a blank floor and a
   * palette to work out.
   */
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    loadLayout(OPENING_PRESET.layout, OPENING_PRESET.id);
  }, [loadLayout]);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const selectedZoneIdRef = useRef<string | null>(null);
  selectedZoneIdRef.current = selectedZoneId;

  /**
   * Global shortcuts: 1-5 arm a palette entry, Escape disarms, Delete removes
   * the selected equipment or empty zone. Ignored while a text field or slider
   * has focus so typing is never hijacked.
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
        } else if (selectedZoneIdRef.current) {
          event.preventDefault();
          removeZone(selectedZoneIdRef.current);
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
  }, [beginPlacing, setMode, remove, removeZone]);

  /**
   * Text equivalent of the canvas, announced politely. The 3D view is
   * aria-hidden, so this is the only description assistive tech receives.
   */
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

  const connectSource = mode.type === "connecting" ? items.find((i) => i.id === mode.fromId) : null;

  /**
   * What the pointer will do next, if anything. Kept separate from the scene
   * description below: an armed tool used to replace the whole line, which hid
   * what had been built at exactly the moment a screen-reader user was building
   * it — and made the readout unverifiable while placing.
   */
  const modeHint =
    mode.type === "placing"
      ? `Placing ${CATALOGUE[mode.kind].label} — click a tile, or press Escape to cancel.`
      : connectSource
        ? `Connecting from ${CATALOGUE[connectSource.kind].label} — click a highlighted target, or press Escape to cancel.`
        : selectedItem
          ? `${CATALOGUE[selectedItem.kind].label} selected at tile ${selectedItem.cell.x + 1}, ${selectedItem.cell.z + 1}. Press Delete to remove it.`
          : selectedZone
            ? `${selectedZone.name} selected. Edit it in the Zones panel, or press Delete to remove it once it is empty.`
            : null;

  /**
   * What gets *announced*. Only the short, event-driven half: what the pointer
   * will do, and why something was refused.
   *
   * The scene description and the readout deliberately stay out of this. They
   * carry PUE, inlet temperatures and power, republished ten times a second,
   * and a polite live region containing them made a screen reader recite the
   * numbers continuously while the model settled.
   */
  const announcement = notice ?? modeHint ?? "";

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
            <SButton
              variant="primary"
              size="sm"
              onClick={runSimulation}
              aria-label="Validate the design and run a simulation"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Run simulation
            </SButton>
            <SButton variant="ghost" size="sm" onClick={reset} aria-label="Reset the sandbox">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset
            </SButton>
          </div>
        </header>

        <Presets />

        <div className="flex flex-col gap-3 p-3 lg:flex-row">
          <div className="flex flex-col gap-3 lg:w-[230px]">
            <Palette />
            <Zones />
          </div>

          <div
            className="relative min-h-[340px] flex-1 overflow-hidden rounded-[10px] border border-[var(--sbx-border)] sm:min-h-[440px] lg:min-h-[520px]"
            role="group"
            aria-label="Data centre floor plan"
            aria-describedby="sandbox-scene-summary"
          >
            <CanvasErrorBoundary
              fallback={
                <div
                  role="img"
                  aria-label={sceneSummary}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--sbx-surface-0)] px-6 text-center"
                >
                  <p className="font-[family-name:var(--sbx-font-mono)] text-[11px] tracking-[0.14em] text-[var(--sbx-primary)]">
                    3D SCENE UNAVAILABLE
                  </p>
                  <p className="max-w-[340px] text-[12px] leading-[1.6] text-[var(--sbx-text-muted)]">
                    This preview does not provide WebGL. The cooling model, controls, and inspector are still active.
                  </p>
                  <p className="max-w-[420px] font-[family-name:var(--sbx-font-mono)] text-[11px] leading-[1.6] text-[var(--sbx-text-faint)]">
                    {sceneSummary}
                  </p>
                </div>
              }
            >
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
            </CanvasErrorBoundary>

            <div className="pointer-events-none absolute bottom-2.5 right-2.5 flex items-center gap-2">
              <span className="hidden rounded-[6px] bg-[var(--sbx-surface-0)]/80 px-2 py-1 text-[10px] leading-none text-[var(--sbx-text-faint)] sm:inline">
                Drag to orbit · right-drag to pan · scroll to zoom
              </span>
              <SButton
                size="sm"
                variant="ghost"
                className="pointer-events-auto bg-[var(--sbx-surface-0)]/80"
                onClick={resetView}
                aria-label="Recentre the view"
              >
                <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                Recentre
              </SButton>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:w-[260px]">
            <Telemetry />
            <Inspector />
          </div>
        </div>

        <footer className="border-t border-[var(--sbx-border)] px-4 py-2.5">
          <p className="font-[family-name:var(--sbx-font-mono)] text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
            <span role="status" aria-live="polite">
              {announcement}
            </span>{" "}
            {/* The canvas is aria-hidden, so this is its text equivalent. It is
                readable on demand — it is referenced by the canvas region — but
                never announced, because it changes continuously. */}
            <span id="sandbox-scene-summary">{sceneSummary}</span>
          </p>
        </footer>
      </div>

      <ResultsOverlay />

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
