import { AlertTriangle, Check } from "lucide-react";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SPanel } from "../primitives/SPanel";

const kw = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} kW`;

/** One label/value row. Values are monospaced so they stop jittering as they tick. */
function Row({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 py-1.5">
      <span className="text-[11px] text-[var(--sbx-text-faint)]">{label}</span>
      <span
        className="font-[family-name:var(--sbx-font-mono)] text-[12px]"
        style={{ color: tone === "warn" ? "var(--sbx-heat)" : "var(--sbx-text)" }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The hall's live readout.
 *
 * Values come from the published simulation snapshot, which updates ten times a
 * second rather than every frame — fast enough to feel live, slow enough to
 * read.
 */
export function Telemetry() {
  const telemetry = useSandboxStore((s) => s.telemetry);
  const controlMode = useSandboxStore((s) => s.controlMode);

  if (!telemetry || telemetry.rackCount === 0) {
    return (
      <SPanel title="Telemetry">
        <p className="px-3.5 py-4 text-[12px] leading-[1.6] text-[var(--sbx-text-faint)]">
          Place a rack and connect cooling to see the hall respond.
        </p>
      </SPanel>
    );
  }

  const { pue, maxInletC, meanInletC, racksAtRisk, unservedRacks } = telemetry;
  const healthy = racksAtRisk === 0 && unservedRacks === 0;

  return (
    <SPanel title="Telemetry">
      <div className="border-b border-[var(--sbx-border-hairline)] px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--sbx-text-faint)]">
            PUE
          </span>
          <span
            className="font-[family-name:var(--sbx-font-mono)] text-[26px] leading-none"
            style={{
              color: controlMode === "wattr" ? "var(--sbx-healthy)" : "var(--sbx-text)",
            }}
          >
            {pue === null ? "—" : pue.toFixed(3)}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] leading-[1.5] text-[var(--sbx-text-faint)]">
          {controlMode === "wattr"
            ? "Wattr control: setpoints reset upward, fans trimmed to need."
            : "Baseline: fixed setpoints, fans left as configured."}
        </p>
      </div>

      <div className="divide-y divide-[var(--sbx-border-hairline)]">
        <div className="py-1">
          <Row label="IT power" value={kw(telemetry.itPowerKw)} />
          <Row label="Fans / pumps" value={kw(telemetry.fanPowerKw)} />
          <Row label="Chiller" value={kw(telemetry.chillerPowerKw)} />
          <Row label="Total draw" value={kw(telemetry.totalPowerKw)} />
        </div>

        <div className="py-1">
          <Row
            label="Mean inlet"
            value={meanInletC === null ? "—" : `${meanInletC.toFixed(1)} °C`}
          />
          <Row
            label="Peak inlet"
            value={maxInletC === null ? "—" : `${maxInletC.toFixed(1)} °C`}
            tone={racksAtRisk > 0 ? "warn" : undefined}
          />
          {telemetry.chilledWaterC !== null && (
            <Row label="Chilled water" value={`${telemetry.chilledWaterC.toFixed(1)} °C`} />
          )}
          {telemetry.meanFan !== null && (
            <Row label="Mean fan" value={`${(telemetry.meanFan * 100).toFixed(0)} %`} />
          )}
        </div>
      </div>

      {/* Always shown, both ways. Control sometimes spends a little more power
          to bring a hall back inside its limits, and that trade is only legible
          if the safe state is stated as plainly as the unsafe one. */}
      <div
        className="flex items-start gap-2 border-t border-[var(--sbx-border-hairline)] px-3.5 py-2.5"
        style={{
          background: healthy ? "color-mix(in srgb, var(--sbx-healthy) 6%, transparent)" : "color-mix(in srgb, var(--sbx-heat) 7%, transparent)",
        }}
      >
        {healthy ? (
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sbx-healthy)]" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sbx-heat)]" aria-hidden="true" />
        )}
        <p className="text-[11px] leading-[1.5] text-[var(--sbx-text-muted)]">
          {healthy ? (
            <>Every rack within its inlet limit.</>
          ) : (
            <>
              {unservedRacks > 0 && (
                <>
                  {unservedRacks} rack{unservedRacks > 1 ? "s" : ""} with no cooling connected.{" "}
                </>
              )}
              {racksAtRisk > 0 && (
                <>
                  {racksAtRisk} rack{racksAtRisk > 1 ? "s" : ""} at or above the inlet limit.
                </>
              )}
            </>
          )}
        </p>
      </div>
    </SPanel>
  );
}
