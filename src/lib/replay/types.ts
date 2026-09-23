import type { FacilityModelConfig } from "@/lib/cockpit/simulation";

/** CSV columns intentionally stay small and map to supported boundary conditions. */
export type ReplayInputRow = {
  timestamp: number;
  rackId: string;
  workloadKw: number;
  rackPowerKw: number;
  ambientC: number;
  coolingSupplyC: number;
  coolingFlowPct: number | null;
  /** Optional measured state at a period boundary; never silently fabricated. */
  initialInletC: number | null;
};

export type ReplayInputStatus = {
  workload: "PRESENT" | "MISSING";
  rackPower: "PRESENT" | "MISSING";
  environment: "PRESENT" | "MISSING";
  cooling: "PRESENT" | "MISSING";
  initialInlet: "PRESENT" | "MISSING";
};

export type ReplayValidation = {
  valid: boolean;
  inputStatus: ReplayInputStatus;
  errors: string[];
  warnings: string[];
  rowCount: number;
  timestamps: number[];
  missingRacksByTimestamp: Array<{ timestamp: number; rackIds: string[] }>;
};

export type HistoricalDataset = {
  id: string;
  facilityId: string;
  source: "UPLOADED_CSV" | "SYNTHETIC_DEMO";
  sourceName: string;
  checksum: string;
  rows: ReplayInputRow[];
  validation: ReplayValidation;
  periodStartAt: number;
  periodEndAt: number;
  createdAt?: string;
};

export type RackRelocation = {
  rackId: string;
  to: { x: number; z: number };
};

export type HistoricalScenario = {
  id: string;
  facilityId: string;
  datasetId: string;
  name: string;
  status: "DRAFT" | "SAVED_FOR_REVIEW";
  periodStartAt: number;
  periodEndAt: number;
  historicalModelVersionId: string;
  baselineModelConfig: FacilityModelConfig;
  relocation: RackRelocation;
  assumptions: string[];
  missingInputs: string[];
  validationStatus: "VALID" | "INVALID";
  source: HistoricalDataset["source"];
  createdAt?: string;
  createdBy?: string;
};

export type ReplayTimePoint = {
  timestamp: number;
  peakInletC: number;
  meanInletC: number;
  thermalHeadroomC: number;
  hotspot: boolean;
  violations: number;
};

export type ReplayRawPoint = ReplayTimePoint & {
  racks: Array<{ rackId: string; inletC: number; limitC: number; spatialAdjustmentC: number }>;
};

export type ThermalComparison = {
  baseline: number;
  candidate: number;
  difference: number;
};

export type HistoricalReplayResult = {
  scenarioId: string;
  simulated: true;
  source: HistoricalDataset["source"];
  sourceName: string;
  period: { startAt: number; endAt: number };
  model: { versionId: string; config: FacilityModelConfig };
  inputFingerprint: string;
  assumptions: string[];
  missingInputs: string[];
  validationStatus: "VALID" | "INVALID";
  method: "CONSTRAINED_SPATIAL_THERMAL_APPROXIMATION";
  limitation: string;
  metrics: {
    thermalPeakC: ThermalComparison;
    meanInletC: ThermalComparison;
    thermalHeadroomC: ThermalComparison;
    hotspotDurationS: ThermalComparison;
    thermalLimitViolations: ThermalComparison;
  };
  unsupportedMetrics: string[];
  spatialLayouts: {
    relocatedRackId: string;
    baselineRacks: Array<{ rackId: string; x: number; z: number }>;
    candidateRacks: Array<{ rackId: string; x: number; z: number }>;
  };
  baselineSeries: ReplayTimePoint[];
  candidateSeries: ReplayTimePoint[];
  baselineRawOutputs: ReplayRawPoint[];
  candidateRawOutputs: ReplayRawPoint[];
};