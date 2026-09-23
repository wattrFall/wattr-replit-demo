import type { ReplayInputRow, ReplayInputStatus, ReplayValidation } from "./types";

export const REPLAY_CSV_COLUMNS = [
  "timestamp",
  "rack_id",
  "workload_kw",
  "rack_power_kw",
  "ambient_c",
  "cooling_supply_c",
] as const;

const MAX_CSV_BYTES = 90_000;
const MAX_ROWS = 10_000;
const finite = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (quoted) throw new RangeError("CSV has an unterminated quoted value");
  row.push(value.replace(/\r$/, ""));
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

function timestamp(value: string): number | null {
  if (/^\d{1,10}$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed % 1000 === 0 ? parsed / 1000 : null;
}

export function validateReplayRows(rows: ReplayInputRow[], expectedRackIds: readonly string[]): ReplayValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const status: ReplayInputStatus = {
    workload: rows.some((row) => Number.isFinite(row.workloadKw)) ? "PRESENT" : "MISSING",
    rackPower: rows.some((row) => Number.isFinite(row.rackPowerKw)) ? "PRESENT" : "MISSING",
    environment: rows.some((row) => Number.isFinite(row.ambientC)) ? "PRESENT" : "MISSING",
    cooling: rows.some((row) => Number.isFinite(row.coolingSupplyC) || row.coolingFlowPct !== null) ? "PRESENT" : "MISSING",
    initialInlet: "MISSING",
  };
  if (status.workload === "MISSING") errors.push("Missing workload_kw boundary condition.");
  if (status.rackPower === "MISSING") errors.push("Missing rack_power_kw boundary condition.");
  if (status.environment === "MISSING") errors.push("Missing ambient_c environmental boundary condition.");
  if (status.cooling === "MISSING") errors.push("Missing supported cooling boundary condition (cooling_supply_c or cooling_flow_pct).");

  const expected = new Set(expectedRackIds);
  const byTimestamp = new Map<number, Set<string>>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!expected.has(row.rackId)) errors.push(`Rack ${row.rackId} is not supported by the selected historical model.`);
    const key = `${row.timestamp}:${row.rackId}`;
    if (seen.has(key)) errors.push(`Duplicate input row for ${row.rackId} at ${row.timestamp}.`);
    seen.add(key);
    const rackIds = byTimestamp.get(row.timestamp) ?? new Set<string>();
    rackIds.add(row.rackId);
    byTimestamp.set(row.timestamp, rackIds);
  }
  const timestamps = [...byTimestamp.keys()].sort((a, b) => a - b);
  status.initialInlet = hasHistoricalInitialInlets(rows, timestamps[0], expectedRackIds) ? "PRESENT" : "MISSING";
  if (timestamps.length < 2) errors.push("At least two timestamped samples are required for a historical replay.");
  const missingRacksByTimestamp = timestamps.map((at) => ({
    timestamp: at,
    rackIds: expectedRackIds.filter((rackId) => !byTimestamp.get(at)?.has(rackId)),
  })).filter((entry) => entry.rackIds.length > 0);
  if (missingRacksByTimestamp.length) errors.push("Every selected timestamp must include one row for every rack in the historical model.");
  if (!expectedRackIds.length) errors.push("The selected historical model has no supported racks.");
  if (timestamps.length && timestamps[timestamps.length - 1] - timestamps[0] > 7 * 24 * 60 * 60) {
    errors.push("Historical replay periods longer than seven days are unsupported.");
  }
  if (timestamps.some((at, index) => index > 0 && at <= timestamps[index - 1])) errors.push("Timestamps must be strictly increasing.");
  if (!errors.length && rows.some((row) => row.coolingFlowPct === null)) {
    warnings.push("cooling_flow_pct is not provided; cooling_supply_c is used as the supported cooling boundary.");
  }
  if (status.initialInlet === "MISSING") {
    warnings.push("No complete historical initial_inlet_c values exist at the period boundary; replay explicitly uses its documented 30°C synthetic initial thermal state.");
  }
  return { valid: errors.length === 0, inputStatus: status, errors, warnings, rowCount: rows.length, timestamps, missingRacksByTimestamp };
}

/** A state is usable only when every rack at the selected boundary supplied it. */
export function hasHistoricalInitialInlets(rows: ReplayInputRow[], at: number, expectedRackIds: readonly string[]): boolean {
  const values = new Map(rows.filter((row) => row.timestamp === at).map((row) => [row.rackId, row.initialInletC]));
  return expectedRackIds.length > 0 && expectedRackIds.every((rackId) => {
    const value = values.get(rackId);
    return value !== undefined && value !== null && Number.isFinite(value);
  });
}

