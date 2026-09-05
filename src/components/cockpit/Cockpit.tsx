import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Show, SignIn, SignUp, useUser } from "@clerk/react";
import {
  Activity, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowDownUp, BookOpen, BrainCircuit, Check,
  CircleHelp, Clock3, Cpu, Gauge, GitBranch, History, LayoutDashboard, Layers3, Menu, MousePointer2,
  Pause, Play, RotateCcw, Search, Save, ShieldCheck, SkipForward, SlidersHorizontal, Sun, Moon, Monitor, Thermometer, Trash2, UserCog, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { replayCockpitSnapshot, SCENARIO_DURATION_S, snapshotForAudit, type CockpitSnapshot, type FacilityModelConfig } from "@/lib/cockpit/simulation";
import { compareControllers, graphSelection, thermalGraph, type GraphView, type ControllerComparison } from "@/lib/cockpit/workspaces";
import { ROLES, type Role } from "@/lib/security/rolePolicy";
import { assistantSuggestions, type AssistantResponse } from "@/lib/cockpit/assistant";
import { learningSurfaceForPath, recordLearningEvent, reportLearningError } from "@/lib/cockpit/learning";

type Capabilities = { view: boolean; operate: boolean; engineer: boolean; model: boolean; assistant: boolean };
type Me = { id: string; display_name: string; organization_id: string; role: Role; is_admin: boolean; is_owner: boolean; capabilities: Capabilities; default_path: string; theme: string; tutorial_complete: boolean; tutorial_step: number };
type Facility = { id: string; name: string; location: string; model_version: string; model_config: FacilityModelConfig; provenance: "SIMULATED"; recommendation_status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXPIRED" | "NONE"; can_view: boolean; can_operate: boolean; can_edit_model: boolean; can_engineer: boolean; can_assistant: boolean };
type Audit = { id: number; action: string; scenario_id: string; simulated_at: number; model_version: string; payload: Record<string, any>; created_at: string };
type IncidentSignal = { id: string; assetId: string; metric: string; direction: string };
type Incident = { id: string; title: string; severity: "WATCH" | "HIGH"; status: "OPEN" | "RESOLVED"; simulated_at: number; affected_assets: string[]; raw_signal_count: number; likely_cause: string; forecast_minutes: number; correlated_signals: IncidentSignal[]; thermal_path: string[]; deduplication_key: string; model_version: string };
type SafetyEvaluation = {
  id: string;
  outcome: "PASS" | "WARNING" | "BLOCK";
  checks: Array<{ id: string; status: "PASS" | "WARNING" | "BLOCK"; pass: boolean; detail: string; evidence: Record<string, unknown> }>;
  command: { assetId: "cdu-03"; flowPercent: number; durationMinutes: number };
  simulatedAt: number;
  recommendationVersion: number;
  modelVersionId: string;
};
type WhatIfComparison = {
  simulatedAt: number;
  modelVersionId: string;
  recommendationVersion: number;
  options: Array<{
    id: "inaction" | "recommendation" | "alternative";
    label: string;
    command: { assetId: "cdu-03"; flowPercent: number; durationMinutes: number } | null;
    peakC: number;
    constraintMinutes: number;
    series: Array<{ simulatedAt: number; peakC: number }>;
  }>;
};
type ModelVersion = { id: string; facility_id: string; status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED"; config: Record<string, unknown>; published_at: string | null; created_by: string | null; created_at: string };
type MemberFacility = { facility_id: string; facility_name: string; can_view: boolean; can_operate: boolean; can_edit_model: boolean };
type Member = { id: string; email: string | null; display_name: string | null; role: Role; is_admin: boolean; is_owner: boolean; facilities: MemberFacility[] };
type SessionData = { me: Me; facilities: Facility[] };
type ThemePreference = "light" | "dark" | "system";
type LearningOutcomesData = {
  scope: string;
  retention: { eventsAndFeedbackDays: number; errorsDays: number };
  journeyEvents: Array<{ event_name: string; count: number; users: number }>;
  operatorSessions: { total: number; completed: number; abandoned: number; avg_time_to_understanding_s: number | null; avg_error_count: number | null };
  safetyOutcomes: Array<{ outcome: string; count: number }>;
  decisionOutcomes: Array<{ outcome: string; count: number }>;
  feedback: { count: number; positive: number; neutral: number; negative: number };
  errors: Array<{ category: string; count: number }>;
  commonAssistantTopics: Array<{ topic: string; count: number }>;
};

const mono = "font-[family-name:var(--font-mono)]";
const navigate = (path: string) => {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};
const e2eTestUserId = () =>
  (globalThis as typeof globalThis & { __WATTR_E2E_USER_ID__?: string }).__WATTR_E2E_USER_ID__;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const testUserId = e2eTestUserId();
  if (testUserId) headers.set("x-test-user-id", testUserId);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!path.startsWith("/api/learning/")) {
      const category = response.status === 401 || response.status === 403 || response.status === 404
        ? "PERMISSION_FAILURE"
        : response.status === 502 || response.status === 503 || response.status === 504
          ? "EXTERNAL_SERVICE_UNAVAILABLE"
          : "APPLICATION_FAULT";
      reportLearningError(category, `HTTP_${response.status}`, { route: location.pathname });
    }
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body as T;
}
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const remove = (path: string) => api<void>(path, { method: "DELETE" });

const ThemeContext = createContext<{
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}>({ theme: "system", setTheme: () => {} });

function useTheme() {
  return useContext(ThemeContext);
}

function ThemeProvider({ initialTheme, children }: { initialTheme: string; children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(
    initialTheme === "light" || initialTheme === "dark" ? initialTheme : "system",
  );
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }, [theme]);
  const setTheme = (next: ThemePreference) => {
    setThemeState(next);
    setNotice(`Appearance set to ${next}.`);
    patch("/api/me/preferences", { theme: next }).catch(() => {
      setNotice("Appearance changed locally; it could not be saved.");
    });
  };
  return <ThemeContext.Provider value={{ theme, setTheme }}>
    {children}
    <span className="sr-only" role="status" aria-live="polite">{notice}</span>
  </ThemeContext.Provider>;
}

function ContextualHelp({ title, children }: { title: string; children: ReactNode }) {
  return <details className="context-help">
    <summary><CircleHelp size={14} aria-hidden="true"/><span>{title}</span></summary>
    <div className="context-help-content">{children}</div>
  </details>;
}

function DisclosureSection({ label, children, engineering = false }: { label: string; children: ReactNode; engineering?: boolean }) {
  return <details className={`disclosure ${engineering ? "engineering" : ""}`}>
    <summary>{label}<ArrowRight size={13} aria-hidden="true"/></summary>
    <div className="disclosure-content">{children}</div>
  </details>;
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return <fieldset className="theme-control">
    <legend>Appearance</legend>
    {([
      ["system", "System", Monitor],
      ["light", "Light", Sun],
      ["dark", "Dark", Moon],
    ] as const).map(([value, label, Icon]) => <button
      key={value}
      type="button"
      className={theme === value ? "selected" : ""}
      aria-pressed={theme === value}
      aria-label={`${label} appearance`}
      onClick={() => setTheme(value)}
    ><Icon size={13} aria-hidden="true"/><span>{label}</span></button>)}
  </fieldset>;
}

