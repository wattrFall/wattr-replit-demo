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
const timeoutByScript: Record<string, number> = {
  "test:browser": 240_000,
  "test:performance": 120_000,
  build: 180_000,
  "db:setup": 180_000,
};
const defaultTimeoutMs = 120_000;
const totalBudgetMs = 15 * 60_000;

for (const [label, script] of gates) {
  if (Date.now() - startedAt >= totalBudgetMs) {
    failures.push(`overall release budget (timeout after ${Math.round(totalBudgetMs / 60_000)}m)`);
    break;
  }
  console.log(`\n=== RELEASE GATE: ${label} (npm run ${script}) ===`);
  const result = spawnSync(npm, ["run", script], {
    stdio: "inherit",
    env: { ...process.env, RELEASE_GATE: "1" },
    timeout: Math.min(timeoutByScript[script] ?? defaultTimeoutMs, totalBudgetMs - (Date.now() - startedAt)),
    killSignal: "SIGTERM",
  });
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    failures.push(`${label} (${timedOut ? "TIMEOUT" : result.error.message})`);
    console.error(`--- FAILED: ${label}: ${timedOut ? "bounded execution time exceeded" : result.error.message} ---`);
    break;
  }
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