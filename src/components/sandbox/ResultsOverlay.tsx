import { useEffect, useRef } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { useSandboxStore } from "@/lib/sandbox/store";
import type { RunSummary } from "@/lib/sandbox/run";
import { SButton } from "./primitives/SButton";

type Better = "lower" | "higher" | "none";

interface StatRow {
  label: string;
  /** Rendered value per side. */
  format: (s: RunSummary) => string;
  /** Raw comparable number, or null when the stat is not a contest. */
  value: (s: RunSummary) => number | null;
  better: Better;
  hint?: string;
}

const ENERGY_ROWS: StatRow[] = [
  {
    label: "Mean PUE",
    format: (s) => (s.meanPue === null ? "—" : s.meanPue.toFixed(3)),
    value: (s) => s.meanPue,
    better: "lower",
    hint: "Facility power divided by IT power, averaged across the run.",
  },
  {
    label: "Cooling power",
    format: (s) => `${s.meanCoolingPowerKw.toFixed(1)} kW`,
    value: (s) => s.meanCoolingPowerKw,
    better: "lower",
    hint: "Fans, pumps and compressor. The part control can actually move.",
  },
  {
    label: "Cooling energy",
    format: (s) => `${s.coolingEnergyKwh.toFixed(1)} kWh`,
    value: (s) => s.coolingEnergyKwh,
    better: "lower",
  },
  {
    label: "Total draw",
    format: (s) => `${s.meanTotalPowerKw.toFixed(1)} kW`,
    value: (s) => s.meanTotalPowerKw,
    better: "lower",
  },
  {
    label: "Chilled water",
    format: (s) => (s.finalChilledWaterC === null ? "—" : `${s.finalChilledWaterC.toFixed(1)} °C`),
    value: () => null,
    better: "none",
    hint: "Warmer is cheaper to make, if the hall still holds its limits.",
  },
  {
    label: "Mean fan / pump",
    format: (s) => (s.meanFan === null ? "—" : `${(s.meanFan * 100).toFixed(0)} %`),
    value: () => null,
    better: "none",
  },
];

const SAFETY_ROWS: StatRow[] = [
  // Deliberately not a contest. Once both sides are inside the racks' limits, a
  // colder hall is not a better one — it is a more expensive one, and crowning
  // the colder column here would reward exactly the overcooling the controller
  // exists to remove. Whether a hall was actually safe is the two rows below.
  {
    label: "Peak inlet",
    format: (s) => (s.peakInletC === null ? "—" : `${s.peakInletC.toFixed(1)} °C`),
    value: () => null,
    better: "none",
    hint: "The hottest any rack got. Colder is not better if both stayed within limits — only cheaper to leave warm.",
  },
  {
    label: "Mean inlet",
    format: (s) => (s.meanInletC === null ? "—" : `${s.meanInletC.toFixed(1)} °C`),
    value: () => null,
    better: "none",
  },
  {
    label: "Steps over limit",
    format: (s) => `${s.stepsOverLimit}`,
    value: (s) => s.stepsOverLimit,
    better: "lower",
    hint: "Steps where at least one rack sat at or above its own inlet limit.",
  },
  {
    label: "Worst racks at risk",
    format: (s) => `${s.worstRacksAtRisk} of ${s.rackCount}`,
    value: (s) => s.worstRacksAtRisk,
    better: "lower",
  },
];

/** Which side wins a row, or null when it is not a contest or they tie. */
function winner(row: StatRow, a: RunSummary, b: RunSummary): "baseline" | "wattr" | null {
  if (row.better === "none") return null;
  const va = row.value(a);
  const vb = row.value(b);
  if (va === null || vb === null) return null;
  if (Math.abs(va - vb) < 1e-9) return null;
  const wattrWins = row.better === "lower" ? vb < va : vb > va;
  return wattrWins ? "wattr" : "baseline";
}

