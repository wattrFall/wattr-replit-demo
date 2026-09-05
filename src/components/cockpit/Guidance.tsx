import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, RotateCcw, X } from "lucide-react";
import type { Role } from "@/lib/security/rolePolicy";

export type GuideStep = {
  id: string;
  title: string;
  body: string;
  route: string;
  target: string;
  action?: string;
  actionLabel?: string;
};

const stepsByRole: Record<Role, GuideStep[]> = {
  PORTFOLIO_MANAGER: [
    { id: "portfolio", title: "Start with ranked facility health", body: "Use the authorized site list to find predicted risk before opening a facility.", route: "/portfolio", target: ".panel" },
    { id: "twin", title: "Inspect the live operating twin", body: "The twin, HUD, forecast, and replay clock share one deterministic instant.", route: "/operations", target: "[data-guide='twin']", action: "asset-select", actionLabel: "Select an asset" },
  ],
  OPERATOR: [
    { id: "orbit", title: "Orient in orbit view", body: "Drag to orbit, wheel to zoom, and right-drag to pan. This changes only your viewpoint.", route: "/operations", target: "[data-guide='camera-orbit']", action: "camera-orbit", actionLabel: "Choose Orbit" },
    { id: "walk", title: "Enter aisle-level walkthrough", body: "Walk mode uses WASD and drag-to-look. Escape always releases pointer capture.", route: "/operations", target: "[data-guide='camera-walk']", action: "camera-walk", actionLabel: "Choose Walk" },
    { id: "floor", title: "Move between facility floors", body: "Floor navigation changes the visible model level without changing replay state.", route: "/operations", target: "[data-guide='floor-change']", action: "floor-change", actionLabel: "Choose another floor" },
    { id: "asset", title: "Inspect an asset", body: "Select a rack, cooling unit, power asset, or sensor to load its synchronized HUD context.", route: "/operations", target: "[data-guide='assets']", action: "asset-select", actionLabel: "Select an asset" },
    { id: "thermal", title: "Reveal the thermal pattern", body: "Thermal view maps modeled inlet temperature; it does not imply measured telemetry.", route: "/operations", target: "[data-guide='view'] button:last-of-type", action: "thermal-view", actionLabel: "Turn on Thermal overlay" },
    { id: "incident", title: "Trace the active incident", body: "Open the correlated incident and review its evidence and thermal path.", route: "/incidents/inc-204", target: ".panel", action: "incident-review", actionLabel: "Select the incident" },
    { id: "recommendation", title: "Compare the advisory", body: "Run a same-input what-if before deciding. Only advisory parameters change.", route: "/recommendations/rec-17", target: "[data-guide='what-if'] button", action: "what-if", actionLabel: "Run comparison" },
    { id: "safety", title: "Run the Safety Shield", body: "The server verifies this command, model, user, and replay instant. It never grants decision authority.", route: "/recommendations/rec-17", target: "[data-guide='safety'] button", action: "safety-run", actionLabel: "Run Safety Shield" },
    { id: "decision", title: "Record a human disposition", body: "Approve, reject, defer, or request an alternative. No choice sends an equipment command.", route: "/recommendations/rec-17", target: "[data-guide='disposition'] button", action: "decision-record", actionLabel: "Record a disposition" },
    { id: "audit", title: "Reconstruct the immutable record", body: "Select a decision to load the exact stored scenario, evidence, model, and Safety Shield result.", route: "/audit", target: "[data-guide='audit'] button", action: "audit-reconstruct", actionLabel: "Select a record" },
  ],
  ENGINEER: [
    { id: "twin", title: "Inspect the operating twin", body: "Select an asset to connect physical state to the canonical replay instant.", route: "/operations", target: "[data-guide='assets']", action: "asset-select", actionLabel: "Select an asset" },
    { id: "thermal", title: "Compare thermal state", body: "Thermal view reveals modeled heat distribution without changing the underlying state.", route: "/operations", target: "[data-guide='view'] button:last-of-type", action: "thermal-view", actionLabel: "Turn on Thermal overlay" },
    { id: "topology", title: "Trace heat dependencies", body: "Select a graph node to see upstream causes and downstream cooling impact.", route: "/topology", target: ".panel" },
    { id: "model-lab", title: "Compare controllers fairly", body: "Run all controller rows from the same state and event stream.", route: "/model-lab", target: ".panel", action: "model-compare", actionLabel: "Run comparison" },
  ],
  MODEL_ADMIN: [
    { id: "edit", title: "Enter explicit model edit mode", body: "This preview is separate from Operations. Draft changes remain unpublished until you act.", route: "/model", target: "#model-config", action: "model-draft", actionLabel: "Save a draft" },
    { id: "validate", title: "Validate the draft", body: "Validation checks model configuration before publication becomes available.", route: "/model", target: "[data-guide='model-validate']", action: "model-validate", actionLabel: "Validate a draft" },
    { id: "publish", title: "Publish deliberately", body: "Publication changes the model Operations consumes and remains an explicit action.", route: "/model", target: "[data-guide='model-publish']", action: "model-publish", actionLabel: "Publish a validated version" },
    { id: "rollback", title: "Know the rollback path", body: "An archived validated version can be restored deliberately from version history.", route: "/model", target: ".panel" },
  ],
  VIEWER: [
    { id: "twin", title: "Explore read-only operations", body: "Select an asset and inspect its synchronized state. Your role cannot record operational decisions.", route: "/operations", target: "[data-guide='assets']", action: "asset-select", actionLabel: "Select an asset" },
    { id: "thermal", title: "Read the thermal layer", body: "Thermal view maps modeled temperatures while preserving the operational HUD.", route: "/operations", target: "[data-guide='view'] button:last-of-type", action: "thermal-view", actionLabel: "Turn on Thermal overlay" },
    { id: "audit", title: "Review historical context", body: "Select an available audit record to reconstruct what was known at decision time.", route: "/audit", target: "[data-guide='audit'] button", action: "audit-reconstruct", actionLabel: "Select a record" },
  ],
};

