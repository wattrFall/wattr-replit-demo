/** The signed-in page frame, its navigation and the shared replay controls. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useClerk } from "@clerk/react";
import {
  Activity, AlertTriangle, ArrowRight, Boxes, BrainCircuit, CircleHelp, Clock3, Gauge, GitBranch, History,
  LayoutDashboard, LogOut, Menu, MessageSquare, Pause, Play, RotateCcw, ShieldCheck, SkipForward, SlidersHorizontal, UserCog,
  type LucideIcon,
} from "lucide-react";
import { learningSurfaceForPath } from "@/lib/cockpit/learning";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { SCENARIO_DURATION_S } from "@/lib/cockpit/simulation";
import { ROLES, canViewTopology, type Role } from "@/lib/security/rolePolicy";
import { ApiError, clearTestIdentity, describeError, navigate, post, SESSION_CHANGED } from "./api";
import type { Facility, SessionData } from "./types";
import { Brand, mono, Status, ThemeControl } from "./ui";

/**
 * Feedback on the current workspace, from a small header control rather than a
 * panel at the foot of every page. Structured choices only, so no
 * facility-sensitive detail or operator notes enter learning records.
 */
function FeedbackControl({ facility }: { facility?: Facility }) {
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<"POSITIVE" | "NEUTRAL" | "NEGATIVE">("NEUTRAL");
  const [feedbackCode, setFeedbackCode] = useState("HELPFUL");
  const [message, setMessage] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    addEventListener("keydown", closeOnEscape);
    addEventListener("mousedown", closeOutside);
    return () => {
      removeEventListener("keydown", closeOnEscape);
      removeEventListener("mousedown", closeOutside);
    };
  }, [open]);

  const submit = async () => {
    try {
      await post("/api/learning/feedback", {
        ...(facility ? { facilityId: facility.id } : {}),
        surface: learningSurfaceForPath(location.pathname),
        sentiment,
        feedbackCode,
      });
      setMessage("Thanks. Your feedback was saved.");
    } catch (cause) {
      setMessage(`Feedback was not saved. ${describeError(cause)}`);
    }
  };

  return <div className="feedback-control">
    <button ref={triggerRef} type="button" className="feedback-trigger" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => { setOpen(!open); setMessage(""); }}>
      <MessageSquare size={13} aria-hidden="true"/><span>Feedback</span>
    </button>
    {open && <div ref={panelRef} id={panelId} role="dialog" aria-label="Share feedback on this workspace" className="feedback-panel">
      <b className="block text-sm">Feedback on this workspace</b>
      <p className="mt-1 text-xs leading-5 text-slate-500">Optional. Structured choices only, so no facility details or notes are recorded.</p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="How was this workspace?">
        {([["POSITIVE", "Good"], ["NEUTRAL", "Okay"], ["NEGATIVE", "Poor"]] as const).map(([value, label]) => <button type="button" key={value} className={`speed ${sentiment === value ? "selected" : ""}`} aria-pressed={sentiment === value} onClick={() => setSentiment(value)}>{label}</button>)}
      </div>
      <label className="field mt-3 block">What best describes it?<select className="select mt-2 w-full" value={feedbackCode} onChange={(event) => setFeedbackCode(event.target.value)}><option value="HELPFUL">Helpful</option><option value="UNCLEAR">Unclear</option><option value="MISSING_CONTEXT">Missing context</option><option value="TOO_SLOW">Too slow</option><option value="UNEXPECTED_RESULT">Unexpected result</option><option value="OTHER">Other product friction</option></select></label>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="button primary" onClick={submit}>Send feedback</button>
        <button type="button" className="button secondary" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>Close</button>
      </div>
      {message && <p className="mt-2 text-xs leading-5 text-slate-400" role="status">{message}</p>}
    </div>}
  </div>;
}

const ROLE_LABELS: Record<Role, string> = {
  PORTFOLIO_MANAGER: "Portfolio manager",
  OPERATOR: "Operator",
  ENGINEER: "Engineer",
  MODEL_ADMIN: "Model admin",
  VIEWER: "Viewer",
};

