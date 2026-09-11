import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeError } from "./api";
import { ArrowRight, BookOpen, RotateCcw, X } from "lucide-react";
import type { Role } from "@/lib/security/rolePolicy";
import { tutorialPageLabel, tutorialRouteFor } from "@/lib/cockpit/tutorial";

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
    { id: "replay", title: "Set the scenario time", body: "Play, step, or scrub the deterministic scenario here. Every Operations panel follows this one clock.", route: "/operations", target: "[data-guide='replay']" },
    { id: "twin", title: "Explore read-only operations", body: "Select an asset in the twin to inspect its synchronized state. Viewer access never records an operational decision.", route: "/operations", target: "[data-guide='assets']", action: "asset-select", actionLabel: "Select an asset" },
    { id: "thermal", title: "Read the thermal layer", body: "Choose Thermal overlay to map modeled inlet temperatures without hiding the operational HUD.", route: "/operations", target: "[data-guide='view'] button:last-of-type", action: "thermal-view", actionLabel: "Turn on Thermal overlay" },
    { id: "layers", title: "Control operational layers", body: "Use the controls beside the twin view to reveal heat, flow, sensors, labels, incidents, and forecast context without changing the simulation.", route: "/operations", target: "[data-guide='view']" },
    { id: "timeline", title: "Jump to an authored event", body: "The timeline moves the shared replay clock to a meaningful scenario checkpoint.", route: "/operations", target: ".timeline" },
    { id: "assistant", title: "Ask Wattr with evidence", body: "Ask a natural-language question about the authorized facility. Answers stay grounded in structured records and cannot issue commands.", route: "/ask-wattr", target: ".panel" },
    { id: "audit", title: "Review historical context", body: "Select an available audit record to reconstruct what was known at decision time.", route: "/audit", target: "[data-guide='audit'] button", action: "audit-reconstruct", actionLabel: "Select a record" },
  ],
};

type GuidanceContextValue = { emit: (action: string) => void; restart: () => void };
const GuidanceContext = createContext<GuidanceContextValue>({ emit: () => {}, restart: () => {} });
export const useGuidance = () => useContext(GuidanceContext);

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
  const locatedStepRef = useRef("");
  const [cardSize, setCardSize] = useState({ width: 344, height: 270 });
  const current = steps[stepIndex];
  const recoverFocus = () => {
    const target = originRef.current?.isConnected
      ? originRef.current
      : document.querySelector<HTMLElement>("#main-content");
    target?.focus({ preventScroll: true });
  };

  // The tutorial never changes pages by itself. A step on another page offers
  // an explicit "Open <page>" button instead.
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onNavigate = () => setPath(location.pathname);
    addEventListener("popstate", onNavigate);
    return () => removeEventListener("popstate", onNavigate);
  }, []);
  const stepPath = current ? tutorialRouteFor(current.route, facilityId) : "";
  const onStepPage = path === stepPath;

  const locate = useCallback(() => {
    if (!open || !current) return;
    const target = onStepPage ? document.querySelector<HTMLElement>(current.target) : null;
    if (!target) {
      setRect(null);
      return;
    }
    if (locatedStepRef.current !== current.id) {
      locatedStepRef.current = current.id;
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      window.setTimeout(() => setRect(target.getBoundingClientRect()), 220);
    } else {
      setRect(target.getBoundingClientRect());
    }
  }, [current, open, onStepPage]);
  useLayoutEffect(() => {
    locate();
    addEventListener("resize", locate);
    addEventListener("scroll", locate, true);
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(locate, 500);
    return () => { removeEventListener("resize", locate); removeEventListener("scroll", locate, true); observer.disconnect(); clearInterval(timer); };
  }, [locate]);
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return;
    const update = () => {
      const box = cardRef.current?.getBoundingClientRect();
      if (box) setCardSize({ width: box.width, height: box.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [open, current]);
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
      if (complete) { setOpen(false); setNotice("Tutorial complete. You can restart it from Help and tutorials."); recoverFocus(); }
    } catch (cause) { setError(describeError(cause)); }
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

  const next = () => { const finished = stepIndex + 1 >= steps.length; void persist(stepIndex + 1, finished); };
  // Skipping is remembered: the tutorial won't open by itself again until it
  // is restarted from Help.
  const skip = async () => {
    setOpen(false);
    recoverFocus();
    try {
      await save(stepIndex, true);
      setNotice("Tutorial skipped. You can restart it from Help at any time.");
    } catch {
      setNotice("Tutorial closed, but skipping couldn't be saved, so it may open again next time.");
    }
  };
  const cardStyle = (() => {
    if (!rect) return { right: 16, bottom: 16 };
    const margin = 16;
    const cardWidth = Math.min(cardSize.width, window.innerWidth - margin * 2);
    const estimatedHeight = cardSize.height;
    const clampedTop = Math.min(
      window.innerHeight - estimatedHeight - margin,
      Math.max(74, rect.top),
    );
    if (rect.right + margin + cardWidth <= window.innerWidth) {
      return { left: rect.right + margin, top: clampedTop };
    }
    if (rect.left - margin - cardWidth >= margin) {
      return { left: rect.left - margin - cardWidth, top: clampedTop };
    }
    if (rect.bottom + margin + estimatedHeight <= window.innerHeight) {
      return {
        left: Math.min(window.innerWidth - cardWidth - margin, Math.max(margin, rect.left)),
        top: rect.bottom + margin,
      };
    }
    return {
      left: Math.min(window.innerWidth - cardWidth - margin, Math.max(margin, rect.left)),
      bottom: Math.max(margin, window.innerHeight - rect.top + margin),
    };
  })();

  return <GuidanceContext.Provider value={{ emit, restart }}>
    {children}
    <span className="sr-only" role="status" aria-live="polite">{notice}</span>
    {open && current && <div className="guide-layer" aria-live="polite">
      {rect && <div className="guide-spotlight" style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }}/>}
      <section ref={cardRef} tabIndex={-1} className="guide-card" style={cardStyle} role="region" aria-labelledby="guide-title" aria-describedby="guide-body">
        <div className="flex items-start justify-between gap-3"><div><div className="eyebrow">GUIDED TWIN · {stepIndex + 1}/{steps.length}</div><h2 id="guide-title" className="mt-1 font-semibold">{current.title}</h2></div><button className="icon-button" onClick={skip} aria-label="Close tutorial"><X size={15}/></button></div>
        <p id="guide-body" className="mt-3 text-xs leading-5 text-slate-300">{current.body}</p>
        <p className="mt-3 text-xs text-cyan-300">{current.actionLabel ? `Required: ${current.actionLabel}.` : "Review this area, then continue."}</p>
        {!onStepPage && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-amber-300"><span>This step is on the {tutorialPageLabel(current.route)} page.</span><button className="button secondary" onClick={() => navigate(stepPath)}>Open {tutorialPageLabel(current.route)} <ArrowRight size={14}/></button></div>}
        {onStepPage && !rect && <p className="mt-2 text-xs text-amber-300">This control isn't visible right now. Use Next to continue.</p>}
        {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="button secondary" disabled={stepIndex === 0} onClick={() => void persist(stepIndex - 1, false)}>Back</button>
          <button className="button primary" onClick={next}>Next</button>
        </div>
        <button className="tutorial-later" onClick={skip}>Skip tutorial</button>
      </section>
    </div>}
  </GuidanceContext.Provider>;
}

export function RestartGuidanceButton() {
  const { restart } = useGuidance();
  return <button type="button" className="button secondary" onClick={restart}><RotateCcw size={15}/>Restart guided tutorial</button>;
}