function StatBlock({
  title,
  rows,
  baseline,
  wattr,
}: {
  title: string;
  rows: StatRow[];
  baseline: RunSummary;
  wattr: RunSummary;
}) {
  return (
    <section className="flex flex-col">
      <h3 className="border-b border-[var(--sbx-border-strong)] pb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--sbx-text-faint)]">
        {title}
      </h3>
      <div className="divide-y divide-[var(--sbx-border-hairline)]">
        {rows.map((row) => {
          const win = winner(row, baseline, wattr);
          return (
            <div key={row.label} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-2.5">
              <span
                className="text-right font-[family-name:var(--sbx-font-mono)] text-[15px] tabular-nums"
                style={{
                  color: win === "baseline" ? "var(--sbx-healthy)" : "var(--sbx-text-muted)",
                  fontWeight: win === "baseline" ? 600 : 400,
                }}
              >
                {row.format(baseline)}
              </span>

              <span className="min-w-[9.5rem] text-center text-[11px] leading-[1.35] text-[var(--sbx-text-faint)] sm:min-w-[12rem]">
                {row.label}
                {row.hint && (
                  <span className="mt-0.5 hidden text-[10px] leading-[1.3] text-[var(--sbx-text-faint)] opacity-70 sm:block">
                    {row.hint}
                  </span>
                )}
              </span>

              <span
                className="font-[family-name:var(--sbx-font-mono)] text-[15px] tabular-nums"
                style={{
                  color: win === "wattr" ? "var(--sbx-healthy)" : "var(--sbx-text-muted)",
                  fontWeight: win === "wattr" ? 600 : 400,
                }}
              >
                {row.format(wattr)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The end-of-run comparison.
 *
 * Both columns come from one run over the same layout, so they are comparable
 * rather than two remembered sessions. Energy and safety are given equal
 * billing deliberately: on a heavily loaded hall the baseline can draw slightly
 * LESS power while running racks over their limit, and an energy-only
 * scoreboard would read that as a win.
 */
export function ResultsOverlay() {
  const showResults = useSandboxStore((s) => s.showResults);
  const lastRun = useSandboxStore((s) => s.lastRun);
  const findings = useSandboxStore((s) => s.runFindings);
  const close = useSandboxStore((s) => s.closeResults);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showResults) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showResults, close]);

  if (!showResults) return null;

  const blocked = !!findings && !findings.ok;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={blocked ? "Design checks failed" : "Simulation results"}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--sbx-surface-0)]/95 p-4 backdrop-blur-sm sm:p-8"
    >
      <div className="w-full max-w-[880px] rounded-[14px] border border-[var(--sbx-border-strong)] bg-[var(--sbx-surface-1)] font-[family-name:var(--sbx-font-sans)]">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--sbx-border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-medium text-[var(--sbx-text)]">
              {blocked ? "Fix these before running" : "Run complete"}
            </h2>
            <p className="mt-1 text-[11px] leading-[1.5] text-[var(--sbx-text-faint)]">
              {blocked
                ? "The model cannot say anything useful about this design yet."
                : `${lastRun?.steps ?? 0} steps, both control modes over the same hall. Illustrative model — not measured performance.`}
            </p>
          </div>
          <SButton ref={closeRef} size="sm" variant="ghost" onClick={close} aria-label="Close results">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Close
          </SButton>
        </header>

        {findings && findings.findings.length > 0 && (
          <ul className="flex flex-col gap-2 border-b border-[var(--sbx-border)] px-5 py-4">
            {findings.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                {f.severity === "error" ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sbx-heat)]" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sbx-caution)]" aria-hidden="true" />
                )}
                <span className="text-[12px] leading-[1.55] text-[var(--sbx-text-muted)]">{f.message}</span>
              </li>
            ))}
          </ul>
        )}

        {!blocked && findings && findings.findings.length === 0 && (
          <div className="flex items-center gap-2 border-b border-[var(--sbx-border)] px-5 py-3">
            <Check className="h-3.5 w-3.5 text-[var(--sbx-healthy)]" aria-hidden="true" />
            <span className="text-[12px] text-[var(--sbx-text-muted)]">Design checks passed.</span>
          </div>
        )}

        {!blocked && lastRun && (
          <div className="px-5 pb-5">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-4">
              <span className="text-right text-[12px] font-medium uppercase tracking-[0.14em] text-[var(--sbx-text-muted)]">
                Baseline
              </span>
              <span className="min-w-[9.5rem] text-center text-[10px] uppercase tracking-[0.16em] text-[var(--sbx-text-faint)] sm:min-w-[12rem]">
                vs
              </span>
              <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-[var(--sbx-primary-bright)]">
                Wattr control
              </span>
            </div>

            <div className="flex flex-col gap-5">
              <StatBlock title="Energy" rows={ENERGY_ROWS} baseline={lastRun.baseline} wattr={lastRun.wattr} />
              <StatBlock title="Safety" rows={SAFETY_ROWS} baseline={lastRun.baseline} wattr={lastRun.wattr} />
            </div>

            <p className="mt-5 border-t border-[var(--sbx-border-hairline)] pt-3 text-[10px] leading-[1.6] text-[var(--sbx-text-faint)]">
              Both columns are the same hall, stepped the same number of times, differing only in how
              the plant is driven. Highlighted values are the better of the two on that row. Energy
              and safety are shown together because they trade against each other: holding a hall
              inside its limits can cost power, and spending less can mean running it hot.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