function Brand() {
  return <button onClick={() => navigate("/")} className="flex items-center gap-2.5 text-left"><span className="grid h-8 w-8 place-items-center rounded-md bg-cyan-400 text-slate-950"><Activity size={18}/></span><span><b className="block text-sm tracking-[.18em]">WATTR</b><small className="block text-[9px] tracking-[.2em] text-slate-500">OPERATOR COCKPIT</small></span></button>;
}
function Status({ children, tone = "good" }: { children: ReactNode; tone?: "good" | "warn" | "bad" }) { return <span className={`status ${tone}`}>{children}</span>; }
function Metric({ label, value, unit, sub, warn, help }: { label: string; value: string; unit?: string; sub: string; warn?: boolean; help?: string }) {
  return <article className="panel metric" aria-label={`${label}: ${value}${unit ? ` ${unit}` : ""}. ${sub}`}><div className="text-[10px] uppercase tracking-[.16em] text-slate-500">{label}</div><div className={`mt-3 text-2xl font-semibold ${warn ? "text-amber-300" : "text-slate-100"}`}>{value}<small className="ml-1 text-xs font-normal text-slate-500">{unit}</small></div><div className="mt-2 text-[11px] text-slate-500">{sub}</div>{help && <ContextualHelp title={`About ${label}`}><p>{help}</p></ContextualHelp>}</article>;
}
function PageHead({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className={`${mono} mb-2 text-[10px] tracking-[.2em] text-cyan-400`}>{eyebrow}</div><h1 className="text-2xl font-semibold tracking-tight text-slate-100 md:text-3xl">{title}</h1><p className="mt-1 text-sm text-slate-500">{detail}</p></div>{action}</div>;
}

function ContextualFeedback({ facility }: { facility?: Facility }) {
  const [sentiment, setSentiment] = useState<"POSITIVE" | "NEUTRAL" | "NEGATIVE">("NEUTRAL");
  const [feedbackCode, setFeedbackCode] = useState("HELPFUL");
  const [message, setMessage] = useState("");
  const submit = async () => {
    try {
      await post("/api/learning/feedback", {
        ...(facility ? { facilityId: facility.id } : {}),
        surface: learningSurfaceForPath(location.pathname),
        sentiment,
        feedbackCode,
      });
      setMessage("Feedback saved with this product surface.");
    } catch (cause) {
      setMessage(`Feedback was not saved: ${String(cause)}`);
    }
  };
  return <details className="disclosure mt-8">
    <summary>Share feedback on this workspace<ArrowRight size={13} aria-hidden="true"/></summary>
    <div className="disclosure-content">
      <p className="text-xs text-slate-500">Optional and non-blocking. Structured categories prevent facility-sensitive details or operator notes from entering learning records.</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Feedback sentiment">
        {(["POSITIVE", "NEUTRAL", "NEGATIVE"] as const).map((item) => <button type="button" key={item} className={`speed ${sentiment === item ? "selected" : ""}`} aria-pressed={sentiment === item} onClick={() => setSentiment(item)}>{item.toLowerCase()}</button>)}
      </div>
      <label className="field mt-3 block">What best describes this surface?<select className="select mt-2 w-full" value={feedbackCode} onChange={(event) => setFeedbackCode(event.target.value)}><option value="HELPFUL">Helpful</option><option value="UNCLEAR">Unclear</option><option value="MISSING_CONTEXT">Missing context</option><option value="TOO_SLOW">Too slow</option><option value="UNEXPECTED_RESULT">Unexpected result</option><option value="OTHER">Other product friction</option></select></label>
      <div className="mt-3 flex items-center gap-3"><button type="button" className="button secondary" onClick={submit}>Send feedback</button>{message && <span className="text-xs text-slate-500" role="status">{message}</span>}</div>
    </div>
  </details>;
}

function Shell({ data, facility, children }: { data: SessionData; facility?: Facility; children: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const active = facility ?? data.facilities[0];
  const nav: Array<[LucideIcon, string, string]> = [
    ...(data.me.role === "PORTFOLIO_MANAGER" ? [[LayoutDashboard, "Portfolio", "/portfolio"] as [LucideIcon, string, string]] : []),
    ...(data.me.role === "PORTFOLIO_MANAGER" ? [[BrainCircuit, "Ask Wattr", "/ask-wattr"] as [LucideIcon, string, string]] : []),
    ...(active ? [
      [Gauge, "Operations", `/facilities/${active.id}/operations`] as [LucideIcon, string, string],
      [AlertTriangle, "Incident", `/facilities/${active.id}/incidents/inc-204`] as [LucideIcon, string, string],
      [ShieldCheck, "Recommendation", `/facilities/${active.id}/recommendations/rec-17`] as [LucideIcon, string, string],
      [History, "Audit history", `/facilities/${active.id}/audit`] as [LucideIcon, string, string],
      ...(active.can_assistant && data.me.role !== "PORTFOLIO_MANAGER" ? [[BrainCircuit, "Ask Wattr", `/facilities/${active.id}/ask-wattr`] as [LucideIcon, string, string]] : []),
      ...(["OPERATOR", "ENGINEER"].includes(data.me.role) ? [[GitBranch, "Thermal graph", `/facilities/${active.id}/topology`] as [LucideIcon, string, string]] : []),
      ...(active.can_engineer ? [[BrainCircuit, "Model Lab", `/facilities/${active.id}/model-lab`] as [LucideIcon, string, string]] : []),
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
      <div className="flex items-center gap-3 text-xs"><span className="hidden text-slate-500 sm:inline">SYNTHETIC ENVIRONMENT</span><Status>{data.me.role.replace(/_/g, " ")}</Status><ThemeControl/></div>
    </header>
    {mobile && <button type="button" className="mobile-scrim md:hidden" aria-label="Close navigation" onClick={() => { setMobile(false); menuButtonRef.current?.focus(); }}/>}
    <aside id="cockpit-navigation" aria-label="Primary navigation" className={`fixed bottom-0 left-0 top-[62px] z-20 w-[232px] border-r border-slate-800 bg-[#0b121c] p-3 transition-transform md:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}><div className="mb-5 rounded-md border border-slate-800 bg-[#101a26] p-3"><div className="text-[9px] tracking-[.18em] text-slate-500">AUTHORIZED FACILITY</div><div className="mt-1 text-sm font-semibold">{active?.name ?? "No facility access"}</div><div className="text-[11px] text-slate-500">{active?.location}</div></div><nav className="space-y-1">{nav.map(([Icon, label, path]) => <button type="button" key={label} onClick={() => { setMobile(false); navigate(path); }} className={`cockpit-nav ${location.pathname === path ? "active" : ""}`} aria-current={location.pathname === path ? "page" : undefined}><Icon size={16} aria-hidden="true"/>{label}</button>)}</nav><div className="absolute bottom-5 left-3 right-3 border-t border-slate-800 pt-3"><button type="button" onClick={() => { setMobile(false); navigate("/help"); }} className="cockpit-nav"><CircleHelp size={16} aria-hidden="true"/>Help & tutorials</button></div></aside>
    <main id="main-content" tabIndex={-1} className="pt-[62px] md:pl-[232px]"><div className="mx-auto max-w-[1600px] p-4 md:p-7">{children}<ContextualFeedback facility={facility}/></div></main>
  </div>;
}

type PortfolioSort = "attention" | "risk" | "power" | "cooling" | "efficiency" | "recommendation";
type PortfolioFilter = "all" | "attention" | "nominal" | "recommendation";

function portfolioRisk(snapshot: CockpitSnapshot) {
  return snapshot.forecast.risk === "critical" ? 3 : snapshot.forecast.risk === "watch" ? 2 : 1;
}

function Portfolio({ data }: { data: SessionData }) {
  const simulatedAt = useScenarioSession((s) => s.simulatedAt);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PortfolioFilter>("all");
  const [sort, setSort] = useState<PortfolioSort>("attention");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const rows = useMemo(() => data.facilities.map((facility) => ({
    facility,
    snapshot: replayCockpitSnapshot(simulatedAt, facility.model_config),
  })), [data.facilities, simulatedAt]);
  const filtered = useMemo(() => rows
    .filter(({ facility, snapshot }) => {
      const matchesSearch = `${facility.name} ${facility.location} ${facility.id}`.toLowerCase().includes(query.toLowerCase().trim());
      const matchesFilter = filter === "all" || (filter === "attention" ? snapshot.incident.open : filter === "recommendation" ? facility.recommendation_status === "PROPOSED" : !snapshot.incident.open);
      return matchesSearch && matchesFilter;
    })
    .sort((a, b) => {
      if (sort === "risk" || sort === "attention") return portfolioRisk(b.snapshot) - portfolioRisk(a.snapshot) || b.snapshot.peakInletC - a.snapshot.peakInletC;
      if (sort === "power") return b.snapshot.itPowerKw - a.snapshot.itPowerKw;
      if (sort === "cooling") return b.snapshot.fanPercent - a.snapshot.fanPercent;
      if (sort === "recommendation") return Number(b.facility.recommendation_status === "PROPOSED") - Number(a.facility.recommendation_status === "PROPOSED");
      return a.snapshot.pue - b.snapshot.pue;
    }), [rows, query, filter, sort]);
  const fleet = rows.reduce((total, row) => ({
    headroom: total.headroom + row.snapshot.headroomKw,
    incidents: total.incidents + (row.snapshot.incident.open ? 1 : 0),
    itPower: total.itPower + row.snapshot.itPowerKw,
    totalPower: total.totalPower + row.snapshot.totalPowerKw,
  }), { headroom: 0, incidents: 0, itPower: 0, totalPower: 0 });
  const toggleCompare = (id: string) => setCompareIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : ids.length < 3 ? [...ids, id] : ids);
  const openFacility = (facility: Facility) => {
    void recordLearningEvent("FACILITY_DRILLDOWN", {
      facilityId: facility.id,
    });
    navigate(`/facilities/${facility.id}/operations`);
  };
  const compared = rows.filter((row) => compareIds.includes(row.facility.id));
  return <Shell data={data}>
    <PageHead eyebrow={`PORTFOLIO COMMAND / ${data.facilities.length.toString().padStart(2, "0")} AUTHORIZED`} title="Facility health" detail="Ranked operating context from your authorized sites." action={<Status>{formatSimulatedAt(simulatedAt).slice(0, 16)} UTC</Status>}/>
    <div className="grid gap-3 md:grid-cols-4">
      <Metric label="Sites monitored" value={String(rows.length).padStart(2, "0")} sub="permission-filtered"/>
      <Metric label="Fleet headroom" value={fleet.headroom.toLocaleString()} unit="kW" sub="rated capacity less IT load"/>
      <Metric label="Open incidents" value={String(fleet.incidents).padStart(2, "0")} sub={fleet.incidents ? "requires review" : "no active forecast"} warn={fleet.incidents > 0}/>
      <Metric label="Fleet PUE" value={fleet.itPower ? (fleet.totalPower / fleet.itPower).toFixed(3) : "—"} sub="aggregate total ÷ aggregate IT"/>
    </div>
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 p-4">
        <div className="relative min-w-[220px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-slate-500"/><input aria-label="Search authorized facilities" className="input w-full pl-9" placeholder="Search sites or locations" value={query} onChange={(event) => setQuery(event.target.value)}/></div>
        <div className="flex gap-1" role="group" aria-label="Facility status filter">{(["all", "attention", "nominal", "recommendation"] as PortfolioFilter[]).map((item) => <button key={item} className={`speed ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)}>{item === "all" ? "All sites" : item === "attention" ? "Needs attention" : item === "recommendation" ? "Advisory ready" : "Nominal"}</button>)}</div>
        <label className="flex items-center gap-2 text-xs text-slate-500">Rank by <select aria-label="Rank facilities by" className="select" value={sort} onChange={(event) => setSort(event.target.value as PortfolioSort)}><option value="attention">Attention</option><option value="risk">Forecast risk</option><option value="power">IT power</option><option value="cooling">Cooling load</option><option value="efficiency">PUE efficiency</option><option value="recommendation">Recommendation status</option></select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#0d1722] px-4 py-3 text-xs text-slate-400"><span><b className="text-slate-200">{filtered.length}</b> of {rows.length} authorized sites shown</span><span className="flex items-center gap-2"><Layers3 size={14} className="text-cyan-300"/>Compare up to 3 sites</span></div>
      <div className="hidden overflow-x-auto md:block"><table className="data-table min-w-[980px]"><caption className="sr-only">Authorized facility ranking</caption><thead><tr><th>Compare</th><th>Facility</th><th><ArrowDownUp size={12} className="inline"/> Health</th><th>IT power</th><th>Peak inlet</th><th>Cooling</th><th>PUE</th><th>Recommendation</th><th>Model</th><th/></tr></thead><tbody>{filtered.map(({ facility, snapshot }) => <tr key={facility.id} className="hover:bg-slate-800/30"><td><input aria-label={`Compare ${facility.name}`} type="checkbox" checked={compareIds.includes(facility.id)} onChange={() => toggleCompare(facility.id)} disabled={!compareIds.includes(facility.id) && compareIds.length >= 3}/></td><td><b>{facility.name}</b><small className="mt-1 block text-slate-500">{facility.location} · {facility.id}</small></td><td><Status tone={snapshot.forecast.risk === "critical" ? "bad" : snapshot.incident.open ? "warn" : "good"}>{snapshot.forecast.risk === "clear" ? "Nominal" : snapshot.forecast.risk}</Status><small className="mt-1 block text-slate-500">{snapshot.forecast.baselinePeakC.toFixed(1)}°C forecast</small></td><td>{snapshot.itPowerKw.toLocaleString()} kW</td><td className={snapshot.peakInletC >= snapshot.incident.limitC ? "text-amber-300" : ""}>{snapshot.peakInletC.toFixed(1)}°C</td><td>{snapshot.fanPercent.toFixed(0)}%</td><td>{snapshot.pue.toFixed(3)}</td><td><Status tone={facility.recommendation_status === "PROPOSED" ? "warn" : "good"}>{facility.recommendation_status}</Status></td><td><span className={`${mono} text-[10px] text-slate-500`}>{facility.model_version}</span></td><td><button className="button secondary" onClick={() => openFacility(facility)}>Open <ArrowRight size={14}/></button></td></tr>)}</tbody></table></div>
      <div className="space-y-2 p-3 md:hidden">{filtered.map(({ facility, snapshot }) => <article key={facility.id} className="rounded-md border border-slate-800 p-4"><div className="flex items-start justify-between gap-3"><div><b>{facility.name}</b><p className="mt-1 text-xs text-slate-500">{facility.location}</p></div><Status tone={snapshot.incident.open ? "warn" : "good"}>{snapshot.incident.open ? "Attention" : "Nominal"}</Status></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><span className="text-slate-500">Peak <b className="ml-1 text-slate-200">{snapshot.peakInletC.toFixed(1)}°C</b></span><span className="text-slate-500">PUE <b className="ml-1 text-slate-200">{snapshot.pue.toFixed(3)}</b></span><span className="text-slate-500">Power <b className="ml-1 text-slate-200">{snapshot.itPowerKw.toLocaleString()} kW</b></span><span className="text-slate-500">Cooling <b className="ml-1 text-slate-200">{snapshot.fanPercent.toFixed(0)}%</b></span><span className="col-span-2 text-slate-500">Recommendation <b className="ml-1 text-slate-200">{facility.recommendation_status}</b></span></div><div className="mt-4 flex items-center justify-between"><label className="text-xs text-slate-500"><input type="checkbox" checked={compareIds.includes(facility.id)} onChange={() => toggleCompare(facility.id)} className="mr-2"/>Compare</label><button className="button secondary" onClick={() => openFacility(facility)}>Open <ArrowRight size={14}/></button></div></article>)}</div>
      {!filtered.length && <p className="p-8 text-center text-sm text-slate-500">No authorized facilities match those filters.</p>}
    </section>
    {compared.length > 0 && <section className="panel mt-4 overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4"><div><div className="eyebrow">SIDE-BY-SIDE REVIEW</div><h2 className="mt-1 font-semibold">{compared.length} selected {compared.length === 1 ? "site" : "sites"}</h2></div><button className="button secondary" onClick={() => setCompareIds([])}>Clear comparison</button></div><div className="grid gap-3 p-4 md:grid-cols-3">{compared.map(({ facility, snapshot }) => <div key={facility.id} className="rounded-md border border-slate-800 p-4"><div className="flex items-center justify-between"><b>{facility.name}</b><Status tone={snapshot.incident.open ? "warn" : "good"}>{snapshot.incident.open ? "Watch" : "Nominal"}</Status></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><Metric label="Risk" value={snapshot.forecast.baselinePeakC.toFixed(1)} unit="°C" sub={`${snapshot.forecast.horizonS / 60}m forecast`}/><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub="current load"/><Metric label="Cooling" value={snapshot.fanPercent.toFixed(0)} unit="%" sub="fan / pump command"/><Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="physical balance"/></div><p className="mt-3 text-xs text-slate-500">Recommendation <b className="ml-1 text-slate-200">{facility.recommendation_status}</b></p></div>)}</div></section>}
  </Shell>;
}
function useScenarioClock() {
  const playing = useScenarioSession((s) => s.playing), speed = useScenarioSession((s) => s.speed);
  useEffect(() => { if (!playing) return; const timer = window.setInterval(() => { const state = useScenarioSession.getState(); state.advance(state.speed); }, 1000); return () => clearInterval(timer); }, [playing, speed]);
}
function ReplayBar({ onReset = () => {} }: { onReset?: () => void }) {
  const s = useScenarioSession();
  const elapsed = s.simulation.snapshot.elapsedS;
  return <section className="replay-bar mb-4" aria-label="Canonical replay controls">
    <div className="flex flex-wrap items-center gap-3"><Clock3 size={15} className="text-cyan-300" aria-hidden="true"/><span className={`${mono} text-xs`}>{formatSimulatedAt(s.simulatedAt)}</span><span className="text-xs text-slate-500">· {Math.round(elapsed / 60)} of 30 min</span><div className="ml-auto flex items-center gap-1" role="group" aria-label="Replay speed"><span className="mr-1 text-[10px] uppercase tracking-[.12em] text-slate-500">Speed</span>{([1,5,10,30,60] as const).map(v => <button type="button" aria-label={`Replay speed ${v} times`} aria-pressed={s.speed === v} key={v} onClick={() => s.setSpeed(v)} className={`speed ${s.speed === v ? "selected" : ""}`}>{v}×</button>)}</div><button type="button" className="button secondary" onClick={() => s.setPlaying(!s.playing)}>{s.playing ? <Pause size={15} aria-hidden="true"/> : <Play size={15} aria-hidden="true"/>} {s.playing ? "Pause" : "Play"}</button></div>
    <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className="button secondary" onClick={() => s.step(30)} disabled={elapsed >= SCENARIO_DURATION_S}><SkipForward size={14} aria-hidden="true"/>Step 30s</button><button type="button" className="button secondary" onClick={() => s.jump(Math.max(0, elapsed - 300))} disabled={elapsed === 0}>−5m</button><button type="button" className="button secondary" onClick={() => s.jump(Math.min(SCENARIO_DURATION_S, elapsed + 300))} disabled={elapsed >= SCENARIO_DURATION_S}>+5m</button><button type="button" className="button secondary" onClick={() => s.jump(900)} disabled={elapsed === 900}>Jump to forecast</button><input aria-label="Replay position" aria-valuetext={`${Math.round(elapsed / 60)} minutes into the 30 minute scenario`} className="replay-range" type="range" min="0" max={SCENARIO_DURATION_S} step="1" value={elapsed} onChange={(event) => s.jump(Number(event.target.value))}/><span className={`${mono} text-[10px] text-slate-500`}>{Math.round(elapsed / 60)}m</span><button type="button" className="button secondary" onClick={() => { s.reset(); onReset(); }}><RotateCcw size={15} aria-hidden="true"/>Reset</button><Status tone={s.mode === "Advisory" ? "warn" : "good"}>{s.mode} · human-in-loop</Status></div>
    <p className="sr-only" role="status" aria-live="polite">Replay at {Math.round(elapsed / 60)} minutes. {s.playing ? `Playing at ${s.speed} times speed.` : "Paused."}</p>
  </section>;
}
function LegacyOperations({ data, facility }: { data: SessionData; facility: Facility }) {
  const s = useScenarioSession(), snapshot = s.simulation.snapshot;
  return <Shell data={data} facility={facility}><PageHead eyebrow={`FACILITY / ${facility.id.toUpperCase()} / OPERATIONS`} title={facility.name} detail={`${facility.location} · deterministic GPU Training Ramp · ${facility.provenance}`}/><ReplayBar/><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}%`}/><Metric label="Total facility" value={snapshot.totalPowerKw.toLocaleString()} unit="kW" sub="physical power balance"/><Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn={snapshot.peakInletC >= snapshot.incident.limitC}/><Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="physical simulation"/><Metric label="Headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub="rated capacity"/></div><div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_.8fr]"><section className="panel min-h-[430px] overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Synchronized facility twin</h2><p className="text-xs text-slate-500">Workload → power → heat → CDU-03 response · {snapshot.coolingUnitCount} cooling unit</p></div><div className="twin-canvas"><div className="twin-grid"/><div className="twin-core"><Cpu size={28}/><b>GPU HALL</b><small>CLUSTER B · {snapshot.itPowerKw.toLocaleString()} kW</small></div>{snapshot.racks.map((rack,i)=><button key={rack.id} aria-label={`Inspect rack ${rack.id}`} onClick={() => navigate(`/facilities/${facility.id}/incidents/inc-204`)} className={`rack rack-${i} ${rack.atRisk?"hot":""}`}><span>{rack.id}</span><i style={{height:`${Math.min(100, Math.max(20, ((rack.inletC - 20) / (rack.limitC - 20)) * 100))}%`}}/></button>)}</div></section><aside className="space-y-4"><section className="panel p-5"><div className="eyebrow">FORECAST RISK</div><h2 className={`mt-2 text-xl font-semibold ${snapshot.forecast.risk === "clear" ? "text-teal-300" : "text-amber-300"}`}>{snapshot.forecast.risk === "clear" ? "Clear condition" : `${snapshot.incident.severity} condition`}</h2><p className="mt-4 text-sm leading-6 text-slate-400">{snapshot.incident.rackId} forecast peak {snapshot.forecast.baselinePeakC.toFixed(1)}°C in the next {Math.round(snapshot.forecast.horizonS / 60)} minutes against a {snapshot.incident.limitC.toFixed(1)}°C limit.</p><button onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="button primary mt-4 w-full justify-center">Review advisory <ArrowRight size={15}/></button></section><section className="panel p-5"><div className="eyebrow">OPERATING MODE</div><select aria-label="Operating mode" value={s.mode} onChange={e=>s.setMode(e.target.value as typeof s.mode)} className="select mt-4 w-full"><option>Observe</option><option>Shadow</option><option>Advisory</option></select><p className="mt-3 text-xs leading-5 text-slate-500">Human approval is always required. No OT commands are issued.</p></section></aside></div></Shell>;
}

function Transparency({ facility, snapshot }: { facility: Facility; snapshot: CockpitSnapshot }) {
  return <section className="panel p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="eyebrow">DATA TRANSPARENCY</div><Status>SYNTHETIC / GOOD</Status></div>
    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      <div><span className="text-slate-500">Provenance</span><b className="mt-1 block">Deterministic simulation</b></div>
      <div><span className="text-slate-500">Model version</span><b className={`${mono} mt-1 block`}>{facility.model_version}</b></div>
      <div><span className="text-slate-500">Freshness</span><b className="mt-1 block">{formatSimulatedAt(snapshot.simulatedAt)}</b></div>
      <div><span className="text-slate-500">Confidence domain</span><b className="mt-1 block">≤ {snapshot.plant.modelDomainMaxC.toFixed(0)}°C</b></div>
    </div>
    <ContextualHelp title="Provenance, confidence, and limitations">
      <p><b>Provenance</b> tells you where a value came from. Here every value is generated by a deterministic simulation, not a live sensor.</p>
      <p className="mt-2"><b>Confidence domain</b> is the temperature range the model is intended to represent. Outside it, treat forecasts as unsupported rather than merely less precise.</p>
      <p className="mt-2"><b>Decision authority</b> remains with the operator. Wattr records advisory decisions but sends no equipment command.</p>
    </ContextualHelp>
  </section>;
}

type TwinView = "physical" | "thermal";
type TwinOverlay = "thermal" | "flow" | "incident";

function OperatorTestSession({ facility, elapsedS }: { facility: Facility; elapsedS: number }) {
  const [sessionId, setSessionId] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [scenarioCompleted, setScenarioCompleted] = useState(false);
  const [feedbackCode, setFeedbackCode] = useState("CLEAR");
  const [abandonmentCode, setAbandonmentCode] = useState("MODERATOR_ENDED");
  const [message, setMessage] = useState("");
  const start = async () => {
    try {
      const session = await post<{ id: string; started_at: string }>("/api/learning/operator-sessions", {
        facilityId: facility.id,
      });
      setSessionId(session.id);
      setStartedAt(Date.now());
      setMessage("Evaluation session active.");
    } catch (cause) {
      setMessage(`Session could not start: ${String(cause)}`);
    }
  };
  const recordFriction = async () => {
    if (!sessionId) return;
    const next = errorCount + 1;
    setErrorCount(next);
    await patch(`/api/learning/operator-sessions/${sessionId}`, { errorCount: next, surface: learningSurfaceForPath(location.pathname) });
    setMessage("Friction noted.");
  };
  const finish = async (status: "COMPLETED" | "ABANDONED") => {
    if (!sessionId) return;
    const timeToUnderstandingS = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    try {
      await patch(`/api/learning/operator-sessions/${sessionId}`, {
        status,
        scenarioCompleted,
        timeToUnderstandingS: status === "COMPLETED" ? timeToUnderstandingS : undefined,
        errorCount,
        abandonmentCode: status === "ABANDONED" ? abandonmentCode : undefined,
        qualitativeFeedbackCode: feedbackCode,
        surface: learningSurfaceForPath(location.pathname),
      });
      setSessionId("");
      setMessage(status === "COMPLETED" ? "Understanding outcome recorded." : "Abandonment recorded.");
    } catch (cause) {
      setMessage(`Session outcome was not saved: ${String(cause)}`);
    }
  };
  return <details className="disclosure mb-4">
    <summary>Operator evaluation session<ArrowRight size={13} aria-hidden="true"/></summary>
    <div className="disclosure-content">
      <p className="text-xs text-slate-500">Optional moderated testing only. This records workflow outcomes, not replay telemetry.</p>
      {!sessionId ? <button type="button" className="button secondary mt-3" onClick={start}>Start evaluation session</button> : <>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <Status>ACTIVE</Status><span>{Math.round(elapsedS / 60)}m into scenario</span>
          <label className="flex items-center gap-2"><input type="checkbox" checked={scenarioCompleted} onChange={(event) => setScenarioCompleted(event.target.checked)}/>Core scenario completed</label>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="field">Understanding<select className="select mt-2 w-full" value={feedbackCode} onChange={(event) => setFeedbackCode(event.target.value)}><option value="CLEAR">Clear</option><option value="PARTLY_CLEAR">Partly clear</option><option value="UNCLEAR">Unclear</option><option value="TOO_SLOW">Too slow</option><option value="MISSING_CONTEXT">Missing context</option><option value="OTHER">Other</option></select></label><label className="field">If abandoned<select className="select mt-2 w-full" value={abandonmentCode} onChange={(event) => setAbandonmentCode(event.target.value)}><option value="MODERATOR_ENDED">Moderator ended</option><option value="NAVIGATION_FRICTION">Navigation friction</option><option value="UNCLEAR_FORECAST">Forecast unclear</option><option value="UNCLEAR_RECOMMENDATION">Recommendation unclear</option><option value="PERMISSION_BLOCK">Permission blocked</option><option value="TECHNICAL_ERROR">Technical error</option><option value="OTHER">Other</option></select></label></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="button secondary" onClick={recordFriction}>Record friction ({errorCount})</button><button type="button" className="button primary" onClick={() => finish("COMPLETED")}>Mark thread understood</button><button type="button" className="button secondary" onClick={() => finish("ABANDONED")}>End as abandoned</button></div>
      </>}
      {message && <p className="mt-3 text-xs text-slate-500" role="status">{message}</p>}
    </div>
  </details>;
}

function Operations({ data, facility }: { data: SessionData; facility: Facility }) {
  const s = useScenarioSession(), snapshot = s.simulation.snapshot;
  const [view, setView] = useState<TwinView>("physical");
  const selectedAsset = s.selectedAssetId;
  const setSelectedAsset = s.selectAsset;
  const [overlays, setOverlays] = useState<TwinOverlay[]>(["thermal", "flow", "incident"]);
  useEffect(() => { useScenarioSession.getState().setModelConfig(facility.model_config); }, [facility.id, facility.model_version]);
  const selectedRack = snapshot.racks.find((rack) => rack.id === selectedAsset);
  const selectedLabel = selectedRack ? `Rack ${selectedRack.id}` : selectedAsset === "cdu-03" ? "CDU-03" : selectedAsset === "chiller-01" ? "Chiller-01" : "GPU Cluster B";
  const toggleOverlay = (overlay: TwinOverlay) => setOverlays((items) => items.includes(overlay) ? items.filter((item) => item !== overlay) : [...items, overlay]);
  const riskTone = snapshot.forecast.risk === "critical" ? "bad" : snapshot.incident.open ? "warn" : "good";
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow={`FACILITY / ${facility.id.toUpperCase()} / OPERATIONS`} title={facility.name} detail={`${facility.location} · deterministic GPU Training Ramp · ${facility.provenance}`} action={<Status tone="warn">REPLAY-CONTROLLED</Status>}/>
    <ReplayBar/>
    {data.me.role === "OPERATOR" && <OperatorTestSession facility={facility} elapsedS={snapshot.elapsedS}/>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}%`} help="The modeled electrical load used by computing equipment. It is the main heat input to this scenario."/>
      <Metric label="Total facility" value={snapshot.totalPowerKw.toLocaleString()} unit="kW" sub="physical power balance" help="IT power plus modeled cooling and facility overhead at this replay instant."/>
      <Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn={snapshot.peakInletC >= snapshot.incident.limitC} help="The warmest modeled rack inlet. A forecast may raise attention before this current value reaches its limit."/>
      <Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="total ÷ IT power" help="Power usage effectiveness: total facility power divided by IT power. Lower is more efficient, but this synthetic value is not a measured savings claim."/>
      <Metric label="Headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub={`of ${snapshot.plant.ratedCapacityKw.toLocaleString()} kW rated`} help="Remaining modeled electrical capacity before the facility rating is reached."/>
    </div>
    <div className="mt-3"><DisclosureSection label="Advanced operating context"><p>All KPI cards, the facility twin, incident forecast, and recommendation read from the same deterministic replay instant. Move the canonical clock once to compare like with like across the workflow.</p></DisclosureSection></div>
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,.8fr)]">
      <section className="panel min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-5"><div><h2 className="font-semibold">Synchronized facility twin</h2><p className="mt-1 text-xs text-slate-500">Select an asset to inspect its replay state and dependencies.</p></div><div className="flex gap-1" role="group" aria-label="Twin view">{(["physical", "thermal"] as TwinView[]).map((item) => <button key={item} className={`speed ${view === item ? "selected" : ""}`} onClick={() => setView(item)}>{item === "physical" ? "Physical" : "Thermal overlay"}</button>)}</div></div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-800 px-5 py-3 text-xs text-slate-400">{(["thermal", "flow", "incident"] as TwinOverlay[]).map((overlay) => <label key={overlay} className="flex items-center gap-2"><input type="checkbox" checked={overlays.includes(overlay)} onChange={() => toggleOverlay(overlay)}/>{overlay === "thermal" ? "Heat map" : overlay === "flow" ? "Flow paths" : "Incident focus"}</label>)}</div>
        <div className={`twin-canvas ${view === "thermal" && overlays.includes("thermal") ? "thermal-view" : ""}`} aria-label={`Facility twin in ${view} view. ${snapshot.rackCount} racks, peak inlet ${snapshot.peakInletC.toFixed(1)} degrees.`}>
          <div className="twin-grid"/>
          {overlays.includes("flow") && <><div className="twin-pipe p1"/><div className="twin-pipe p2"/><div className="twin-label l1">LIQUID LOOP<small>ACTIVE</small></div></>}
          <button className={`twin-core ${selectedAsset === "gpu-b" ? "selected" : ""}`} onClick={() => setSelectedAsset("gpu-b")} aria-pressed={selectedAsset === "gpu-b"}><Cpu size={28}/><b>GPU HALL</b><small>CLUSTER B · {snapshot.itPowerKw.toLocaleString()} kW</small></button>
          {snapshot.racks.map((rack, i) => <button key={rack.id} aria-label={`Inspect rack ${rack.id}`} aria-pressed={selectedAsset === rack.id} onClick={() => setSelectedAsset(rack.id)} className={`rack rack-${i} ${rack.atRisk && overlays.includes("incident") ? "hot" : ""} ${selectedAsset === rack.id ? "selected" : ""}`}><span>{rack.id}</span><i style={{height: `${Math.min(100, Math.max(20, ((rack.inletC - 20) / (rack.limitC - 20)) * 100))}%`}}/></button>)}
          <button aria-label="Inspect CDU-03" aria-pressed={selectedAsset === "cdu-03"} onClick={() => setSelectedAsset("cdu-03")} className={`twin-system cdu ${selectedAsset === "cdu-03" ? "selected" : ""}`}><Thermometer size={17}/>CDU-03<small>{snapshot.fanPercent.toFixed(0)}% flow</small></button>
          <button aria-label="Inspect Chiller-01" aria-pressed={selectedAsset === "chiller-01"} onClick={() => setSelectedAsset("chiller-01")} className={`twin-system chiller ${selectedAsset === "chiller-01" ? "selected" : ""}`}><Gauge size={17}/>CHILLER-01<small>{snapshot.chilledWaterC.toFixed(1)}°C supply</small></button>
        </div>
        <div className="border-t border-slate-800 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="eyebrow">REPLAY TIMELINE</div><p className="mt-1 text-xs text-slate-500">Every panel reads the same canonical clock.</p></div><span className={`${mono} text-xs text-cyan-300`}>{Math.round(snapshot.elapsedS / 60)}m / 30m</span></div><div className="timeline mt-4"><div className="timeline-axis"/>{[0, 300, 900, 1800].map((at) => <button key={at} className={`timeline-event ${Math.abs(snapshot.elapsedS - at) < 30 ? "current" : ""}`} onClick={() => s.jump(at)}><span className={`dot ${at >= 900 ? "amber" : ""}`}/><small>{at / 60}m</small><b>{at === 0 ? "Baseline" : at === 900 ? "Forecast" : at === 1800 ? "Ramp end" : "Power rise"}</b></button>)}</div></div>
      </section>
      <aside className="min-w-0 space-y-4">
        <section className="panel p-5"><div className="eyebrow">CONTEXTUAL HUD</div><h2 className="mt-2 text-xl font-semibold">{selectedLabel}</h2>{selectedRack ? <><p className="mt-2 text-sm text-slate-400">Current rack state at this replay instant.</p><div className="mt-5 grid grid-cols-2 gap-3"><Metric label="Inlet" value={selectedRack.inletC.toFixed(1)} unit="°C" sub={`limit ${selectedRack.limitC.toFixed(1)}°C`} warn={selectedRack.atRisk}/><Metric label="Heat" value={selectedRack.heatKw.toLocaleString()} unit="kW" sub="estimated IT heat"/></div>{selectedRack.atRisk && <button className="button primary mt-4 w-full justify-center" onClick={() => navigate(`/facilities/${facility.id}/incidents/inc-204`)}>Inspect incident <ArrowRight size={14}/></button>}</> : <p className="mt-2 text-sm leading-6 text-slate-400">{selectedAsset === "cdu-03" ? `Cooling distribution is at ${snapshot.fanPercent.toFixed(0)}% command with ${snapshot.coolingUnitCount} unit online.` : selectedAsset === "chiller-01" ? `Chilled water supply is ${snapshot.chilledWaterC.toFixed(1)}°C.` : `Cluster workload is ${snapshot.workloadPercent}% with ${snapshot.rackCount} racks online.`}</p>}<ContextualHelp title="Why select an asset?"><p>Selection adds local state and dependencies without replacing the facility-wide summary. Use it when a site-level signal needs asset context.</p></ContextualHelp></section>
        <section className="panel p-5"><div className="eyebrow">FORECAST RISK</div><div className="mt-2 flex items-center justify-between gap-3"><h2 className={`text-xl font-semibold ${riskTone === "good" ? "text-teal-300" : riskTone === "bad" ? "text-red-300" : "text-amber-300"}`}>{snapshot.forecast.risk === "clear" ? "Clear condition" : `${snapshot.incident.severity} condition`}</h2><Status tone={riskTone}>{snapshot.forecast.risk}</Status></div><p className="mt-3 text-sm leading-6 text-slate-400">{snapshot.incident.rackId} forecast peak {snapshot.forecast.baselinePeakC.toFixed(1)}°C in the next {Math.round(snapshot.forecast.horizonS / 60)} minutes against a {snapshot.incident.limitC.toFixed(1)}°C limit.</p><ContextualHelp title="How to read this forecast"><p>The forecast extends the current replay state through the disclosed horizon. Risk describes whether modeled temperature approaches or crosses the limit; it is not a live alarm or certainty statement.</p></ContextualHelp><button onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="button primary mt-4 w-full justify-center">Review advisory <ArrowRight size={15}/></button></section>
        <section className="panel p-5"><div className="eyebrow">OPERATING MODE</div><select aria-label="Operating mode" value={s.mode} onChange={(event) => s.setMode(event.target.value as typeof s.mode)} className="select mt-4 w-full"><option>Observe</option><option>Shadow</option><option>Advisory</option></select><p className="mt-3 text-xs leading-5 text-slate-500">{s.mode === "Observe" ? "Read-only view. No advisory is proposed." : s.mode === "Shadow" ? "Recommendations are simulated for comparison; no action is sent." : "Advisories may be reviewed, but human approval is required. No OT commands are issued."}</p><ContextualHelp title="What changes by mode?"><p><b>Observe</b> shows state only. <b>Shadow</b> computes recommendations for comparison. <b>Advisory</b> lets authorized operators review and record a disposition. None of these modes sends an OT command.</p></ContextualHelp></section>
        <Transparency facility={facility} snapshot={snapshot}/>
      </aside>
    </div>
  </Shell>;
}

