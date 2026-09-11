import { useEffect, useRef } from "react";
import { Play, RotateCcw } from "lucide-react";
import { useSandboxStore } from "@/lib/sandbox/store";
import { demoScenario } from "@/lib/demoScenario";
import { OPENING_PRESET } from "@/lib/sandbox/presets";
import { SButton } from "./primitives/SButton";
import { SToggle } from "./primitives/SToggle";
import { Palette } from "./panels/Palette";
import { Zones } from "./panels/Zones";
import { Inspector } from "./panels/Inspector";
import { Telemetry } from "./panels/Telemetry";
import { Presets } from "./panels/Presets";
import { ResultsOverlay } from "./ResultsOverlay";
import { SandboxStage } from "./SandboxStage";
import { useSandboxShortcuts } from "./useSandboxShortcuts";
import { useSandboxSimulation } from "./useSandboxSimulation";
import { useSceneDescription } from "./useSceneDescription";

/**
 * The public cooling sandbox: build a small hall, then run baseline and Wattr
 * control over it. The editor pieces are shared with the facility Builder.
 */
export function SandboxShell() {
  // Runs the thermal model for as long as the sandbox is mounted.
  useSandboxSimulation();
  useSandboxShortcuts();
  const { sceneSummary, announcement } = useSceneDescription();
  const controlMode = useSandboxStore((s) => s.controlMode);
  const setControlMode = useSandboxStore((s) => s.setControlMode);
  const reset = useSandboxStore((s) => s.reset);
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
    // The store is shared with the facility Builder, which works at facility
    // scale; the public sandbox always uses its own, smaller ranges.
    useSandboxStore.getState().setParamScale("sandbox");
    loadLayout(OPENING_PRESET.layout, OPENING_PRESET.id);
  }, [loadLayout]);

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

          <SandboxStage sceneSummary={sceneSummary} summaryId="sandbox-scene-summary" />

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
