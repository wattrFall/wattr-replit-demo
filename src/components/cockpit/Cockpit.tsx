import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Show, SignIn, SignUp, useUser } from "@clerk/react";
import {
  Activity, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowDownUp, BookOpen, Boxes, BrainCircuit, Check, ChevronDown, Layers,
  CircleHelp, Clock3, Cpu, Gauge, GitBranch, History, LayoutDashboard, Layers3, Menu, MousePointer2,
  Pause, Play, RotateCcw, Search, Save, ShieldCheck, SkipForward, SlidersHorizontal, Sun, Moon, Monitor, Thermometer, Trash2, UserCog, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { FacilityTwin } from "@/components/twin/FacilityTwin";
import type { TwinOverlay, TwinView } from "@/components/twin/types";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { replayCockpitSnapshot, SCENARIO_DURATION_S, snapshotForAudit, type CockpitSnapshot, type FacilityModelConfig } from "@/lib/cockpit/simulation";
import { compareControllers, graphSelection, thermalGraph, type GraphView, type ControllerComparison } from "@/lib/cockpit/workspaces";
import { canViewTopology, ROLES, type Role } from "@/lib/security/rolePolicy";
import { incidentStateAt, selectIncident, type IncidentReplayState } from "@/lib/cockpit/incidents";
import { assistantSuggestions, type AssistantResponse } from "@/lib/cockpit/assistant";
import { learningSurfaceForPath, recordLearningEvent, reportLearningError } from "@/lib/cockpit/learning";
import { GuidanceProvider, useGuidance } from "./Guidance";
import { FacilityBuilder } from "@/components/builder/FacilityBuilder";
import { facilityAssets } from "@/lib/cockpit/facilityAssets";
import { facilityPlant } from "@/lib/cockpit/simulation";
import { ApiError, describeError, navigate, e2eTestUserId, FACILITIES_CHANGED, SESSION_CHANGED, api, post, patch, remove } from "./api";
import { CLERK_LIGHT_APPEARANCE, Landing, PublicFrame, StateScreen } from "./PublicScreens";
import { Recommendation } from "./RecommendationPage";
import { ThermalGraphPage } from "./ThermalGraphPage";
import { FacilityIntelligencePage } from "@/components/intelligence/FacilityIntelligencePage";
import { FacilityHistoryPage } from "@/components/replay/HistoryPage";
import { ScenarioReplayPage } from "@/components/replay/ReplayPage";
import { FacilityImportPage } from "@/components/imports/FacilityImportPage";
import { ReplayBar, ROLE_LABELS, Shell } from "./Shell";
import type { Me, Facility, Audit, Incident, ModelVersion, MemberFacility, Member, SessionData, LearningOutcomesData } from "./types";
import { mono, ThemeProvider, ContextualHelp, ThemeControl, Brand, Status, Metric, MetricStrip, PageHead, Segmented, sentenceCase } from "./ui";
import { Floating, useDismiss } from "./Floating";
import { showsLightTheme } from "./ui";

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
    <PageHead eyebrow={`Facility health / ${data.facilities.length} authorized`} title="Portfolio" detail="Ranked operating context from your authorized sites." action={<Status>{formatSimulatedAt(simulatedAt).slice(0, 16)} UTC</Status>}/>
    <MetricStrip label="Portfolio figures">
      <Metric label="Sites monitored" value={String(rows.length).padStart(2, "0")} sub="permission-filtered"/>
      <Metric label="Fleet headroom" value={fleet.headroom.toLocaleString()} unit="kW" sub="rated capacity less IT load"/>
      <Metric label="Open incidents" value={String(fleet.incidents).padStart(2, "0")} sub={fleet.incidents ? "requires review" : "no active forecast"} warn={fleet.incidents > 0}/>
      <Metric label="Fleet PUE" value={fleet.itPower ? (fleet.totalPower / fleet.itPower).toFixed(3) : "—"} sub="aggregate total ÷ aggregate IT"/>
    </MetricStrip>
    <section className="panel mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 p-4">
        <div className="relative min-w-[220px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true"/><input aria-label="Search authorized facilities" className="input w-full pl-9" placeholder="Search sites or locations" value={query} onChange={(event) => setQuery(event.target.value)}/></div>
        <Segmented label="Facility status filter" value={filter} onChange={setFilter} options={(["all", "attention", "nominal", "recommendation"] as PortfolioFilter[]).map((item) => ({ value: item, label: item === "all" ? "All sites" : item === "attention" ? "Needs attention" : item === "recommendation" ? "Advisory ready" : "Nominal" }))}/>
        <label className="flex items-center gap-2 text-xs text-slate-500">Rank by <select aria-label="Rank facilities by" className="select" value={sort} onChange={(event) => setSort(event.target.value as PortfolioSort)}><option value="attention">Attention</option><option value="risk">Forecast risk</option><option value="power">IT power</option><option value="cooling">Cooling load</option><option value="efficiency">PUE efficiency</option><option value="recommendation">Recommendation status</option></select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#0d1722] px-4 py-3 text-xs text-slate-400"><span><b className="text-slate-200">{filtered.length}</b> of {rows.length} authorized sites shown</span><span className="flex items-center gap-2"><Layers3 size={14} className="text-slate-500" aria-hidden="true"/>Compare up to 3 sites</span></div>
      <div className="hidden overflow-x-auto md:block"><table className="data-table min-w-[980px]"><caption className="sr-only">Authorized facility ranking</caption><thead><tr><th>Compare</th><th>Facility</th><th><ArrowDownUp size={12} className="inline"/> Health</th><th>IT power</th><th>Peak inlet</th><th>Cooling</th><th>PUE</th><th>Recommendation</th><th>Model</th><th/></tr></thead><tbody>{filtered.map(({ facility, snapshot }) => <tr key={facility.id} className="hover:bg-slate-800/30"><td><input aria-label={`Compare ${facility.name}`} type="checkbox" checked={compareIds.includes(facility.id)} onChange={() => toggleCompare(facility.id)} disabled={!compareIds.includes(facility.id) && compareIds.length >= 3}/></td><td><b>{facility.name}</b><small className="mt-1 block text-slate-500">{facility.location} · {facility.id}</small></td><td><Status tone={snapshot.forecast.risk === "critical" ? "bad" : snapshot.incident.open ? "warn" : "good"}>{snapshot.forecast.risk === "clear" ? "Nominal" : snapshot.forecast.risk}</Status><small className="mt-1 block text-slate-500">{snapshot.forecast.baselinePeakC.toFixed(1)}°C forecast</small></td><td>{snapshot.itPowerKw.toLocaleString()} kW</td><td className={snapshot.peakInletC >= snapshot.incident.limitC ? "text-amber-300" : ""}>{snapshot.peakInletC.toFixed(1)}°C</td><td>{snapshot.fanPercent.toFixed(0)}%</td><td>{snapshot.pue.toFixed(3)}</td><td><Status tone={facility.recommendation_status === "PROPOSED" ? "warn" : "good"}>{facility.recommendation_status}</Status></td><td><span className={`${mono} text-xs text-slate-500`}>{facility.model_version}</span></td><td><button className="button secondary" onClick={() => openFacility(facility)}>Open <ArrowRight size={14}/></button></td></tr>)}</tbody></table></div>
      <div className="space-y-2 p-3 md:hidden">{filtered.map(({ facility, snapshot }) => <article key={facility.id} className="rounded-md border border-slate-800 p-4"><div className="flex items-start justify-between gap-3"><div><b>{facility.name}</b><p className="mt-1 text-xs text-slate-500">{facility.location}</p></div><Status tone={snapshot.incident.open ? "warn" : "good"}>{snapshot.incident.open ? "Attention" : "Nominal"}</Status></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><span className="text-slate-500">Peak <b className="ml-1 text-slate-200">{snapshot.peakInletC.toFixed(1)}°C</b></span><span className="text-slate-500">PUE <b className="ml-1 text-slate-200">{snapshot.pue.toFixed(3)}</b></span><span className="text-slate-500">Power <b className="ml-1 text-slate-200">{snapshot.itPowerKw.toLocaleString()} kW</b></span><span className="text-slate-500">Cooling <b className="ml-1 text-slate-200">{snapshot.fanPercent.toFixed(0)}%</b></span><span className="col-span-2 text-slate-500">Recommendation <b className="ml-1 text-slate-200">{facility.recommendation_status}</b></span></div><div className="mt-4 flex items-center justify-between"><label className="text-xs text-slate-500"><input type="checkbox" checked={compareIds.includes(facility.id)} onChange={() => toggleCompare(facility.id)} className="mr-2"/>Compare</label><button className="button secondary" onClick={() => openFacility(facility)}>Open <ArrowRight size={14}/></button></div></article>)}</div>
      {!filtered.length && <p className="p-8 text-center text-sm text-slate-500">No authorized facilities match those filters.</p>}
    </section>
    {compared.length > 0 && <section className="panel mt-4 overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4"><div><div className="eyebrow">Side-by-side review</div><h2 className="mt-1 font-semibold">{compared.length} selected {compared.length === 1 ? "site" : "sites"}</h2></div><button className="button secondary" onClick={() => setCompareIds([])}>Clear comparison</button></div><div className="grid gap-3 p-4 md:grid-cols-3">{compared.map(({ facility, snapshot }) => <div key={facility.id} className="rounded-md border border-slate-800 p-4"><div className="flex items-center justify-between"><b>{facility.name}</b><Status tone={snapshot.incident.open ? "warn" : "good"}>{snapshot.incident.open ? "Watch" : "Nominal"}</Status></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><Metric label="Risk" value={snapshot.forecast.baselinePeakC.toFixed(1)} unit="°C" sub={`${snapshot.forecast.horizonS / 60}m forecast`}/><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub="current load"/><Metric label="Cooling" value={snapshot.fanPercent.toFixed(0)} unit="%" sub="fan / pump command"/><Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="physical balance"/></div><p className="mt-3 text-xs text-slate-500">Recommendation <b className="ml-1 text-slate-200">{facility.recommendation_status}</b></p></div>)}</div></section>}
  </Shell>;
}
function useScenarioClock() {
  const playing = useScenarioSession((s) => s.playing), speed = useScenarioSession((s) => s.speed);
  useEffect(() => { if (!playing) return; const timer = window.setInterval(() => { const state = useScenarioSession.getState(); state.advance(state.speed); }, 1000); return () => clearInterval(timer); }, [playing, speed]);
}
function LegacyOperations({ data, facility }: { data: SessionData; facility: Facility }) {
  const s = useScenarioSession(), snapshot = s.simulation.snapshot;
  return <Shell data={data} facility={facility}><PageHead eyebrow={`Facility / ${facility.id.toUpperCase()} / Operations`} title={facility.name} detail={`${facility.location} · deterministic GPU Training Ramp · ${facility.provenance}`}/><ReplayBar/><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}%`}/><Metric label="Total facility" value={snapshot.totalPowerKw.toLocaleString()} unit="kW" sub="physical power balance"/><Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn={snapshot.peakInletC >= snapshot.incident.limitC}/><Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="physical simulation"/><Metric label="Headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub="rated capacity"/></div><div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_.8fr]"><section className="panel min-h-[430px] overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Synchronized facility twin</h2><p className="text-xs text-slate-500">Workload → power → heat → CDU-03 response · {snapshot.coolingUnitCount} cooling unit</p></div><div className="twin-canvas"><div className="twin-grid"/><div className="twin-core"><Cpu size={28}/><b>GPU HALL</b><small>CLUSTER B · {snapshot.itPowerKw.toLocaleString()} kW</small></div>{snapshot.racks.map((rack,i)=><button key={rack.id} aria-label={`Inspect rack ${rack.id}`} onClick={() => navigate(`/facilities/${facility.id}/incidents/inc-204`)} className={`rack rack-${i} ${rack.atRisk?"hot":""}`}><span>{rack.id}</span><i style={{height:`${Math.min(100, Math.max(20, ((rack.inletC - 20) / (rack.limitC - 20)) * 100))}%`}}/></button>)}</div></section><aside className="space-y-4"><section className="panel p-5"><div className="eyebrow">Forecast risk</div><h2 className={`mt-2 text-xl font-semibold ${snapshot.forecast.risk === "clear" ? "text-teal-300" : "text-amber-300"}`}>{snapshot.forecast.risk === "clear" ? "Clear condition" : snapshot.incident.open ? `${snapshot.incident.severity} condition` : "Approaching limit"}</h2><p className="mt-4 text-sm leading-6 text-slate-400">{snapshot.incident.rackId} forecast peak {snapshot.forecast.baselinePeakC.toFixed(1)}°C in the next {Math.round(snapshot.forecast.horizonS / 60)} minutes against a {snapshot.incident.limitC.toFixed(1)}°C limit.</p><button onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="button primary mt-4 w-full justify-center">Review advisory <ArrowRight size={15}/></button></section><section className="panel p-5"><div className="eyebrow">Operating mode</div><select aria-label="Operating mode" value={s.mode} onChange={e=>s.setMode(e.target.value as typeof s.mode)} className="select mt-4 w-full"><option>Observe</option><option>Shadow</option><option>Advisory</option></select><p className="mt-3 text-xs leading-5 text-slate-500">Human approval is always required. No OT commands are issued.</p></section></aside></div></Shell>;
}

function Transparency({ facility, snapshot }: { facility: Facility; snapshot: CockpitSnapshot }) {
  return <details className="rail-disclosure">
    <summary><span>Data transparency</span><Status>SYNTHETIC / GOOD</Status></summary>
    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      <div><span className="text-slate-500">Provenance</span><b className="mt-1 block">Deterministic simulation</b></div>
      <div><span className="text-slate-500">Model version</span><b className={`${mono} mt-1 block`}>{facility.model_version}</b></div>
      <div><span className="text-slate-500">Freshness</span><b className="mt-1 block">{formatSimulatedAt(snapshot.simulatedAt)}</b></div>
      <div><span className="text-slate-500">Confidence domain</span><b className="mt-1 block">≤ {snapshot.plant.modelDomainMaxC.toFixed(0)}°C</b></div>
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500"><b>Provenance</b> tells you where a value came from; here every value comes from a deterministic simulation, not a live sensor. Outside the <b>confidence domain</b>, treat forecasts as unsupported. <b>Decision authority</b> stays with the operator: Wattr records advisory decisions but sends no equipment command.</p>
  </details>;
}

const LAYERS: ReadonlyArray<readonly [TwinOverlay, string]> = [
  ["heat", "Heat map"], ["flow", "Flow paths"], ["sensors", "Sensors"], ["labels", "Labels"], ["incidents", "Incidents"], ["forecast", "Forecast"],
];

/** What the twin draws, one click away in its toolbar rather than a row of checkboxes above it. */
function LayersMenu({ overlays, onToggle }: { overlays: TwinOverlay[]; onToggle: (overlay: TwinOverlay) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useDismiss(open, () => setOpen(false), triggerRef, panelRef);
  return <>
    <button ref={triggerRef} type="button" className="toolbar-button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      <Layers size={13} aria-hidden="true"/>Layers<span className="toolbar-count">{overlays.length}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    <Floating open={open} anchorRef={triggerRef} floatingRef={panelRef} align="start" id={panelId} role="dialog" aria-label="Twin layers" className="menu-panel">
      {LAYERS.map(([overlay, label]) => <label key={overlay} className="menu-check"><input type="checkbox" checked={overlays.includes(overlay)} onChange={() => onToggle(overlay)}/>{label}</label>)}
    </Floating>
  </>;
}

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
      setMessage(`Session could not start. ${describeError(cause)}`);
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
      setMessage(`Session outcome was not saved. ${describeError(cause)}`);
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
  const guidance = useGuidance();
  const s = useScenarioSession();
  const snapshot = useMemo(() => replayCockpitSnapshot(s.simulatedAt, facility.model_config), [s.simulatedAt, facility.id, facility.model_version]);
  const [view, setView] = useState<TwinView>("physical");
  const selectedAsset = s.selectedAssetId;
  const setSelectedAsset = s.selectAsset;
  const [overlays, setOverlays] = useState<TwinOverlay[]>(["heat", "flow", "sensors", "labels", "incidents", "forecast"]);
  useEffect(() => { useScenarioSession.getState().setModelConfig(facility.model_config); }, [facility.id, facility.model_version]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const assetId = params.get("assetId");
    const at = params.get("at");
    if (assetId || at) useScenarioSession.getState().focusTwin({
      assetId: assetId || undefined,
      simulatedAt: at && Number.isFinite(Number(at)) ? Number(at) : undefined,
    });
  }, [facility.id]);
  const selectedRack = snapshot.racks.find((rack) => rack.id === selectedAsset);
  const assets = facilityAssets(facility.model_config);
  const selectedEquipment = assets.byId.get(selectedAsset);
  const selectedLabel = selectedRack ? `Rack ${selectedRack.id}` : selectedEquipment && selectedEquipment.kind !== "workload" ? selectedEquipment.label : selectedAsset.startsWith("pdu-") ? selectedAsset.toUpperCase() : selectedAsset.startsWith("rack-f2-") ? `Floor 2 rack ${selectedAsset.slice(-1).toUpperCase()}` : assets.workload.label;
  const toggleOverlay = (overlay: TwinOverlay) => setOverlays((items) => items.includes(overlay) ? items.filter((item) => item !== overlay) : [...items, overlay]);
  const riskTone = snapshot.forecast.risk === "critical" ? "bad" : snapshot.forecast.risk === "watch" || snapshot.incident.open ? "warn" : "good";
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow={`Facility / ${facility.id.toUpperCase()} / Operations`} title={facility.name} detail={`${facility.location} · deterministic GPU Training Ramp · ${facility.provenance}`} action={<Status tone="warn">REPLAY-CONTROLLED</Status>}/>
    <ReplayBar/>
    {data.me.role === "OPERATOR" && <OperatorTestSession facility={facility} elapsedS={snapshot.elapsedS}/>}
    <MetricStrip label="Facility figures">
      <Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}%`} onClick={() => navigate(`/facilities/${facility.id}/intelligence?view=power&metric=rack_power_kw&at=${snapshot.simulatedAt}`)} help="The modeled electrical load used by computing equipment. It is the main heat input to this scenario."/>
      <Metric label="Total facility" value={snapshot.totalPowerKw.toLocaleString()} unit="kW" sub="physical power balance" help="IT power plus modeled cooling and facility overhead at this replay instant."/>
      <Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn={snapshot.peakInletC >= snapshot.incident.limitC} onClick={() => navigate(`/facilities/${facility.id}/intelligence?view=telemetry&metric=rack_inlet_temperature_c&at=${snapshot.simulatedAt}`)} help="The warmest modeled rack inlet. A forecast may raise attention before this current value reaches its limit."/>
      <Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="total ÷ IT power" help="Power usage effectiveness: total facility power divided by IT power. Lower is more efficient, but this synthetic value is not a measured savings claim."/>
      <Metric label="Headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub={`of ${snapshot.plant.ratedCapacityKw.toLocaleString()} kW rated`} help="Remaining modeled electrical capacity before the facility rating is reached."/>
    </MetricStrip>
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(300px,.72fr)]">
      <section className="panel min-w-0 overflow-hidden" aria-labelledby="twin-heading">
        <h2 id="twin-heading" className="sr-only">Facility twin</h2>
        <FacilityTwin model={facility.model_config} modelVersion={facility.model_version} snapshot={snapshot} selectedId={selectedAsset} selectedFloor={s.selectedFloor} highlightedPath={s.highlightedPath} onSelect={setSelectedAsset} view={view} overlays={overlays} canEdit={facility.can_edit_model} onGuideAction={guidance.emit}
          toolbarStart={<Segmented label="Twin view" guide="view" value={view} onChange={(item) => { setView(item); if (item === "thermal") guidance.emit("thermal-view"); }} options={[{ value: "physical" as TwinView, label: "Physical" }, { value: "thermal" as TwinView, label: "Thermal overlay" }]}/>}
          toolbarEnd={<LayersMenu overlays={overlays} onToggle={toggleOverlay}/>}
          help={<p><b>Physical</b> emphasizes equipment; <b>Thermal overlay</b> colours modeled inlet temperatures to reveal hot spots, not measured telemetry. <b>Layers</b> choose what the scene draws.</p>}
        />
        <div className="border-t border-slate-800 px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="eyebrow">Replay timeline · every panel reads the same clock</div><span className={`${mono} text-xs text-slate-400`}>{Math.round(snapshot.elapsedS / 60)}m / 30m</span></div><div className="timeline mt-3"><div className="timeline-axis"/>{[0, 300, 900, 1800].map((at) => <button key={at} className={`timeline-event ${Math.abs(snapshot.elapsedS - at) < 30 ? "current" : ""}`} onClick={() => s.jump(at)}><span className={`dot ${at >= 900 ? "amber" : ""}`}/><small>{at / 60}m</small><b>{at === 0 ? "Baseline" : at === 900 ? "Forecast" : at === 1800 ? "Ramp end" : "Power rise"}</b></button>)}</div></div>
      </section>
      <aside className="panel rail min-w-0" aria-label="Asset and forecast">
        {(s.focusedIncidentId || s.focusedRecommendationId) && <section className="rail-section" aria-label="Assistant twin focus"><div className="eyebrow text-purple-300">Ask Wattr focus</div><div className="mt-2 flex flex-wrap items-center gap-2"><Status tone={s.focusedIncidentId ? "warn" : "good"}>{s.focusedIncidentId ? `Incident ${s.focusedIncidentId}` : `Recommendation ${s.focusedRecommendationId}`}</Status><span className="text-xs text-slate-400">{s.highlightedPath.length ? s.highlightedPath.join(" → ") : `${selectedLabel} at the cited scenario time`}</span></div></section>}
        <section className="rail-section"><div className="flex items-center justify-between gap-2"><div className="eyebrow">Contextual HUD</div><ContextualHelp title="Why select an asset?"><p>Selection adds local state and dependencies without replacing the facility-wide summary. Use it when a site-level signal needs asset context.</p></ContextualHelp></div><h2 className="mt-2 text-xl font-semibold">{selectedLabel}</h2>{selectedRack ? <><p className="mt-2 text-sm text-slate-400">Current rack state at this replay instant.</p><div className="mt-4 grid grid-cols-2 gap-4"><Metric label="Inlet" value={selectedRack.inletC.toFixed(1)} unit="°C" sub={`limit ${selectedRack.limitC.toFixed(1)}°C`} warn={selectedRack.atRisk}/><Metric label="Heat" value={selectedRack.heatKw.toLocaleString()} unit="kW" sub="estimated IT heat"/></div>{selectedRack.atRisk && <button className="button secondary mt-4 w-full justify-center" onClick={() => navigate(`/facilities/${facility.id}/incidents/inc-204`)}>Inspect incident <ArrowRight size={14}/></button>}</> : <p className="mt-2 text-sm leading-6 text-slate-400">{selectedEquipment?.kind === "cooling" ? `${selectedEquipment.item?.kind === "crac" ? "Cooling air" : "Cooling distribution"} is at ${snapshot.fanPercent.toFixed(0)}% command with ${snapshot.coolingUnitCount} unit${snapshot.coolingUnitCount === 1 ? "" : "s"} online.` : selectedEquipment?.kind === "chiller" ? `Chilled water supply is ${snapshot.chilledWaterC.toFixed(1)}°C.` : selectedAsset.startsWith("pdu-") ? "Power distribution asset in the authorized facility topology. Facility power context remains synchronized to the replay clock." : selectedAsset.startsWith("sensor-") ? `Environmental sensor marker. Facility mean inlet is ${snapshot.meanInletC.toFixed(1)}°C at this replay instant.` : selectedAsset.startsWith("rack-f2-") ? "Floor 2 modeled compute asset. This floor has no rack-level telemetry in the canonical training scenario." : `Cluster workload is ${snapshot.workloadPercent}% with ${snapshot.rackCount} racks online.`}</p>}<button type="button" className="text-link mt-3" onClick={() => navigate(`/facilities/${facility.id}/intelligence?view=telemetry&assetId=${encodeURIComponent(selectedEquipment?.item?.id ?? selectedAsset)}&at=${snapshot.simulatedAt}`)}>Inspect asset <ArrowRight size={14} aria-hidden="true"/></button></section>
        <section className="rail-section"><div className="flex items-center justify-between gap-2"><div className="eyebrow">Forecast risk</div><ContextualHelp title="How to read this forecast"><p>The forecast extends the current replay state through the disclosed horizon. Risk describes whether modeled temperature approaches or crosses the limit; it is not a live alarm or certainty statement.</p></ContextualHelp></div><div className="mt-2 flex items-center justify-between gap-3"><h2 className={`text-xl font-semibold ${riskTone === "good" ? "text-teal-300" : riskTone === "bad" ? "text-red-300" : "text-amber-300"}`}>{snapshot.forecast.risk === "clear" ? "Clear condition" : snapshot.incident.open ? `${snapshot.incident.severity} condition` : "Approaching limit"}</h2><Status tone={riskTone}>{snapshot.forecast.risk}</Status></div><p className="mt-3 text-sm leading-6 text-slate-400">{snapshot.incident.rackId} forecast peak {snapshot.forecast.baselinePeakC.toFixed(1)}°C in the next {Math.round(snapshot.forecast.horizonS / 60)} minutes against a {snapshot.incident.limitC.toFixed(1)}°C limit.</p><button onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="button primary mt-4 w-full justify-center">Review advisory <ArrowRight size={15}/></button></section>
        <section className="rail-section"><Transparency facility={facility} snapshot={snapshot}/></section>
      </aside>
    </div>
  </Shell>;
}

