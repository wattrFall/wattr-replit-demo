import { create } from "zustand";
import {
  advanceCockpitSimulation,
  createCockpitSimulation,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  type CockpitSimulationState,
} from "./simulation";

export { SCENARIO_START_S } from "./simulation";

type ScenarioSession = {
  scenarioId: "gpu-training-ramp-v1";
  simulatedAt: number;
  playing: boolean;
  speed: 1 | 5 | 10 | 30 | 60;
  mode: "Observe" | "Shadow" | "Advisory";
  simulation: CockpitSimulationState;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: ScenarioSession["speed"]) => void;
  setMode: (mode: ScenarioSession["mode"]) => void;
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
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode }),
  advance: (seconds) => set((state) => {
    const simulation = advanceCockpitSimulation(state.simulation, seconds, SCENARIO_START_S);
    return {
      simulatedAt: simulation.simulatedAt,
      simulation,
      playing: simulation.snapshot.elapsedS < SCENARIO_DURATION_S && state.playing,
    };
  }),
  reset: () => {
    const simulation = createCockpitSimulation(SCENARIO_START_S);
    set({ simulatedAt: SCENARIO_START_S, playing: false, speed: 1, simulation });
  },
}));

export function formatSimulatedAt(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000", "");
}