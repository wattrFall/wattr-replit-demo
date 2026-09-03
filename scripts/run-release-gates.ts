import { spawnSync } from "node:child_process";

const gates = [
  ["typecheck", "check"],
  ["production build", "build"],
  ["migration and canonical seed", "db:setup"],
  ["public demo fixture", "demo:validate"],
  ["clean database startup", "test:clean-database"],
  ["domain invariants", "test:domain"],
  ["deterministic replay", "test:simulation"],
  ["operating workspaces", "test:workspaces"],
  ["canonical contracts", "test:contracts"],
  ["role and persistence security", "test:role-security"],
  ["role security API", "test:role-security-api"],
  ["assistant grounding and actions", "test:ask-wattr"],
  ["decision and safety workflow", "test:decision-workflow"],
  ["product learning boundaries", "test:product-learning"],
  ["browser flow and UI quality", "test:browser"],
  ["performance budgets", "test:performance"],
] as const;

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failures: string[] = [];
const startedAt = Date.now();

for (const [label, script] of gates) {
  console.log(`\n=== RELEASE GATE: ${label} (npm run ${script}) ===`);
  const result = spawnSync(npm, ["run", script], {
    stdio: "inherit",
    env: { ...process.env, RELEASE_GATE: "1" },
  });
  if (result.status !== 0) {
    failures.push(`${label} (exit ${result.status ?? "signal"})`);
    console.error(`--- FAILED: ${label} ---`);
    break;
  }
  console.log(`--- PASSED: ${label} ---`);
}

const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length) {
  console.error(`\nRelease blocked after ${durationS}s: ${failures.join(", ")}.`);
  process.exit(1);
}
console.log(`\nRelease gates passed in ${durationS}s. Publication is unblocked.`);