function Recommendation({ data, facility }: { data: SessionData; facility: Facility }) {
  const snapshot = useScenarioSession((state) => state.simulation.snapshot);
  const [flowPercent, setFlowPercent] = useState(snapshot.recommendation.flowPercent);
  const [durationMinutes, setDurationMinutes] = useState(snapshot.recommendation.durationMinutes);
  const [comparison, setComparison] = useState<WhatIfComparison | null>(null);
  const [evaluation, setEvaluation] = useState<SafetyEvaluation | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const command = { assetId: "cdu-03" as const, flowPercent, durationMinutes };

  useEffect(() => {
    void recordLearningEvent("RECOMMENDATION_INSPECTED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  }, [facility.id]);

  useEffect(() => {
    setComparison(null);
    setEvaluation(null);
    setMessage("");
  }, [snapshot.simulatedAt, flowPercent, durationMinutes]);

  const compare = async () => {
    setError("");
    try {
      setComparison(await post<WhatIfComparison>(
        `/api/facilities/${facility.id}/recommendations/rec-17/what-if`,
        { simulatedAt: snapshot.simulatedAt, command },
      ));
    } catch (cause) { setError(String(cause)); }
  };
  const evaluate = async () => {
    setError("");
    try {
      setEvaluation(await post<SafetyEvaluation>(
        `/api/facilities/${facility.id}/recommendations/rec-17/evaluate`,
        { simulatedAt: snapshot.simulatedAt, command },
      ));
    } catch (cause) { setError(String(cause)); }
  };
  const decide = async (decision: "APPROVE" | "REJECT" | "DEFER" | "REQUEST_ALTERNATIVE" | "ACKNOWLEDGE") => {
    setError("");
    try {
      const record = await post<Audit>(
        `/api/facilities/${facility.id}/recommendations/rec-17/decisions`,
        {
          decision,
          simulatedAt: snapshot.simulatedAt,
          safetyEvaluationId: evaluation?.id,
          command,
          note,
        },
      );
      setMessage(`${decision.replace(/_/g, " ")} recorded as immutable decision #${record.id}.`);
      setEvaluation(null);
    } catch (cause) { setError(String(cause)); }
  };
  const evaluationTone = evaluation?.outcome === "PASS" ? "text-teal-300" : evaluation?.outcome === "WARNING" ? "text-amber-300" : "text-red-300";

  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="RECOMMENDATION / REC-17 / VERSION 1" title="Pre-emptive CDU-03 flow adjustment" detail={`Bound to ${formatSimulatedAt(snapshot.simulatedAt)}, GPU Training Ramp, and ${facility.model_version}.`}/>
    <ReplayBar/>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(330px,.75fr)]">
      <div className="space-y-4">
        <section className="panel p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><Status tone="warn">ADVISORY · SYNTHETIC</Status><h2 className="mt-3 text-xl font-semibold">{snapshot.recommendation.what}</h2></div><ShieldCheck className="text-cyan-300"/></div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              ["WHY", snapshot.recommendation.why],
              ["WHERE", snapshot.recommendation.where],
              ["EXPECTED EFFECT", snapshot.recommendation.expectedEffect],
              ["CONFIDENCE", `${Math.round(snapshot.recommendation.confidence * 100)}% at the ${snapshot.forecast.horizonS / 60}-minute horizon; quality GOOD inside the disclosed domain.`],
            ].map(([label, value]) => <div key={label} className="subpanel"><span className="eyebrow">{label}</span><p className="text-sm leading-6 text-slate-300">{value}</p></div>)}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Metric label="Inaction peak" value={snapshot.recommendation.baselinePeakC.toFixed(1)} unit="°C" sub="same initial state" warn/>
            <Metric label="Recommended peak" value={snapshot.recommendation.advisoryPeakC.toFixed(1)} unit="°C" sub={`${snapshot.recommendation.reductionC.toFixed(1)}°C modeled reduction`}/>
            <Metric label="Constraint avoided" value={String(snapshot.recommendation.constraintMinutesAvoided)} unit="min" sub="same events and model"/>
          </div>
          <div className="mt-5 grid gap-2">
            <DisclosureSection label="Advanced: confidence and limitations"><p>Confidence is scoped to this replay state, horizon, and model domain; it is not a probability that an operator decision is correct.</p><ul className="mt-2 list-disc space-y-1 pl-5">{snapshot.recommendation.limitations.map((item) => <li key={item}>{item}</li>)}</ul></DisclosureSection>
            <DisclosureSection label="Engineering: provenance and model binding" engineering><p>{snapshot.recommendation.provenance} · deterministic reduced-order model · {facility.model_version}. The recommendation, Safety Shield result, and recorded decision remain bound to this exact model version and replay instant.</p></DisclosureSection>
          </div>
        </section>

        <DisclosureSection label="Advanced: compare a permitted alternative">
        <section className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">WHAT-IF COMPARISON</div><h2 className="mt-2 text-lg font-semibold">Adjust a permitted advisory</h2><p className="copy">Only the advisory parameters change. Initial state, event stream, replay instant, and model version stay fixed.</p></div><SlidersHorizontal className="text-cyan-300"/></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="field">CDU-03 flow: <b>{flowPercent}%</b><input aria-label="Alternative CDU flow percent" type="range" min="60" max="85" step="1" value={flowPercent} onChange={(event) => setFlowPercent(Number(event.target.value))}/></label>
            <label className="field">Duration: <b>{durationMinutes} minutes</b><input aria-label="Alternative duration minutes" type="range" min="1" max="30" step="1" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}/></label>
          </div>
          <button className="button secondary mt-5" onClick={compare}><Layers3 size={15}/>Compare identical-input outcomes</button>
          {comparison && <div className="mt-5 grid gap-3 md:grid-cols-3">{comparison.options.map((option) => <article key={option.id} className={`subpanel ${option.id === "alternative" ? "border-cyan-500/60" : ""}`}><div className="flex items-center justify-between gap-2"><b>{option.label}</b>{option.id === "alternative" && <Status>EDITED</Status>}</div><span className="text-2xl font-semibold">{option.peakC.toFixed(1)}<small className="ml-1 text-xs text-slate-500">°C peak</small></span><small>{option.constraintMinutes.toFixed(1)} modeled constraint minutes</small><small>{option.command ? `${option.command.flowPercent}% · ${option.command.durationMinutes} min` : "No advisory action"}</small></article>)}</div>}
        </section>
        </DisclosureSection>
      </div>

      <aside className="space-y-4">
        <section className="panel p-6">
          <div className="eyebrow">SAFETY SHIELD · SERVER VERIFIED</div>
          {evaluation ? <>
            <div className="mt-2 flex items-center justify-between"><h2 className={`text-2xl font-semibold ${evaluationTone}`}>{evaluation.outcome}</h2><Status tone={evaluation.outcome === "PASS" ? "good" : evaluation.outcome === "WARNING" ? "warn" : "bad"}>{evaluation.modelVersionId}</Status></div>
            <p className="mt-2 text-xs text-slate-500">Bound to recommendation v{evaluation.recommendationVersion}, this command, user, model, and replay instant.</p>
            <ul className="mt-5 space-y-3">{evaluation.checks.map((check) => <li key={check.id} className="flex gap-3 text-sm"><span className={check.status === "PASS" ? "text-teal-300" : check.status === "WARNING" ? "text-amber-300" : "text-red-300"}>{check.status === "PASS" ? <Check size={16}/> : <X size={16}/>}</span><span><span className="flex items-center gap-2"><b>{check.id.replace(/_/g, " ")}</b><Status tone={check.status === "PASS" ? "good" : check.status === "WARNING" ? "warn" : "bad"}>{check.status}</Status></span><small className="mt-1 block leading-5 text-slate-500">{check.detail}</small></span></li>)}</ul>
          </> : <p className="copy">Run the server-side evaluation after choosing the command. A changed parameter, replay instant, model, or reused result invalidates approval.</p>}
          <ContextualHelp title="Who has decision authority?"><p>The Safety Shield verifies constraints but does not approve the advisory. Only an authorized operator can record a disposition, and approval never sends an equipment command.</p></ContextualHelp>
          {facility.can_assistant && <button className="button primary mt-5 w-full justify-center" onClick={evaluate}><ShieldCheck size={15}/>Run Safety Shield</button>}
        </section>
        {facility.can_operate ? <section className="panel p-6">
          <div className="eyebrow">OPERATOR DISPOSITION</div>
          <label className="field">Decision note (optional)<textarea className="textarea mt-2 min-h-[76px] w-full" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Record operational context"/></label>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="button primary justify-center" disabled={evaluation?.outcome !== "PASS"} onClick={() => decide("APPROVE")}><Check size={14}/>Approve</button>
            <button className="button secondary justify-center" onClick={() => decide("REJECT")}><X size={14}/>Reject</button>
            <button className="button secondary justify-center" onClick={() => decide("DEFER")}><Clock3 size={14}/>Defer</button>
            <button className="button secondary justify-center" onClick={() => decide("REQUEST_ALTERNATIVE")}><RotateCcw size={14}/>Request alternative</button>
          </div>
          {evaluation?.outcome === "WARNING" && <button className="button secondary mt-2 w-full justify-center" onClick={() => decide("ACKNOWLEDGE")}>Acknowledge warning without approval</button>}
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Approval is available only for an unused, unexpired PASS. This records an advisory disposition; it never sends an equipment command.</p>
        </section> : <section className="panel p-6 text-sm text-slate-500">Read-only access: operator dispositions are unavailable for this role.</section>}
        {error && <p role="alert" className="panel p-4 text-sm text-red-300">{error}</p>}
        {message && <p role="status" className="panel p-4 text-sm text-teal-300">{message}</p>}
      </aside>
    </div>
  </Shell>;
}