function IncidentPage({ data, facility, incidentId }: { data: SessionData; facility: Facility; incidentId?: string }) {
  const guidance = useGuidance();
  const snapshot = useScenarioSession((s) => s.simulation.snapshot);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [reconstructed, setReconstructed] = useState<CockpitSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    setReconstructed(null);
    api<Incident[]>(`/api/facilities/${facility.id}/incidents`).then((items) => {
      if (cancelled) return;
      setIncidents(items);
      setLoaded(true);
      const { incident: item } = selectIncident(items, incidentId);
      if (!item) return;
      setSelected(item);
      return api<{ incident: Incident; snapshot: CockpitSnapshot }>(`/api/facilities/${facility.id}/incidents/${item.id}`)
        .then((result) => { if (!cancelled) setReconstructed(result.snapshot); });
    }).catch((e) => { if (!cancelled) setError(describeError(e)); });
    return () => { cancelled = true; };
  }, [facility.id, incidentId]);
  // An unknown incident id shows a not-found state rather than another incident.
  const notFound = loaded && !selected && selectIncident(incidents, incidentId).notFound;
  const incident = selected;
  const reconstruct = async (item: Incident) => { setSelected(item); try { const result = await api<{ incident: Incident; snapshot: CockpitSnapshot }>(`/api/facilities/${facility.id}/incidents/${item.id}`); setReconstructed(result.snapshot); guidance.emit("incident-review"); } catch (e) { setError(describeError(e)); } };
  const current = reconstructed ?? snapshot;
  // Status follows the replay clock, matching Portfolio, Operations and Ask Wattr.
  const stateTone = (state: IncidentReplayState): "good" | "warn" | "bad" => state.status === "CLEAR" ? "good" : state.severity === "HIGH" ? "bad" : "warn";
  const stateLabel = (state: IncidentReplayState) => state.status === "CLEAR" ? "CLEAR" : `OPEN · ${state.severity}`;
  const incidentState = incident ? incidentStateAt(incident, snapshot) : null;
  const replayTime = formatSimulatedAt(snapshot.simulatedAt).slice(11);
  return <Shell data={data} facility={facility}><PageHead eyebrow="Incidents / correlated events" title="Incidents" detail="Incident status follows the replay clock. Each record keeps the scenario time it was raised, so you can reconstruct what was known."/>
    <div className="grid gap-4 xl:grid-cols-[300px_1fr]">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-800 p-4"><h2 className="font-semibold">Scenario incidents</h2><p className="mt-1 text-xs text-slate-500">Status at {replayTime}</p></div>
        {incidents.map((item) => {
          const state = incidentStateAt(item, snapshot);
          return <button key={item.id} onClick={() => reconstruct(item)} className={`w-full border-b border-slate-800 p-4 text-left ${incident?.id === item.id ? "bg-slate-800/60" : ""}`}><div className="flex justify-between gap-2"><b>{item.id}</b><Status tone={stateTone(state)}>{stateLabel(state)}</Status></div><p className="mt-2 text-xs text-slate-400">{item.title}</p><p className="mt-2 text-xs text-slate-500">{item.raw_signal_count} raw signals · {item.forecast_minutes}m forecast</p></button>;
        })}
        {loaded && !incidents.length && !error && <p className="p-4 text-sm text-slate-500">No incidents have been recorded for this facility.</p>}
        {error && <p role="alert" className="p-4 text-sm text-red-300">{error}</p>}
      </section>
      <section className="space-y-4">
        {notFound ? <section className="panel p-6" aria-labelledby="incident-not-found">
          <Status tone="warn">NOT FOUND</Status>
          <h2 id="incident-not-found" className="mt-3 text-xl font-semibold">Incident {incidentId} was not found</h2>
          <p className="copy">This facility has no incident with that ID, so nothing is shown in its place. The link may be out of date. Choose an incident from the list{incidents[0] ? ", or open the most recent one" : ""}.</p>
          {incidents[0] && <button className="button primary mt-4" onClick={() => navigate(`/facilities/${facility.id}/incidents/${incidents[0].id}`)}>Open {incidents[0].id} <ArrowRight size={15}/></button>}
        </section> : incident && incidentState ? <><section className="panel p-6"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><Status tone={stateTone(incidentState)}>{stateLabel(incidentState)}</Status><h2 className="mt-3 text-xl font-semibold">{incident.id} · {incident.title}</h2><p className="mt-2 text-sm text-slate-400">Raised at {formatSimulatedAt(incidentState.recordedAt)} in the GPU Training Ramp. Status shown for replay time {replayTime}.</p></div><AlertTriangle className="shrink-0 text-amber-300" aria-hidden="true"/></div><div className="mt-6 grid gap-3 sm:grid-cols-3"><Metric label="Affected" value={incident.affected_assets[0]} sub={incident.affected_assets.slice(1).join(" · ")}/><Metric label="Forecast impact" value={String(incident.forecast_minutes)} unit="min" sub="to thermal margin breach" warn/><Metric label="Correlated signals" value={String(incident.raw_signal_count)} sub="deduplicated into one incident"/></div><p className="copy">Likely cause: {incident.likely_cause}. The server replay below is reconstructed at the incident timestamp, not the current clock.</p><div className="mt-5 grid gap-3 md:grid-cols-2"><div className="subpanel"><span className="eyebrow">Correlated evidence</span>{(incident.correlated_signals ?? []).map(signal => <div key={signal.id} className="text-xs text-slate-300"><b>{signal.assetId}</b> · {signal.metric.replace(/_/g, " ")} · {signal.direction}</div>)}</div><div className="subpanel"><span className="eyebrow">Thermal path</span><div className="flex flex-wrap items-center gap-2 text-xs">{(incident.thermal_path ?? []).map((asset, index) => <span key={asset} className="flex items-center gap-2"><b>{asset}</b>{index < incident.thermal_path.length - 1 && <ArrowRight size={12} className="text-slate-500" aria-hidden="true"/>}</span>)}</div><small>Dedup key: {incident.deduplication_key}</small></div></div><div className="mt-5 flex flex-wrap gap-2"><button className="button secondary" onClick={() => navigate(`/facilities/${facility.id}/topology?focus=${facilityPlant(facility.model_config).advisedUnit.id}`)}>View thermal path <GitBranch size={15}/></button><button className="button primary" onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)}>View recommendation <ArrowRight size={15}/></button></div></section><section className="panel p-6"><div className="flex items-center justify-between"><div><div className="eyebrow">Reconstructed scenario context</div><h2 className="mt-2 font-semibold">{reconstructed ? "Historical state loaded" : "Select incident to reconstruct"}</h2></div><History className="text-slate-500" aria-hidden="true"/></div><div className="mt-5 grid gap-3 sm:grid-cols-4"><Metric label="Simulated time" value={formatSimulatedAt(current.simulatedAt).slice(11)} sub={`${Math.round(current.elapsedS / 60)}m into ramp`}/><Metric label="IT power" value={current.itPowerKw.toLocaleString()} unit="kW" sub={`workload ${current.workloadPercent}%`}/><Metric label="Peak inlet" value={current.peakInletC.toFixed(1)} unit="°C" sub={`limit ${current.incident.limitC.toFixed(1)}°C`} warn/><Metric label="Model" value={incident.model_version} sub="version used by replay"/></div></section></> : <section className="panel p-6 text-sm text-slate-500">{loaded ? "Choose an incident to inspect its correlated signals." : "Loading incidents…"}</section>}
      </section>
    </div>
  </Shell>;
}

function AuditPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const guidance = useGuidance();
  const current = useScenarioSession((state) => state.simulation.snapshot);
  const [records, setRecords] = useState<Audit[]>([]);
  const [selected, setSelected] = useState<Audit | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [decisionFilter, setDecisionFilter] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [filtersApplied, setFiltersApplied] = useState(false);
  const load = () => {
    const query = new URLSearchParams();
    if (decisionFilter) query.set("decision", decisionFilter);
    if (search.trim()) query.set("search", search.trim());
    setFiltersApplied(Boolean(decisionFilter || search.trim()));
    api<Audit[]>(`/api/facilities/${facility.id}/audit?${query}`).then(setRecords).catch((cause) => setError(describeError(cause)));
  };
  useEffect(() => { load(); }, [facility.id, decisionFilter]);
  const select = async (record: Audit) => {
    setSelected(record);
    setDetail(null);
    setError("");
    try {
      setDetail(await api(`/api/facilities/${facility.id}/audit/${record.id}`));
      guidance.emit("audit-reconstruct");
    } catch (cause) { setDetail(null); setError(describeError(cause)); }
  };
  const snapshot = detail?.snapshot;
  const decision = detail?.decision ?? selected?.payload?.decision;
  const safety = detail?.safetyEvaluation ?? selected?.payload?.safetyEvaluation;
  const recommendation = detail?.recommendation ?? selected?.payload?.recommendation;
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="Audit history / immutable decisions" title="Audit history" detail="Filter decisions and reconstruct the exact recorded scenario, model, evidence, Safety Shield evaluation, and disposition."/>
    <section className="panel mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="field m-0 flex-1">Search evidence or action<input className="input mt-2 w-full" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && load()} placeholder="e.g. deferred, CDU-03, PASS"/></label>
        <label className="field m-0">Disposition<select className="select mt-2 block" value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value)}><option value="">All dispositions</option><option value="APPROVE">Approved</option><option value="REJECT">Rejected</option><option value="DEFER">Deferred</option><option value="REQUEST_ALTERNATIVE">Alternative requested</option><option value="ACKNOWLEDGE">Warning acknowledged</option></select></label>
        <button className="button secondary" onClick={load}><Search size={14}/>Apply filters</button>
      </div>
    </section>
    <section className="panel mb-4 p-5"><div className="eyebrow">Current replay · not used for history</div><div className="mt-3 grid gap-3 sm:grid-cols-4"><Metric label="Simulated at" value={formatSimulatedAt(current.simulatedAt).slice(11)} sub={`${Math.round(current.elapsedS / 60)}m into ramp`}/><Metric label="IT power" value={current.itPowerKw.toLocaleString()} unit="kW" sub={`workload ${current.workloadPercent}%`}/><Metric label="Peak inlet" value={current.peakInletC.toFixed(1)} unit="°C" sub={`limit ${current.incident.limitC.toFixed(1)}°C`}/><Metric label="Forecast" value={current.forecast.baselinePeakC.toFixed(1)} unit="°C" sub={`${current.forecast.horizonS / 60}m horizon`}/></div></section>
    <div className="grid gap-4 xl:grid-cols-[minmax(380px,.85fr)_minmax(0,1.15fr)]">
      <section className="panel overflow-hidden" data-guide="audit">
        {records.map((record) => {
          const recordDecision = record.payload?.decision;
          return <button key={record.id} onClick={() => select(record)} className={`facility-row w-full text-left ${selected?.id === record.id ? "bg-slate-800/60" : ""}`}><div><Status tone={recordDecision?.decision === "APPROVE" ? "good" : recordDecision?.decision === "REJECT" ? "bad" : "warn"}>{record.action.replace("DECISION_", "").replace(/_/g, " ")}</Status><h2 className="mt-2 font-semibold">Recommendation {record.payload?.recommendation?.id ?? record.payload?.recommendationId}</h2><p className="mt-1 text-xs text-slate-500">{new Date(record.created_at).toLocaleString()} · {record.model_version}</p></div><div className="text-right"><b>{recordDecision?.outcome ?? record.payload?.outcome}</b><p className={`${mono} mt-1 text-xs text-slate-500`}>{formatSimulatedAt(record.simulated_at)}</p></div></button>;
        })}
        {!records.length && !error && <p className="p-6 text-sm text-slate-500">{filtersApplied ? "No decisions match these filters." : "No decisions have been recorded for this facility yet."}</p>}
        {error && <p role="alert" className="p-6 text-red-300">{error}</p>}
      </section>
      <section className="panel p-6">
        <div className="eyebrow">Reconstructed immutable record</div>
        {selected && snapshot ? <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Decision #{selected.id}</h2><p className="mt-1 text-xs text-slate-500">{selected.scenario_id} · {selected.model_version} · {formatSimulatedAt(selected.simulated_at)}</p></div><Status tone={safety?.outcome === "PASS" ? "good" : safety?.outcome === "WARNING" ? "warn" : "bad"}>{safety?.outcome ?? "RECORDED"}</Status></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="IT power" value={Number(snapshot.itPowerKw).toLocaleString()} unit="kW" sub="stored snapshot"/><Metric label="Peak inlet" value={Number(snapshot.peakInletC).toFixed(1)} unit="°C" sub={`PUE ${Number(snapshot.pue).toFixed(3)}`}/><Metric label="Forecast" value={Number(snapshot.forecast.baselinePeakC).toFixed(1)} unit="°C" sub={`${snapshot.forecast.horizonS / 60}m stored horizon`}/><Metric label="Advisory" value={`${snapshot.recommendation.flowPercent}%`} sub={`${snapshot.recommendation.durationMinutes} minute alternative`}/></div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="subpanel"><span className="eyebrow">Decision snapshot</span><b>{decision?.decision?.replace(/_/g, " ")} → {decision?.outcome}</b><small>{decision?.note || "No operator note"}</small><small>Command: {decision?.command?.flowPercent}% for {decision?.command?.durationMinutes} min</small></div>
            <div className="subpanel"><span className="eyebrow">Recommendation & model</span><b>{recommendation?.title}</b><small>Recommendation v{recommendation?.version} · model {detail?.model?.version ?? selected.model_version}</small><small>Confidence {Math.round(Number(recommendation?.confidence ?? 0) * 100)}% · SIMULATED</small></div>
          </div>
          <div className="mt-5"><div className="eyebrow">Recorded safety evidence</div><ul className="mt-3 space-y-2">{(safety?.checks ?? []).map((check: any) => <li key={check.id} className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2 text-xs"><span><b>{check.id.replace(/_/g, " ")}</b><small className="mt-1 block text-slate-500">{check.detail}</small></span><Status tone={check.status === "PASS" ? "good" : check.status === "WARNING" ? "warn" : "bad"}>{check.status}</Status></li>)}</ul></div>
          <p className="mt-5 text-xs leading-5 text-slate-500">This view renders the JSON snapshot stored with the decision. It does not replay the active model or substitute current facility state.</p>
        </> : <p className="copy">Select a record to load its exact stored reconstruction.</p>}
      </section>
    </div>
  </Shell>;
}

function FacilityBuilderPage({ data, facility }: { data: SessionData; facility: Facility }) {
  // After a publish or restore, every page and the replay session must pick up the newly published model.
  const reloadPublishedModel = async () => {
    dispatchEvent(new Event(FACILITIES_CHANGED));
  };
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="Facility builder / layout" title="Facility builder" detail="Construct the data centre Operations runs: zones, equipment and connections, saved as versions that are checked and then published."/>
    <FacilityBuilder facilityId={facility.id} request={api} onPublished={reloadPublishedModel}/>
  </Shell>;
}

function ModelStudio({ data, facility }: { data: SessionData; facility: Facility }) {
  const guidance = useGuidance();
  const [versions, setVersions] = useState<ModelVersion[]>([]), [config, setConfig] = useState('{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'), [message, setMessage] = useState(""), [error, setError] = useState("");
  const refresh = () => api<ModelVersion[]>(`/api/facilities/${facility.id}/model/versions`).then(setVersions).catch(e => setError(describeError(e)));
  useEffect(() => { void refresh(); }, [facility.id]);
  useEffect(() => {
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      const label = button.textContent?.trim() ?? "";
      if (label.startsWith("Validate")) button.dataset.guide = "model-validate";
      if (label.startsWith("Publish")) button.dataset.guide = "model-publish";
      if (label.startsWith("Rollback")) button.dataset.guide = "model-rollback";
    });
  }, [versions]);
  useEffect(() => {
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
    });
  }, [facility.id]);
  const createDraft = async () => { try { const parsed = JSON.parse(config); const result = await post<ModelVersion>(`/api/facilities/${facility.id}/model/versions`, { config: parsed }); setVersions(v => [result, ...v]); setMessage(`${result.id} created as DRAFT`); setError(""); guidance.emit("model-draft"); } catch (e) { setError(describeError(e)); } };
  const action = async (path: string, success: string, body: unknown = {}, reloadModel = false) => { try { await post(path, body); await refresh(); if (reloadModel) dispatchEvent(new Event(FACILITIES_CHANGED)); setMessage(success); setError(""); guidance.emit(path.endsWith("/validate") ? "model-validate" : path.endsWith("/publish") ? "model-publish" : "model-rollback"); } catch (e) { setError(describeError(e)); } };
  const simulatedAt = useScenarioSession((state) => state.simulatedAt);
  const previewConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(config) as FacilityModelConfig;
      // A draft inherits the published build's layout, so it previews on that build.
      const withLayout = parsed.layout || !facility.model_config.layout ? parsed : { ...parsed, layout: facility.model_config.layout };
      return parsed.scenario === "gpu-training-ramp-v1" && Number.isFinite(parsed.seed) && parsed.thermalMass > 0 && parsed.responseLag >= 0
        ? withLayout
        : facility.model_config;
    } catch {
      return facility.model_config;
    }
  }, [config, facility.model_config]);
  const snapshot = useMemo(() => replayCockpitSnapshot(simulatedAt, previewConfig), [simulatedAt, previewConfig]);
  const selectedId = useScenarioSession((state) => state.selectedAssetId);
  const selectAsset = useScenarioSession((state) => state.selectAsset);
  return <Shell data={data} facility={facility}><PageHead eyebrow="Model administration / demo model" title="Model Studio" detail="Edit the facility representation Operations consumes. Changes are validated, versioned, and explicitly published." action={<Status tone="warn">DEMO MODEL</Status>}/><section className="panel mb-4 overflow-hidden"><div className="border-b border-slate-800 p-4"><h2 className="font-semibold">Shared facility scene · edit preview</h2><p className="mt-1 text-xs text-slate-500">This is the same authorized visual model used in Operations. Publishing remains a separate, explicit action below.</p></div><FacilityTwin model={facility.model_config} modelVersion={facility.model_version} snapshot={snapshot} selectedId={selectedId} onSelect={selectAsset} view="physical" overlays={["flow","sensors","labels"]} mode="edit" canEdit={facility.can_edit_model}/></section><div className="grid gap-4 xl:grid-cols-[.9fr_1.1fr]"><section className="panel p-6"><div className="flex items-center gap-3"><SlidersHorizontal className="text-slate-500" aria-hidden="true"/><div><h2 className="font-semibold">Create facility model version</h2><p className="text-xs text-slate-500">Synthetic simulation parameters only</p></div></div><label className="mt-6 block text-xs text-slate-500" htmlFor="model-config">Configuration JSON</label><textarea id="model-config" value={config} onChange={e=>setConfig(e.target.value)} className="textarea mt-2 min-h-[170px] w-full font-mono text-xs" aria-describedby="model-config-help"/><p id="model-config-help" className="mt-2 text-xs text-slate-500">Include scenario, seed, thermal mass, and response lag. Invalid JSON cannot be saved.</p><button className="button primary mt-4" onClick={createDraft}><Save size={15}/>Save draft version</button>{message&&<p role="status" className="mt-4 text-sm text-teal-300">{message}</p>}{error&&<p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}</section><section className="panel overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Version history</h2><p className="mt-1 text-xs text-slate-500">Published version: {facility.model_version}</p></div>{versions.map(version => <div key={version.id} className="border-b border-slate-800 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className={`${mono} text-sm text-cyan-300`}>{version.id}</div><p className="mt-1 text-xs text-slate-500">{new Date(version.created_at).toLocaleString()} · {Object.keys(version.config).length} parameters</p></div><Status tone={version.status === "PUBLISHED" ? "good" : version.status === "DRAFT" ? "warn" : "good"}>{version.status}</Status></div><div className="mt-4 flex flex-wrap gap-2">{version.status === "DRAFT"&&<button className="button secondary" onClick={() => action(`/api/facilities/${facility.id}/model/versions/${version.id}/validate`, `${version.id} validated`)}><Check size={14}/>Validate</button>}{version.status === "VALIDATED"&&<button className="button primary" onClick={() => action(`/api/facilities/${facility.id}/model/versions/${version.id}/publish`, `${version.id} published to Operations`, {}, true)}><ArrowUp size={14}/>Publish</button>}{version.status !== "PUBLISHED"&&version.status !== "DRAFT"&&<button className="button secondary" onClick={() => action(`/api/facilities/${facility.id}/model/rollback`, `Operations rolled back to ${version.id}`, { versionId: version.id }, true)}><RotateCcw size={14}/>Rollback to this version</button>}</div></div>)}{versions.length===0&&<p className="p-5 text-sm text-slate-500">No model versions returned.</p>}</section></div></Shell>;
}

