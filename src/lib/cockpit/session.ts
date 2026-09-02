import { create } from "zustand";
import {
  advanceCockpitSimulation,
  createCockpitSimulation,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  type CockpitSimulationState,
  type FacilityModelConfig,
  DEFAULT_FACILITY_MODEL,
} from "./simulation";

export { SCENARIO_START_S } from "./simulation";

type ScenarioSession = {
  scenarioId: "gpu-training-ramp-v1";
  simulatedAt: number;
  playing: boolean;
  speed: 1 | 5 | 10 | 30 | 60;
  mode: "Observe" | "Shadow" | "Advisory";
  simulation: CockpitSimulationState;
  modelConfig: FacilityModelConfig;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: ScenarioSession["speed"]) => void;
  setMode: (mode: ScenarioSession["mode"]) => void;
  setModelConfig: (config: FacilityModelConfig) => void;
  advance: (seconds: number) => void;
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
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode }),
  setModelConfig: (modelConfig) => set({
    modelConfig,
    simulatedAt: SCENARIO_START_S,
    playing: false,
    simulation: createCockpitSimulation(SCENARIO_START_S, modelConfig),
  }),
  advance: (seconds) => set((state) => {
    const simulation = advanceCockpitSimulation(state.simulation, seconds, SCENARIO_START_S, state.modelConfig);
    return {
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: simulation.snapshot.elapsedS < SCENARIO_DURATION_S && state.playing,
    };
  }),
  reset: () => set((state) => ({
    simulatedAt: SCENARIO_START_S,
    playing: false,
    speed: 1,
    simulation: createCockpitSimulation(SCENARIO_START_S, state.modelConfig),
  })),
}));

export function formatSimulatedAt(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000", "");
}