function IncidentPage({ data, facility, incidentId }: { data: SessionData; facility: Facility; incidentId: string }) {
  const snapshot = useScenarioSession((s) => s.simulation.snapshot), [incidents, setIncidents] = useState<Incident[]>([]), [selected, setSelected] = useState<Incident | null>(null), [reconstructed, setReconstructed] = useState<CockpitSnapshot | null>(null), [error, setError] = useState("");
  useEffect(() => {
    api<Incident[]>(`/api/facilities/${facility.id}/incidents`).then((items) => {
      setIncidents(items);
      const item = items.find(candidate => candidate.id === incidentId) ?? items[0];
      if (!item) return;
      setSelected(item);
      return api<{ incident: Incident; snapshot: CockpitSnapshot }>(`/api/facilities/${facility.id}/incidents/${item.id}`)
        .then(result => setReconstructed(result.snapshot));
    }).catch(e => setError(String(e)));
  }, [facility.id, incidentId]);
  const incident = selected ?? incidents[0];
  const reconstruct = async (item: Incident) => { setSelected(item); try { const result = await api<{ incident: Incident; snapshot: CockpitSnapshot }>(`/api/facilities/${facility.id}/incidents/${item.id}`); setReconstructed(result.snapshot); } catch (e) { setError(String(e)); } };
  const current = reconstructed ?? snapshot;
  return <Shell data={data} facility={facility}><PageHead eyebrow="INCIDENTS / CORRELATED EVENTS" title="Incident investigation" detail="Persisted incidents retain their scenario timestamp so operators can reconstruct what was known."/><div className="grid gap-4 xl:grid-cols-[300px_1fr]"><section className="panel overflow-hidden"><div className="border-b border-slate-800 p-4"><h2 className="font-semibold">Open incidents</h2></div>{incidents.map(item => <button key={item.id} onClick={() => reconstruct(item)} className={`w-full border-b border-slate-800 p-4 text-left ${incident?.id === item.id ? "bg-slate-800/60" : ""}`}><div className="flex justify-between"><b>{item.id}</b><Status tone={item.severity === "HIGH" ? "bad" : "warn"}>{item.severity}</Status></div><p className="mt-2 text-xs text-slate-400">{item.title}</p><p className="mt-2 text-[10px] text-slate-500">{item.raw_signal_count} raw signals · {item.forecast_minutes}m forecast</p></button>)}{!incidents.length&&!error&&<p className="p-4 text-sm text-slate-500">No persisted incidents.</p>}{error&&<p role="alert" className="p-4 text-sm text-red-300">{error}</p>}</section><section className="space-y-4">{incident ? <><section className="panel p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><Status tone={incident.severity === "HIGH" ? "bad" : "warn"}>{incident.status}</Status><h2 className="mt-3 text-xl font-semibold">{incident.id} · {incident.title}</h2><p className="mt-2 text-sm text-slate-400">Generated at {formatSimulatedAt(incident.simulated_at)} from the GPU Training Ramp.</p></div><AlertTriangle className="text-amber-300"/></div><div className="mt-6 grid gap-3 sm:grid-cols-3"><Metric label="Affected" value={incident.affected_assets[0]} sub={incident.affected_assets.slice(1).join(" · ")}/><Metric label="Forecast impact" value={String(incident.forecast_minutes)} unit="min" sub="to thermal margin breach" warn/><Metric label="Correlated signals" value={String(incident.raw_signal_count)} sub="deduplicated into one incident"/></div><p className="copy">Likely cause: {incident.likely_cause}. The server replay below is reconstructed at the incident timestamp, not the current clock.</p><div className="mt-5 grid gap-3 md:grid-cols-2"><div className="subpanel"><span className="eyebrow">CORRELATED EVIDENCE</span>{(incident.correlated_signals ?? []).map(signal => <div key={signal.id} className="text-xs text-slate-300"><b>{signal.assetId}</b> · {signal.metric.replace(/_/g, " ")} · {signal.direction}</div>)}</div><div className="subpanel"><span className="eyebrow">THERMAL PATH</span><div className="flex flex-wrap items-center gap-2 text-xs">{(incident.thermal_path ?? []).map((asset, index) => <span key={asset} className="flex items-center gap-2"><b>{asset}</b>{index < incident.thermal_path.length - 1 && <ArrowRight size={12} className="text-cyan-300"/>}</span>)}</div><small>Dedup key: {incident.deduplication_key}</small></div></div><div className="mt-5 flex flex-wrap gap-2"><button className="button secondary" onClick={() => navigate(`/facilities/${facility.id}/topology?focus=cdu-03`)}>View thermal path <GitBranch size={15}/></button><button className="button primary" onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)}>View recommendation <ArrowRight size={15}/></button></div></section><section className="panel p-6"><div className="flex items-center justify-between"><div><div className="eyebrow">RECONSTRUCTED SCENARIO CONTEXT</div><h2 className="mt-2 font-semibold">{reconstructed ? "Historical state loaded" : "Select incident to reconstruct"}</h2></div><History className="text-cyan-300"/></div><div className="mt-5 grid gap-3 sm:grid-cols-4"><Metric label="Simulated time" value={formatSimulatedAt(current.simulatedAt).slice(11)} sub={`${Math.round(current.elapsedS / 60)}m into ramp`}/><Metric label="IT power" value={current.itPowerKw.toLocaleString()} unit="kW" sub={`workload ${current.workloadPercent}%`}/><Metric label="Peak inlet" value={current.peakInletC.toFixed(1)} unit="°C" sub={`limit ${current.incident.limitC.toFixed(1)}°C`} warn/><Metric label="Model" value={incident.model_version} sub="version used by replay"/></div></section></> : <section className="panel p-6 text-sm text-slate-500">Choose an incident to inspect its correlated signals.</section>}</section></div></Shell>;
}

function AuditPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const current = useScenarioSession((state) => state.simulation.snapshot);
  const [records, setRecords] = useState<Audit[]>([]);
  const [selected, setSelected] = useState<Audit | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [decisionFilter, setDecisionFilter] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    const query = new URLSearchParams();
    if (decisionFilter) query.set("decision", decisionFilter);
    if (search.trim()) query.set("search", search.trim());
    api<Audit[]>(`/api/facilities/${facility.id}/audit?${query}`).then(setRecords).catch((cause) => setError(String(cause)));
  };
  useEffect(() => { load(); }, [facility.id, decisionFilter]);
  const select = async (record: Audit) => {
    setSelected(record);
    setError("");
    try {
      setDetail(await api(`/api/facilities/${facility.id}/audit/${record.id}`));
    } catch (cause) { setError(String(cause)); }
  };
  const snapshot = detail?.snapshot;
  const decision = detail?.decision ?? selected?.payload?.decision;
  const safety = detail?.safetyEvaluation ?? selected?.payload?.safetyEvaluation;
  const recommendation = detail?.recommendation ?? selected?.payload?.recommendation;
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="AUDIT HISTORY / IMMUTABLE DECISIONS" title="Audit history" detail="Filter decisions and reconstruct the exact recorded scenario, model, evidence, Safety Shield evaluation, and disposition."/>
    <section className="panel mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="field m-0 flex-1">Search evidence or action<input className="input mt-2 w-full" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && load()} placeholder="e.g. deferred, CDU-03, PASS"/></label>
        <label className="field m-0">Disposition<select className="select mt-2 block" value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value)}><option value="">All dispositions</option><option value="APPROVE">Approved</option><option value="REJECT">Rejected</option><option value="DEFER">Deferred</option><option value="REQUEST_ALTERNATIVE">Alternative requested</option><option value="ACKNOWLEDGE">Warning acknowledged</option></select></label>
        <button className="button secondary" onClick={load}><Search size={14}/>Apply filters</button>
      </div>
    </section>
    <section className="panel mb-4 p-5"><div className="eyebrow">CURRENT REPLAY · NOT USED FOR HISTORY</div><div className="mt-3 grid gap-3 sm:grid-cols-4"><Metric label="Simulated at" value={formatSimulatedAt(current.simulatedAt).slice(11)} sub={`${Math.round(current.elapsedS / 60)}m into ramp`}/><Metric label="IT power" value={current.itPowerKw.toLocaleString()} unit="kW" sub={`workload ${current.workloadPercent}%`}/><Metric label="Peak inlet" value={current.peakInletC.toFixed(1)} unit="°C" sub={`limit ${current.incident.limitC.toFixed(1)}°C`}/><Metric label="Forecast" value={current.forecast.baselinePeakC.toFixed(1)} unit="°C" sub={`${current.forecast.horizonS / 60}m horizon`}/></div></section>
    <div className="grid gap-4 xl:grid-cols-[minmax(380px,.85fr)_minmax(0,1.15fr)]">
      <section className="panel overflow-hidden">
        {records.map((record) => {
          const recordDecision = record.payload?.decision;
          return <button key={record.id} onClick={() => select(record)} className={`facility-row w-full text-left ${selected?.id === record.id ? "bg-slate-800/60" : ""}`}><div><Status tone={recordDecision?.decision === "APPROVE" ? "good" : recordDecision?.decision === "REJECT" ? "bad" : "warn"}>{record.action.replace("DECISION_", "").replace(/_/g, " ")}</Status><h2 className="mt-2 font-semibold">Recommendation {record.payload?.recommendation?.id ?? record.payload?.recommendationId}</h2><p className="mt-1 text-xs text-slate-500">{new Date(record.created_at).toLocaleString()} · {record.model_version}</p></div><div className="text-right"><b>{recordDecision?.outcome ?? record.payload?.outcome}</b><p className={`${mono} mt-1 text-[10px] text-slate-500`}>{formatSimulatedAt(record.simulated_at)}</p></div></button>;
        })}
        {!records.length && !error && <p className="p-6 text-sm text-slate-500">No decisions match these filters.</p>}
        {error && <p role="alert" className="p-6 text-red-300">{error}</p>}
      </section>
      <section className="panel p-6">
        <div className="eyebrow">RECONSTRUCTED IMMUTABLE RECORD</div>
        {selected && snapshot ? <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Decision #{selected.id}</h2><p className="mt-1 text-xs text-slate-500">{selected.scenario_id} · {selected.model_version} · {formatSimulatedAt(selected.simulated_at)}</p></div><Status tone={safety?.outcome === "PASS" ? "good" : safety?.outcome === "WARNING" ? "warn" : "bad"}>{safety?.outcome ?? "RECORDED"}</Status></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="IT power" value={Number(snapshot.itPowerKw).toLocaleString()} unit="kW" sub="stored snapshot"/><Metric label="Peak inlet" value={Number(snapshot.peakInletC).toFixed(1)} unit="°C" sub={`PUE ${Number(snapshot.pue).toFixed(3)}`}/><Metric label="Forecast" value={Number(snapshot.forecast.baselinePeakC).toFixed(1)} unit="°C" sub={`${snapshot.forecast.horizonS / 60}m stored horizon`}/><Metric label="Advisory" value={`${snapshot.recommendation.flowPercent}%`} sub={`${snapshot.recommendation.durationMinutes} minute alternative`}/></div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="subpanel"><span className="eyebrow">DECISION SNAPSHOT</span><b>{decision?.decision?.replace(/_/g, " ")} → {decision?.outcome}</b><small>{decision?.note || "No operator note"}</small><small>Command: {decision?.command?.flowPercent}% for {decision?.command?.durationMinutes} min</small></div>
            <div className="subpanel"><span className="eyebrow">RECOMMENDATION & MODEL</span><b>{recommendation?.title}</b><small>Recommendation v{recommendation?.version} · model {detail?.model?.version ?? selected.model_version}</small><small>Confidence {Math.round(Number(recommendation?.confidence ?? 0) * 100)}% · SIMULATED</small></div>
          </div>
          <div className="mt-5"><div className="eyebrow">RECORDED SAFETY EVIDENCE</div><ul className="mt-3 space-y-2">{(safety?.checks ?? []).map((check: any) => <li key={check.id} className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2 text-xs"><span><b>{check.id.replace(/_/g, " ")}</b><small className="mt-1 block text-slate-500">{check.detail}</small></span><Status tone={check.status === "PASS" ? "good" : check.status === "WARNING" ? "warn" : "bad"}>{check.status}</Status></li>)}</ul></div>
          <p className="mt-5 text-[11px] leading-5 text-slate-500">This view renders the JSON snapshot stored with the decision. It does not replay the active model or substitute current facility state.</p>
        </> : <p className="copy">Select a record to load its exact stored reconstruction.</p>}
      </section>
    </div>
  </Shell>;
}

function GraphPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const snapshot = useScenarioSession((s) => s.simulation.snapshot), selectedId = useScenarioSession((s) => s.selectedAssetId), setSelectedId = useScenarioSession((s) => s.selectAsset), [view, setView] = useState<GraphView>("topology"), graph = useMemo(() => thermalGraph(snapshot, view), [snapshot, view]);
  const selected = graph.nodes.find(node => node.id === selectedId) ?? graph.nodes[0], related = graphSelection(graph, selected.id);
  const nodeTone = (node: typeof graph.nodes[number]) =>
    related.upstream.some((item) => item.id === node.id) ? "border-sky-400 bg-sky-400/10"
      : related.downstream.some((item) => item.id === node.id) ? "border-teal-400 bg-teal-400/10"
        : view === "forecast" && node.risk ? "border-amber-400 bg-amber-400/10"
          : "border-slate-700 bg-slate-900";
  useEffect(() => {
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  }, [facility.id, view]);
  return <Shell data={data} facility={facility}><PageHead eyebrow="THERMAL DEPENDENCY GRAPH" title="Heat-flow topology" detail="Select an asset to trace what affects it, where heat goes, and what would be impacted by degradation."/><ReplayBar/><div className="mb-4 flex flex-wrap gap-2">{(["topology","current","forecast"] as GraphView[]).map(item => <button key={item} onClick={() => setView(item)} className={`button ${view === item ? "primary" : "secondary"}`}>{item === "topology" ? "Topology" : item === "current" ? "Current state" : "Forecast state"}</button>)}</div><div className="grid gap-4 xl:grid-cols-[1fr_340px]"><section className="panel p-5"><div className="mb-5 flex items-center justify-between"><div><h2 className="font-semibold">{view === "topology" ? "THERMAL DEPENDENCY GRAPH" : view.toUpperCase()}</h2><p className="mt-1 text-xs text-slate-500">GPU Training Ramp · {formatSimulatedAt(snapshot.simulatedAt)}</p></div><GitBranch className="text-cyan-300"/></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{graph.nodes.map(node => <button key={node.id} onClick={() => setSelectedId(node.id)} className={`rounded-md border p-4 text-left transition-colors ${nodeTone(node)} ${selected.id === node.id ? "ring-2 ring-cyan-300" : ""}`}><div className="flex justify-between gap-2"><span className="text-[10px] uppercase tracking-[.14em] text-slate-500">{node.kind}</span>{node.risk&&<span className="text-[10px] text-amber-300">RISK</span>}</div><b className="mt-2 block">{node.label}</b><span className="mt-1 block text-xs text-slate-500">{node.detail}</span><span className={`${mono} mt-3 block text-xs text-cyan-300`}>{node.value}</span></button>)}</div><div className="mt-5 border-t border-slate-800 pt-4"><div className="eyebrow">RELATIONSHIPS</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).map(edge => <div key={`${edge.from}-${edge.to}`} className="flex items-center gap-2 text-xs"><span className="text-slate-300">{graph.nodes.find(n => n.id === edge.from)?.label}</span><ArrowRight size={13} className="text-cyan-300"/><span className="text-slate-300">{graph.nodes.find(n => n.id === edge.to)?.label}</span><small className="text-slate-500">· {edge.label}</small></div>)}</div></div></section><aside className="panel p-5"><div className="eyebrow">SELECTED ASSET</div><h2 className="mt-2 text-xl font-semibold">{selected.label}</h2><p className="mt-2 text-sm text-slate-400">{selected.detail} · {selected.value}</p><div className="mt-6 space-y-5"><div><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-slate-500"><ArrowUp size={13}/>Upstream / what affects it</div><ul className="mt-2 space-y-1 text-sm">{related.upstream.length ? related.upstream.map(node => <li key={node.id}>{node.label}</li>) : <li className="text-slate-500">Source node</li>}</ul></div><div><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-slate-500"><ArrowDown size={13}/>Downstream / carries heat away</div><ul className="mt-2 space-y-1 text-sm">{related.downstream.length ? related.downstream.map(node => <li key={node.id}>{node.label}</li>) : <li className="text-slate-500">Terminal node</li>}</ul></div><div className="border-t border-slate-800 pt-4"><div className="text-[10px] uppercase tracking-[.14em] text-amber-300">Impact if degraded</div><p className="mt-2 text-sm leading-6 text-slate-400">{related.impact.length ? `${related.impact.map(node => node.label).join(", ")} would require review.` : "No downstream impact is modeled."}</p></div></div></aside></div></Shell>;
}

