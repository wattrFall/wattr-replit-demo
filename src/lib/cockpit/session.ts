import { create } from "zustand";
import {
  advanceCockpitSimulation,
  createCockpitSimulation,
  SIM_DT_S,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  type CockpitSimulationState,
  type FacilityModelConfig,
  DEFAULT_FACILITY_MODEL,
  facilityPlant,
} from "./simulation";
import { facilityAssets } from "./facilityAssets";

export { SCENARIO_START_S } from "./simulation";

type ScenarioSession = {
  scenarioId: "gpu-training-ramp-v1";
  simulatedAt: number;
  playing: boolean;
  speed: 1 | 5 | 10 | 30 | 60;
  mode: "Observe" | "Shadow" | "Advisory";
  simulation: CockpitSimulationState;
  modelConfig: FacilityModelConfig;
  selectedAssetId: string;
  selectedFloor: 1 | 2;
  highlightedPath: string[];
  focusedIncidentId: string | null;
  focusedRecommendationId: string | null;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: ScenarioSession["speed"]) => void;
  setMode: (mode: ScenarioSession["mode"]) => void;
  setModelConfig: (config: FacilityModelConfig) => void;
  selectAsset: (assetId: string) => void;
  focusTwin: (focus: {
    assetId?: string;
    floor?: 1 | 2;
    path?: string[];
    incidentId?: string;
    recommendationId?: string;
    simulatedAt?: number;
  }) => void;
  advance: (seconds: number) => void;
  step: (seconds?: number) => void;
  jump: (elapsedSeconds: number) => void;
  reset: () => void;
};

export const useScenarioSession = create<ScenarioSession>((set) => ({
  scenarioId: "gpu-training-ramp-v1",
  simulatedAt: SCENARIO_START_S,
  playing: false,
  speed: 1,
  mode: "Advisory",
  simulation: createCockpitSimulation(SCENARIO_START_S),
  modelConfig: DEFAULT_FACILITY_MODEL,
  selectedAssetId: "cdu-03",
  selectedFloor: 1,
  highlightedPath: [],
  focusedIncidentId: null,
  focusedRecommendationId: null,
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode }),
  selectAsset: (selectedAssetId) => set({ selectedAssetId }),
  focusTwin: (focus) => set((state) => {
    const targetTime = focus.simulatedAt;
    const simulation = targetTime === undefined
      ? state.simulation
      : advanceCockpitSimulation(
          createCockpitSimulation(SCENARIO_START_S, state.modelConfig),
          Math.min(SCENARIO_DURATION_S, Math.max(0, targetTime - SCENARIO_START_S)),
          SCENARIO_START_S,
          state.modelConfig,
        );
    return {
      selectedAssetId: focus.assetId ?? state.selectedAssetId,
      selectedFloor: focus.floor ?? state.selectedFloor,
      highlightedPath: focus.path ?? [],
      focusedIncidentId: focus.incidentId ?? null,
      focusedRecommendationId: focus.recommendationId ?? null,
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: false,
    };
  }),
  setModelConfig: (modelConfig) => set((state) => {
    // A newly published build changes the facility even when the physics do not.
    const sameLayout = JSON.stringify(state.modelConfig.layout ?? null) === JSON.stringify(modelConfig.layout ?? null);
    if (
      state.modelConfig.seed === modelConfig.seed &&
      state.modelConfig.thermalMass === modelConfig.thermalMass &&
      state.modelConfig.responseLag === modelConfig.responseLag &&
      state.modelConfig.scenario === modelConfig.scenario &&
      sameLayout
    ) return state;
    const elapsed = state.simulation.snapshot.elapsedS;
    const simulation = advanceCockpitSimulation(
      createCockpitSimulation(SCENARIO_START_S, modelConfig),
      elapsed,
      SCENARIO_START_S,
      modelConfig,
    );
    // A different build may not have the selected asset or the focused path,
    // so select the unit its advice commands instead.
    const keepSelection = sameLayout || facilityAssets(modelConfig).byId.has(state.selectedAssetId);
    return {
      modelConfig,
      simulatedAt: simulation.simulatedAt,
      playing: state.playing,
      simulation,
      selectedAssetId: keepSelection ? state.selectedAssetId : facilityPlant(modelConfig).advisedUnit.id,
      highlightedPath: sameLayout ? state.highlightedPath : [],
    };
  }),
  advance: (seconds) => set((state) => {
    const simulation = advanceCockpitSimulation(state.simulation, seconds, SCENARIO_START_S, state.modelConfig);
    return {
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: simulation.snapshot.elapsedS < SCENARIO_DURATION_S && state.playing,
    };
  }),
  step: (seconds = 30) => set((state) => {
    const simulation = advanceCockpitSimulation(state.simulation, Math.max(SIM_DT_S, seconds), SCENARIO_START_S, state.modelConfig);
    return {
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: false,
    };
  }),
  jump: (elapsedSeconds) => set((state) => {
    const target = Math.min(SCENARIO_DURATION_S, Math.max(0, Math.round(elapsedSeconds)));
    const simulation = advanceCockpitSimulation(
      createCockpitSimulation(SCENARIO_START_S, state.modelConfig),
      target,
      SCENARIO_START_S,
      state.modelConfig,
    );
    return {
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: false,
    };
  }),
  reset: () => set((state) => ({
    simulatedAt: SCENARIO_START_S,
    playing: false,
    speed: 1,
    simulation: createCockpitSimulation(SCENARIO_START_S, state.modelConfig),
    highlightedPath: [],
    focusedIncidentId: null,
    focusedRecommendationId: null,
  })),
}));

export function formatSimulatedAt(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000", "");
}