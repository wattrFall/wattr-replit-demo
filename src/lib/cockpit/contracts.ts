/**
 * Canonical product contracts shared by persistence, API read models, and the
 * deterministic cockpit replay.  These are deliberately small and JSON-safe:
 * a real telemetry provider can implement the same vocabulary without changing
 * the operator-facing model.
 */

export const CONTRACT_VERSION = "wattr.contracts.v1" as const;

export type ContractVersion = typeof CONTRACT_VERSION;
export type ProvenanceKind = "SIMULATED" | "MEASURED" | "IMPORTED" | "CURATED";
export type SyntheticStatus = "SYNTHETIC" | "OBSERVED" | "MIXED";
export type DataQuality = "GOOD" | "DEGRADED" | "UNKNOWN";
export type QuantityUnit = "kW" | "kWh" | "°C" | "K" | "%" | "s" | "min" | "count";
export type ModelVersionRef = string;

export interface Quantity {
  value: number;
  unit: QuantityUnit;
}

export interface Provenance {
  kind: ProvenanceKind;
  syntheticStatus: SyntheticStatus;
  source: string;
  sourceRevision: string | null;
  generatedAt: string;
}

export interface CanonicalRecord {
  contractVersion: ContractVersion;
  id: string;
  facilityId: string;
  modelVersionId: ModelVersionRef;
  provenance: Provenance;
  quality: DataQuality;
}

export interface ScenarioContract extends CanonicalRecord {
  scenarioKey: "gpu-training-ramp-v1";
  name: string;
  simulatedStartAt: number;
  durationS: number;
  seed: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
}

export interface ReplayCheckpointContract extends CanonicalRecord {
  scenarioId: string;
  simulatedAt: number;
  elapsedS: number;
  state: Record<string, unknown>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;

export function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isFiniteQuantity(value: unknown, unit: QuantityUnit): value is Quantity {
  return typeof value === "object" && value !== null &&
    Number.isFinite((value as Quantity).value) && (value as Quantity).unit === unit;
}

export function quantity(value: number, unit: QuantityUnit): Quantity {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid ${unit} quantity`);
  return { value, unit };
}

export function isScenarioTimestamp(
  value: unknown,
  startAt: number,
  durationS: number,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= startAt && value <= startAt + durationS;
}

export function assertModelConfig(value: unknown): asserts value is {
  scenario: "gpu-training-ramp-v1";
  seed: number;
  thermalMass: number;
  responseLag: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Invalid facility model configuration");
  }
  const config = value as Record<string, unknown>;
  const thermalMass = config.thermalMass;
  const responseLag = config.responseLag;
  if (
    config.scenario !== "gpu-training-ramp-v1" ||
    !Number.isSafeInteger(config.seed) ||
    typeof thermalMass !== "number" || thermalMass < 0.2 || thermalMass > 2 ||
    typeof responseLag !== "number" || responseLag < 1 || responseLag > 120
  ) {
    throw new RangeError("Invalid facility model configuration");
  }
}

export function syntheticProvenance(
  generatedAt = new Date(0).toISOString(),
  sourceRevision = "gpu-training-ramp-v1",
): Provenance {
  return {
    kind: "SIMULATED",
    syntheticStatus: "SYNTHETIC",
    source: "Wattr deterministic simulation",
    sourceRevision,
    generatedAt,
  };
}

export function provenanceForRecord(record: {
  provenance?: string;
  synthetic_status?: string;
  created_at?: string;
  generated_at?: string;
  model_version_id?: string;
}): Provenance {
  const generatedAt = record.generated_at ?? record.created_at;
  return {
    ...syntheticProvenance(
      generatedAt ? new Date(generatedAt).toISOString() : undefined,
      record.model_version_id ?? "gpu-training-ramp-v1",
    ),
    kind: (record.provenance ?? "SIMULATED") as ProvenanceKind,
    syntheticStatus: (record.synthetic_status ?? "SYNTHETIC") as SyntheticStatus,
  };
}