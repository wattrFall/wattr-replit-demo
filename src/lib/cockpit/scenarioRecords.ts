/**
 * The incident and recommendation the GPU Training Ramp raises for a facility
 * model.
 *
 * Operations works through one scenario incident and one advisory for the
 * cooling unit serving the most IT load. When a different model is published,
 * the server rebinds those records to it with this content, so the incident,
 * Safety Shield and decision workflow follow the build. Models saved before
 * the Builder get the SFO-01 records exactly as they are seeded.
 */
import { BUILD_WORKLOAD_ID } from "./facilityAssets";
import {
  DEFAULT_ADVISORY_PARAMETERS,
  SCENARIO_START_S,
  facilityPlant,
  rackLabel,
  replayCockpitSnapshot,
  type FacilityModelConfig,
} from "./simulation";

/** When the scenario incident and recommendation are raised: eleven minutes into the ramp. */
export const SCENARIO_INCIDENT_AT = SCENARIO_START_S + 660;

/** Incidents whose deduplication key ends this way are the scenario's own. */
export const SCENARIO_INCIDENT_KEY_SUFFIX = ":thermal-response";

export interface ScenarioSignal {
  id: string;
  assetId: string;
  metric: string;
  direction: string;
}

export interface ScenarioIncidentRecord {
  title: string;
  affectedAssets: string[];
  likelyCause: string;
  correlatedSignals: ScenarioSignal[];
  thermalPath: string[];
  deduplicationKey: string;
}

export interface ScenarioRecommendationRecord {
  title: string;
  rationale: string;
  command: { assetId: string; flowPercent: number; durationMinutes: number };
  explanation: {
    what: string;
    why: string;
    where: string;
    expectedEffect: string;
    confidence: string;
    provenance: "SIMULATED";
  };
  evidence: string[];
}

export interface ScenarioRecords {
  incident: ScenarioIncidentRecord;
  recommendation: ScenarioRecommendationRecord;
}

const EXPECTED_EFFECT = "Reduce modeled peak inlet temperature and constraint exposure.";
const CONFIDENCE = "Forecast confidence declines with horizon and is valid only inside the disclosed model domain.";

/** The SFO-01 records, identical to the rows database/schema.sql seeds. */
export const REFERENCE_SCENARIO_RECORDS: ScenarioRecords = {
  incident: {
    title: "CDU-03 thermal response degradation",
    affectedAssets: ["GPU Hall B", "Rows 12–16", "CDU-03"],
    likelyCause: "Reduced CDU flow response during the workload ramp",
    correlatedSignals: [
      { id: "signal-workload-ramp", assetId: "gpu-b", metric: "scheduled_load", direction: "rising" },
      { id: "signal-rack-inlet", assetId: "rack-b02", metric: "inlet_temperature", direction: "rising" },
      { id: "signal-cdu-lag", assetId: "cdu-03", metric: "pump_response", direction: "lagging" },
    ],
    thermalPath: ["gpu-b", "rack-b02", "cdu-03", "primary-loop", "chiller-01"],
    deduplicationKey: `gpu-training-ramp-v1:cdu-03${SCENARIO_INCIDENT_KEY_SUFFIX}`,
  },
  recommendation: {
    title: "Pre-emptive CDU-03 flow adjustment",
    rationale: "Increase CDU-03 flow before the workload ramp reaches the thermal constraint.",
    command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    explanation: {
      what: "Increase CDU-03 flow to 78% for 20 minutes.",
      why: "Pre-empt the modeled CDU-03 response lag before the workload ramp reaches the thermal constraint.",
      where: "GPU Hall B · GPU Training Zone · CDU-03 serving racks A01–B02.",
      expectedEffect: EXPECTED_EFFECT,
      confidence: CONFIDENCE,
      provenance: "SIMULATED",
    },
    evidence: ["GPU Training Ramp event stream", "Rack inlet temperature trend", "CDU-03 response lag", "Primary-loop thermal path"],
  },
};

/** The scenario records for a facility model. */
export function scenarioRecords(config: FacilityModelConfig): ScenarioRecords {
  if (!config.layout) return REFERENCE_SCENARIO_RECORDS;

  const plant = facilityPlant(config);
  const unit = plant.advisedUnit;
  const label = plant.advisedLabel;
  const liquid = unit.kind === "cdu";
  const snapshot = replayCockpitSnapshot(SCENARIO_INCIDENT_AT, config);
  const hotRack = plant.items.find((item) => item.kind === "rack" && rackLabel(item.id) === snapshot.incident.rackId);
  const chillers = plant.connections.filter((link) => link.toId === unit.id).map((link) => link.fromId);
  const racks = plant.advisedRacks;
  const rackSpan = racks.length > 1 ? `Racks ${racks[0]}–${racks[racks.length - 1]}` : `Rack ${racks[0] ?? "none"}`;

  return {
    incident: {
      title: `${label} thermal response degradation`,
      affectedAssets: [plant.advisedZone, rackSpan, label],
      likelyCause: `Reduced ${liquid ? "CDU flow" : "CRAC airflow"} response during the workload ramp`,
      correlatedSignals: [
        { id: "signal-workload-ramp", assetId: BUILD_WORKLOAD_ID, metric: "scheduled_load", direction: "rising" },
        ...(hotRack ? [{ id: "signal-rack-inlet", assetId: hotRack.id, metric: "inlet_temperature", direction: "rising" }] : []),
        { id: "signal-cooling-lag", assetId: unit.id, metric: liquid ? "pump_response" : "fan_response", direction: "lagging" },
      ],
      thermalPath: [BUILD_WORKLOAD_ID, ...(hotRack ? [hotRack.id] : []), unit.id, ...chillers],
      deduplicationKey: `gpu-training-ramp-v1:${unit.id}${SCENARIO_INCIDENT_KEY_SUFFIX}`,
    },
    recommendation: {
      title: `Pre-emptive ${label} flow adjustment`,
      rationale: `Increase ${label} flow before the workload ramp reaches the thermal constraint.`,
      command: { assetId: unit.id, ...DEFAULT_ADVISORY_PARAMETERS },
      explanation: {
        what: snapshot.recommendation.what,
        why: snapshot.recommendation.why,
        where: snapshot.recommendation.where,
        expectedEffect: EXPECTED_EFFECT,
        confidence: CONFIDENCE,
        provenance: "SIMULATED",
      },
      evidence: [
        "GPU Training Ramp event stream",
        "Rack inlet temperature trend",
        `${label} response lag`,
        chillers.length ? "Chilled-water thermal path" : "Cooling-unit thermal path",
      ],
    },
  };
}
