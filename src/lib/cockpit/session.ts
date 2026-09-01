import { create } from "zustand";

export const SCENARIO_START_S = 1_752_676_800;

type ScenarioSession = {
  scenarioId: "gpu-training-ramp-v1";
  simulatedAt: number;
  playing: boolean;
  speed: 1 | 5 | 10 | 30 | 60;
  mode: "Observe" | "Shadow" | "Advisory";
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
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode }),
  advance: (seconds) => set((state) => ({ simulatedAt: state.simulatedAt + seconds })),
  reset: () => set({ simulatedAt: SCENARIO_START_S, playing: false, speed: 1 }),
}));

export function formatSimulatedAt(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000", "");
}