function ModelStudio({ data, facility }: { data: SessionData; facility: Facility }) {
  const [versions, setVersions] = useState<ModelVersion[]>([]), [config, setConfig] = useState('{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'), [message, setMessage] = useState(""), [error, setError] = useState("");
  const refresh = () => api<ModelVersion[]>(`/api/facilities/${facility.id}/model/versions`).then(setVersions).catch(e => setError(String(e)));
  useEffect(() => { void refresh(); }, [facility.id]);
  useEffect(() => {
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
    });
  }, [facility.id]);
  const createDraft = async () => { try { const parsed = JSON.parse(config); const result = await post<ModelVersion>(`/api/facilities/${facility.id}/model/versions`, { config: parsed }); setVersions(v => [result, ...v]); setMessage(`${result.id} created as DRAFT`); setError(""); } catch (e) { setError(String(e)); } };
  const action = async (path: string, success: string, body: unknown = {}, reloadModel = false) => { try { await post(path, body); await refresh(); if (reloadModel) { const active = (await api<Facility[]>("/api/facilities")).find(item => item.id === facility.id); if (active) useScenarioSession.getState().setModelConfig(active.model_config); } setMessage(success); setError(""); } catch (e) { setError(String(e)); } };
  return <Shell data={data} facility={facility}><PageHead eyebrow="MODEL ADMINISTRATION / DEMO MODEL" title="Model Studio" detail="Edit the facility representation Operations consumes. Changes are validated, versioned, and explicitly published." action={<Status tone="warn">DEMO MODEL</Status>}/><div className="grid gap-4 xl:grid-cols-[.9fr_1.1fr]"><section className="panel p-6"><div className="flex items-center gap-3"><SlidersHorizontal className="text-cyan-300"/><div><h2 className="font-semibold">Create facility model version</h2><p className="text-xs text-slate-500">Synthetic simulation parameters only</p></div></div><label className="mt-6 block text-xs text-slate-500" htmlFor="model-config">Configuration JSON</label><textarea id="model-config" value={config} onChange={e=>setConfig(e.target.value)} className="textarea mt-2 min-h-[170px] w-full font-mono text-xs" aria-describedby="model-config-help"/><p id="model-config-help" className="mt-2 text-xs text-slate-500">Include scenario, seed, thermal mass, and response lag. Invalid JSON cannot be saved.</p><button className="button primary mt-4" onClick={createDraft}><Save size={15}/>Save draft version</button>{message&&<p role="status" className="mt-4 text-sm text-teal-300">{message}</p>}{error&&<p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}</section><section className="panel overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Version history</h2><p className="mt-1 text-xs text-slate-500">Published version: {facility.model_version}</p></div>{versions.map(version => <div key={version.id} className="border-b border-slate-800 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className={`${mono} text-sm text-cyan-300`}>{version.id}</div><p className="mt-1 text-xs text-slate-500">{new Date(version.created_at).toLocaleString()} · {Object.keys(version.config).length} parameters</p></div><Status tone={version.status === "PUBLISHED" ? "good" : version.status === "DRAFT" ? "warn" : "good"}>{version.status}</Status></div><div className="mt-4 flex flex-wrap gap-2">{version.status === "DRAFT"&&<button className="button secondary" onClick={() => action(`/api/facilities/${facility.id}/model/versions/${version.id}/validate`, `${version.id} validated`)}><Check size={14}/>Validate</button>}{version.status === "VALIDATED"&&<button className="button primary" onClick={() => action(`/api/facilities/${facility.id}/model/versions/${version.id}/publish`, `${version.id} published to Operations`, {}, true)}><ArrowUp size={14}/>Publish</button>}{version.status !== "PUBLISHED"&&version.status !== "DRAFT"&&<button className="button secondary" onClick={() => action(`/api/facilities/${facility.id}/model/rollback`, `Operations rolled back to ${version.id}`, { versionId: version.id }, true)}><RotateCcw size={14}/>Rollback to this version</button>}</div></div>)}{versions.length===0&&<p className="p-5 text-sm text-slate-500">No model versions returned.</p>}</section></div></Shell>;
}

