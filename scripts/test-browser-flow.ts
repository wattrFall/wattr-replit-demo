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
const testUserIds = [userId, browserUserId];
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
    await client.query("ALTER TABLE replay_change_events DISABLE TRIGGER replay_change_events_immutable");
    await client.query(
      "DELETE FROM replay_change_events WHERE actor_user_id = ANY($1::text[])",
      [testUserIds],
    );
    await client.query("ALTER TABLE replay_change_events ENABLE TRIGGER replay_change_events_immutable");
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
    try { await client.query("ALTER TABLE replay_change_events ENABLE TRIGGER replay_change_events_immutable"); } catch { /* rollback restores DDL */ }
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
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(healthy, `browser-flow server did not start on ${port}: ${stderr}`);

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
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
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

    const firstTwinStarted = performance.now();
    await assertPageQuality(page, "/facilities/sfo-01/operations", "Synchronized facility twin");
    const twin = page.locator("[data-guide='twin']");
    const replay = page.getByLabel("Replay position");
    const replayBeforeViewpoint = await replay.getAttribute("aria-valuetext");
    const canvas = twin.locator("canvas");
    await canvas.waitFor({ timeout: 15_000 });
    const firstTwinMs = performance.now() - firstTwinStarted;
    assert(firstTwinMs < 15_000, `first twin paint exceeded 15s (${firstTwinMs.toFixed(0)}ms)`);
    const frameIntervals = await page.evaluate(async () => {
      const samples: number[] = [];
      let previous = performance.now();
      for (let index = 0; index < 30; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame((now) => {
          samples.push(now - previous);
          previous = now;
          resolve();
        }));
      }
      return samples;
    });
    const p95Frame = [...frameIntervals].sort((a, b) => a - b)[Math.floor(frameIntervals.length * .95)];
    assert(p95Frame < 250, `twin frame stability exceeded 250ms p95 (${p95Frame.toFixed(1)}ms)`);

    const canvasBox = await canvas.boundingBox();
    assert(canvasBox, "twin canvas has no interactive bounds");
    await page.mouse.move(canvasBox.x + canvasBox.width * .5, canvasBox.y + canvasBox.height * .75);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(250);
    assert.equal(await page.locator("[data-guide='camera-orbit']").getAttribute("aria-pressed"), "true", "orbit mode is not active");

    await page.locator("[data-guide='camera-walk']").click();
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new Error("synthetic pointer capture rejection"));
    });
    await canvas.dispatchEvent("mousedown");
    await page.keyboard.down("w");
    await page.waitForTimeout(350);
    await page.keyboard.up("w");
    const walkMoved = await twin.getAttribute("data-camera-state");
    await canvas.dispatchEvent("mouseup");
    assert(walkMoved?.includes("walk:"), `walk camera state missing: ${walkMoved}`);
    assert(walkMoved?.includes("drag-fallback"), `pointer-lock rejection did not preserve drag fallback: ${walkMoved}`);
    const walkCoordinates = walkMoved?.split(":")[1].split(",").map(Number) ?? [];
    assert(walkCoordinates.length === 3 && walkCoordinates.every(Number.isFinite), `invalid walk camera diagnostics: ${walkMoved}`);
    assert(Math.abs(walkCoordinates[0]) <= 10.6 && Math.abs(walkCoordinates[2]) <= 7.6, `walk camera escaped collision bounds: ${walkMoved}`);

    await page.locator("[data-guide='camera-orbit']").click();
    await page.locator("[data-guide='floor-change']").click();
    assert.equal(await page.getByRole("button", { name: "F2" }).getAttribute("aria-pressed"), "true");
    const floorTwoRack = page.getByText("Rack F2-A", { exact: true });
    await floorTwoRack.click();
    assert.equal(await floorTwoRack.getAttribute("aria-pressed"), "true");
    await page.getByText("Floor 2 rack A", { exact: true }).waitFor();
    assert.equal(await replay.getAttribute("aria-valuetext"), replayBeforeViewpoint, "camera, floor, or selection changed replay time");

    await page.getByRole("button", { name: "Thermal overlay" }).click();
    await page.locator(".twin-legend").waitFor();
    const overlayStarted = performance.now();
    await page.getByText("Heat map", { exact: true }).locator("input").uncheck();
    await page.waitForFunction(() => document.querySelector(".twin-layer-summary")?.textContent?.startsWith("Flow"));
    const overlayMs = performance.now() - overlayStarted;
    assert(overlayMs < 1_000, `overlay update exceeded 1s (${overlayMs.toFixed(0)}ms)`);
    await page.getByRole("button", { name: "Jump to forecast" }).click();
    assert.match(await replay.getAttribute("aria-valuetext") ?? "", /15 minutes/);
    assert.match(await page.locator(".twin-layer-summary").innerText(), /deterministic snapshot at 15m/i);
    await page.getByRole("button", { name: "Reset" }).click();

    for (const width of [1280, 1440, 1728, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${baseUrl}/facilities/sfo-01/operations`, { waitUntil: "domcontentloaded" });
      await page.getByText("Synchronized facility twin").waitFor();
      for (const required of [
        page.locator("[data-guide='twin']"),
        page.getByLabel("Canonical replay controls"),
        page.getByText("CONTEXTUAL HUD", { exact: true }),
        page.getByText("Review advisory", { exact: true }),
      ]) {
        const box = await required.first().boundingBox();
        assert(box && box.width > 0 && box.height > 0, `required operations control hidden at ${width}px`);
      }
      const stageBox = await page.locator("[data-guide='twin']").boundingBox();
      assert(stageBox && stageBox.width >= 650, `twin is not the visual focus at ${width}px (${stageBox?.width ?? 0}px)`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `operations overflows at ${width}px`);
    }

    await page.evaluate(() => document.body.style.zoom = "125%");
    assert(await page.getByLabel("Canonical replay controls").isVisible(), "replay controls hidden at 125% zoom");
    assert(await page.getByText("Review advisory", { exact: true }).isVisible(), "decision control hidden at 125% zoom");
    await page.evaluate(() => document.body.style.zoom = "");

    await page.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded" });
    const restartGuide = page.getByRole("button", { name: "Restart guided tutorial" });
    await restartGuide.focus();
    await restartGuide.click();
    await page.getByText("Orient in orbit view", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/help", "tutorial changed pages by itself");
    await page.getByRole("button", { name: "Open Operations" }).click();
    await page.locator(".guide-spotlight").waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.getByRole("button", { name: "Next" }).isVisible(), "guidance did not provide consistent next navigation");
    assert.equal(await page.getByRole("button", { name: "Focus control" }).count(), 0, "obsolete focus control is still rendered");
    await page.locator("[data-guide='camera-orbit']").click();
    await page.getByText("Enter aisle-level walkthrough", { exact: true }).waitFor();
    const skipSaved = page.waitForResponse((response) =>
      response.url().endsWith("/api/me/tutorial") && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Skip tutorial", exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "main-content",
      "tutorial did not recover focus after its launcher left the current route",
    );
    await skipSaved;
    const savedTutorial = await request("/api/me");
    assert.equal(savedTutorial.body.tutorial_step, 1, "tutorial action completion was not persisted");
    assert.equal(savedTutorial.body.tutorial_complete, true, "skipping the tutorial was not remembered");
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.locator(".guide-card").count(), 0, "a skipped tutorial reopened on reload");
    await request("/api/me/tutorial", {
      method: "PATCH",
      body: JSON.stringify({ role: "OPERATOR", step: 10, complete: true }),
    });

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
    await fallbackPage.goto(`${baseUrl}/demo/sandbox`, { waitUntil: "domcontentloaded" });
    await fallbackPage.getByText("This preview does not provide WebGL", { exact: false }).waitFor();
    assert(
      await fallbackPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "WebGL fallback has horizontal overflow",
    );
    await fallbackContext.close();

    const twinFallbackContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const twinFallbackPage = await configurePage(twinFallbackContext, userId);
    await twinFallbackPage.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return original.call(this, type as never, ...(args as []));
      };
    });
    await twinFallbackPage.goto(`${baseUrl}/facilities/sfo-01/operations`, { waitUntil: "domcontentloaded" });
    await twinFallbackPage.getByText("3D scene unavailable", { exact: true }).waitFor();
    await twinFallbackPage.getByRole("img", { name: /Authorized facility model/ }).waitFor();
    assert(await twinFallbackPage.getByLabel("Canonical replay controls").isVisible(), "WebGL failure hid replay controls");
    assert(await twinFallbackPage.getByText("CONTEXTUAL HUD", { exact: true }).isVisible(), "WebGL failure hid equivalent HUD");
    await twinFallbackContext.close();
  } finally {
    await browser.close();
  }

  const [appSource, sandboxSource, stageSource, cssSource, builtHtml] = await Promise.all([
    readFile(new URL("../src/components/cockpit/Cockpit.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/sandbox/SandboxShell.tsx", import.meta.url), "utf8"),
    // The 3D stage and its WebGL fallback are shared by the sandbox and the facility Builder.
    readFile(new URL("../src/components/sandbox/SandboxStage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/index.css", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  ]);
  assert(appSource.includes("SignIn") && appSource.includes("SignUp"), "login flow is not wired");
  for (const text of ["portfolio", "incidents", "recommendations", "audit"]) {
    assert(appSource.toLowerCase().includes(text), `browser flow missing ${text} surface`);
  }
  assert(stageSource.includes("This preview does not provide WebGL"), "WebGL fallback is missing");
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