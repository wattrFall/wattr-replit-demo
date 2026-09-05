import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { chromium } from "playwright";
import { availableTestPort } from "./test-port";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const suffix = randomUUID().slice(0, 8);
const userId = `browser-flow-${suffix}`;
const browserUserId = `browser-manager-${suffix}`;
const port = await availableTestPort();
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let originalRecommendationStatus = "PROPOSED";
server.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-test-user-id": userId,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(`Browser test server request failed for ${path}: ${String(error)}\n${stderr}`);
  }
  const isHtml = response.headers.get("content-type")?.includes("text/html");
  const payload = isHtml
    ? { body: null, text: await response.text() }
    : { body: await response.json().catch(() => null), text: "" };
  return {
    status: response.status,
    ...payload,
  };
}

async function seed() {
  const recommendation = await pool.query("SELECT status FROM recommendations WHERE id = 'rec-17'");
  originalRecommendationStatus = recommendation.rows[0]?.status ?? "PROPOSED";
  await pool.query(
    `INSERT INTO users (id, display_name)
     VALUES ($1, 'Release browser operator'), ($2, 'Release browser manager')`,
    [userId, browserUserId],
  );
  await pool.query(
    `INSERT INTO memberships (user_id, organization_id, role)
     VALUES ($1, 'wattr-demo', 'OPERATOR'), ($2, 'wattr-demo', 'PORTFOLIO_MANAGER')`,
    [userId, browserUserId],
  );
  await pool.query(
    `INSERT INTO facility_permissions (user_id, facility_id, can_view, can_operate, can_edit_model)
     VALUES ($1, 'sfo-01', true, true, false), ($2, 'sfo-01', true, false, false)`,
    [userId, browserUserId],
  );
  await pool.query(
    `INSERT INTO user_preferences (user_id, tutorial_complete, tutorial_step, tutorial_role)
     VALUES ($1, true, 10, 'OPERATOR'), ($2, true, 10, 'PORTFOLIO_MANAGER')`,
    [userId, browserUserId],
  );
  await pool.query(
    `INSERT INTO user_tutorial_progress (user_id, role, tutorial_complete, tutorial_step)
     VALUES ($1, 'OPERATOR', true, 10), ($2, 'PORTFOLIO_MANAGER', true, 10)`,
    [userId, browserUserId],
  );
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable");
    await client.query("ALTER TABLE operator_decisions DISABLE TRIGGER operator_decisions_immutable");
    await client.query("DELETE FROM audit_records WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM operator_decisions WHERE user_id = $1", [userId]);
    await client.query("ALTER TABLE operator_decisions ENABLE TRIGGER operator_decisions_immutable");
    await client.query("ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable");
    await client.query("DELETE FROM safety_evaluations WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [[userId, browserUserId]]);
    await client.query("UPDATE recommendations SET status = $1 WHERE id = 'rec-17'", [originalRecommendationStatus]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

try {
  await seed();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert((await fetch(`${baseUrl}/api/health`)).ok, `browser-flow server did not start: ${stderr}`);

  const unauthenticated = await fetch(`${baseUrl}/api/facilities`);
  assert.equal(unauthenticated.status, 401);
  for (const path of [
    "/sign-in",
    "/portfolio",
    "/facilities/sfo-01/operations",
    "/facilities/sfo-01/incidents/inc-204",
    "/facilities/sfo-01/recommendations/rec-17",
    "/facilities/sfo-01/audit",
  ]) {
    const page = await request(path);
    assert.equal(page.status, 200, `route delivery failed for ${path}`);
    assert(page.text.includes('<div id="root"></div>'), `SPA shell missing for ${path}`);
  }

  const operatorProgress = await request("/api/me/tutorial", {
    method: "PATCH",
    body: JSON.stringify({ role: "OPERATOR", step: 2, complete: false }),
  });
  assert.equal(operatorProgress.status, 200);
  await pool.query("UPDATE memberships SET role = 'MODEL_ADMIN' WHERE user_id = $1", [userId]);
  const modelProgress = await request("/api/me/tutorial", {
    method: "PATCH",
    body: JSON.stringify({ role: "MODEL_ADMIN", step: 3, complete: true }),
  });
  assert.equal(modelProgress.status, 200);
  const modelMe = await request("/api/me");
  assert.equal(modelMe.body.tutorial_step, 3);
  assert.equal(modelMe.body.tutorial_complete, true);
  await pool.query("UPDATE memberships SET role = 'OPERATOR' WHERE user_id = $1", [userId]);
  const operatorMe = await request("/api/me");
  assert.equal(operatorMe.body.tutorial_step, 2);
  assert.equal(operatorMe.body.tutorial_complete, false);
  await request("/api/me/tutorial", {
    method: "PATCH",
    body: JSON.stringify({ role: "OPERATOR", step: 10, complete: true }),
  });

  const facilities = await request("/api/facilities");
  assert.equal(facilities.status, 200);
  assert.equal(facilities.body[0].id, "sfo-01");
  const context = await request("/api/facilities/sfo-01/context");
  assert.equal(context.status, 200);
  const snapshot = await request("/api/facilities/sfo-01/scenarios/gpu-training-ramp-v1/snapshot?simulatedAt=1752677100");
  assert.equal(snapshot.status, 200);
  const incidents = await request("/api/facilities/sfo-01/incidents");
  assert.equal(incidents.status, 200);
  assert.equal(incidents.body[0].id, "inc-204");
  const recommendations = await request("/api/facilities/sfo-01/recommendations");
  assert.equal(recommendations.status, 200);
  assert.equal(recommendations.body.items[0].id, "rec-17");
  const whatIf = await request("/api/facilities/sfo-01/recommendations/rec-17/what-if", {
    method: "POST",
    body: JSON.stringify({
      simulatedAt: 1752677100,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(whatIf.status, 200);
  const evaluation = await request("/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
    method: "POST",
    body: JSON.stringify({ simulatedAt: 1752677100 }),
  });
  assert.equal(evaluation.status, 201);
  assert(["PASS", "WARNING", "BLOCK"].includes(evaluation.body.outcome));
  const decision = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "ACKNOWLEDGE",
      simulatedAt: 1752677100,
      safetyEvaluationId: evaluation.body.id,
    }),
  });
  assert.equal(decision.status, 201);
  const audit = await request("/api/facilities/sfo-01/audit");
  assert.equal(audit.status, 200);
  assert(audit.body.some((item: { action: string }) => item.action === "DECISION_ACKNOWLEDGE"));

  const browser = await chromium.launch({ headless: true });
  try {
    const managerContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const browserErrors: string[] = [];
    const isInfrastructureNoise = (text: string) =>
      text.includes("401 (Unauthorized)") ||
      text.includes("[vite] failed to connect to websocket") ||
      (text.includes("WebSocket") && text.includes("24678")) ||
      text.includes("WebSocket closed without opened");
    const configurePage = async (context: typeof managerContext, identity: string) => {
      const page = await context.newPage();
      await page.addInitScript((testUserId) => {
        (globalThis as typeof globalThis & { __WATTR_E2E_USER_ID__?: string }).__WATTR_E2E_USER_ID__ = testUserId;
      }, identity);
      page.on("pageerror", (error) => {
        if (!isInfrastructureNoise(error.message)) browserErrors.push(error.message);
      });
      page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error" && !isInfrastructureNoise(text)) {
          browserErrors.push(message.text());
        }
      });
      return page;
    };
    const assertPageQuality = async (
      page: Awaited<ReturnType<typeof configurePage>>,
      path: string,
      expected: string,
    ) => {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
      try {
        await page.getByText(expected, { exact: false }).first().waitFor({ timeout: 10_000 });
      } catch {
        throw new Error(
          `${path} did not render ${expected}. Body: ${(await page.locator("body").innerText()).slice(0, 1_000)}. Errors: ${browserErrors.join("; ")}`,
        );
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `${path} has horizontal overflow`,
      );
      const unnamedControls = await page.locator("button, a[href], input, select, textarea").evaluateAll((elements) =>
        elements.filter((element) => {
          const html = element as HTMLElement;
          const labelledControl = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          return !(
            html.textContent?.trim() ||
            html.getAttribute("aria-label")?.trim() ||
            html.getAttribute("title")?.trim() ||
            html.getAttribute("name")?.trim() ||
            [...(labelledControl.labels ?? [])].some((label) => label.textContent?.trim())
          );
        }).map((element) => element.outerHTML.slice(0, 300)),
      );
      assert.deepEqual(unnamedControls, [], `${path} contains unnamed interactive controls: ${unnamedControls.join(" | ")}`);
    };

    const managerPage = await configurePage(managerContext, browserUserId);
    await assertPageQuality(managerPage, "/portfolio", "Portfolio");
    await managerContext.close();

    const operatorContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await configurePage(operatorContext, userId);
    for (const [path, expected] of [
      ["/facilities/sfo-01/operations", "GPU"],
      ["/facilities/sfo-01/incidents/inc-204", "Incident"],
      ["/facilities/sfo-01/recommendations/rec-17", "Run Safety Shield"],
      ["/facilities/sfo-01/audit", "Audit"],
    ] as const) {
      await assertPageQuality(page, path, expected);
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await assertPageQuality(page, "/facilities/sfo-01/recommendations/rec-17", "Run Safety Shield");
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement !== document.body), "keyboard focus did not enter the page");
    assert.deepEqual(browserErrors, [], `browser console/page errors: ${browserErrors.join("; ")}`);
    await operatorContext.close();

    const fallbackContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return original.call(this, type as never, ...(args as []));
      };
    });
    await fallbackPage.goto(`${baseUrl}/demo/sandbox`, { waitUntil: "networkidle" });
    await fallbackPage.getByText("This preview does not provide WebGL", { exact: false }).waitFor();
    assert(
      await fallbackPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "WebGL fallback has horizontal overflow",
    );
    await fallbackContext.close();
  } finally {
    await browser.close();
  }

  const [appSource, sandboxSource, cssSource, builtHtml] = await Promise.all([
    readFile(new URL("../src/components/cockpit/Cockpit.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/sandbox/SandboxShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/index.css", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  ]);
  assert(appSource.includes("SignIn") && appSource.includes("SignUp"), "login flow is not wired");
  for (const text of ["portfolio", "incidents", "recommendations", "audit"]) {
    assert(appSource.toLowerCase().includes(text), `browser flow missing ${text} surface`);
  }
  assert(sandboxSource.includes("This preview does not provide WebGL"), "WebGL fallback is missing");
  assert(sandboxSource.includes("aria-live=\"polite\""), "fallback status is not announced");
  assert(cssSource.includes("@media (max-width:767px)"), "primary responsive breakpoint is missing");
  assert(cssSource.includes("overflow-x"), "horizontal overflow handling is missing");
  assert(!/\bconsole\.(log|warn|error)\s*\(/.test(appSource), "cockpit contains browser console output");
  assert(builtHtml.includes('<div id="root"></div>'), "production build shell is invalid");
} finally {
  if (!server.killed) server.kill("SIGTERM");
  await cleanup();
}

console.log("Browser-flow route, login shell, operating thread, accessibility, responsive, console, and WebGL fallback checks passed.");