function ModelLab({ data, facility }: { data: SessionData; facility: Facility }) {
  const snapshot = useScenarioSession((s) => s.simulation.snapshot), [comparison, setComparison] = useState<ControllerComparison | null>(null);
  const run = () => {
    setComparison(compareControllers(snapshot));
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  };
  return <Shell data={data} facility={facility}><PageHead eyebrow="MODEL LAB / PHYSICAL AI" title="Controller comparison" detail="Every controller receives the same initial state and event stream. This is a comparison harness, not a superiority claim." action={<Status tone="warn">SYNTHETIC</Status>}/><ReplayBar/><section className="panel p-6"><div className="grid gap-4 md:grid-cols-3"><div><div className="eyebrow">INITIAL STATE</div><p className="mt-2 text-sm">{comparison?.initialState ?? `${snapshot.workloadPercent}% workload · ${snapshot.itPowerKw.toLocaleString()} kW IT · ${snapshot.rackCount} racks`}</p></div><div><div className="eyebrow">SHARED EVENTS</div><p className="mt-2 text-sm">{comparison?.events.join(" → ") ?? "Training ramp → power rise → CDU response lag"}</p></div><div className="flex items-end md:justify-end"><button className="button primary" onClick={run}><Play size={15}/>Run same-input comparison</button></div></div></section>{comparison&&<section className="panel mt-4 overflow-x-auto"><table className="data-table min-w-[900px]"><caption className="sr-only">Controller comparison results</caption><thead><tr><th>Controller</th><th>Peak temp</th><th>Degree-minutes</th><th>Warning lead</th><th>Cooling energy</th><th>Interventions</th><th>Inference events</th><th>Objective</th></tr></thead><tbody>{comparison.results.map(result => <tr key={result.id}><td><b>{result.name}</b><small className="mt-1 block text-slate-500">{result.architecturalMetric}: {result.architecturalValue}</small></td><td>{result.peakC.toFixed(1)}°C</td><td>{result.degreeMinutes.toFixed(1)}</td><td>{result.warningLeadMinutes === null ? "Unavailable" : `${result.warningLeadMinutes} min`}</td><td>{result.coolingEnergyKwh === null ? "Unavailable" : `${result.coolingEnergyKwh} kWh`}</td><td>{result.interventions}</td><td>{result.inferenceEvents === null ? "Unavailable" : result.inferenceEvents}</td><td>{result.objective}</td></tr>)}</tbody></table><p className="p-5 text-xs text-slate-500">SNN rows show only metrics supported by an implemented measurement. Compute energy, event sparsity, and unsupported physical-AI claims are marked unavailable.</p></section>}</Shell>;
}

