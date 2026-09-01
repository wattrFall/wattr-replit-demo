import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Show, SignIn, SignUp, useUser } from "@clerk/react";
import {
  Activity, AlertTriangle, ArrowRight, BookOpen, BrainCircuit, Check, CircleHelp,
  Clock3, Cpu, Gauge, GitBranch, History, LayoutDashboard, Menu, Pause, Play,
  RotateCcw, ShieldCheck, SlidersHorizontal, Thermometer,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import { snapshotForAudit } from "@/lib/cockpit/simulation";

type Me = { id: string; display_name: string; role: "PORTFOLIO_MANAGER" | "OPERATOR" | "ENGINEER" | "MODEL_ADMIN" | "VIEWER"; theme: string };
type Facility = { id: string; name: string; location: string; model_version: string; provenance: "SIMULATED"; can_operate: boolean; can_edit_model: boolean };
type Audit = { id: number; action: string; scenario_id: string; simulated_at: number; model_version: string; payload: { recommendationId?: string; outcome?: string; snapshot?: ReturnType<typeof snapshotForAudit> }; created_at: string };
type SessionData = { me: Me; facilities: Facility[] };

const mono = "font-[family-name:var(--font-mono)]";
const navigate = (path: string) => {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function Brand() {
  return <button onClick={() => navigate("/")} className="flex items-center gap-2.5 text-left"><span className="grid h-8 w-8 place-items-center rounded-md bg-cyan-400 text-slate-950"><Activity size={18}/></span><span><b className="block text-sm tracking-[.18em]">WATTR</b><small className="block text-[9px] tracking-[.2em] text-slate-500">OPERATOR COCKPIT</small></span></button>;
}

function Status({ children, tone = "good" }: { children: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

function Metric({ label, value, unit, sub, warn }: { label: string; value: string; unit?: string; sub: string; warn?: boolean }) {
  return <div className="panel metric"><div className="text-[10px] uppercase tracking-[.16em] text-slate-500">{label}</div><div className={`mt-3 text-2xl font-semibold ${warn ? "text-amber-300" : "text-slate-100"}`}>{value}<small className="ml-1 text-xs font-normal text-slate-500">{unit}</small></div><div className="mt-2 text-[11px] text-slate-500">{sub}</div></div>;
}

function PageHead({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className={`${mono} mb-2 text-[10px] tracking-[.2em] text-cyan-400`}>{eyebrow}</div><h1 className="text-2xl font-semibold tracking-tight text-slate-100 md:text-3xl">{title}</h1><p className="mt-1 text-sm text-slate-500">{detail}</p></div>{action}</div>;
}

function Shell({ data, facility, children }: { data: SessionData; facility?: Facility; children: ReactNode }) {
  const [mobile, setMobile] = useState(false);
  const active = facility ?? data.facilities[0];
  const nav: Array<[LucideIcon, string, string]> = active ? [
    [LayoutDashboard, "Portfolio", "/portfolio"],
    [Gauge, "Operations", `/facilities/${active.id}/operations`],
    [AlertTriangle, "Incident", `/facilities/${active.id}/incidents/inc-204`],
    [ShieldCheck, "Recommendation", `/facilities/${active.id}/recommendations/rec-17`],
    [History, "Audit history", `/facilities/${active.id}/audit`],
    [GitBranch, "Thermal graph", `/facilities/${active.id}/topology`],
    ...(active.can_edit_model ? [[SlidersHorizontal, "Model Studio", `/facilities/${active.id}/model`] as [LucideIcon, string, string]] : []),
  ] : [];
  return <div className="min-h-[100dvh] bg-[#0a1018] text-slate-200">
    <header className="fixed inset-x-0 top-0 z-30 flex h-[62px] items-center justify-between border-b border-slate-800 bg-[#0a1018]/95 px-4"><div className="flex items-center gap-4"><button className="md:hidden" onClick={() => setMobile(!mobile)} aria-label="Open navigation"><Menu size={20}/></button><Brand/></div><div className="flex items-center gap-3 text-xs"><span className="hidden text-slate-500 sm:inline">SYNTHETIC ENVIRONMENT</span><Status>{data.me.role.replace(/_/g, " ")}</Status></div></header>
    <aside className={`fixed bottom-0 left-0 top-[62px] z-20 w-[232px] border-r border-slate-800 bg-[#0b121c] p-3 transition-transform md:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}><div className="mb-5 rounded-md border border-slate-800 bg-[#101a26] p-3"><div className="text-[9px] tracking-[.18em] text-slate-500">AUTHORIZED FACILITY</div><div className="mt-1 text-sm font-semibold">{active?.name ?? "No facility access"}</div><div className="text-[11px] text-slate-500">{active?.location}</div></div><div className="space-y-1">{nav.map(([Icon, label, path]) => <button key={label} onClick={() => navigate(path)} className={`cockpit-nav ${location.pathname === path ? "active" : ""}`}><Icon size={16}/>{label}</button>)}</div><div className="absolute bottom-5 left-3 right-3 border-t border-slate-800 pt-3"><button onClick={() => navigate("/help")} className="cockpit-nav"><CircleHelp size={16}/>Help & tutorials</button></div></aside>
    <main className="pt-[62px] md:pl-[232px]"><div className="mx-auto max-w-[1600px] p-4 md:p-7">{children}</div></main>
  </div>;
}

function Portfolio({ data }: { data: SessionData }) {
  const snapshot = useScenarioSession((s) => s.simulation.snapshot);
  return <Shell data={data}><PageHead eyebrow={`PORTFOLIO COMMAND / ${data.facilities.length.toString().padStart(2, "0")} AUTHORIZED`} title="Facility health" detail="Only facilities permitted by your server-side grants appear here."/><div className="grid gap-3 md:grid-cols-4"><Metric label="Sites monitored" value={String(data.facilities.length).padStart(2, "0")} sub="permission-filtered"/><Metric label="Fleet headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}% load`}/><Metric label="Open incidents" value={snapshot.incident.open ? "01" : "00"} sub={snapshot.incident.open ? "requires review" : "no active forecast"} warn={snapshot.incident.open}/><Metric label="Fleet PUE" value={snapshot.pue.toFixed(3)} sub="physical simulation"/></div><section className="panel mt-5 overflow-hidden"><div className="border-b border-slate-800 px-5 py-4"><h2 className="font-semibold">Authorized sites</h2></div>{data.facilities.map(f => <button key={f.id} onClick={() => navigate(`/facilities/${f.id}/operations`)} className="facility-row"><div><b>{f.name}</b><div className="mt-1 text-xs text-slate-500">{f.location}</div></div><div className="flex items-center gap-4"><Status tone={snapshot.incident.open ? "warn" : "good"}>{snapshot.incident.open ? "Watch" : "Nominal"}</Status><span className={`${mono} text-[10px] text-slate-500`}>{f.provenance}</span><ArrowRight size={16}/></div></button>)}{data.facilities.length === 0 && <p className="p-6 text-sm text-slate-500">No facility grants are assigned to this account.</p>}</section></Shell>;
}

function useScenarioClock() {
  const playing = useScenarioSession((s) => s.playing);
  const speed = useScenarioSession((s) => s.speed);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const state = useScenarioSession.getState();
      state.advance(state.speed);
    }, 1000);
    return () => clearInterval(timer);
  }, [playing]);
}

function Operations({ data, facility }: { data: SessionData; facility: Facility }) {
  const s = useScenarioSession();
  const snapshot = s.simulation.snapshot;
  return <Shell data={data} facility={facility}><PageHead eyebrow={`FACILITY / ${facility.id.toUpperCase()} / OPERATIONS`} title={facility.name} detail={`${facility.location} · deterministic GPU Training Ramp · ${facility.provenance}`} action={<div className="flex gap-2"><button className="button secondary" onClick={() => s.setPlaying(!s.playing)}>{s.playing ? <Pause size={15}/> : <Play size={15}/>} {s.playing ? "Pause" : "Play"}</button><button className="button secondary" onClick={s.reset}><RotateCcw size={15}/>Reset</button></div>}/><div className="mb-4 flex flex-wrap items-center gap-3 border-y border-slate-800 py-2.5"><span className={mono}>{formatSimulatedAt(s.simulatedAt)}</span><div className="ml-auto flex gap-1">{([1,5,10,30,60] as const).map(v => <button key={v} onClick={() => s.setSpeed(v)} className={`speed ${s.speed === v ? "selected" : ""}`}>{v}×</button>)}</div><Status tone={s.mode === "Advisory" ? "warn" : "good"}>{s.mode} mode</Status></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`GPU ramp at ${snapshot.workloadPercent}%`}/><Metric label="Total facility" value={snapshot.totalPowerKw.toLocaleString()} unit="kW" sub="physical power balance"/><Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn={snapshot.peakInletC >= snapshot.incident.limitC}/><Metric label="PUE" value={snapshot.pue.toFixed(3)} sub="physical simulation"/><Metric label="Headroom" value={snapshot.headroomKw.toLocaleString()} unit="kW" sub="rated capacity"/></div><div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_.8fr]"><section className="panel min-h-[430px] overflow-hidden"><div className="border-b border-slate-800 p-5"><h2 className="font-semibold">Synchronized facility twin</h2><p className="text-xs text-slate-500">Workload → power → heat → CDU-03 response · {snapshot.coolingUnitCount} cooling unit</p></div><div className="twin-canvas"><div className="twin-grid"/><div className="twin-core"><Cpu size={28}/><b>GPU HALL</b><small>CLUSTER B · {snapshot.itPowerKw.toLocaleString()} kW</small></div>{snapshot.racks.map((rack,i)=><button key={rack.id} onClick={() => navigate(`/facilities/${facility.id}/incidents/inc-204`)} className={`rack rack-${i} ${rack.atRisk?"hot":""}`}><span>{rack.id}</span><i style={{height:`${Math.min(100, Math.max(20, ((rack.inletC - 20) / (rack.limitC - 20)) * 100))}%`}}/></button>)}</div></section><aside className="space-y-4"><section className="panel p-5"><div className="eyebrow">FORECAST RISK</div><h2 className={`mt-2 text-xl font-semibold ${snapshot.forecast.risk === "clear" ? "text-teal-300" : "text-amber-300"}`}>{snapshot.forecast.risk === "clear" ? "Clear condition" : `${snapshot.incident.severity} condition`}</h2><p className="mt-4 text-sm leading-6 text-slate-400">{snapshot.incident.rackId} forecast peak {snapshot.forecast.baselinePeakC.toFixed(1)}°C in the next ${Math.round(snapshot.forecast.horizonS / 60)} minutes against a ${snapshot.incident.limitC.toFixed(1)}°C limit.</p><button onClick={() => navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="button primary mt-4 w-full justify-center">Review advisory <ArrowRight size={15}/></button></section><section className="panel p-5"><div className="eyebrow">OPERATING MODE</div><select value={s.mode} onChange={e=>s.setMode(e.target.value as typeof s.mode)} className="select mt-4 w-full"><option>Observe</option><option>Shadow</option><option>Advisory</option></select><p className="mt-3 text-xs leading-5 text-slate-500">Human approval is always required. No OT commands are issued.</p></section></aside></div></Shell>;
}

