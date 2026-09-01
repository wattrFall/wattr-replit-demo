export type DemoStageId = "demand" | "predict" | "review";

export const demoMetadata = {
  title: "Wattr Cooling Sandbox",
  description: "An interactive illustrative cooling sandbox.",
  canonicalUrl: null,
} as const;

export interface DemoControlInputs {
  workloadMultiplier: number;
  pumpSpeedFraction: number;
  supplyTemperatureC: number;
}

export interface DemoValidatedOutputs {
  itHeatKw: number;
  returnTemperatureC: number;
  pumpPowerKw: number;
  ratedCapacityMarginKw: number;
}

export interface DemoStage {
  id: DemoStageId;
  eyebrow: string;
  title: string;
  narrative: string;
  primaryResult: {
    label: string;
    value: string;
    detail: string;
  };
  state: "signal" | "prediction" | "operator-review";
  affectedRacks: readonly number[];
  signalItHeatKw: number | null;
  controls: DemoControlInputs;
  outputs: DemoValidatedOutputs;
}

export interface DemoScenario {
  id: string;
  label: string;
  provenance: {
    source: string;
    sourceRevision: string;
    generatedAt: string;
    reviewedAt: string;
  };
  modelScope: string;
  limitations: readonly string[];
  savingsEstimatePercent: number | null;
  topology: {
    rackGroups: number;
    pumpCount: number;
    heatExchangerCount: number;
    ratedCoolingCapacityKw: number;
    referenceWaterSideHeatRemovalKw: number;
    referenceLoopDeltaK: number;
    nominalMassFlowKgS: number;
  };
  baseline: {
    controls: DemoControlInputs;
    outputs: DemoValidatedOutputs;
  };
  stages: readonly DemoStage[];
}

export const demoScenario = {
  id: "container-dc-liquid-loop-public-v2",
  label: "Reviewed reference environment · Direct-to-chip liquid cooling · AI demand increase",
  provenance: {
    source: "Cooling Twin Forge curated container liquid-loop reference",
    sourceRevision: "1027824",
    generatedAt: "2026-07-16",
    reviewedAt: "2026-07-16",
  },
  modelScope: "Steady-state water-side reference used to explain the decision path, not to represent a live facility.",
  limitations: [
    "Pressure drop is not represented in this reference.",
    "Facility-side heat rejection is simplified.",
    "Site energy impact requires a measured baseline and read-only pilot.",
  ],
  savingsEstimatePercent: null,
  topology: {
    rackGroups: 4,
    pumpCount: 1,
    heatExchangerCount: 1,
    ratedCoolingCapacityKw: 60,
    referenceWaterSideHeatRemovalKw: 52.67,
    referenceLoopDeltaK: 9,
    nominalMassFlowKgS: 1.4,
  },
  baseline: {
    controls: {
      workloadMultiplier: 1,
      pumpSpeedFraction: 0.85,
      supplyTemperatureC: 21,
    },
    outputs: {
      itHeatKw: 44,
      returnTemperatureC: 29.84564352056612,
      pumpPowerKw: 1.22825,
      ratedCapacityMarginKw: 16,
    },
  },
  stages: [
    {
      id: "demand",
      eyebrow: "01 · AI demand arrives",
      title: "The cooling decision starts with the workload signal.",
      narrative: "An incoming inference workload would raise IT heat from the 44 kW reference state to 55 kW across all four rack groups. Wattr begins in read-only mode: observe the change before proposing a control response.",
      primaryResult: {
        label: "Incoming IT heat",
        value: "+11 kW",
        detail: "44 kW reference → 55 kW requested",
      },
      state: "signal",
      affectedRacks: [1, 2, 3, 4],
      signalItHeatKw: 55,
      controls: {
        workloadMultiplier: 1,
        pumpSpeedFraction: 0.85,
        supplyTemperatureC: 21,
      },
      outputs: {
        itHeatKw: 44,
        returnTemperatureC: 29.84564352056612,
        pumpPowerKw: 1.22825,
        ratedCapacityMarginKw: 16,
      },
    },
    {
      id: "predict",
      eyebrow: "02 · Wattr predicts the constraint",
      title: "The same pump setting produces a hotter return path.",
      narrative: "At the current 85% pump command, the steady-state reference predicts the return temperature rising as the 55 kW workload reaches the loop. The exchanger remains below its rated capacity, but the operating condition has changed enough to review before control.",
      primaryResult: {
        label: "Predicted return",
        value: "≈ 32.06 °C",
        detail: "At 55 kW IT heat and the current pump command",
      },
      state: "prediction",
      affectedRacks: [1, 2, 3, 4],
      signalItHeatKw: 55,
      controls: {
        workloadMultiplier: 1.25,
        pumpSpeedFraction: 0.85,
        supplyTemperatureC: 21,
      },
      outputs: {
        itHeatKw: 55,
        returnTemperatureC: 32.05705440070765,
        pumpPowerKw: 1.22825,
        ratedCapacityMarginKw: 5,
      },
    },
    {
      id: "review",
      eyebrow: "03 · Review the safe control path",
      title: "A bounded action stays with the operator.",
      narrative: "Wattr can compare a pump increase against configured limits, show the predicted trade-off, and flag that workload placement still needs review. The operator approves the action today; guarded execution follows only after site-specific validation, fallback testing, and human override are in place.",
      primaryResult: {
        label: "Control authority",
        value: "Operator approval",
        detail: "Guarded execution is a validated destination",
      },
      state: "operator-review",
      affectedRacks: [1, 2, 3, 4],
      signalItHeatKw: 55,
      controls: {
        workloadMultiplier: 1.25,
        pumpSpeedFraction: 1,
        supplyTemperatureC: 21,
      },
      outputs: {
        itHeatKw: 55,
        returnTemperatureC: 30.398496240601503,
        pumpPowerKw: 2,
        ratedCapacityMarginKw: 5,
      },
    },
  ],
} as const satisfies DemoScenario;