/** Parse a deliberately constrained CSV. Values are stored only after this validation succeeds. */
export function parseReplayCsv(csv: string, expectedRackIds: readonly string[]): { rows: ReplayInputRow[]; validation: ReplayValidation } {
  if (typeof csv !== "string" || !csv.trim()) throw new RangeError("A non-empty CSV upload is required.");
  if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) throw new RangeError(`CSV upload exceeds the ${MAX_CSV_BYTES.toLocaleString()} byte replay limit.`);
  const records = parseCsv(csv);
  if (!records.length) throw new RangeError("CSV has no header row.");
  const header = records[0].map((value) => value.trim().toLowerCase());
  const duplicates = header.filter((name, index) => header.indexOf(name) !== index);
  if (duplicates.length) throw new RangeError(`CSV repeats header ${duplicates[0]}.`);
  const positions = new Map(header.map((name, index) => [name, index]));
  const missingColumns = REPLAY_CSV_COLUMNS.filter((column) => !positions.has(column));
  if (missingColumns.length) throw new RangeError(`CSV is missing required columns: ${missingColumns.join(", ")}.`);
  if (records.length - 1 > MAX_ROWS) throw new RangeError(`CSV has more than ${MAX_ROWS.toLocaleString()} rows.`);
  const flowIndex = positions.get("cooling_flow_pct");
  const initialInletIndex = positions.get("initial_inlet_c");
  const errors: string[] = [];
  const rows: ReplayInputRow[] = [];
  records.slice(1).forEach((record, index) => {
    const at = timestamp(record[positions.get("timestamp")!] ?? "");
    const rackId = (record[positions.get("rack_id")!] ?? "").trim();
    const numerics = ["workload_kw", "rack_power_kw", "ambient_c", "cooling_supply_c"] as const;
    if (record.length !== header.length) errors.push(`Row ${index + 2} has ${record.length} fields; expected ${header.length}.`);
    if (at === null) errors.push(`Row ${index + 2} has an invalid timestamp.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rackId)) errors.push(`Row ${index + 2} has an invalid rack_id.`);
    for (const column of numerics) {
      if (!finite(record[positions.get(column)!] ?? "")) errors.push(`Row ${index + 2} has no finite ${column}.`);
    }
    const workload = Number(record[positions.get("workload_kw")!] ?? "");
    const rackPower = Number(record[positions.get("rack_power_kw")!] ?? "");
    const ambient = Number(record[positions.get("ambient_c")!] ?? "");
    const supply = Number(record[positions.get("cooling_supply_c")!] ?? "");
    if (Number.isFinite(workload) && workload < 0) errors.push(`Row ${index + 2} workload_kw cannot be negative.`);
    if (Number.isFinite(rackPower) && rackPower < 0) errors.push(`Row ${index + 2} rack_power_kw cannot be negative.`);
    if (Number.isFinite(ambient) && (ambient < -30 || ambient > 60)) errors.push(`Row ${index + 2} ambient_c is outside the supported -30 to 60°C range.`);
    if (Number.isFinite(supply) && (supply < 0 || supply > 40)) errors.push(`Row ${index + 2} cooling_supply_c is outside the supported 0 to 40°C range.`);
    const flowRaw = flowIndex === undefined ? "" : record[flowIndex] ?? "";
    const initialInletRaw = initialInletIndex === undefined ? "" : record[initialInletIndex] ?? "";
    if (flowRaw.trim() !== "" && (!finite(flowRaw) || Number(flowRaw) < 0 || Number(flowRaw) > 100)) {
      errors.push(`Row ${index + 2} cooling_flow_pct must be between 0 and 100 when supplied.`);
    }
    if (initialInletRaw.trim() !== "" && (!finite(initialInletRaw) || Number(initialInletRaw) < 10 || Number(initialInletRaw) > 60)) {
      errors.push(`Row ${index + 2} initial_inlet_c must be between 10 and 60°C when supplied.`);
    }
    if (at !== null && rackId && numerics.every((column) => finite(record[positions.get(column)!] ?? ""))) {
      rows.push({
        timestamp: at, rackId,
        workloadKw: Number(record[positions.get("workload_kw")!]),
        rackPowerKw: Number(record[positions.get("rack_power_kw")!]),
        ambientC: Number(record[positions.get("ambient_c")!]),
        coolingSupplyC: Number(record[positions.get("cooling_supply_c")!]),
        coolingFlowPct: flowRaw.trim() === "" ? null : Number(flowRaw),
        initialInletC: initialInletRaw.trim() === "" ? null : Number(initialInletRaw),
      });
    }
  });
  if (errors.length) throw new RangeError(errors.slice(0, 8).join(" "));
  const validation = validateReplayRows(rows, expectedRackIds);
  return { rows: rows.sort((a, b) => a.timestamp - b.timestamp || a.rackId.localeCompare(b.rackId)), validation };
}

/** Clearly labelled sample input for the demo; it is never passed off as uploaded history. */
export function syntheticReplayCsv(rackIds: readonly string[], startAt = 1_752_676_800): string {
  const header = [...REPLAY_CSV_COLUMNS, "cooling_flow_pct"].join(",");
  const lines = [header];
  for (let offset = 0; offset <= 1_800; offset += 300) {
    rackIds.forEach((rackId, index) => {
      const workload = 420 + offset / 30 + index * 8;
      lines.push([startAt + offset, rackId, workload, workload * 0.82, 28 + offset / 900, 20.5, 70].join(","));
    });
  }
  return lines.join("\n");
}