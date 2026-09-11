import { useEffect, useRef } from "react";
import {
  MAX_SLICES_PER_CALL,
  SIM_DT_S,
  createSimState,
  readTelemetry,
  stepSim,
  type SimState,
} from "@/lib/sandbox/model";
import { useSandboxStore } from "@/lib/sandbox/store";

/** How often the running simulation publishes to the store for the UI. */
const PUBLISH_INTERVAL_MS = 100;

/**
 * Drives the thermal model.
 *
 * The simulation lives in a ref and advances on every animation frame, but only
 * publishes to the store ten times a second. Panels re-render at that rate
 * instead of at 60fps, which keeps the numbers readable and leaves the frame
 * budget to the scene.
 *
 * Layout and control mode are read with getState() rather than subscribed, so
 * the loop is started once and never torn down and rebuilt as the user builds.
 */
export function useSandboxSimulation() {
  const sim = useRef<SimState | null>(null);

  useEffect(() => {
    // Seed state and publish once up front, so the readout is correct even if
    // the animation loop never gets to run.
    {
      const { items, connections, controlMode, publishSim } = useSandboxStore.getState();
      const layout = { items, connections };
      if (!sim.current) sim.current = createSimState(layout);
      publishSim(sim.current.inletC, readTelemetry(sim.current, layout, controlMode));
    }

    let frame = 0;
    let lastFrameMs = performance.now();
    let lastPublishMs = 0;
    /** Real time banked but not yet integrated, carried across frames. */
    let accumulator = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      const dt = Math.min(0.25, (now - lastFrameMs) / 1000);
      lastFrameMs = now;

      // Bank elapsed time and spend it in whole fixed slices. The remainder
      // stays banked, so simulated time advances at the same rate whatever the
      // frame rate happens to be.
      accumulator += dt;
      const slices = Math.min(MAX_SLICES_PER_CALL, Math.floor(accumulator / SIM_DT_S));
      accumulator -= slices * SIM_DT_S;
      // A long stall would otherwise leave a large debt to work off.
      if (accumulator > MAX_SLICES_PER_CALL * SIM_DT_S) accumulator = 0;

      const { items, connections, controlMode, publishSim } = useSandboxStore.getState();
      const layout = { items, connections };

      if (!sim.current) sim.current = createSimState(layout);
      if (slices > 0) sim.current = stepSim(sim.current, layout, controlMode, slices);

      if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
        lastPublishMs = now;
        publishSim(sim.current.inletC, readTelemetry(sim.current, layout, controlMode));
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * Republish immediately whenever the hall or the control mode changes.
   *
   * Power, PUE and the resolved setpoints are algebraic in the layout — they do
   * not need time to settle, only temperatures do. Leaving them to the
   * animation loop meant a toggle or a slider showed nothing until the next
   * publish, and showed nothing at all when requestAnimationFrame is throttled:
   * a background tab, a low-power mode, or a hidden window. The loop stays
   * responsible for advancing temperature; this makes the readout truthful the
   * instant the user changes something.
   */
  useEffect(() => {
    return useSandboxStore.subscribe((state, prev) => {
      const changed =
        state.items !== prev.items ||
        state.connections !== prev.connections ||
        state.controlMode !== prev.controlMode;
      // Guard against recursion: publishSim only writes inletC/telemetry, and
      // neither is compared above, so this cannot re-enter.
      if (!changed || !sim.current) return;
      const layout = { items: state.items, connections: state.connections };
      // Stepping zero slices reconciles the state with the layout — racks just
      // placed get their starting temperature, deleted ones drop out — without
      // advancing time. Without this a rack added while the loop is throttled
      // would have no temperature to report.
      sim.current = stepSim(sim.current, layout, state.controlMode, 0);
      state.publishSim(sim.current.inletC, readTelemetry(sim.current, layout, state.controlMode));
    });
  }, []);
}
