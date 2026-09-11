/**
 * Design checks, run before a simulation.
 *
 * A simulation of an incoherent hall is worse than no simulation: it produces
 * numbers that look authoritative and mean nothing. So the run is gated, and
 * every problem is phrased as something the user can act on.
 *
 * The split matters. An ERROR means the model cannot say anything useful — a
 * rack with no cooling has no steady state to report. A WARNING means the run
 * is valid but the design is odd, and the user is told rather than stopped.
 *
 * Pure functions over the layout: no store, no rendering.
 */
import { rackHeatKw } from "./model";
import type { SandboxItem, SandboxLayout } from "./types";

export interface Finding {
  severity: "error" | "warning";
  message: string;
  /** Items the finding is about, so the UI can point at them. */
  itemIds: string[];
}

export interface ValidationResult {
  findings: Finding[];
  errors: Finding[];
  warnings: Finding[];
  ok: boolean;
}

const isCooling = (item: SandboxItem) => item.kind === "crac" || item.kind === "cdu";

export function validateLayout(layout: SandboxLayout): ValidationResult {
  const findings: Finding[] = [];
  const { items, connections } = layout;

  const racks = items.filter((i) => i.kind === "rack");
  const coolers = items.filter(isCooling);
  const chillers = items.filter((i) => i.kind === "chiller");
  const sensors = items.filter((i) => i.kind === "sensor");

  const feeds = (fromId: string, toId: string) =>
    connections.some((c) => c.fromId === fromId && c.toId === toId);

  // --- errors -------------------------------------------------------------
  if (racks.length === 0) {
    findings.push({
      severity: "error",
      message: "No racks placed. The hall has no load to cool.",
      itemIds: [],
    });
  }

  const unserved = racks.filter((r) => !coolers.some((c) => feeds(c.id, r.id)));
  if (unserved.length > 0) {
    findings.push({
      severity: "error",
      message: `${unserved.length} rack${unserved.length > 1 ? "s have" : " has"} no cooling connected. Connect a CRAC unit or CDU to each rack.`,
      itemIds: unserved.map((r) => r.id),
    });
  }

  const unchilled = coolers.filter((c) => !chillers.some((ch) => feeds(ch.id, c.id)));
  if (unchilled.length > 0) {
    findings.push({
      severity: "error",
      message: `${unchilled.length} cooling unit${unchilled.length > 1 ? "s have" : " has"} no chiller behind ${unchilled.length > 1 ? "them" : "it"}. Heat collected from the racks has nowhere to go.`,
      itemIds: unchilled.map((c) => c.id),
    });
  }

  const itLoadKw = racks.reduce((sum, r) => sum + rackHeatKw(r), 0);

  // The chiller's rated capacity finally does something: it is the ceiling for
  // everything upstream, exactly as its own parameter hint claims.
  const rejectionKw = chillers.reduce((sum, c) => sum + (c.params.capacityKw ?? 200), 0);
  if (chillers.length > 0 && rejectionKw < itLoadKw) {
    findings.push({
      severity: "error",
      message: `Chiller capacity (${rejectionKw.toFixed(0)} kW) is below the IT load (${itLoadKw.toFixed(0)} kW). The plant cannot reject the heat the hall makes.`,
      itemIds: chillers.map((c) => c.id),
    });
  }

  const coolingKw = coolers.reduce((sum, c) => sum + (c.params.capacityKw ?? 60), 0);
  if (coolers.length > 0 && coolingKw < itLoadKw) {
    findings.push({
      severity: "error",
      message: `Cooling capacity (${coolingKw.toFixed(0)} kW) is below the IT load (${itLoadKw.toFixed(0)} kW). Add capacity or reduce load.`,
      itemIds: coolers.map((c) => c.id),
    });
  }

  // --- warnings -----------------------------------------------------------
  // Sensors are what the results screen reports inlet readings from, so a hall
  // without them is running blind even though the model still solves.
  if (racks.length > 0 && sensors.length === 0) {
    findings.push({
      severity: "warning",
      message: "No sensors placed. The hall will run, but nothing on the floor is reporting inlet temperature.",
      itemIds: [],
    });
  }

  const unwatched = racks.filter((r) => !sensors.some((s) => feeds(s.id, r.id)));
  if (sensors.length > 0 && unwatched.length > 0) {
    findings.push({
      severity: "warning",
      message: `${unwatched.length} rack${unwatched.length > 1 ? "s are" : " is"} not covered by a sensor.`,
      itemIds: unwatched.map((r) => r.id),
    });
  }

  const idleCoolers = coolers.filter((c) => !racks.some((r) => feeds(c.id, r.id)));
  if (idleCoolers.length > 0) {
    findings.push({
      severity: "warning",
      message: `${idleCoolers.length} cooling unit${idleCoolers.length > 1 ? "s are" : " is"} connected to no rack, so ${idleCoolers.length > 1 ? "they draw" : "it draws"} power for nothing.`,
      itemIds: idleCoolers.map((c) => c.id),
    });
  }

  // A CRAC that cannot move the air its capacity implies will never reach
  // nameplate, however hard the controller pushes it.
  const starved = coolers.filter((c) => {
    if (c.kind !== "crac") return false;
    const needed = 9000 * ((c.params.capacityKw ?? 60) / 60);
    return (c.params.airflowCmh ?? 9000) < needed * 0.6;
  });
  if (starved.length > 0) {
    findings.push({
      severity: "warning",
      message: `${starved.length} CRAC unit${starved.length > 1 ? "s move" : " moves"} too little air for ${starved.length > 1 ? "their" : "its"} rated capacity, and will not reach it.`,
      itemIds: starved.map((c) => c.id),
    });
  }

  const overTight = racks.filter((r) => (r.params.inletLimitC ?? 27) < 20);
  if (overTight.length > 0) {
    findings.push({
      severity: "warning",
      message: `${overTight.length} rack${overTight.length > 1 ? "s have" : " has"} an inlet limit below 20 °C, which is colder than the plant can hold.`,
      itemIds: overTight.map((r) => r.id),
    });
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { findings, errors, warnings, ok: errors.length === 0 };
}

/** One-line summary for the run button. */
export function validationSummary(result: ValidationResult): string {
  if (result.ok && result.warnings.length === 0) return "Design checks passed.";
  if (result.ok) {
    return `${result.warnings.length} warning${result.warnings.length > 1 ? "s" : ""}, safe to run.`;
  }
  return `${result.errors.length} problem${result.errors.length > 1 ? "s" : ""} to fix before running.`;
}
