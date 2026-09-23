/** The signed-in page frame, its navigation and the shared replay controls. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useClerk } from "@clerk/react";
import {
  Activity, AlertTriangle, ArrowLeft, Boxes, BrainCircuit, Building2, ChevronsUpDown, CircleHelp, Clock3, Ellipsis, FastForward, FileUp,
  FlaskConical, Gauge, History, LayoutDashboard, LogOut, Menu, MessageSquare, Network, Pause, Play, Rewind,
  RotateCcw, ScrollText, ShieldCheck, SkipForward, SlidersHorizontal, Users, type LucideIcon,
} from "lucide-react";
import { learningSurfaceForPath } from "@/lib/cockpit/learning";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { SCENARIO_DURATION_S } from "@/lib/cockpit/simulation";
import { ROLES, canViewTopology, type Role } from "@/lib/security/rolePolicy";
import { ApiError, clearTestIdentity, describeError, navigate, post, SESSION_CHANGED } from "./api";
import { Floating, useDismiss } from "./Floating";
import type { Facility, SessionData } from "./types";
import { ContextualHelp, mono, Segmented, ThemeControl } from "./ui";

export const ROLE_LABELS: Record<Role, string> = {
  PORTFOLIO_MANAGER: "Portfolio manager",
  OPERATOR: "Operator",
  ENGINEER: "Engineer",
  MODEL_ADMIN: "Model admin",
  VIEWER: "Viewer",
};

type Sentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

/**
 * Everything about you and this session, one click away at the foot of the
 * sidebar: the demo's role switch, appearance, feedback, administration and
 * the way out.
 *
 * This is a synthetic environment, so taking another role needs no further
 * sign-in. The server still enforces whichever role it finds on every request,
 * and administrator and owner rights are not granted here. Feedback takes
 * structured choices only, so no facility-sensitive detail or operator notes
 * enter learning records.
 */