function ModelLab({ data, facility }: { data: SessionData; facility: Facility }) {
  const guidance = useGuidance();
  const snapshot = useScenarioSession((s) => s.simulation.snapshot), [comparison, setComparison] = useState<ControllerComparison | null>(null);
  const run = () => {
    setComparison(compareControllers(snapshot));
    guidance.emit("model-compare");
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  };
  return <Shell data={data} facility={facility}><PageHead eyebrow="Controller comparison / physical AI" title="Model Lab" detail="Every controller receives the same initial state and event stream. This is a comparison harness, not a superiority claim." action={<Status tone="warn">SYNTHETIC</Status>}/><ReplayBar/><section className="panel p-6"><div className="grid gap-4 md:grid-cols-3"><div><div className="eyebrow">Initial state</div><p className="mt-2 text-sm">{comparison?.initialState ?? `${snapshot.workloadPercent}% workload · ${snapshot.itPowerKw.toLocaleString()} kW IT · ${snapshot.rackCount} racks`}</p></div><div><div className="eyebrow">Shared events</div><p className="mt-2 text-sm">{comparison?.events.join(" → ") ?? "Training ramp → power rise → CDU response lag"}</p></div><div className="flex items-end md:justify-end"><button className="button primary" onClick={run}><Play size={15}/>Run same-input comparison</button></div></div></section>{comparison&&<section className="panel mt-4 overflow-x-auto"><table className="data-table min-w-[900px]"><caption className="sr-only">Controller comparison results</caption><thead><tr><th>Controller</th><th>Peak temp</th><th>Degree-minutes</th><th>Warning lead</th><th>Cooling energy</th><th>Commands issued</th><th>Inference events</th><th>Peak margin</th></tr></thead><tbody>{comparison.results.map(result => <tr key={result.id}><td><b>{result.name}</b><small className="mt-1 block text-slate-500">{result.architecturalMetric}: {result.architecturalValue}</small></td><td>{result.peakC.toFixed(1)}°C</td><td>{result.degreeMinutes.toFixed(1)}</td><td>{result.warningLeadMinutes === null ? "No crossing in horizon" : `${result.warningLeadMinutes} min`}</td><td>{result.coolingEnergyKwh === null ? "Unavailable" : `${result.coolingEnergyKwh} kWh`}</td><td>{result.interventions}</td><td>{result.inferenceEvents === null ? "Not measured" : result.inferenceEvents}</td><td>{result.peakMarginC >= 0 ? `${result.peakMarginC.toFixed(1)}°C below limit` : `${Math.abs(result.peakMarginC).toFixed(1)}°C over limit`}</td></tr>)}</tbody></table><div className="space-y-2 p-5 text-xs leading-5 text-slate-500"><p><b>Warning lead</b> is the time from a controller's warning to the first modeled limit crossing without intervention. A predictive policy warns as soon as its forecast shows the crossing; a reactive controller warns only at the limit.</p><p><b>Commands issued</b> counts advisory commands in the horizon. <b>Peak margin</b> is the rack inlet limit minus the run's peak temperature.</p><p>SNN rows show only metrics supported by an implemented measurement. Compute energy and inference events are not measured, and unsupported physical-AI claims are marked unavailable.</p></div></section>}</Shell>;
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
    } catch (cause) { setError(describeError(cause)); }
  };
  useEffect(() => { void refresh(); }, []);
  const saveMember = async (member: { userId: string; email?: string; displayName?: string; role: Role; isAdmin: boolean }) => {
    try {
      await post("/api/admin/memberships", member);
      setMessage(`${member.userId} access saved`);
      await refresh();
    } catch (cause) { setError(describeError(cause)); }
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
    } catch (cause) { setError(describeError(cause)); }
  };
  const revoke = async (member: Member) => {
    try {
      await remove(`/api/admin/memberships/${encodeURIComponent(member.id)}`);
      setMessage(`${member.display_name ?? member.id} membership revoked`);
      await refresh();
    } catch (cause) { setError(describeError(cause)); }
  };
  return <Shell data={data}><PageHead eyebrow="Organization / access administration" title="Access administration" detail="Organization roles and site grants take effect on the next authorized request. Every change is retained in administrative history."/>
    <section className="panel mb-4 p-5"><h2 className="font-semibold">Provision a member</h2><div className="mt-4 grid gap-3 md:grid-cols-5"><input className="input" placeholder="Clerk user ID" value={draft.userId} onChange={event=>setDraft({...draft,userId:event.target.value})}/><input className="input" placeholder="Display name" value={draft.displayName} onChange={event=>setDraft({...draft,displayName:event.target.value})}/><input className="input" placeholder="Email (optional)" value={draft.email} onChange={event=>setDraft({...draft,email:event.target.value})}/><select className="select" value={draft.role} onChange={event=>setDraft({...draft,role:event.target.value as Role})}>{ROLES.map(role=><option key={role}>{role}</option>)}</select><button className="button primary justify-center" disabled={!draft.userId} onClick={()=>saveMember(draft)}>Save membership</button></div>{data.me.is_owner&&<label className="mt-3 flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={draft.isAdmin} onChange={event=>setDraft({...draft,isAdmin:event.target.checked})}/>Grant organization administration</label>}{message&&<p role="status" className="mt-3 text-sm text-teal-300">{message}</p>}{error&&<p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}</section>
    <div className="grid gap-4 xl:grid-cols-[1fr_.7fr]"><section className="space-y-3">{members.map(member=><article key={member.id} className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><b>{member.display_name ?? member.id}</b>{member.is_owner&&<Status>OWNER</Status>}{member.is_admin&&!member.is_owner&&<Status>ADMIN</Status>}</div><p className="mt-1 text-xs text-slate-500">{member.email ?? member.id}</p></div><div className="flex gap-2"><select className="select" value={member.role} disabled={member.is_owner} onChange={event=>saveMember({userId:member.id,role:event.target.value as Role,isAdmin:member.is_admin})}>{ROLES.map(role=><option key={role}>{role}</option>)}</select>{!member.is_owner&&member.id!==data.me.id&&<button className="button secondary" aria-label={`Revoke ${member.display_name ?? member.id}`} onClick={()=>revoke(member)}><Trash2 size={14}/></button>}</div></div><div className="mt-4 space-y-2">{member.facilities.map(facility=><div key={facility.facility_id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 p-3"><span className="text-sm font-medium">{facility.facility_name}</span><div className="flex flex-wrap gap-4 text-xs text-slate-400">{([["View","can_view"],["Operate","can_operate"],["Edit model","can_edit_model"]] as const).map(([label,key])=><label key={key} className="flex items-center gap-2"><input type="checkbox" checked={facility[key]} disabled={key!=="can_view"&&!facility.can_view} onChange={event=>saveGrant(member,facility,{[key]:event.target.checked,...(key==="can_view"&&!event.target.checked?{can_operate:false,can_edit_model:false}:{})})}/>{label}</label>)}</div></div>)}</div></article>)}</section><aside className="panel overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Administrative history</h2><p className="mt-1 text-xs text-slate-500">Immutable role and facility changes</p></div>{audit.map(record=><div key={record.id} className="border-b border-slate-800 p-4"><Status>{record.action.replace(/_/g," ")}</Status><p className="mt-2 text-xs text-slate-400">{record.target_user_id ?? "Organization"}{record.facility_id ? ` · ${record.facility_id}` : ""}</p><p className="mt-1 text-xs text-slate-500">{new Date(record.created_at).toLocaleString()} · by {record.actor_user_id}</p></div>)}{!audit.length&&<p className="p-5 text-sm text-slate-500">No access changes recorded yet.</p>}</aside></div>
  </Shell>;
}

function LearningOutcomes({ data }: { data: SessionData }) {
  const [outcomes, setOutcomes] = useState<LearningOutcomesData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<LearningOutcomesData>("/api/learning/outcomes").then(setOutcomes).catch((cause) => setError(describeError(cause)));
  }, []);
  const eventCount = (name: string) => outcomes?.journeyEvents.find((item) => item.event_name === name)?.count ?? 0;
  return <Shell data={data}>
    <PageHead eyebrow="Product learning / permission controlled" title="Learning outcomes" detail="Sparse workflow outcomes for managers and administrators. No replay ticks, raw questions, operator notes, or individual feedback are exposed."/>
    {error && <p className="panel p-5 text-red-300" role="alert">{error}</p>}
    {!outcomes && !error && <p className="panel p-5 text-slate-500">Loading outcome summaries…</p>}
    {outcomes && <>
      <MetricStrip label="Learning figures">
        <Metric label="Facility drilldowns" value={String(eventCount("FACILITY_DRILLDOWN"))} sub="authorized site opens"/>
        <Metric label="Incident reviews" value={String(eventCount("INCIDENT_REVIEWED"))} sub="persisted investigations"/>
        <Metric label="What-if uses" value={String(eventCount("WHAT_IF_USED"))} sub="same-input comparisons"/>
        <Metric label="Safety results" value={String(eventCount("SAFETY_RESULT"))} sub="server-verified outcomes"/>
        <Metric label="Decisions" value={String(eventCount("DECISION_RECORDED"))} sub="immutable dispositions"/>
      </MetricStrip>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="panel p-5"><div className="eyebrow">Operator understanding</div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Sessions" value={String(outcomes.operatorSessions.total ?? 0)} sub="moderated tests"/><Metric label="Completed" value={String(outcomes.operatorSessions.completed ?? 0)} sub="thread understood"/><Metric label="Abandoned" value={String(outcomes.operatorSessions.abandoned ?? 0)} sub="ended early" warn={Boolean(outcomes.operatorSessions.abandoned)}/><Metric label="Avg. understanding" value={outcomes.operatorSessions.avg_time_to_understanding_s == null ? "—" : String(outcomes.operatorSessions.avg_time_to_understanding_s)} unit="s" sub={`avg. errors ${outcomes.operatorSessions.avg_error_count ?? 0}`}/></div></section>
        <section className="panel p-5"><div className="eyebrow">Contextual feedback</div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Responses" value={String(outcomes.feedback.count)} sub="surface-linked"/><Metric label="Positive" value={String(outcomes.feedback.positive)} sub="helpful"/><Metric label="Neutral" value={String(outcomes.feedback.neutral)} sub="mixed"/><Metric label="Negative" value={String(outcomes.feedback.negative)} sub="friction" warn={Boolean(outcomes.feedback.negative)}/></div></section>
        <section className="panel p-5"><div className="eyebrow">Safety & decisions</div><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-semibold">Safety outcomes</h2><div className="mt-2 space-y-2">{outcomes.safetyOutcomes.map((item) => <div key={item.outcome} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.outcome}</span><b>{item.count}</b></div>)}</div></div><div><h2 className="text-sm font-semibold">Decision outcomes</h2><div className="mt-2 space-y-2">{outcomes.decisionOutcomes.map((item) => <div key={item.outcome} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.outcome.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}</div></div></div></section>
        <section className="panel p-5"><div className="eyebrow">Friction & questions</div><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-semibold">Classified errors</h2><div className="mt-2 space-y-2">{outcomes.errors.map((item) => <div key={item.category} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.category.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}{!outcomes.errors.length && <p className="text-xs text-slate-500">No classified errors.</p>}</div></div><div><h2 className="text-sm font-semibold">Common assistant topics</h2><div className="mt-2 space-y-2">{outcomes.commonAssistantTopics.map((item) => <div key={item.topic} className="flex justify-between border-b border-slate-800 pb-2 text-xs"><span>{item.topic.replace(/_/g, " ")}</span><b>{item.count}</b></div>)}{!outcomes.commonAssistantTopics.length && <p className="text-xs text-slate-500">No assistant use recorded.</p>}</div></div></div></section>
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
  const update = async (next: number, complete = false) => {
    if (next === 0 && !complete) {
      dispatchEvent(new Event("wattr:restart-guide"));
      return;
    }
    setStep(next); setDone(complete);
    try { await patch("/api/me/tutorial", { step: next, complete, role: data.me.role }); } catch (e) { setError(describeError(e)); }
  };
  const current = steps[Math.min(step, steps.length - 1)];
  const openTutorialRoute = () => {
    if (current.route === "/portfolio") navigate("/portfolio");
    else if (facility) navigate(`/facilities/${facility.id}${current.route}`);
  };
  return <Shell data={data}><PageHead eyebrow={`Help / ${ROLE_LABELS[data.me.role]}`} title="Help & tutorials" detail="A role-specific, restartable tutorial for the Wattr operating thread."/><div className="grid gap-4 lg:grid-cols-[1fr_.8fr]"><section className="panel p-6"><div className="flex items-center gap-3"><BookOpen className="text-slate-500" aria-hidden="true"/><div><h2 className="font-semibold">{done ? "Tutorial complete" : "Welcome to Wattr"}</h2><p className="text-xs text-slate-500">Step {done ? steps.length : step + 1} of {steps.length}</p></div></div>{done ? <p className="copy">You can restart this guide any time. The cockpit always keeps human authority and synthetic provenance visible.</p> : <><div className="mt-8 rounded-md border border-cyan-400/30 bg-cyan-400/5 p-5"><div className="eyebrow">Step {step + 1}</div><h3 className="mt-2 text-xl font-semibold">{current.title}</h3><p className="mt-3 text-sm leading-6 text-slate-400">{current.body}</p></div><div className="mt-5 flex flex-wrap gap-2"><button type="button" className="button secondary" disabled={step===0} onClick={() => update(Math.max(0, step - 1))}>Back</button><button type="button" className="button primary" onClick={() => update(step + 1 >= steps.length ? step : step + 1, step + 1 >= steps.length)}>Next <ArrowRight size={15}/></button><button type="button" className="button secondary" onClick={() => update(step, true)}>Skip tutorial</button><button type="button" className="button secondary" onClick={openTutorialRoute}>Open this workspace</button></div></>}{error&&<p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}</section><section className="panel p-6"><div className="eyebrow">Role lens</div><h2 className="mt-2 text-xl font-semibold">{data.me.role.replace(/_/g, " ")}</h2><p className="copy">The same deterministic scenario is disclosed progressively: portfolio outcomes first, asset relationships next, and model-level details only when your role needs them.</p><button type="button" className="button secondary" onClick={() => update(0, false)}><RotateCcw size={15}/>Restart tutorial</button><div className="mt-6 border-t border-slate-800 pt-5"><ThemeControl/></div></section></div></Shell>;
}

function GuidedHelp({ data }: { data: SessionData }) {
  const restart = () => dispatchEvent(new Event("wattr:restart-guide"));
  return <Shell data={data}>
    <PageHead eyebrow={`Help / ${ROLE_LABELS[data.me.role]}`} title="Help & tutorials" detail="Learn in the live workspace by performing the required operating actions."/>
    <div className="grid gap-4 lg:grid-cols-[1fr_.8fr]">
      <section className="panel p-6">
        <div className="flex items-center gap-3"><BookOpen className="text-slate-500" aria-hidden="true"/><div><h2 className="font-semibold">Action-aware tutorial</h2><p className="text-xs text-slate-500">Starts automatically the first time you sign in with a role, and saves progress for that role.</p></div></div>
        <p className="copy">The guide spotlights the real control on each page and advances when you perform its action. It never changes pages on its own: when a step is on another page, it offers a button to open that page. The spotlight never intercepts clicks or hides operating state.</p>
        <div className="mt-5 flex flex-wrap gap-2"><button className="button primary" onClick={restart}><RotateCcw size={15}/>Restart guided tutorial</button></div>
      </section>
      <section className="panel p-6">
        <div className="eyebrow">Available at any time</div>
        <ul className="mt-4 space-y-3 text-sm text-slate-300">
          <li><b>Back</b> revisits the prior instruction.</li>
          <li><b>Next</b> moves on without performing the action.</li>
          <li><b>Skip tutorial</b> closes guidance. It won't open by itself again; restart it here whenever you like.</li>
          <li><b>Escape</b> remains available for walkthrough pointer capture and emergency navigation.</li>
        </ul>
      </section>
    </div>
  </Shell>;
}

function AssistantPage({ data, facility }: { data: SessionData; facility?: Facility }) {
  const simulatedAt = useScenarioSession((state) => state.simulatedAt);
  const selectedAssetId = useScenarioSession((state) => state.selectedAssetId);
  const highlightedPath = useScenarioSession((state) => state.highlightedPath);
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
        ...(facility ? { selection: { assetId: selectedAssetId, path: highlightedPath } } : {}),
      });
      setResponse(result);
    } catch (cause) {
      setError(describeError(cause));
      setResponse(null);
    } finally {
      setPending(false);
    }
  };
  const runAction = async (action: NonNullable<AssistantResponse["actions"]>[number]) => {
    if (!facility) return;
    try {
      const result = await post<{ path: string; action: "NAVIGATE" | "FOCUS"; focus?: AssistantResponse["actions"][number]["focus"] }>("/api/assistant/action", {
        action: action.id,
        facilityId: facility.id,
      });
      if (result.focus) useScenarioSession.getState().focusTwin(result.focus);
      navigate(result.path);
    } catch (cause) {
      setError(describeError(cause));
    }
  };
  return <Shell data={data} facility={facility}>
    <PageHead
      eyebrow={`Authorized operating answers / ${ROLE_LABELS[data.me.role]}`}
      title="Ask Wattr"
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
            <span className="text-xs text-slate-500">Answers use authorized structured data only. Current twin selection is included as context.</span>
            <button className="button primary" type="submit" disabled={!question.trim() || pending}><BrainCircuit size={15}/>{pending ? "Reading canonical state…" : "Ask Wattr"}</button>
          </div>
        </form>
        {!response && !error && <div className="p-6"><div className="eyebrow">Try a role-aware question</div><div className="mt-3 grid gap-2">{suggestions.map((suggestion) => <button key={suggestion} type="button" className="w-full rounded-md border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-cyan-400/60" onClick={() => void ask(suggestion)}>{suggestion}<ArrowRight size={14} className="float-right mt-0.5 text-cyan-300"/></button>)}</div></div>}
        {error && <div className="p-6" role="alert"><p className="text-sm text-red-300">{error}</p><p className="mt-2 text-xs text-slate-500">No answer was shown because the authorized assistant request did not complete.</p></div>}
        {response && <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">{sentenceCase(response.tool)} · {response.interpretation.source} interpretation</div><h2 className="mt-2 text-xl font-semibold">Grounded answer</h2></div><Status tone={response.tool === "refusal" ? "bad" : "good"}>{response.tool === "refusal" ? "LIMITED" : "AUTHORIZED"}</Status></div>
          <p className="mt-5 text-sm leading-7 text-slate-200">{response.answer}</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="subpanel"><span className="eyebrow">Facility</span><b>{response.context.facilityId ?? (response.citations.length ? `${response.citations.length} authorized sites` : "Unavailable")}</b></div>
            <div className="subpanel"><span className="eyebrow">Scenario time</span><b className={mono}>{response.context.simulatedAt ? formatSimulatedAt(response.context.simulatedAt) : "Unavailable"}</b></div>
            <div className="subpanel"><span className="eyebrow">Model version</span><b className={mono}>{response.context.modelVersionId ?? (response.citations[0]?.modelVersionId ?? "Unavailable")}</b></div>
            <div className="subpanel"><span className="eyebrow">Confidence / quality</span><b>{response.confidence === null ? "Unavailable" : `${Math.round(response.confidence * 100)}%`} · {response.context.quality}</b></div>
          </div>
          {response.limitations.length > 0 && <div className="mt-5 rounded-md border border-amber-400/30 bg-amber-400/5 p-4"><div className="eyebrow text-amber-300">Limitations</div><ul className="mt-2 space-y-1 text-xs leading-5 text-slate-400">{response.limitations.map((limitation) => <li key={limitation}>• {limitation}</li>)}</ul></div>}
          {response.actions.length > 0 && <div className="mt-5 flex flex-wrap gap-2"><span className="self-center text-xs text-slate-500">Confirm a safe focus or navigation:</span>{response.actions.map((action) => <button type="button" key={action.id} className="button secondary" onClick={() => void runAction(action)}>{action.label}<ArrowRight size={14}/></button>)}</div>}
        </div>}
      </section>
      <aside className="space-y-4">
        <section className="panel p-5"><div className="eyebrow">Evidence used</div><p className="mt-2 text-xs leading-5 text-slate-500">Each answer exposes the structured records used to produce it. Expand a source to inspect the evidence values.</p><div className="mt-4 space-y-2">{response?.citations.map((citation) => <details key={citation.id} className="disclosure"><summary>{citation.label}<span className="ml-auto text-xs text-slate-500">{citation.quality}</span></summary><div className="space-y-2 text-xs"><p><b>Facility:</b> {citation.facilityId} · <b>Scenario:</b> {citation.scenarioId ?? "none"}</p><p><b>Time:</b> {citation.simulatedAt === null ? "unavailable" : formatSimulatedAt(citation.simulatedAt)}</p><p><b>Model:</b> {citation.modelVersionId}</p><p><b>Provenance:</b> {citation.provenance.kind} / {citation.provenance.syntheticStatus} · {citation.provenance.source}</p><pre className="overflow-x-auto rounded bg-black/20 p-2 text-xs">{JSON.stringify(citation.evidence, null, 2)}</pre></div></details>)}{response && !response.citations.length && <p className="text-xs text-slate-500">No evidence was returned because the requested data is unavailable or unauthorized.</p>}{!response && <p className="text-xs text-slate-500">Evidence will appear here after you ask a question.</p>}</div></section>
        <section className="panel p-5"><div className="eyebrow">Boundary</div><p className="mt-3 text-xs leading-6 text-slate-400">Ask Wattr can read authorized portfolio, facility, incident, recommendation, audit, simulation, and model state. It cannot approve decisions, publish models, or issue operational technology commands.</p></section>
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
      setError(describeError(cause));
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
        <div className="flex items-center gap-3"><span className="tutorial-icon"><BookOpen size={18} aria-hidden="true"/></span><div><div className="eyebrow">Welcome / {data.me.role.replace(/_/g, " ")}</div><h2 id="tutorial-title" className="mt-1 text-xl font-semibold">{current.title}</h2></div></div>
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

function Auth({up=false}:{up?:boolean}){
  // Clerk's card follows the page: light variables here, dark ones from the provider otherwise.
  const appearance = showsLightTheme() ? CLERK_LIGHT_APPEARANCE : undefined;
  return <PublicFrame className="grid place-items-center p-5"><div className="w-full max-w-[460px]"><Brand/><div className="mt-8">{up?<SignUp appearance={appearance} routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/portfolio"/>:<SignIn appearance={appearance} routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/portfolio"/>}</div></div></PublicFrame>;
}

function ProtectedRoutes({path, data}:{path:string; data: SessionData}){
  const defaultPath = data.me.default_path.replace("{facilityId}", data.facilities[0]?.id ?? "");
  useEffect(()=>{if(path==="/portfolio"&&data.me.role!=="PORTFOLIO_MANAGER"&&data.facilities[0])navigate(defaultPath)},[data.me.role,data.facilities,path,defaultPath]);
  if(path==="/admin"&&!data.me.is_admin)return <Shell data={data}><PageHead eyebrow="Access" title="Workspace unavailable" detail="This workspace is not present in your authorized navigation."/></Shell>;
  if(path==="/admin")return <AccessAdministration data={data}/>;
  if(path==="/learning"&&data.me.role!=="PORTFOLIO_MANAGER"&&!data.me.is_admin)return <Shell data={data}><PageHead eyebrow="Access" title="Learning outcomes unavailable" detail="Organization learning summaries require manager or administrator access."/></Shell>;
  if(path==="/learning")return <LearningOutcomes data={data}/>;
  if(path==="/portfolio"&&data.me.role!=="PORTFOLIO_MANAGER"&&data.facilities[0])return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-cyan-300">Opening your authorized workspace…</div>;
  if(path==="/portfolio")return <Portfolio data={data}/>;
  if(path==="/ask-wattr"&&data.me.role==="PORTFOLIO_MANAGER")return <AssistantPage data={data}/>;
  if(path==="/help")return <GuidedHelp data={data}/>;
  const parts=path.split("/").filter(Boolean), facility=parts[0]==="facilities"&&data.facilities.find(f=>f.id===parts[1]);
  if(!facility)return <Shell data={data}><PageHead eyebrow="Access" title="Facility unavailable" detail="This facility is not present in your authorized API response."/></Shell>;
  const section=parts[2];
  if(section==="intelligence")return <FacilityIntelligencePage key={facility.id} data={data} facility={facility}/>;
  if(section==="history")return <FacilityHistoryPage key={facility.id} data={data} facility={facility}/>;
  if(section==="replay")return <ScenarioReplayPage key={facility.id} data={data} facility={facility}/>;
  if(section==="import")return <FacilityImportPage key={facility.id} data={data} facility={facility}/>;
  if(section==="operations")return <Operations data={data} facility={facility}/>;
  if(section==="incidents")return <IncidentPage data={data} facility={facility} incidentId={parts[3]}/>;
  if(section==="recommendations")return <Recommendation data={data} facility={facility}/>;
  if(section==="audit")return <AuditPage data={data} facility={facility}/>;
  if(section==="ask-wattr"&&!facility.can_assistant)return <Shell data={data} facility={facility}><PageHead eyebrow="Access" title="Ask Wattr unavailable" detail="Assistant access requires an authorized role and facility view grant."/></Shell>;
  if(section==="ask-wattr")return <AssistantPage data={data} facility={facility}/>;
  if(section==="topology"&&!canViewTopology(data.me.role, data.me.is_owner))return <Shell data={data} facility={facility}><PageHead eyebrow="Access" title="Workspace unavailable" detail="This analysis workspace is not present in your authorized navigation."/></Shell>;
  if(section==="topology")return <ThermalGraphPage data={data} facility={facility}/>;
  if(section==="builder")return <FacilityBuilderPage data={data} facility={facility}/>;
  if(section==="model-lab"&&!facility.can_engineer)return <Shell data={data} facility={facility}><PageHead eyebrow="Access" title="Workspace unavailable" detail="Engineering analysis access is required."/></Shell>;
  if(section==="model-lab")return <ModelLab data={data} facility={facility}/>;
  if(section==="model"&&!facility.can_edit_model)return <Shell data={data} facility={facility}><PageHead eyebrow="Forbidden" title="Model Studio access required" detail="Your role cannot edit or publish facility models."/></Shell>;
  if(section==="model")return <ModelStudio data={data} facility={facility}/>;
  return <Shell data={data} facility={facility}><PageHead eyebrow="Access" title="Workspace unavailable" detail="Choose an operating workspace from the facility navigation."/></Shell>;
}
function ProtectedApp({path}:{path:string}){
  const [data,setData]=useState<SessionData|null>(null),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{setError(null);Promise.all([api<Me>("/api/me"),api<Facility[]>("/api/facilities")]).then(([me,facilities])=>{if(facilities[0]?.model_config)useScenarioSession.getState().setModelConfig(facilities[0].model_config);setData({me,facilities});}).catch((cause)=>setError(cause ?? new Error("The workspace could not be loaded")));},[attempt]);
  // A publish or restore changes the model Operations runs. Reload the
  // facilities so Operations, the twin and the replay session all use it. If
  // the reload fails, pages keep the facilities they already have.
  useEffect(() => {
    const reload = () => {
      api<Facility[]>("/api/facilities").then((facilities) => {
        if (facilities[0]?.model_config) useScenarioSession.getState().setModelConfig(facilities[0].model_config);
        setData((current) => current ? { ...current, facilities } : current);
      }).catch(() => {});
    };
    addEventListener(FACILITIES_CHANGED, reload);
    return () => removeEventListener(FACILITIES_CHANGED, reload);
  }, []);
  // Taking another role changes capabilities, navigation and the default page,
  // so the whole session is re-read rather than just the facilities.
  useEffect(() => {
    const reload = () => {
      Promise.all([api<Me>("/api/me"), api<Facility[]>("/api/facilities")])
        .then(([me, facilities]) => setData({ me, facilities }))
        .catch(() => {});
    };
    addEventListener(SESSION_CHANGED, reload);
    return () => removeEventListener(SESSION_CHANGED, reload);
  }, []);
  if(error){
    const status = error instanceof ApiError ? error.status : undefined;
    return <StateScreen
      kind="error"
      title={status === 401 ? "Sign in again" : status === 403 ? "No access to this workspace" : "Wattr could not open your workspace"}
      body={describeError(error)}
      actions={<>
        {status === 401
          ? <button type="button" className="button primary" onClick={()=>navigate("/sign-in")}>Sign in</button>
          : <button type="button" className="button primary" onClick={()=>setAttempt((value)=>value+1)}>Try again</button>}
        <button type="button" className="button secondary" onClick={()=>navigate("/demo/sandbox")}>Open the cooling sandbox</button>
      </>}
    />;
  }
  if(!data)return <StateScreen kind="loading" title="Opening your workspace" body="Checking your access and loading the facility model Operations runs."/>;
  const roleProgressMatches = data.me.tutorial_role === data.me.role;
  return <ThemeProvider initialTheme={data.me.theme}><GuidanceProvider
    role={data.me.role}
    facilityId={data.facilities[0]?.id}
    initialStep={roleProgressMatches ? data.me.tutorial_step : 0}
    initialComplete={roleProgressMatches ? data.me.tutorial_complete : false}
    navigate={navigate}
    save={async (step, complete) => {
      await patch("/api/me/tutorial", { step, complete, role: data.me.role });
      setData(current => current ? ({ ...current, me: { ...current.me, tutorial_step: step, tutorial_complete: complete, tutorial_role: data.me.role } }) : current);
    }}
  ><ProtectedRoutes path={path} data={data}/></GuidanceProvider></ThemeProvider>;
}
export function CockpitApp(){
  const [path,setPath]=useState(location.pathname),{isSignedIn,isLoaded}=useUser(),[signInSlow,setSignInSlow]=useState(false);
  // If the sign-in service never answers, say so rather than leaving a blank page.
  useEffect(()=>{if(isLoaded)return;const timer=setTimeout(()=>setSignInSlow(true),8000);return()=>clearTimeout(timer);},[isLoaded]);
  const testSignedIn = Boolean(e2eTestUserId());
  useScenarioClock();
  useEffect(()=>{const on=()=>setPath(location.pathname);addEventListener("popstate",on);return()=>removeEventListener("popstate",on)},[]);
  useEffect(()=>{if(path==="/"&&(isSignedIn||testSignedIn))navigate("/portfolio")},[path,isSignedIn,testSignedIn]);
  useEffect(()=>{
    const publicPath = path === "/" || path === "/demo/sandbox" || path.startsWith("/sign-in") || path.startsWith("/sign-up");
    if (isLoaded && !isSignedIn && !testSignedIn && !publicPath) navigate("/");
  },[isLoaded,isSignedIn,testSignedIn,path]);
  if(path==="/demo/sandbox")return <SandboxShell/>; if(path.startsWith("/sign-in"))return <Auth/>; if(path.startsWith("/sign-up"))return <Auth up/>; if(path==="/")return <Landing/>;
  if(testSignedIn)return <ProtectedApp path={path}/>;
  if(!isLoaded)return <StateScreen kind="loading" title="Checking your sign-in" body={signInSlow ? "Sign-in is taking longer than usual. The public cooling sandbox is available without an account." : "Connecting to the sign-in service."} actions={signInSlow ? <button type="button" className="button secondary" onClick={()=>navigate("/demo/sandbox")}>Open the cooling sandbox</button> : undefined}/>;
  return <><Show when="signed-in"><ProtectedApp path={path}/></Show><Show when="signed-out"><StateScreen kind="signed-out" title="Sign in to open the cockpit" body="The operator cockpit is for authorized facility teams. The public cooling sandbox needs no account." actions={<><button type="button" className="button primary" onClick={()=>navigate("/sign-in")}>Sign in</button><button type="button" className="button secondary" onClick={()=>navigate("/demo/sandbox")}>Open the cooling sandbox</button></>}/></Show></>;
}