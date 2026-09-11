import assert from "node:assert/strict";
import {
  DEFAULT_FACILITY_MODEL,
  RISK_APPROACH_BAND_C,
  SCENARIO_START_S,
  advanceCockpitSimulation,
  counterfactualCockpitSnapshot,
  createCockpitSimulation,
  forecastRiskFor,
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
    advisoryPeakC: 30.8,
    // 31.8 °C is within RISK_APPROACH_BAND_C of the 32 °C limit.
    risk: "watch",
  },
  {
    elapsedS: 300,
    itPowerKw: 1708.3,
    totalPowerKw: 2098.2,
    peakInletC: 31.8,
    pue: 1.228,
    headroomKw: 451.7,
    forecastPeakC: 32.3,
    advisoryPeakC: 31.8,
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
    advisoryPeakC: 32.7,
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
    advisoryPeakC: 34,
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

const causal = replayCockpitSnapshot(SCENARIO_START_S + 900);
assert.notDeepEqual(causal.series.forecast, causal.series.counterfactual, "recommendation must branch the physical path");
assert.notDeepEqual(causal.series.counterfactual, causal.series.alternative, "operator alternative must have its own physical path");
assert.notDeepEqual(causal.series.forecast, causal.series.alternative, "operator alternative must execute rather than replay baseline");
assert(causal.forecast.advisoryPeakC < causal.forecast.baselinePeakC, "action must improve the thermal outcome");
const lowFlow = counterfactualCockpitSnapshot(SCENARIO_START_S + 900, { flowPercent: 60, durationMinutes: 20 });
const highFlow = counterfactualCockpitSnapshot(SCENARIO_START_S + 900, { flowPercent: 85, durationMinutes: 20 });
const shortAction = counterfactualCockpitSnapshot(SCENARIO_START_S + 900, { flowPercent: 85, durationMinutes: 1 });
assert.notDeepEqual(lowFlow.series.counterfactual, highFlow.series.counterfactual, "alternative flow must change the physical trajectory");
assert(highFlow.forecast.advisoryPeakC <= lowFlow.forecast.advisoryPeakC, "greater bounded flow must not worsen peak temperature");
assert(highFlow.forecast.advisoryPeakC <= shortAction.forecast.advisoryPeakC, "command duration must affect action-versus-expiry outcome");
assert(causal.checkpoints.filter((event) => event.reached).map((event) => event.elapsedS).every((time, index, all) => index === 0 || time > all[index - 1]), "event checkpoints must remain ordered");

const noLag = replayCockpitSnapshot(SCENARIO_START_S + 300, { ...DEFAULT_FACILITY_MODEL, responseLag: 0 });
const lagged = replayCockpitSnapshot(SCENARIO_START_S + 300, { ...DEFAULT_FACILITY_MODEL, responseLag: 60 });
assert(lagged.forecast.advisoryPeakC >= noLag.forecast.advisoryPeakC, "cooling response lag must not improve cooling");
const earlyCoolingEffect = lagged.series.forecast[0].baselinePeakC - lagged.series.counterfactual[0].baselinePeakC;
const settledCoolingEffect = lagged.series.forecast[90].baselinePeakC - lagged.series.counterfactual[90].baselinePeakC;
assert(settledCoolingEffect >= earlyCoolingEffect, "advisory cooling effect must emerge after the response lag");

for (const elapsedS of [0, 300, 900, 1_800]) {
  const sample = replayCockpitSnapshot(SCENARIO_START_S + elapsedS);
  assert(sample.peakInletC >= 20, "thermal state must remain physically bounded");
}

// WATCH starts RISK_APPROACH_BAND_C below the limit; CRITICAL starts 1 °C above it.
assert.equal(forecastRiskFor(32 - RISK_APPROACH_BAND_C - 0.1, 32), "clear");
assert.equal(forecastRiskFor(32 - RISK_APPROACH_BAND_C, 32), "watch");
assert.equal(forecastRiskFor(32.9, 32), "watch");
assert.equal(forecastRiskFor(33, 32), "critical");
const approaching = replayCockpitSnapshot(SCENARIO_START_S);
assert.equal(approaching.forecast.risk, "watch", "a forecast just below the limit must read WATCH");
assert.equal(approaching.incident.open, false, "approaching the limit must not open an incident");

console.log("Cockpit simulation golden and replay tests passed.");