function AccountMenu({ data, facility, onNavigate }: { data: SessionData; facility?: Facility; onNavigate: () => void }) {
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "feedback">("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentiment, setSentiment] = useState<Sentiment>("NEUTRAL");
  const [feedbackCode, setFeedbackCode] = useState("HELPFUL");
  const [message, setMessage] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = () => { setOpen(false); setView("menu"); setMessage(""); setError(""); };
  useDismiss(open, close, triggerRef, panelRef);
  // Moving between the menu and the feedback form keeps focus inside the panel.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    panelRef.current?.querySelector<HTMLElement>("button, select")?.focus();
  }, [view]);

  const go = (path: string) => { close(); onNavigate(); navigate(path); };

  const takeRole = async (role: Role) => {
    if (role === data.me.role) { close(); return; }
    setBusy(true);
    setError("");
    try {
      const seat = await post<{ default_path: string }>("/api/me/role", { role });
      dispatchEvent(new Event(SESSION_CHANGED));
      go(seat.default_path.replace("{facilityId}", data.facilities[0]?.id ?? ""));
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

  const initials = data.me.display_name.split(/\s+/).map((word) => word.charAt(0)).join("").slice(0, 2).toUpperCase();
  const learning = data.me.role === "PORTFOLIO_MANAGER" || data.me.is_admin;

  return <>
    <button ref={triggerRef} type="button" className="account-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => open ? close() : setOpen(true)}>
      <span className="account-avatar" aria-hidden="true">{initials}</span>
      <span className="account-name"><b>{data.me.display_name}</b><small>{ROLE_LABELS[data.me.role] ?? data.me.role}</small></span>
      <ChevronsUpDown size={14} aria-hidden="true"/>
    </button>
    <Floating open={open} anchorRef={triggerRef} floatingRef={panelRef} side="top" align="start" id={panelId} role="dialog" aria-label={view === "menu" ? "Your account" : "Share feedback on this workspace"} className="account-panel">
      {view === "menu" ? <>
        <section className="account-section" aria-label="Role">
          <div className="eyebrow">Role</div>
          <div className="mt-1 grid gap-0.5" role="group" aria-label="Take a role">
            {ROLES.map((role) => <button
              key={role}
              type="button"
              className={`session-role ${role === data.me.role ? "current" : ""}`}
              aria-pressed={role === data.me.role}
              disabled={busy}
              onClick={() => takeRole(role)}
            ><span>{ROLE_LABELS[role]}</span>{role === data.me.role && <small>Current</small>}</button>)}
          </div>
          <p className="account-note">A synthetic demo: take any role without signing in again. The role you take is enforced on every request.</p>
          {data.me.is_owner && <p className="account-note">Owner and administrator rights stay with your account whichever role you take.</p>}
          {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
        </section>
        <section className="account-section" aria-label="Appearance">
          <div className="eyebrow mb-1.5">Appearance</div>
          <ThemeControl/>
        </section>
        <section className="account-section">
          <button type="button" className="account-item" onClick={() => setView("feedback")}><MessageSquare size={15} aria-hidden="true"/>Send feedback</button>
          {data.me.is_admin && <button type="button" className="account-item" onClick={() => go("/admin")}><Users size={15} aria-hidden="true"/>Access administration</button>}
          {learning && <button type="button" className="account-item" onClick={() => go("/learning")}><Activity size={15} aria-hidden="true"/>Learning outcomes</button>}
          <button type="button" className="account-item" onClick={signOut}><LogOut size={15} aria-hidden="true"/>Sign out</button>
        </section>
      </> : <section className="account-section">
        <button type="button" className="account-back" onClick={() => { setView("menu"); setMessage(""); }}><ArrowLeft size={14} aria-hidden="true"/>Back</button>
        <b className="mt-2 block text-sm">Feedback on this workspace</b>
        <p className="account-note">Optional. Structured choices only, so no facility details or notes are recorded.</p>
        <Segmented className="mt-3" label="How was this workspace?" value={sentiment} onChange={setSentiment} options={[
          { value: "POSITIVE", label: "Good" }, { value: "NEUTRAL", label: "Okay" }, { value: "NEGATIVE", label: "Poor" },
        ]}/>
        <label className="field mt-3 block">What best describes it?<select className="select mt-2 w-full" value={feedbackCode} onChange={(event) => setFeedbackCode(event.target.value)}><option value="HELPFUL">Helpful</option><option value="UNCLEAR">Unclear</option><option value="MISSING_CONTEXT">Missing context</option><option value="TOO_SLOW">Too slow</option><option value="UNEXPECTED_RESULT">Unexpected result</option><option value="OTHER">Other product friction</option></select></label>
        <button type="button" className="button primary mt-3 w-full justify-center" onClick={submit}>Send feedback</button>
        {message && <p className="mt-2 text-xs leading-5 text-slate-400" role="status">{message}</p>}
      </section>}
    </Floating>
  </>;
}

/** The operating mode, set once for every page. None of the modes sends an OT command. */
function ModeControl() {
  const mode = useScenarioSession((state) => state.mode);
  const setMode = useScenarioSession((state) => state.setMode);
  return <div className="sidebar-mode">
    <div className="flex items-center justify-between">
      <span className="eyebrow" id="operating-mode-label">Mode</span>
      <ContextualHelp title="What changes by mode?" align="start"><p><b>Observe</b> shows state only. <b>Shadow</b> computes recommendations for comparison. <b>Advisory</b> lets authorized operators review and record a disposition. Human approval is always required, and none of these modes sends an OT command.</p></ContextualHelp>
    </div>
    <Segmented label="Operating mode" value={mode} onChange={setMode} options={[
      { value: "Observe", label: "Observe" }, { value: "Shadow", label: "Shadow" }, { value: "Advisory", label: "Advisory" },
    ]}/>
  </div>;
}

type NavItem = { icon: LucideIcon; label: string; path: string };

/** The pages this seat can open: day-to-day work pinned at the top, the rest grouped below. */
function navigation(data: SessionData, active?: Facility): { primary: NavItem[]; groups: Array<{ label: string; items: NavItem[] }> } {
  const portfolio = data.me.role === "PORTFOLIO_MANAGER";
  const primary: NavItem[] = portfolio ? [
    { icon: LayoutDashboard, label: "Portfolio", path: "/portfolio" },
    { icon: BrainCircuit, label: "Ask Wattr", path: "/ask-wattr" },
  ] : [];
  if (!active) return { primary, groups: [] };
  const at = (section: string) => `/facilities/${active.id}/${section}`;
  const when = (condition: boolean, item: NavItem) => condition ? [item] : [];
  primary.push(
    { icon: Gauge, label: "Operations", path: at("operations") },
    { icon: AlertTriangle, label: "Incidents", path: at("incidents") },
    { icon: ShieldCheck, label: "Recommendation", path: at("recommendations/rec-17") },
    ...when(canViewTopology(data.me.role, data.me.is_owner), { icon: Network, label: "Thermal graph", path: at("topology") }),
  );
  const groups = [
    { label: "Analyze", items: [
      { icon: Building2, label: "Facility intelligence", path: at("intelligence") },
      { icon: Rewind, label: "Scenario replay", path: at("replay") },
      ...when(active.can_assistant && !portfolio, { icon: BrainCircuit, label: "Ask Wattr", path: at("ask-wattr") }),
      ...when(active.can_engineer, { icon: FlaskConical, label: "Model Lab", path: at("model-lab") }),
    ] },
    // Everyone with access to the facility can build for now; build permissions come later.
    { label: "Build", items: [
      { icon: Boxes, label: "Facility builder", path: at("builder") },
      { icon: FileUp, label: "Import engineering data", path: at("import") },
      ...when(active.can_edit_model, { icon: SlidersHorizontal, label: "Model Studio", path: at("model") }),
    ] },
    { label: "Records", items: [
      { icon: ScrollText, label: "Audit history", path: at("audit") },
      { icon: History, label: "Change history", path: at("history") },
    ] },
  ];
  return { primary, groups };
}

/** Whether a nav item is the page on screen; an incident or recommendation counts as its section. */
const isCurrent = (path: string) => location.pathname === path ||
  (path.endsWith("/incidents") && location.pathname.startsWith(`${path}/`));

/** Where the sidebar was scrolled, so it holds its place as pages change. */
let sidebarScrollTop = 0;

/** Mark which edges of the sidebar list have more items beyond them, for the fade that says so. */
function markSidebarOverflow(list: HTMLElement) {
  const above = list.scrollTop > 1;
  const below = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
  list.dataset.more = [above && "above", below && "below"].filter(Boolean).join(" ");
}

function SidebarBrand() {
  return <button type="button" className="sidebar-brand" onClick={() => navigate("/")}>
    <span className="sidebar-logo" aria-hidden="true"><Activity size={16}/></span>
    <span>WATTR</span>
  </button>;
}

export function Shell({ data, facility, children }: { data: SessionData; facility?: Facility; children: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
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
  const { primary, groups } = navigation(data, active);
  const closeMobile = () => setMobile(false);
  const link = ({ icon: Icon, label, path }: NavItem) => <button type="button" key={path} onClick={() => { closeMobile(); navigate(path); }} className={`cockpit-nav ${isCurrent(path) ? "active" : ""}`} aria-current={isCurrent(path) ? "page" : undefined}><Icon size={16} aria-hidden="true"/><span>{label}</span></button>;
  return <div className="cockpit min-h-[100dvh] bg-[#0a1018] text-slate-200">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    {/* On a phone the sidebar is a drawer, opened from this bar. */}
    <header className="cockpit-header fixed inset-x-0 top-0 z-[var(--z-header)] flex h-[52px] items-center gap-3 border-b border-slate-800 px-4 md:hidden">
      <button ref={menuButtonRef} type="button" className="icon-button" onClick={() => setMobile(!mobile)} aria-label={mobile ? "Close navigation" : "Open navigation"} aria-expanded={mobile} aria-controls="cockpit-navigation"><Menu size={18} aria-hidden="true"/></button>
      <SidebarBrand/>
    </header>
    {mobile && <button type="button" className="mobile-scrim md:hidden" aria-label="Close navigation" onClick={() => { closeMobile(); menuButtonRef.current?.focus(); }}/>}
    <aside id="cockpit-navigation" aria-label="Sidebar" className={`cockpit-sidebar fixed bottom-0 left-0 top-[52px] z-[var(--z-sidebar)] w-[240px] border-r border-slate-800 transition-transform md:top-0 md:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="sidebar-top">
        <div className="hidden md:block"><SidebarBrand/></div>
        <div className="sidebar-facility">
          <b>{active?.name ?? "No facility access"}</b>
          {active?.location && <span>{active.location}</span>}
          <span className="sidebar-synthetic">Synthetic demo environment</span>
        </div>
      </div>
      <nav className="sidebar-navigation" aria-label="Primary navigation">
        {primary.length > 0 && <div className="sidebar-primary">{primary.map(link)}</div>}
        <div ref={navRef} className="sidebar-nav" onScroll={(event) => { sidebarScrollTop = event.currentTarget.scrollTop; markSidebarOverflow(event.currentTarget); }}>
          {groups.filter((group) => group.items.length).map((group) => <div key={group.label} className="sidebar-group" role="group" aria-label={group.label}>
            <div className="sidebar-group-label" aria-hidden="true">{group.label}</div>
            {group.items.map(link)}
          </div>)}
        </div>
      </nav>
      <div className="sidebar-footer">
        <ModeControl/>
        <button type="button" onClick={() => { closeMobile(); navigate("/help"); }} className={`cockpit-nav ${location.pathname === "/help" ? "active" : ""}`} aria-current={location.pathname === "/help" ? "page" : undefined}><CircleHelp size={16} aria-hidden="true"/><span>Help & tutorials</span></button>
        <AccountMenu data={data} facility={facility} onNavigate={closeMobile}/>
      </div>
    </aside>
    <main id="main-content" tabIndex={-1} className="pt-[52px] md:pl-[240px] md:pt-0"><div className="mx-auto max-w-[1600px] p-4 md:px-8 md:py-6">{children}</div></main>
  </div>;
}

export function ReplayBar({ onReset = () => {} }: { onReset?: () => void }) {
  const s = useScenarioSession();
  const elapsed = s.simulation.snapshot.elapsedS;
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useDismiss(more, () => setMore(false), moreRef, panelRef);
  if (!location.pathname.endsWith("/operations")) return null;
  const minutes = Math.round(elapsed / 60);
  return <section className="replay-bar" data-guide="replay" aria-label="Canonical replay controls">
    <span className="replay-time"><Clock3 size={15} aria-hidden="true"/><span className={`${mono} text-slate-200`}>{formatSimulatedAt(s.simulatedAt)}</span><span>· {minutes} of 30 min</span></span>
    <button type="button" className="button secondary" onClick={() => s.setPlaying(!s.playing)}>{s.playing ? <Pause size={15} aria-hidden="true"/> : <Play size={15} aria-hidden="true"/>}{s.playing ? "Pause" : "Play"}</button>
    <input aria-label="Replay position" aria-valuetext={`${minutes} minutes into the 30 minute scenario`} className="replay-range" type="range" min="0" max={SCENARIO_DURATION_S} step="1" value={elapsed} onChange={(event) => s.jump(Number(event.target.value))}/>
    <Segmented label="Replay speed" value={s.speed} onChange={s.setSpeed} options={([1, 5, 10, 30, 60] as const).map((v) => ({ value: v, label: `${v}×`, ariaLabel: `Replay speed ${v} times` }))}/>
    <button type="button" className="button secondary" onClick={() => s.jump(900)} disabled={elapsed === 900}>Jump to forecast</button>
    <button ref={moreRef} type="button" className="icon-button" aria-label="More replay controls" aria-expanded={more} aria-controls={more ? panelId : undefined} onClick={() => setMore(!more)}><Ellipsis size={16} aria-hidden="true"/></button>
    <Floating open={more} anchorRef={moreRef} floatingRef={panelRef} id={panelId} role="dialog" aria-label="Step through the replay" className="menu-panel">
      <button type="button" className="menu-item" onClick={() => s.step(30)} disabled={elapsed >= SCENARIO_DURATION_S}><SkipForward size={15} aria-hidden="true"/>Step 30 s</button>
      <button type="button" className="menu-item" onClick={() => s.jump(Math.max(0, elapsed - 300))} disabled={elapsed === 0}><Rewind size={15} aria-hidden="true"/>Back 5 min</button>
      <button type="button" className="menu-item" onClick={() => s.jump(Math.min(SCENARIO_DURATION_S, elapsed + 300))} disabled={elapsed >= SCENARIO_DURATION_S}><FastForward size={15} aria-hidden="true"/>Forward 5 min</button>
      <button type="button" className="menu-item" onClick={() => { s.reset(); onReset(); setMore(false); }}><RotateCcw size={15} aria-hidden="true"/>Reset</button>
    </Floating>
    <p className="sr-only" role="status" aria-live="polite">Replay at {minutes} minutes. {s.playing ? `Playing at ${s.speed} times speed.` : "Paused."}</p>
  </section>;
}