function AccessAdministration({ data }: { data: SessionData }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<Array<{ id: string; action: string; actor_user_id: string; target_user_id: string | null; facility_id: string | null; created_at: string }>>([]);
  const [draft, setDraft] = useState({ userId: "", email: "", displayName: "", role: "VIEWER" as Role, isAdmin: false });
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const refresh = async () => {
    try {
      const [membershipResult, auditResult] = await Promise.all([
        api<{ items: Member[] }>("/api/admin/memberships"),
        api<{ items: typeof audit }>("/api/admin/audit"),
      ]);
      setMembers(membershipResult.items);
      setAudit(auditResult.items);
      setError("");
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => { void refresh(); }, []);
  const saveMember = async (member: { userId: string; email?: string; displayName?: string; role: Role; isAdmin: boolean }) => {
    try {
      await post("/api/admin/memberships", member);
      setMessage(`${member.userId} access saved`);
      await refresh();
    } catch (cause) { setError(String(cause)); }
  };
  const saveGrant = async (member: Member, facility: MemberFacility, next: Partial<MemberFacility>) => {
    const grant = { ...facility, ...next };
    try {
      await patch(`/api/admin/memberships/${encodeURIComponent(member.id)}/facilities/${encodeURIComponent(facility.facility_id)}`, {
        canView: grant.can_view,
        canOperate: grant.can_operate,
        canEditModel: grant.can_edit_model,
      });
      setMessage(`${member.display_name ?? member.id} facility access updated`);
      await refresh();
    } catch (cause) { setError(String(cause)); }
  };
  const revoke = async (member: Member) => {
    try {
      await remove(`/api/admin/memberships/${encodeURIComponent(member.id)}`);
      setMessage(`${member.display_name ?? member.id} membership revoked`);
      await refresh();
    } catch (cause) { setError(String(cause)); }
  };
  return <Shell data={data}><PageHead eyebrow="ORGANIZATION / ACCESS ADMINISTRATION" title="People and facility permissions" detail="Organization roles and site grants take effect on the next authorized request. Every change is retained in administrative history."/>
    <section className="panel mb-4 p-5"><h2 className="font-semibold">Provision a member</h2><div className="mt-4 grid gap-3 md:grid-cols-5"><input className="input" placeholder="Clerk user ID" value={draft.userId} onChange={event=>setDraft({...draft,userId:event.target.value})}/><input className="input" placeholder="Display name" value={draft.displayName} onChange={event=>setDraft({...draft,displayName:event.target.value})}/><input className="input" placeholder="Email (optional)" value={draft.email} onChange={event=>setDraft({...draft,email:event.target.value})}/><select className="select" value={draft.role} onChange={event=>setDraft({...draft,role:event.target.value as Role})}>{ROLES.map(role=><option key={role}>{role}</option>)}</select><button className="button primary justify-center" disabled={!draft.userId} onClick={()=>saveMember(draft)}>Save membership</button></div>{data.me.is_owner&&<label className="mt-3 flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={draft.isAdmin} onChange={event=>setDraft({...draft,isAdmin:event.target.checked})}/>Grant organization administration</label>}{message&&<p role="status" className="mt-3 text-sm text-teal-300">{message}</p>}{error&&<p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}</section>
    <div className="grid gap-4 xl:grid-cols-[1fr_.7fr]"><section className="space-y-3">{members.map(member=><article key={member.id} className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><b>{member.display_name ?? member.id}</b>{member.is_owner&&<Status>OWNER</Status>}{member.is_admin&&!member.is_owner&&<Status>ADMIN</Status>}</div><p className="mt-1 text-xs text-slate-500">{member.email ?? member.id}</p></div><div className="flex gap-2"><select className="select" value={member.role} disabled={member.is_owner} onChange={event=>saveMember({userId:member.id,role:event.target.value as Role,isAdmin:member.is_admin})}>{ROLES.map(role=><option key={role}>{role}</option>)}</select>{!member.is_owner&&member.id!==data.me.id&&<button className="button secondary" aria-label={`Revoke ${member.display_name ?? member.id}`} onClick={()=>revoke(member)}><Trash2 size={14}/></button>}</div></div><div className="mt-4 space-y-2">{member.facilities.map(facility=><div key={facility.facility_id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 p-3"><span className="text-sm font-medium">{facility.facility_name}</span><div className="flex flex-wrap gap-4 text-xs text-slate-400">{([["View","can_view"],["Operate","can_operate"],["Edit model","can_edit_model"]] as const).map(([label,key])=><label key={key} className="flex items-center gap-2"><input type="checkbox" checked={facility[key]} disabled={key!=="can_view"&&!facility.can_view} onChange={event=>saveGrant(member,facility,{[key]:event.target.checked,...(key==="can_view"&&!event.target.checked?{can_operate:false,can_edit_model:false}:{})})}/>{label}</label>)}</div></div>)}</div></article>)}</section><aside className="panel overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Administrative history</h2><p className="mt-1 text-xs text-slate-500">Immutable role and facility changes</p></div>{audit.map(record=><div key={record.id} className="border-b border-slate-800 p-4"><Status>{record.action.replace(/_/g," ")}</Status><p className="mt-2 text-xs text-slate-400">{record.target_user_id ?? "Organization"}{record.facility_id ? ` · ${record.facility_id}` : ""}</p><p className="mt-1 text-[10px] text-slate-500">{new Date(record.created_at).toLocaleString()} · by {record.actor_user_id}</p></div>)}{!audit.length&&<p className="p-5 text-sm text-slate-500">No access changes recorded yet.</p>}</aside></div>
  </Shell>;
}

function LearningOutcomes({ data }: { data: SessionData }) {
  const [outcomes, setOutcomes] = useState<LearningOutcomesData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<LearningOutcomesData>("/api/learning/outcomes").then(setOutcomes).catch((cause) => setError(String(cause)));
  }, []);
  const eventCount = (name: string) => outcomes?.journeyEvents.find((item) => item.event_name === name)?.count ?? 0;
  return <Shell data={data}>
    <PageHead eyebrow="PRODUCT LEARNING / PERMISSION CONTROLLED" title="Core journey outcomes" detail="Sparse workflow outcomes for managers and administrators. No replay ticks, raw questions, operator notes, or individual feedback are exposed."/>
    {error && <p className="panel p-5 text-red-300" role="alert">{error}</p>}
    {!outcomes && !error && <p className="panel p-5 text-slate-500">Loading outcome summaries…</p>}
    {outcomes && <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Facility drilldowns" value={String(eventCount("FACILITY_DRILLDOWN"))} sub="authorized site opens"/>
        <Metric label="Incident reviews" value={String(eventCount("INCIDENT_REVIEWED"))} sub="persisted investigations"/>
        <Metric label="What-if uses" value={String(eventCount("WHAT_IF_USED"))} sub="same-input comparisons"/>
        <Metric label="Safety results" value={String(eventCount("SAFETY_RESULT"))} sub="server-verified outcomes"/>
        <Metric label="Decisions" value={String(eventCount("DECISION_RECORDED"))} sub="immutable dispositions"/>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="panel p-5"><div className="eyebrow">OPERATOR UNDERSTANDING</div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Sessions" value={String(outcomes.operatorSessions.total ?? 0)} sub="moderated tests"/><Metric label="Completed" value={String(outcomes.operatorSessions.completed ?? 0)} sub="thread understood"/><Metric label="Abandoned" value={String(outcomes.operatorSessions.abandoned ?? 0)} sub="ended early" warn={Boolean(outcomes.operatorSessions.abandoned)}/><Metric label="Avg. understanding" value={outcomes.operatorSessions.avg_time_to_understanding_s == null ? "—" : String(outcomes.operatorSessions.avg_time_to_understanding_s)} unit="s" sub={`avg. errors ${outcomes.operatorSessions.avg_error_count ?? 0}`}/></div></section>
        <section className="panel p-5"><div className="eyebrow">CONTEXTUAL FEEDBACK</div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Responses" value={String(outcomes.feedback.count)} sub="surface-linked"/><Metric label="Positive" value={String(outcomes.feedback.positive)} sub="helpful"/><Metric label="Neutral" value={String(outcomes.feedback.neutral)} sub="mixed"/><Metric label="Negative" value={String(outcomes.feedback.negative)} sub="friction" warn={Boolean(outcomes.feedback.negative)}/></div></section>
        <section className="panel p-5"><div className="eyebrow">SAFETY & DECISIONS</div><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-semibold">Safety outcomes</h2><div className="mt-2 space-y-2">{outcomes.safetyOutcomes.map((item) => <div key={item.outcome} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.outcome}</span><b>{item.count}</b></div>)}</div></div><div><h2 className="text-sm font-semibold">Decision outcomes</h2><div className="mt-2 space-y-2">{outcomes.decisionOutcomes.map((item) => <div key={item.outcome} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.outcome.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}</div></div></div></section>
        <section className="panel p-5"><div className="eyebrow">FRICTION & QUESTIONS</div><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-semibold">Classified errors</h2><div className="mt-2 space-y-2">{outcomes.errors.map((item) => <div key={item.category} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.category.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}{!outcomes.errors.length && <p className="text-xs text-slate-500">No classified errors.</p>}</div></div><div><h2 className="text-sm font-semibold">Common assistant topics</h2><div className="mt-2 space-y-2">{outcomes.commonAssistantTopics.map((item) => <div key={item.topic} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.topic.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}{!outcomes.commonAssistantTopics.length && <p className="text-xs text-slate-500">No assistant use recorded.</p>}</div></div></div></section>
      </div>
      <p className="mt-4 text-xs text-slate-500">Journey events and feedback expire after {outcomes.retention.eventsAndFeedbackDays} days; classified errors expire after {outcomes.retention.errorsDays} days.</p>
    </>}
  </Shell>;
}

const tutorialSteps: Record<Role, Array<{ title: string; body: string; route: string }>> = {
  PORTFOLIO_MANAGER: [{ title: "Portfolio health", body: "Start with site ranking and predicted risk before drilling into a facility.", route: "/portfolio" }, { title: "Facility outcomes", body: "Open a site to connect thermal headroom to operational decisions.", route: "/portfolio" }],
  OPERATOR: [{ title: "This is your facility", body: "Operations ties workload, power, heat, forecast, and cooling response to one clock.", route: "/operations" }, { title: "Read the forecast", body: "A forecast risk can arrive before a temperature limit is crossed.", route: "/incidents/inc-204" }, { title: "Trace dependencies", body: "Select a predicted risk and follow its thermal path.", route: "/topology" }, { title: "Use the Safety Shield", body: "Recommendations are advisory and require a server-verified safety pass.", route: "/recommendations/rec-17" }],
  ENGINEER: [{ title: "Start with the operating twin", body: "Use the replay clock to compare current and forecast physical state.", route: "/operations" }, { title: "Trace the heat path", body: "The graph exposes upstream workload and downstream cooling dependencies.", route: "/topology" }, { title: "Compare controllers", body: "Model Lab runs baseline and policy rows against identical events.", route: "/model-lab" }],
  MODEL_ADMIN: [{ title: "Model representation", body: "Model Studio controls the facility representation that Operations consumes.", route: "/model" }, { title: "Validate before publish", body: "Drafts must pass validation before becoming the published facility model.", route: "/model" }, { title: "Rollback safely", body: "Every version remains available for a deliberate rollback.", route: "/model" }],
  VIEWER: [{ title: "Read-only operations", body: "Explore the facility twin and forecast without sending commands.", route: "/operations" }, { title: "Historical context", body: "Audit records reconstruct the state behind an operator decision.", route: "/audit" }],
};
function Help({ data }: { data: SessionData }) {
  const facility = data.facilities[0], steps = tutorialSteps[data.me.role], [step, setStep] = useState(data.me.tutorial_step ?? 0), [done, setDone] = useState(data.me.tutorial_complete), [error, setError] = useState("");
  const update = async (next: number, complete = false) => { setStep(next); setDone(complete); try { await patch("/api/me/tutorial", { step: next, complete }); } catch (e) { setError(String(e)); } };
  const current = steps[Math.min(step, steps.length - 1)];
  const openTutorialRoute = () => {
    if (current.route === "/portfolio") navigate("/portfolio");
    else if (facility) navigate(`/facilities/${facility.id}${current.route}`);
  };
  return <Shell data={data}><PageHead eyebrow={`HELP / ${data.me.role.replace(/_/g, " ")}`} title="Operator guide" detail="A role-specific, restartable tutorial for the Wattr operating thread."/><div className="grid gap-4 lg:grid-cols-[1fr_.8fr]"><section className="panel p-6"><div className="flex items-center gap-3"><BookOpen className="text-cyan-300" aria-hidden="true"/><div><h2 className="font-semibold">{done ? "Tutorial complete" : "Welcome to Wattr"}</h2><p className="text-xs text-slate-500">Step {done ? steps.length : step + 1} of {steps.length}</p></div></div>{done ? <p className="copy">You can restart this guide any time. The cockpit always keeps human authority and synthetic provenance visible.</p> : <><div className="mt-8 rounded-md border border-cyan-400/30 bg-cyan-400/5 p-5"><div className="eyebrow">STEP {step + 1}</div><h3 className="mt-2 text-xl font-semibold">{current.title}</h3><p className="mt-3 text-sm leading-6 text-slate-400">{current.body}</p></div><div className="mt-5 flex flex-wrap gap-2"><button type="button" className="button secondary" disabled={step===0} onClick={() => update(Math.max(0, step - 1))}>Back</button><button type="button" className="button primary" onClick={() => update(step + 1 >= steps.length ? step : step + 1, step + 1 >= steps.length)}>Next <ArrowRight size={15}/></button><button type="button" className="button secondary" onClick={() => update(step, true)}>Skip tutorial</button><button type="button" className="button secondary" onClick={openTutorialRoute}>Open this workspace</button></div></>}{error&&<p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}</section><section className="panel p-6"><div className="eyebrow">ROLE LENS</div><h2 className="mt-2 text-xl font-semibold">{data.me.role.replace(/_/g, " ")}</h2><p className="copy">The same deterministic scenario is disclosed progressively: portfolio outcomes first, asset relationships next, and model-level details only when your role needs them.</p><button type="button" className="button secondary" onClick={() => update(0, false)}><RotateCcw size={15}/>Restart tutorial</button><div className="mt-6 border-t border-slate-800 pt-5"><ThemeControl/></div></section></div></Shell>;
}

function AssistantPage({ data, facility }: { data: SessionData; facility?: Facility }) {
  const simulatedAt = useScenarioSession((state) => state.simulatedAt);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<AssistantResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const suggestions = assistantSuggestions(data.me.role, facility?.name);
  const ask = async (value = question) => {
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    setQuestion(trimmed);
    setPending(true);
    setError("");
    try {
      const result = await post<AssistantResponse>("/api/assistant/query", {
        question: trimmed,
        ...(facility ? { facilityId: facility.id } : {}),
        simulatedAt,
      });
      setResponse(result);
    } catch (cause) {
      setError(String(cause));
      setResponse(null);
    } finally {
      setPending(false);
    }
  };
  const runAction = async (action: NonNullable<AssistantResponse["actions"]>[number]) => {
    if (!facility) return;
    try {
      const result = await post<{ path: string }>("/api/assistant/action", {
        action: action.id,
        facilityId: facility.id,
      });
      navigate(result.path);
    } catch (cause) {
      setError(String(cause));
    }
  };
  return <Shell data={data} facility={facility}>
    <PageHead
      eyebrow={`ASK WATTR / ${data.me.role.replace(/_/g, " ")}`}
      title="Authorized operating answers"
      detail={facility ? `${facility.name} · Ask about risk, causes, recommendations, and the published model.` : "Ask about your authorized portfolio and receive facility-ranked operating context."}
      action={<Status tone="warn">READ ONLY · HUMAN AUTHORITY</Status>}
    />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="panel overflow-hidden">
        <form className="border-b border-slate-800 p-5" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <label className="field m-0 block">
            <span>What would you like to know?</span>
            <textarea
              aria-label="Ask Wattr question"
              className="textarea mt-2 min-h-[100px] w-full"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={facility ? "e.g. What is the current risk and what assets are affected?" : "e.g. Which facilities need attention first?"}
              maxLength={2000}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-500">Answers use authorized structured data only. No live telemetry is implied.</span>
            <button className="button primary" type="submit" disabled={!question.trim() || pending}><BrainCircuit size={15}/>{pending ? "Reading canonical state…" : "Ask Wattr"}</button>
          </div>
        </form>
        {!response && !error && <div className="p-6"><div className="eyebrow">TRY A ROLE-AWARE QUESTION</div><div className="mt-3 grid gap-2">{suggestions.map((suggestion) => <button key={suggestion} type="button" className="w-full rounded-md border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-cyan-400/60" onClick={() => void ask(suggestion)}>{suggestion}<ArrowRight size={14} className="float-right mt-0.5 text-cyan-300"/></button>)}</div></div>}
        {error && <div className="p-6" role="alert"><p className="text-sm text-red-300">{error}</p><p className="mt-2 text-xs text-slate-500">No answer was shown because the authorized assistant request did not complete.</p></div>}
        {response && <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">{response.tool.replace(/_/g, " ")}</div><h2 className="mt-2 text-lg font-semibold">Grounded answer</h2></div><Status tone={response.tool === "refusal" ? "bad" : "good"}>{response.tool === "refusal" ? "LIMITED" : "AUTHORIZED"}</Status></div>
          <p className="mt-5 text-sm leading-7 text-slate-200">{response.answer}</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="subpanel"><span className="eyebrow">FACILITY</span><b>{response.context.facilityId ?? (response.citations.length ? `${response.citations.length} authorized sites` : "Unavailable")}</b></div>
            <div className="subpanel"><span className="eyebrow">SCENARIO TIME</span><b className={mono}>{response.context.simulatedAt ? formatSimulatedAt(response.context.simulatedAt) : "Unavailable"}</b></div>
            <div className="subpanel"><span className="eyebrow">MODEL VERSION</span><b className={mono}>{response.context.modelVersionId ?? (response.citations[0]?.modelVersionId ?? "Unavailable")}</b></div>
            <div className="subpanel"><span className="eyebrow">CONFIDENCE / QUALITY</span><b>{response.confidence === null ? "Unavailable" : `${Math.round(response.confidence * 100)}%`} · {response.context.quality}</b></div>
          </div>
          {response.limitations.length > 0 && <div className="mt-5 rounded-md border border-amber-400/30 bg-amber-400/5 p-4"><div className="eyebrow text-amber-300">LIMITATIONS</div><ul className="mt-2 space-y-1 text-xs leading-5 text-slate-400">{response.limitations.map((limitation) => <li key={limitation}>• {limitation}</li>)}</ul></div>}
          {response.actions.length > 0 && <div className="mt-5 flex flex-wrap gap-2"><span className="self-center text-xs text-slate-500">Authorized next step:</span>{response.actions.map((action) => <button type="button" key={action.id} className="button secondary" onClick={() => void runAction(action)}>{action.label}<ArrowRight size={14}/></button>)}</div>}
        </div>}
      </section>
      <aside className="space-y-4">
        <section className="panel p-5"><div className="eyebrow">EVIDENCE USED</div><p className="mt-2 text-xs leading-5 text-slate-500">Each answer exposes the structured records used to produce it. Expand a source to inspect the evidence values.</p><div className="mt-4 space-y-2">{response?.citations.map((citation) => <details key={citation.id} className="disclosure"><summary>{citation.label}<span className="ml-auto text-[10px] text-slate-500">{citation.quality}</span></summary><div className="space-y-2 text-[11px]"><p><b>Facility:</b> {citation.facilityId} · <b>Scenario:</b> {citation.scenarioId ?? "none"}</p><p><b>Time:</b> {citation.simulatedAt === null ? "unavailable" : formatSimulatedAt(citation.simulatedAt)}</p><p><b>Model:</b> {citation.modelVersionId}</p><p><b>Provenance:</b> {citation.provenance.kind} / {citation.provenance.syntheticStatus} · {citation.provenance.source}</p><pre className="overflow-x-auto rounded bg-black/20 p-2 text-[10px]">{JSON.stringify(citation.evidence, null, 2)}</pre></div></details>)}{response && !response.citations.length && <p className="text-xs text-slate-500">No evidence was returned because the requested data is unavailable or unauthorized.</p>}{!response && <p className="text-xs text-slate-500">Evidence will appear here after you ask a question.</p>}</div></section>
        <section className="panel p-5"><div className="eyebrow">BOUNDARY</div><p className="mt-3 text-xs leading-6 text-slate-400">Ask Wattr can read authorized portfolio, facility, incident, recommendation, audit, simulation, and model state. It cannot approve decisions, publish models, or issue operational technology commands.</p></section>
      </aside>
    </div>
  </Shell>;
}

function TutorialOverlay({ data, onProgress }: { data: SessionData; onProgress: (step: number, complete: boolean) => void }) {
  const steps = tutorialSteps[data.me.role];
  const [step, setStep] = useState(Math.min(data.me.tutorial_step ?? 0, steps.length - 1));
  const [open, setOpen] = useState(!data.me.tutorial_complete);
  const [error, setError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const current = steps[step];

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary")];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  const update = async (next: number, complete = false) => {
    setStep(Math.min(next, steps.length - 1));
    try {
      await patch("/api/me/tutorial", { step: next, complete });
      onProgress(next, complete);
      if (complete) setOpen(false);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  };
  const openWorkspace = () => {
    setOpen(false);
    if (current.route === "/portfolio") navigate("/portfolio");
    else if (data.facilities[0]) navigate(`/facilities/${data.facilities[0].id}${current.route}`);
  };
  if (!open) return null;
  return <div className="cockpit tutorial-backdrop" role="presentation">
    <section ref={dialogRef} className="tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" aria-describedby="tutorial-body">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3"><span className="tutorial-icon"><BookOpen size={18} aria-hidden="true"/></span><div><div className="eyebrow">WELCOME / {data.me.role.replace(/_/g, " ")}</div><h2 id="tutorial-title" className="mt-1 text-xl font-semibold">{current.title}</h2></div></div>
        <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Continue later" onClick={() => setOpen(false)}><X size={16} aria-hidden="true"/></button>
      </div>
      <div className="tutorial-progress" aria-label={`Tutorial step ${step + 1} of ${steps.length}`}>{steps.map((item, index) => <span key={item.title} className={index <= step ? "complete" : ""}/>)}</div>
      <p id="tutorial-body" className="mt-5 text-sm leading-6 text-slate-300">{current.body}</p>
      <p className="mt-3 text-xs text-slate-500">Step {step + 1} of {steps.length}. Your progress is saved after each step.</p>
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" className="button secondary" disabled={step === 0} onClick={() => update(step - 1)}>Back</button>
        <button type="button" className="button secondary" onClick={openWorkspace}>Open workspace</button>
        <button type="button" className="button primary" onClick={() => update(step + 1, step + 1 >= steps.length)}>{step + 1 >= steps.length ? "Finish tutorial" : "Next"} <ArrowRight size={15} aria-hidden="true"/></button>
      </div>
      <button type="button" className="tutorial-later" onClick={() => setOpen(false)}>Continue later</button>
    </section>
  </div>;
}

function Landing(){return <div className="min-h-screen bg-[#0a1018] text-slate-200"><header className="flex justify-between border-b border-slate-800 p-5"><Brand/><button onClick={()=>navigate("/sign-in")} className="button secondary">Operator sign in</button></header><main className="mx-auto max-w-6xl px-6 py-24"><div className="eyebrow text-cyan-400">THERMAL OPERATIONS / COMMAND ENVIRONMENT</div><h1 className="mt-5 max-w-4xl text-5xl font-semibold tracking-[-.04em] md:text-7xl">Make the cooling decision before the constraint arrives.</h1><p className="mt-7 max-w-2xl text-lg leading-8 text-slate-400">Wattr turns workload intent into power, heat, forecast risk, a safety-checked advisory, and an auditable operator decision.</p><div className="mt-9 flex gap-3"><button onClick={()=>navigate("/sign-in")} className="button primary">Enter cockpit <ArrowRight size={15}/></button><button onClick={()=>navigate("/demo/sandbox")} className="button secondary">Explore sandbox</button></div></main></div>}
function Auth({up=false}:{up?:boolean}){return <div className="grid min-h-screen place-items-center bg-[#0a1018] p-5"><div className="w-full max-w-[460px]"><Brand/><div className="mt-8">{up?<SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/portfolio"/>:<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/portfolio"/>}</div></div></div>}

function ProtectedRoutes({path, data}:{path:string; data: SessionData}){
  const defaultPath = data.me.default_path.replace("{facilityId}", data.facilities[0]?.id ?? "");
  useEffect(()=>{if(path==="/portfolio"&&data.me.role!=="PORTFOLIO_MANAGER"&&data.facilities[0])navigate(defaultPath)},[data.me.role,data.facilities,path,defaultPath]);
  if(path==="/admin"&&!data.me.is_admin)return <Shell data={data}><PageHead eyebrow="ACCESS" title="Workspace unavailable" detail="This workspace is not present in your authorized navigation."/></Shell>;
  if(path==="/admin")return <AccessAdministration data={data}/>;
  if(path==="/learning"&&data.me.role!=="PORTFOLIO_MANAGER"&&!data.me.is_admin)return <Shell data={data}><PageHead eyebrow="ACCESS" title="Learning outcomes unavailable" detail="Organization learning summaries require manager or administrator access."/></Shell>;
  if(path==="/learning")return <LearningOutcomes data={data}/>;
  if(path==="/portfolio"&&data.me.role!=="PORTFOLIO_MANAGER"&&data.facilities[0])return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-cyan-300">Opening your authorized workspace…</div>;
  if(path==="/portfolio")return <Portfolio data={data}/>;
  if(path==="/ask-wattr"&&data.me.role==="PORTFOLIO_MANAGER")return <AssistantPage data={data}/>;
  if(path==="/help")return <Help data={data}/>;
  const parts=path.split("/").filter(Boolean), facility=parts[0]==="facilities"&&data.facilities.find(f=>f.id===parts[1]);
  if(!facility)return <Shell data={data}><PageHead eyebrow="ACCESS" title="Facility unavailable" detail="This facility is not present in your authorized API response."/></Shell>;
  const section=parts[2];
  if(section==="operations")return <Operations data={data} facility={facility}/>;
  if(section==="incidents")return <IncidentPage data={data} facility={facility} incidentId={parts[3] ?? "inc-204"}/>;
  if(section==="recommendations")return <Recommendation data={data} facility={facility}/>;
  if(section==="audit")return <AuditPage data={data} facility={facility}/>;
  if(section==="ask-wattr"&&!facility.can_assistant)return <Shell data={data} facility={facility}><PageHead eyebrow="ACCESS" title="Ask Wattr unavailable" detail="Assistant access requires an authorized role and facility view grant."/></Shell>;
  if(section==="ask-wattr")return <AssistantPage data={data} facility={facility}/>;
  if(section==="topology"&&!["OPERATOR","ENGINEER"].includes(data.me.role))return <Shell data={data} facility={facility}><PageHead eyebrow="ACCESS" title="Workspace unavailable" detail="This analysis workspace is not present in your authorized navigation."/></Shell>;
  if(section==="topology")return <GraphPage data={data} facility={facility}/>;
  if(section==="model-lab"&&!facility.can_engineer)return <Shell data={data} facility={facility}><PageHead eyebrow="ACCESS" title="Workspace unavailable" detail="Engineering analysis access is required."/></Shell>;
  if(section==="model-lab")return <ModelLab data={data} facility={facility}/>;
  if(section==="model"&&!facility.can_edit_model)return <Shell data={data} facility={facility}><PageHead eyebrow="FORBIDDEN" title="Model Studio access required" detail="Your role cannot edit or publish facility models."/></Shell>;
  if(section==="model")return <ModelStudio data={data} facility={facility}/>;
  return <Shell data={data} facility={facility}><PageHead eyebrow="ACCESS" title="Workspace unavailable" detail="Choose an operating workspace from the facility navigation."/></Shell>;
}
function ProtectedApp({path}:{path:string}){
  const [data,setData]=useState<SessionData|null>(null),[error,setError]=useState("");
  useEffect(()=>{Promise.all([api<Me>("/api/me"),api<Facility[]>("/api/facilities")]).then(([me,facilities])=>{if(facilities[0]?.model_config)useScenarioSession.getState().setModelConfig(facilities[0].model_config);setData({me,facilities});}).catch(e=>setError(String(e)));},[]);
  if(error)return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-red-300">{error}</div>;
  if(!data)return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-cyan-300">Loading authorized facility context…</div>;
  return <ThemeProvider initialTheme={data.me.theme}><TutorialOverlay data={data} onProgress={(step, complete) => setData(current => current ? ({ ...current, me: { ...current.me, tutorial_step: step, tutorial_complete: complete } }) : current)}/><ProtectedRoutes path={path} data={data}/></ThemeProvider>;
}
export function CockpitApp(){
  const [path,setPath]=useState(location.pathname),{isSignedIn}=useUser();
  const testSignedIn = Boolean(e2eTestUserId());
  useScenarioClock();
  useEffect(()=>{const on=()=>setPath(location.pathname);addEventListener("popstate",on);return()=>removeEventListener("popstate",on)},[]);
  useEffect(()=>{if(path==="/"&&(isSignedIn||testSignedIn))navigate("/portfolio")},[path,isSignedIn,testSignedIn]);
  if(path==="/demo/sandbox")return <SandboxShell/>; if(path.startsWith("/sign-in"))return <Auth/>; if(path.startsWith("/sign-up"))return <Auth up/>; if(path==="/")return <Landing/>;
  if(testSignedIn)return <ProtectedApp path={path}/>;
  return <><Show when="signed-in"><ProtectedApp path={path}/></Show><Show when="signed-out"><div className="grid min-h-screen place-items-center bg-[#0a1018]"><button onClick={()=>navigate("/sign-in")} className="button primary">Sign in for authorized access</button></div></Show></>;
}