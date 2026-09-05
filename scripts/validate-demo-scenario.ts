import { demoMetadata, demoScenario } from "../src/lib/demoScenario";

const errors: string[] = [];
const forbiddenPublicReferences = [
  "amazon web services",
  "private repository",
  "github.com/",
  "access key",
  "secret key",
  "storage bucket",
  "compiled unit",
];
const forbiddenPublicPatterns = [
  { label: "cloud provider acronym", pattern: /\baws\b/i },
  { label: "object-store service", pattern: /\bs3\b/i },
  { label: "compiled simulation artifact", pattern: /\bfmus?\b/i },
  { label: "source modeling language", pattern: /\bmodelica\b/i },
  { label: "local user path", pattern: /\/users\//i },
];
const serialized = JSON.stringify(demoScenario).toLowerCase();
const closeTo = (actual: number, expected: number, tolerance = 0.000001) => Math.abs(actual - expected) <= tolerance;

if (demoScenario.topology.rackGroups !== 4) errors.push("Public reference must contain four rack groups.");
if (demoScenario.topology.pumpCount !== 1) errors.push("Public reference must contain one primary pump.");
if (demoScenario.topology.heatExchangerCount !== 1) errors.push("Public reference must contain one heat exchanger.");
if (demoScenario.topology.ratedCoolingCapacityKw !== 60) errors.push("Rated cooling capacity must remain 60 kW.");
if (demoScenario.topology.referenceWaterSideHeatRemovalKw !== 52.67) errors.push("Water-side heat-removal reference must remain 52.67 kW.");
// Read through widened bindings: the fixture is `as const`, so comparing the
// two literal types directly is a compile error rather than a runtime guard.
// The check has to survive a future edit that makes them equal, which is
// exactly the mistake it exists to catch.
const ratedCapacityKw: number = demoScenario.topology.ratedCoolingCapacityKw;
const waterSideHeatKw: number = demoScenario.topology.referenceWaterSideHeatRemovalKw;
if (ratedCapacityKw === waterSideHeatKw) errors.push("Water-side heat removal must not be presented as rated cooling capacity.");
if (demoScenario.topology.referenceLoopDeltaK !== 9) errors.push("Reference loop delta must remain 9 K.");
if (demoScenario.savingsEstimatePercent !== null) errors.push("The public demo cannot contain a savings estimate without validated comparison evidence.");
if (demoMetadata.title !== "Wattr Cooling Sandbox") errors.push("Demo metadata title must identify the standalone sandbox.");
if (demoMetadata.canonicalUrl !== null) errors.push("Standalone demo metadata must not retain a website canonical URL.");
if (!demoScenario.provenance.source || !demoScenario.provenance.sourceRevision || !demoScenario.provenance.generatedAt || !demoScenario.provenance.reviewedAt) errors.push("Fixture provenance is incomplete.");
if (!demoScenario.modelScope || demoScenario.limitations.length < 3) errors.push("Model scope and limitations must be explicit.");
if (demoScenario.stages.length !== 3) errors.push("The investor walkthrough must contain exactly three acts.");
if (demoScenario.stages.map((stage) => stage.id).join(",") !== "demand,predict,review") errors.push("Walkthrough acts must remain demand, prediction, and operator review.");
if (demoScenario.stages.some((stage) => !stage.title || !stage.narrative || !stage.primaryResult.value)) errors.push("Every act needs a title, narrative, and primary result.");
if (demoScenario.stages[0].signalItHeatKw !== 55) errors.push("Demand act must retain the incoming 55 kW signal.");
if (demoScenario.stages.some((stage) => stage.affectedRacks.join(",") !== "1,2,3,4")) errors.push("The public fixture must apply the demand increase across all four rack groups.");

const baseline = demoScenario.baseline;
if (baseline.controls.supplyTemperatureC !== 21) errors.push("Baseline supply temperature must remain 21°C.");
if (baseline.controls.pumpSpeedFraction !== 0.85) errors.push("Baseline pump command must remain 85%.");
if (baseline.outputs.itHeatKw !== 44) errors.push("Baseline IT heat must remain 44 kW.");
if (!closeTo(baseline.outputs.returnTemperatureC, 29.84564352056612)) errors.push("Baseline return temperature does not match the reviewed fixture.");
if (!closeTo(baseline.outputs.pumpPowerKw, 1.22825)) errors.push("Baseline pump power does not match the reviewed fixture.");
if (baseline.outputs.ratedCapacityMarginKw !== 16) errors.push("Baseline rated-capacity margin must remain 16 kW.");

for (const stage of demoScenario.stages) {
  if (stage.controls.supplyTemperatureC !== 21) errors.push(`${stage.id}: supply temperature must remain 21°C.`);
  const expectedMargin = demoScenario.topology.ratedCoolingCapacityKw - stage.outputs.itHeatKw;
  if (!closeTo(stage.outputs.ratedCapacityMarginKw, expectedMargin)) errors.push(`${stage.id}: rated-capacity margin is inconsistent with the 60 kW rating.`);
}

const predicted = demoScenario.stages[1];
if (predicted.outputs.itHeatKw !== 55 || predicted.controls.pumpSpeedFraction !== 0.85) errors.push("Prediction act inputs must remain 55 kW at the 85% pump command.");
if (!closeTo(predicted.outputs.returnTemperatureC, 32.05705440070765)) errors.push("Prediction return temperature does not match the reviewed fixture.");

const reviewed = demoScenario.stages[2];
if (reviewed.outputs.itHeatKw !== 55 || reviewed.controls.pumpSpeedFraction !== 1) errors.push("Review act must retain the 55 kW workload and bounded 100% pump command.");
if (!closeTo(reviewed.outputs.returnTemperatureC, 30.398496240601503)) errors.push("Reviewed-action return temperature does not match the fixture.");
if (!closeTo(reviewed.outputs.pumpPowerKw, 2)) errors.push("Reviewed-action pump power does not match the fixture.");

for (const reference of forbiddenPublicReferences) {
  if (serialized.includes(reference)) errors.push(`Public scenario contains a private infrastructure reference: ${reference}`);
}
for (const { label, pattern } of forbiddenPublicPatterns) {
  if (pattern.test(serialized)) errors.push(`Public scenario contains a private infrastructure reference: ${label}`);
}

if (errors.length) {
  console.error("Demo scenario validation failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Approved public demo fixture: ${demoScenario.id}`);
console.log(`Provenance: ${demoScenario.provenance.source} @ ${demoScenario.provenance.sourceRevision}`);
console.log(`Generated: ${demoScenario.provenance.generatedAt}; reviewed: ${demoScenario.provenance.reviewedAt}`);