function Recommendation({ data, facility }: { data: SessionData; facility: Facility }) {
  const s = useScenarioSession();
  const snapshot = s.simulation.snapshot;
  const [checked,setChecked]=useState(false),[evaluationId,setEvaluationId]=useState(""),[recorded,setRecorded]=useState(false),[error,setError]=useState("");
  const evaluate=async()=>{setError("");try{const result=await api<{id:string;outcome:string}>(`/api/facilities/${facility.id}/recommendations/rec-17/evaluate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({simulatedAt:s.simulatedAt})});setEvaluationId(result.id);setChecked(result.outcome==="PASS");}catch(e){setError(e instanceof Error?e.message:"Safety evaluation failed");}};
  const approve=async()=>{setError("");try{await api(`/api/facilities/${facility.id}/audit`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"APPROVE_ADVISORY",simulatedAt:s.simulatedAt,safetyEvaluationId:evaluationId,payload:{recommendationId:snapshot.recommendation.id,outcome:"ALLOWED_AS_ADVISORY",command:{assetId:"cdu-03",flowPercent:snapshot.recommendation.flowPercent,durationMinutes:snapshot.recommendation.durationMinutes},provenance:"SIMULATED",snapshot:snapshotForAudit(snapshot)}})});setRecorded(true);}catch(e){setError(e instanceof Error?e.message:"Decision failed");}};
  const safetyLabels: Array<[keyof typeof snapshot.safety.checks, string]> = [["commandEnvelope","Command envelope"],["coolingHeadroom","Cooling headroom"],["maintenanceState","Maintenance state"],["modelConfidence","Model confidence"]];
  return <Shell data={data} facility={facility}><PageHead eyebrow="TRUST COCKPIT / REC-17" title="Pre-emptive flow adjustment" detail="Same-input synthetic counterfactual; advisory only." action={<Status tone={recorded?"good":"warn"}>{recorded?"RECORDED":"AWAITING REVIEW"}</Status>}/><div className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]"><section className="panel p-6"><div className="eyebrow">WHAT / WHY / WHERE / EFFECT</div><h2 className="mt-3 text-xl font-semibold">Increase CDU-03 flow to {snapshot.recommendation.flowPercent}% for {snapshot.recommendation.durationMinutes} minutes</h2><p className="copy">Reduce predicted {snapshot.incident.rackId} peak inlet by {snapshot.recommendation.reductionC.toFixed(1)}°C before the GPU Training Ramp reaches steady state.</p><div className="mt-6 grid gap-3 sm:grid-cols-2"><Metric label="Baseline peak" value={snapshot.recommendation.baselinePeakC.toFixed(1)} unit="°C" sub={`${snapshot.forecast.baselineConstraintMinutes.toFixed(1)} constraint minutes`} warn/><Metric label="Advisory peak" value={snapshot.recommendation.advisoryPeakC.toFixed(1)} unit="°C" sub={`${snapshot.forecast.advisoryConstraintMinutes.toFixed(1)} constraint minutes`}/></div></section><aside className="panel p-6"><div className="flex items-center gap-3"><ShieldCheck className="text-teal-300"/><h2 className="font-semibold">Safety Shield · {snapshot.safety.outcome}</h2></div>{safetyLabels.map(([key,x])=><div className="check-row" key={x}><span className={`check ${snapshot.safety.checks[key]?"pass":""}`}>{snapshot.safety.checks[key]?<Check size={12}/>:<Clock3 size={12}/>}</span>{x}</div>)}<button onClick={evaluate} className="button secondary mt-5 w-full justify-center">{checked?"Server evaluation passed":"Run safety evaluation"}</button>{facility.can_operate?<button disabled={!checked||recorded||snapshot.safety.outcome==="BLOCK"} onClick={approve} className="button primary mt-2 w-full justify-center">{recorded?"Decision recorded":"Approve advisory"}</button>:<p className="mt-4 rounded border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-amber-200">Read-only role: operator permission is required to record a decision.</p>}{error&&<p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}<p className="mt-3 text-[10px] text-slate-500">Flow envelope {snapshot.plant.commandEnvelope.minFlowPercent}–{snapshot.plant.commandEnvelope.maxFlowPercent}% · maintenance lockout {snapshot.plant.maintenanceLockout ? "active" : "clear"} · model domain ≤ {snapshot.plant.modelDomainMaxC}°C</p><button onClick={()=>navigate(`/facilities/${facility.id}/audit`)} className="mt-4 w-full text-xs text-cyan-300">View audit history</button></aside></div></Shell>;
}

function AuditPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const snapshot = useScenarioSession((s) => s.simulation.snapshot);
  const [records,setRecords]=useState<Audit[]>([]),[error,setError]=useState("");
  useEffect(()=>{api<Audit[]>(`/api/facilities/${facility.id}/audit`).then(setRecords).catch(e=>setError(String(e)));},[facility.id]);
  return <Shell data={data} facility={facility}><PageHead eyebrow="AUDIT HISTORY" title="Reconstructable decisions" detail="Immutable records filtered by your facility permission."/><section className="panel mb-4 p-5"><div className="eyebrow">CURRENT REPLAY SNAPSHOT</div><div className="mt-3 grid gap-3 sm:grid-cols-4"><Metric label="Simulated at" value={formatSimulatedAt(snapshot.simulatedAt).slice(11)} sub={`${Math.round(snapshot.elapsedS / 60)}m into ramp`}/><Metric label="IT power" value={snapshot.itPowerKw.toLocaleString()} unit="kW" sub={`workload ${snapshot.workloadPercent}%`}/><Metric label="Peak inlet" value={snapshot.peakInletC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`}/><Metric label="Forecast" value={snapshot.forecast.baselinePeakC.toFixed(1)} unit="°C" sub={`${snapshot.forecast.horizonS / 60}m horizon`}/></div></section><section className="panel overflow-hidden">{records.map(r=><article key={r.id} className="facility-row"><div><Status>{r.action.replace(/_/g," ")}</Status><h2 className="mt-2 font-semibold">Recommendation {r.payload.recommendationId}</h2><p className="mt-1 text-xs text-slate-500">{new Date(r.created_at).toLocaleString()} · {r.model_version}</p>{r.payload.snapshot&&<p className="mt-1 text-[11px] text-cyan-300">Replayed {r.payload.snapshot.itPowerKw} kW · peak {r.payload.snapshot.peakInletC}°C · PUE {r.payload.snapshot.pue}</p>}</div><div className="text-right"><b>{r.payload.outcome}</b><p className={`${mono} mt-1 text-[10px] text-slate-500`}>{formatSimulatedAt(r.simulated_at)}</p></div></article>)}{records.length===0&&!error&&<p className="p-6 text-sm text-slate-500">No operator decisions have been recorded yet.</p>}{error&&<p role="alert" className="p-6 text-red-300">{error}</p>}</section></Shell>;
}

function Workspace({ data, facility, kind }: { data: SessionData; facility: Facility; kind: string }) {
  const names:Record<string,string>={incidents:"Incident investigation",topology:"Thermal Dependency Graph",model:"Model Studio","model-lab":"Model Lab"};
  const snapshot = useScenarioSession((s) => s.simulation.snapshot);
  return <Shell data={data} facility={facility}><PageHead eyebrow={kind.toUpperCase()} title={names[kind]??"Operator guide"} detail="Synchronized synthetic context; no closed-loop control."/><div className="grid gap-4 lg:grid-cols-2"><section className="panel p-6"><Thermometer className="text-amber-300"/><h2 className="mt-4 text-xl font-semibold">{kind==="incidents"?`${snapshot.incident.rackId} forecast constraint during GPU Training Ramp`:"SFO-01 operating representation"}</h2><p className="copy">{kind==="incidents"?`The physical replay forecasts ${snapshot.incident.peakC.toFixed(1)}°C against a ${snapshot.incident.limitC.toFixed(1)}°C limit in ${Math.round(snapshot.forecast.horizonS / 60)} minutes.`:`Trace ${snapshot.itPowerKw.toLocaleString()} kW workload, ${snapshot.peakInletC.toFixed(1)}°C inlet heat, ${snapshot.pue.toFixed(3)} PUE, cooling response, and model provenance from one versioned scenario.`}</p>{kind==="incidents"&&<div className="mt-5 grid gap-3 sm:grid-cols-3"><Metric label="Severity" value={snapshot.incident.severity} sub={snapshot.incident.open?"open forecast":"cleared"} warn={snapshot.incident.open}/><Metric label="Peak inlet" value={snapshot.incident.peakC.toFixed(1)} unit="°C" sub={`limit ${snapshot.incident.limitC.toFixed(1)}°C`} warn/><Metric label="At risk now" value={String(snapshot.racksAtRisk)} sub={`of ${snapshot.rackCount} racks`}/></div>}</section><section className="panel p-6"><GitBranch className="text-cyan-300"/><h2 className="mt-4 font-semibold">Operating thread</h2><p className="mt-2 text-xs text-slate-500">Replay timestamp {formatSimulatedAt(snapshot.simulatedAt)} · forecast risk {snapshot.forecast.risk}</p><button onClick={()=>navigate(`/facilities/${facility.id}/recommendations/rec-17`)} className="action-row">Open recommendation <ArrowRight size={14}/></button><button onClick={()=>navigate(`/facilities/${facility.id}/operations`)} className="action-row">Return to operations <ArrowRight size={14}/></button></section></div></Shell>;
}

function Landing(){return <div className="min-h-screen bg-[#0a1018] text-slate-200"><header className="flex justify-between border-b border-slate-800 p-5"><Brand/><button onClick={()=>navigate("/sign-in")} className="button secondary">Operator sign in</button></header><main className="mx-auto max-w-6xl px-6 py-24"><div className="eyebrow text-cyan-400">THERMAL OPERATIONS / COMMAND ENVIRONMENT</div><h1 className="mt-5 max-w-4xl text-5xl font-semibold tracking-[-.04em] md:text-7xl">Make the cooling decision before the constraint arrives.</h1><p className="mt-7 max-w-2xl text-lg leading-8 text-slate-400">Wattr turns workload intent into power, heat, forecast risk, a safety-checked advisory, and an auditable operator decision.</p><div className="mt-9 flex gap-3"><button onClick={()=>navigate("/sign-in")} className="button primary">Enter cockpit <ArrowRight size={15}/></button><button onClick={()=>navigate("/demo/sandbox")} className="button secondary">Explore sandbox</button></div></main></div>}
function Auth({up=false}:{up?:boolean}){return <div className="grid min-h-screen place-items-center bg-[#0a1018] p-5"><div className="w-full max-w-[460px]"><Brand/><div className="mt-8">{up?<SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/portfolio"/>:<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/portfolio"/>}</div></div></div>}

function ProtectedApp({path}:{path:string}){
  const [data,setData]=useState<SessionData|null>(null),[error,setError]=useState("");
  useEffect(()=>{Promise.all([api<Me>("/api/me"),api<Facility[]>("/api/facilities")]).then(([me,facilities])=>setData({me,facilities})).catch(e=>setError(String(e)));},[]);
  if(error)return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-red-300">{error}</div>;
  if(!data)return <div className="grid min-h-screen place-items-center bg-[#0a1018] text-cyan-300">Loading authorized facility context…</div>;
  if(path==="/portfolio")return <Portfolio data={data}/>;
  if(path==="/help")return <Shell data={data}><PageHead eyebrow="HELP" title="Operator guide" detail="Observe, Shadow, and Advisory retain human authority."/><div className="panel p-6"><BookOpen/><p className="copy">All metrics are simulated. Restart the GPU Training Ramp from Operations at any time.</p></div></Shell>;
  const match=path.match(/^\/facilities\/([^/]+)\/([^/]+)/), facility=match&&data.facilities.find(f=>f.id===match[1]);
  if(!match||!facility)return <Shell data={data}><PageHead eyebrow="ACCESS" title="Facility unavailable" detail="This facility is not present in your authorized API response."/></Shell>;
  const section=match[2];
  if(section==="operations")return <Operations data={data} facility={facility}/>;
  if(section==="recommendations")return <Recommendation data={data} facility={facility}/>;
  if(section==="audit")return <AuditPage data={data} facility={facility}/>;
  if(section==="model"&&!facility.can_edit_model)return <Shell data={data} facility={facility}><PageHead eyebrow="FORBIDDEN" title="Model Studio access required" detail="Your role cannot edit or publish facility models."/></Shell>;
  return <Workspace data={data} facility={facility} kind={section}/>;
}

export function CockpitApp(){
  const [path,setPath]=useState(location.pathname),{isSignedIn}=useUser();
  useScenarioClock();
  useEffect(()=>{const on=()=>setPath(location.pathname);addEventListener("popstate",on);return()=>removeEventListener("popstate",on)},[]);
  useEffect(()=>{if(path==="/"&&isSignedIn)navigate("/portfolio")},[path,isSignedIn]);
  if(path==="/demo/sandbox")return <SandboxShell/>;
  if(path.startsWith("/sign-in"))return <Auth/>;
  if(path.startsWith("/sign-up"))return <Auth up/>;
  if(path==="/")return <Landing/>;
  return <><Show when="signed-in"><ProtectedApp path={path}/></Show><Show when="signed-out"><div className="grid min-h-screen place-items-center bg-[#0a1018]"><button onClick={()=>navigate("/sign-in")} className="button primary">Sign in for authorized access</button></div></Show></>;
}