type GuidanceContextValue = { emit: (action: string) => void; restart: () => void };
const GuidanceContext = createContext<GuidanceContextValue>({ emit: () => {}, restart: () => {} });
export const useGuidance = () => useContext(GuidanceContext);

function routeFor(step: GuideStep, facilityId?: string) {
  return step.route === "/portfolio" ? "/portfolio" : facilityId ? `/facilities/${facilityId}${step.route}` : "/portfolio";
}

export function GuidanceProvider({ role, facilityId, initialStep, initialComplete, save, navigate, children }: {
  role: Role; facilityId?: string; initialStep: number; initialComplete: boolean;
  save: (step: number, complete: boolean) => Promise<void>; navigate: (path: string) => void; children: ReactNode;
}) {
  const steps = stepsByRole[role];
  const [stepIndex, setStepIndex] = useState(Math.min(initialStep, Math.max(steps.length - 1, 0)));
  const [open, setOpen] = useState(!initialComplete);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const originRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const current = steps[stepIndex];

  const locate = useCallback(() => {
    if (!open || !current) return;
    const target = document.querySelector<HTMLElement>(current.target);
    setRect(target?.getBoundingClientRect() ?? null);
  }, [current, open]);
  useLayoutEffect(() => {
    locate();
    addEventListener("resize", locate);
    addEventListener("scroll", locate, true);
    const timer = window.setInterval(locate, 500);
    return () => { removeEventListener("resize", locate); removeEventListener("scroll", locate, true); clearInterval(timer); };
  }, [locate]);
  useEffect(() => {
    if (!open || !current) return;
    const wanted = routeFor(current, facilityId);
    if (location.pathname !== wanted) navigate(wanted);
  }, [open, stepIndex, role]);
  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus({ preventScroll: true });
    setNotice(`Guided tutorial step ${stepIndex + 1} of ${steps.length}: ${current.title}. ${current.body} ${current.actionLabel ? `Required action: ${current.actionLabel}.` : ""}`);
  }, [open, stepIndex, current, steps.length]);

  const persist = useCallback(async (next: number, complete: boolean) => {
    const bounded = Math.min(next, Math.max(steps.length - 1, 0));
    setStepIndex(bounded);
    try {
      await save(next, complete);
      setError("");
      if (complete) { setOpen(false); setNotice("Tutorial complete. You can restart it from Help and tutorials."); originRef.current?.focus(); }
    } catch (cause) { setError(String(cause)); }
  }, [save, steps.length]);

  const emit = useCallback((action: string) => {
    if (!open || !current?.action || current.action !== action) return;
    const finished = stepIndex + 1 >= steps.length;
    setNotice(`${current.title} complete.${finished ? " Tutorial complete." : ` Moving to step ${stepIndex + 2}.`}`);
    void persist(stepIndex + 1, finished);
  }, [current, open, persist, stepIndex, steps.length]);
  const restart = useCallback(() => {
    originRef.current = document.activeElement as HTMLElement | null;
    setOpen(true); setNotice("Tutorial restarted at step 1."); void persist(0, false);
  }, [persist]);
  useEffect(() => {
    const onRestart = () => restart();
    addEventListener("wattr:restart-guide", onRestart);
    return () => removeEventListener("wattr:restart-guide", onRestart);
  }, [restart]);

  const skip = () => { const finished = stepIndex + 1 >= steps.length; void persist(stepIndex + 1, finished); };
  const continueLater = () => { setOpen(false); setNotice(`Tutorial paused at step ${stepIndex + 1}. Progress is saved.`); originRef.current?.focus(); };
  const focusTarget = () => {
    const target = document.querySelector<HTMLElement>(current.target);
    const focusable = target?.matches("button, a[href], input, select, textarea, [tabindex]")
      ? target
      : target?.querySelector<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]");
    focusable?.focus({ preventScroll: false });
  };
  const cardStyle = rect ? {
    left: Math.min(window.innerWidth - 340, Math.max(12, rect.left)),
    top: rect.bottom + 220 < window.innerHeight ? rect.bottom + 12 : Math.max(74, rect.top - 210),
  } : { right: 16, bottom: 16 };

  return <GuidanceContext.Provider value={{ emit, restart }}>
    {children}
    <span className="sr-only" role="status" aria-live="polite">{notice}</span>
    {open && current && <div className="guide-layer" aria-live="polite">
      {rect && <div className="guide-spotlight" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }}/>}
      <section ref={cardRef} tabIndex={-1} className="guide-card" style={cardStyle} role="region" aria-labelledby="guide-title" aria-describedby="guide-body">
        <div className="flex items-start justify-between gap-3"><div><div className="eyebrow">GUIDED TWIN · {stepIndex + 1}/{steps.length}</div><h2 id="guide-title" className="mt-1 font-semibold">{current.title}</h2></div><button className="icon-button" onClick={continueLater} aria-label="Continue tutorial later"><X size={15}/></button></div>
        <p id="guide-body" className="mt-3 text-xs leading-5 text-slate-300">{current.body}</p>
        <p className="mt-3 text-xs text-cyan-300">{current.actionLabel ? `Required: ${current.actionLabel}.` : "Review this area, then continue."}</p>
        {!rect && <p className="mt-2 text-xs text-amber-300">This control is unavailable here. Skip this step or open its workspace.</p>}
        {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="button secondary" disabled={stepIndex === 0} onClick={() => void persist(stepIndex - 1, false)}><ArrowLeft size={13}/>Back</button>
          <button className="button secondary" onClick={skip}>Skip</button>
          {rect && <button className="button secondary" onClick={focusTarget}>Focus control</button>}
          {!current.action && <button className="button primary" onClick={() => void persist(stepIndex + 1, stepIndex + 1 >= steps.length)}>Next<ArrowRight size={13}/></button>}
        </div>
        <button className="tutorial-later" onClick={continueLater}>Continue later</button>
      </section>
    </div>}
  </GuidanceContext.Provider>;
}

export function RestartGuidanceButton() {
  const { restart } = useGuidance();
  return <button type="button" className="button secondary" onClick={restart}><RotateCcw size={15}/>Restart guided tutorial</button>;
}