/**
 * The seat you are in: the demo's role switch and the way out.
 *
 * This is a synthetic environment, so taking another role needs no further
 * sign-in. The server still enforces whichever role it finds on every request,
 * and administrator and owner rights are not granted here.
 */
function SessionMenu({ data }: { data: SessionData }) {
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    addEventListener("keydown", closeOnEscape);
    addEventListener("mousedown", closeOutside);
    return () => {
      removeEventListener("keydown", closeOnEscape);
      removeEventListener("mousedown", closeOutside);
    };
  }, [open]);

  const takeRole = async (role: Role) => {
    if (role === data.me.role) { setOpen(false); return; }
    setBusy(true);
    setError("");
    try {
      const seat = await post<{ default_path: string }>("/api/me/role", { role });
      dispatchEvent(new Event(SESSION_CHANGED));
      setOpen(false);
      navigate(seat.default_path.replace("{facilityId}", data.facilities[0]?.id ?? ""));
    } catch (cause) {
      // A server that predates role switching has no such route, and its API
      // answers "Not found"; say what that actually means.
      setError(cause instanceof ApiError && cause.status === 404
        ? "This server has not picked up role switching yet. Restart or redeploy it, then try again."
        : describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    clearTestIdentity();
    try {
      await clerk.signOut();
    } catch {
      // Clerk is unavailable in local development; the development sign-in is already cleared.
    }
    location.assign("/");
  };

  return <div className="session-control">
    <button ref={triggerRef} type="button" className="session-trigger" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      <UserCog size={13} aria-hidden="true"/><span>{ROLE_LABELS[data.me.role] ?? data.me.role}</span>
    </button>
    {open && <div ref={panelRef} id={panelId} role="dialog" aria-label="Your seat in this demo" className="session-panel">
      <b className="block text-sm">{data.me.display_name}</b>
      <p className="mt-1 text-xs leading-5 text-slate-500">Synthetic demo environment: take any role to see the product from that seat. No further sign-in is needed, and the role you take is enforced on every request.</p>
      <div className="mt-3 grid gap-1" role="group" aria-label="Take a role">
        {ROLES.map((role) => <button
          key={role}
          type="button"
          className={`session-role ${role === data.me.role ? "current" : ""}`}
          aria-pressed={role === data.me.role}
          disabled={busy}
          onClick={() => takeRole(role)}
        ><span>{ROLE_LABELS[role]}</span>{role === data.me.role && <small>current</small>}</button>)}
      </div>
      {data.me.is_owner && <p className="mt-2 text-[11px] leading-5 text-slate-500">Owner and administrator rights stay with your account whichever role you take.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      <button type="button" className="button secondary mt-3 w-full justify-center" onClick={signOut}><LogOut size={14} aria-hidden="true"/>Sign out</button>
    </div>}
  </div>;
}

/** Where the sidebar was scrolled, so it holds its place as pages change. */
let sidebarScrollTop = 0;

/** Mark which edges of the sidebar list have more items beyond them, for the fade that says so. */
function markSidebarOverflow(list: HTMLElement) {
  const above = list.scrollTop > 1;
  const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
  list.dataset.more = [above && "above", below && "below"].filter(Boolean).join(" ");
}

export function Shell({ data, facility, children }: { data: SessionData; facility?: Facility; children: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Each page mounts its own shell: restore the sidebar's scroll, then make sure the current page shows.
  useLayoutEffect(() => {
    const list = navRef.current;
    if (!list) return;
    list.scrollTop = sidebarScrollTop;
    const current = list.querySelector<HTMLElement>("[aria-current='page']");
    if (!current) return;
    const top = current.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + current.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + current.offsetHeight - list.clientHeight;
  }, []);
  useEffect(() => {
    const list = navRef.current;
    if (!list) return;
    const mark = () => markSidebarOverflow(list);
    mark();
    addEventListener("resize", mark);
    return () => removeEventListener("resize", mark);
  }, []);
  const active = facility ?? data.facilities[0];
  const nav: Array<[LucideIcon, string, string]> = [
    ...(data.me.role === "PORTFOLIO_MANAGER" ? [[LayoutDashboard, "Portfolio", "/portfolio"] as [LucideIcon, string, string]] : []),
    ...(data.me.role === "PORTFOLIO_MANAGER" ? [[BrainCircuit, "Ask Wattr", "/ask-wattr"] as [LucideIcon, string, string]] : []),
    ...(active ? [
      [Gauge, "Operations", `/facilities/${active.id}/operations`] as [LucideIcon, string, string],
      [Boxes, "Facility intelligence", `/facilities/${active.id}/intelligence`] as [LucideIcon, string, string],
      [History, "Configuration history", `/facilities/${active.id}/history`] as [LucideIcon, string, string],
      [GitBranch, "Scenario replay", `/facilities/${active.id}/replay`] as [LucideIcon, string, string],
      [AlertTriangle, "Incident", `/facilities/${active.id}/incidents/inc-204`] as [LucideIcon, string, string],
      [ShieldCheck, "Recommendation", `/facilities/${active.id}/recommendations/rec-17`] as [LucideIcon, string, string],
      [History, "Audit history", `/facilities/${active.id}/audit`] as [LucideIcon, string, string],
      ...(active.can_assistant && data.me.role !== "PORTFOLIO_MANAGER" ? [[BrainCircuit, "Ask Wattr", `/facilities/${active.id}/ask-wattr`] as [LucideIcon, string, string]] : []),
      ...(canViewTopology(data.me.role, data.me.is_owner) ? [[GitBranch, "Thermal graph", `/facilities/${active.id}/topology`] as [LucideIcon, string, string]] : []),
      ...(active.can_engineer ? [[BrainCircuit, "Model Lab", `/facilities/${active.id}/model-lab`] as [LucideIcon, string, string]] : []),
      // Everyone with access to the facility can build for now; build permissions come later.
      [Boxes, "Facility builder", `/facilities/${active.id}/builder`] as [LucideIcon, string, string],
      [Boxes, "Import engineering data", `/facilities/${active.id}/import`] as [LucideIcon, string, string],
      ...(active.can_edit_model ? [[SlidersHorizontal, "Model Studio", `/facilities/${active.id}/model`] as [LucideIcon, string, string]] : []),
    ] : []),
    ...(data.me.is_admin ? [[UserCog, "Access administration", "/admin"] as [LucideIcon, string, string]] : []),
    ...((data.me.role === "PORTFOLIO_MANAGER" || data.me.is_admin) ? [[Activity, "Learning outcomes", "/learning"] as [LucideIcon, string, string]] : []),
  ];
  return <div className="cockpit min-h-[100dvh] bg-[#0a1018] text-slate-200">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="fixed inset-x-0 top-0 z-30 flex h-[62px] items-center justify-between border-b border-slate-800 bg-[#0a1018]/95 px-4">
      <div className="flex items-center gap-4">
        <button ref={menuButtonRef} type="button" className="md:hidden" onClick={() => setMobile(!mobile)} aria-label={mobile ? "Close navigation" : "Open navigation"} aria-expanded={mobile} aria-controls="cockpit-navigation"><Menu size={20} aria-hidden="true"/></button><Brand/>
      </div>
      <div className="flex items-center gap-3 text-xs"><span className="hidden text-slate-500 sm:inline">SYNTHETIC ENVIRONMENT</span><SessionMenu data={data}/><FeedbackControl facility={facility}/><ThemeControl/></div>
    </header>
    {mobile && <button type="button" className="mobile-scrim md:hidden" aria-label="Close navigation" onClick={() => { setMobile(false); menuButtonRef.current?.focus(); }}/>}
    <aside id="cockpit-navigation" aria-label="Primary navigation" className={`cockpit-sidebar fixed bottom-0 left-0 top-[62px] z-20 w-[232px] border-r border-slate-800 bg-[#0b121c] transition-transform md:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="sidebar-facility rounded-md border border-slate-800 bg-[#101a26] p-3"><div className="text-[9px] tracking-[.18em] text-slate-500">AUTHORIZED FACILITY</div><div className="mt-1 text-sm font-semibold">{active?.name ?? "No facility access"}</div><div className="text-[11px] text-slate-500">{active?.location}</div></div>
      <nav ref={navRef} className="sidebar-nav" onScroll={(event) => { sidebarScrollTop = event.currentTarget.scrollTop; markSidebarOverflow(event.currentTarget); }}>{nav.map(([Icon, label, path]) => <button type="button" key={label} onClick={() => { setMobile(false); navigate(path); }} className={`cockpit-nav ${location.pathname === path ? "active" : ""}`} aria-current={location.pathname === path ? "page" : undefined}><Icon size={16} aria-hidden="true"/><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><button type="button" onClick={() => { setMobile(false); navigate("/help"); }} className={`cockpit-nav ${location.pathname === "/help" ? "active" : ""}`} aria-current={location.pathname === "/help" ? "page" : undefined}><CircleHelp size={16} aria-hidden="true"/><span>Help & tutorials</span></button></div>
    </aside>
    <main id="main-content" tabIndex={-1} className="pt-[62px] md:pl-[232px]"><div className="mx-auto max-w-[1600px] p-4 md:p-7">{children}</div></main>
  </div>;
}

export function ReplayBar({ onReset = () => {} }: { onReset?: () => void }) {
  const s = useScenarioSession();
  const elapsed = s.simulation.snapshot.elapsedS;
  if (!location.pathname.endsWith("/operations")) return null;
  return <section className="replay-bar mb-4" data-guide="replay" aria-label="Canonical replay controls">
    <div className="flex flex-wrap items-center gap-3"><Clock3 size={15} className="text-cyan-300" aria-hidden="true"/><span className={`${mono} text-xs`}>{formatSimulatedAt(s.simulatedAt)}</span><span className="text-xs text-slate-500">· {Math.round(elapsed / 60)} of 30 min</span><div className="ml-auto flex items-center gap-1" role="group" aria-label="Replay speed"><span className="mr-1 text-[10px] uppercase tracking-[.12em] text-slate-500">Speed</span>{([1,5,10,30,60] as const).map(v => <button type="button" aria-label={`Replay speed ${v} times`} aria-pressed={s.speed === v} key={v} onClick={() => s.setSpeed(v)} className={`speed ${s.speed === v ? "selected" : ""}`}>{v}×</button>)}</div><button type="button" className="button secondary" onClick={() => s.setPlaying(!s.playing)}>{s.playing ? <Pause size={15} aria-hidden="true"/> : <Play size={15} aria-hidden="true"/>} {s.playing ? "Pause" : "Play"}</button></div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className="button secondary" onClick={() => s.step(30)} disabled={elapsed >= SCENARIO_DURATION_S}><SkipForward size={14} aria-hidden="true"/>Step 30s</button><button type="button" className="button secondary" onClick={() => s.jump(Math.max(0, elapsed - 300))} disabled={elapsed === 0}>−5m</button><button type="button" className="button secondary" onClick={() => s.jump(Math.min(SCENARIO_DURATION_S, elapsed + 300))} disabled={elapsed >= SCENARIO_DURATION_S}>+5m</button><button type="button" className="button secondary" onClick={() => s.jump(900)} disabled={elapsed === 900}>Jump to forecast</button><input aria-label="Replay position" aria-valuetext={`${Math.round(elapsed / 60)} minutes into the 30 minute scenario`} className="replay-range" type="range" min="0" max={SCENARIO_DURATION_S} step="1" value={elapsed} onChange={(event) => s.jump(Number(event.target.value))}/><span className={`${mono} text-[10px] text-slate-500`}>{Math.round(elapsed / 60)}m</span><button type="button" className="button secondary" onClick={() => { s.reset(); onReset(); }}><RotateCcw size={15} aria-hidden="true"/>Reset</button><Status tone={s.mode === "Advisory" ? "warn" : "good"}>{s.mode} · human-in-loop</Status></div>
    <p className="sr-only" role="status" aria-live="polite">Replay at {Math.round(elapsed / 60)} minutes. {s.playing ? `Playing at ${s.speed} times speed.` : "Paused."}</p>
  </section>;
}
