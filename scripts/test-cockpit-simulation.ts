import assert from "node:assert/strict";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_START_S,
  advanceCockpitSimulation,
  createCockpitSimulation,
  replayCockpitSnapshot,
  scenarioLayout,
  snapshotForAudit,
} from "../src/lib/cockpit/simulation";
import { useScenarioSession } from "../src/lib/cockpit/session";
import { readTelemetry } from "../src/lib/sandbox/model";

function replay(secondsPerTick: 1 | 5 | 10 | 30 | 60, targetSeconds: number) {
  let state = createCockpitSimulation(SCENARIO_START_S);
  for (let elapsed = 0; elapsed < targetSeconds; elapsed += secondsPerTick) {
    state = advanceCockpitSimulation(state, secondsPerTick, SCENARIO_START_S);
  }
  return state;
}

const golden = [
  {
    elapsedS: 0,
    itPowerKw: 1640,
    totalPowerKw: 2015,
    peakInletC: 30,
    pue: 1.229,
    headroomKw: 520,
    forecastPeakC: 31.8,
    advisoryPeakC: 30.7,
    risk: "clear",
  },
  {
    elapsedS: 300,
    itPowerKw: 1708.3,
    totalPowerKw: 2098.2,
    peakInletC: 31.8,
    pue: 1.228,
    headroomKw: 451.7,
    forecastPeakC: 32.3,
    advisoryPeakC: 31.6,
    risk: "watch",
  },
  {
    elapsedS: 900,
    itPowerKw: 1845,
    totalPowerKw: 2264.6,
    peakInletC: 32.7,
    pue: 1.227,
    headroomKw: 315,
    forecastPeakC: 33.1,
    advisoryPeakC: 32.5,
    risk: "critical",
  },
  {
    elapsedS: 1800,
    itPowerKw: 2050,
    totalPowerKw: 2514.2,
    peakInletC: 34,
    pue: 1.226,
    headroomKw: 110,
    forecastPeakC: 34,
    advisoryPeakC: 33.7,
    risk: "critical",
  },
] as const;

for (const expected of golden) {
  const state = advanceCockpitSimulation(
    createCockpitSimulation(SCENARIO_START_S),
    expected.elapsedS,
    SCENARIO_START_S,
  );
  const snapshot = state.snapshot;
  assert.deepEqual(
    {
      elapsedS: snapshot.elapsedS,
      itPowerKw: snapshot.itPowerKw,
      totalPowerKw: snapshot.totalPowerKw,
      peakInletC: snapshot.peakInletC,
      pue: snapshot.pue,
      headroomKw: snapshot.headroomKw,
      forecastPeakC: snapshot.forecast.baselinePeakC,
      advisoryPeakC: snapshot.forecast.advisoryPeakC,
      risk: snapshot.forecast.risk,
    },
    expected,
    `golden snapshot drifted at ${expected.elapsedS}s`,
  );

  const telemetry = readTelemetry(
    state.thermal,
    scenarioLayout(state.simulatedAt, SCENARIO_START_S, "baseline"),
    "baseline",
  );
  assert.equal(snapshot.itPowerKw, Math.round(telemetry.itPowerKw * 10) / 10);
  assert.equal(snapshot.totalPowerKw, Math.round(telemetry.totalPowerKw * 10) / 10);
  assert.equal(snapshot.peakInletC, Math.round((telemetry.maxInletC ?? 0) * 10) / 10);
}

for (const checkpoint of [300, 900, 1_800]) {
  const reference = replay(1, checkpoint);
  for (const speed of [5, 10, 30, 60] as const) {
    const candidate = replay(speed, checkpoint);
    assert.equal(candidate.simulatedAt, SCENARIO_START_S + checkpoint);
    assert.deepEqual(candidate.thermal, reference.thermal, `${speed}x changed physical state at ${checkpoint}s`);
    assert.deepEqual(candidate.snapshot, reference.snapshot, `${speed}x changed cockpit snapshot at ${checkpoint}s`);
  }
  const serverReplay = replayCockpitSnapshot(SCENARIO_START_S + checkpoint);
  assert.deepEqual(serverReplay, reference.snapshot, `server replay diverged at ${checkpoint}s`);
  assert.deepEqual(snapshotForAudit(serverReplay), snapshotForAudit(reference.snapshot));
}

const capped = advanceCockpitSimulation(
  createCockpitSimulation(SCENARIO_START_S),
  10_000,
  SCENARIO_START_S,
);
assert.equal(capped.simulatedAt, SCENARIO_START_S + 1_800);
assert.equal(capped.snapshot.elapsedS, 1_800);

const alternateModel = { ...DEFAULT_FACILITY_MODEL, seed: DEFAULT_FACILITY_MODEL.seed + 1 };
useScenarioSession.getState().reset();
useScenarioSession.getState().jump(900);
useScenarioSession.getState().setModelConfig(alternateModel);
const switched = useScenarioSession.getState();
assert.equal(switched.simulation.snapshot.elapsedS, 900, "facility model switch reset replay position");
assert.equal(switched.simulatedAt, SCENARIO_START_S + 900, "facility model switch changed canonical clock");
assert.deepEqual(
  switched.simulation.snapshot,
  replayCockpitSnapshot(SCENARIO_START_S + 900, alternateModel),
  "facility model switch did not reconstruct the canonical snapshot",
);
useScenarioSession.getState().setModelConfig(DEFAULT_FACILITY_MODEL);
useScenarioSession.getState().reset();

console.log("Cockpit simulation golden and replay tests passed.");