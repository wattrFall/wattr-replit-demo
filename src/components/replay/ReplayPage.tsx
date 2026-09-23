import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, FileUp, FlaskConical, Play, Save, Thermometer, Upload } from "lucide-react";
import { api, describeError, post } from "@/components/cockpit/api";
import { Shell } from "@/components/cockpit/Shell";
import type { Facility, SessionData } from "@/components/cockpit/types";
import { Metric, PageHead, Status, mono } from "@/components/cockpit/ui";
import { supportedReplayRackIds } from "@/lib/replay/engine";
import type { HistoricalReplayResult, ReplayValidation } from "@/lib/replay/types";

type ModelVersion = { id: string; status: string; config: Facility["model_config"] };
type Dataset = {
  id: string; model_version_id: string; source: "UPLOADED_CSV" | "SYNTHETIC_DEMO"; source_name: string;
  checksum: string; validation: ReplayValidation; period_start_at: number; period_end_at: number; created_at: string;
};
type Scenario = {
  id: string; datasetId: string; name: string; status: string; periodStartAt: number; periodEndAt: number;
  historicalModelVersionId: string; relocation: { rackId: string; to: { x: number; z: number } }; source: Dataset["source"];
  validationStatus: string; assumptions: string[]; missingInputs: string[];
};
const formatTime = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();
const delta = (value: number, unit: string) => `${value > 0 ? "+" : ""}${value.toFixed(value % 1 === 0 ? 0 : 2)}${unit}`;
type ComparisonRow = { label: string; value: HistoricalReplayResult["metrics"]["thermalPeakC"]; unit: string };

function SpatialTwin({
  title, positions, current, baseline, relocatedRackId, candidate, bounds,
}: {
  title: string;
  positions: HistoricalReplayResult["spatialLayouts"]["baselineRacks"];
  current: HistoricalReplayResult["baselineRawOutputs"][number] | undefined;
  baseline: HistoricalReplayResult["baselineRawOutputs"][number] | undefined;
  relocatedRackId: string;
  candidate: boolean;
  bounds: { minX: number; minZ: number; width: number; height: number };
}) {
  const unit = 42;
  const width = Math.max(260, bounds.width * unit + 64);
  const height = Math.max(210, bounds.height * unit + 64);
  const rowById = new Map(current?.racks.map((rack) => [rack.rackId, rack]));
  const baselineById = new Map(baseline?.racks.map((rack) => [rack.rackId, rack]));
  const fill = (temperature: number, limit: number) => temperature >= limit ? "#dc6b52" : temperature >= limit - 2 ? "#d9a441" : "#249c91";
  return <div className="subpanel overflow-x-auto">
    <div className="flex items-center justify-between gap-2"><b className="text-sm">{title}</b><span className="text-[10px] text-slate-500">overhead rack grid · simulated inlet °C</span></div>
    <svg className="mt-3 min-w-[260px] rounded border border-slate-700 bg-[#07101a]" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} spatial thermal rack layout`}>
      {Array.from({ length: bounds.width + 1 }, (_, index) => <line key={`x${index}`} x1={32 + index * unit} x2={32 + index * unit} y1="24" y2={height - 24} stroke="#203143" strokeWidth="1"/>)}
      {Array.from({ length: bounds.height + 1 }, (_, index) => <line key={`z${index}`} x1="32" x2={width - 24} y1={24 + index * unit} y2={24 + index * unit} stroke="#203143" strokeWidth="1"/>)}
      {positions.map((position) => {
        const rack = rowById.get(position.rackId);
        const original = baselineById.get(position.rackId);
        const px = 34 + (position.x - bounds.minX) * unit;
        const py = 26 + (position.z - bounds.minZ) * unit;
        const moved = position.rackId === relocatedRackId;
        const change = rack && original ? rack.inletC - original.inletC : 0;
        return <g key={position.rackId}>
          <rect x={px} y={py} width={unit - 4} height={unit - 4} rx="3" fill={rack ? fill(rack.inletC, rack.limitC) : "#475569"} stroke={moved ? "#7dd3fc" : "#9fb3c8"} strokeWidth={moved ? "2.5" : "1"}/>
          <text x={px + 4} y={py + 13} fill="#f1f5f9" fontSize="8">{position.rackId.replace("rack-", "")}</text>
          <text x={px + 4} y={py + 25} fill="#f1f5f9" fontSize="9">{rack?.inletC.toFixed(1)}°</text>
          {candidate && <text x={px + 4} y={py + 34} fill={change > 0 ? "#fed7aa" : "#a7f3d0"} fontSize="7">{delta(change, "°")}</text>}
        </g>;
      })}
      <text x="6" y="16" fill="#64748b" fontSize="8">X</text><text x="6" y={height - 8} fill="#64748b" fontSize="8">Z</text>
    </svg>
    <p className="mt-2 text-[11px] text-slate-500">{candidate ? `Outlined rack ${relocatedRackId} is the proposed relocated asset; labels show candidate delta against the same timestamp baseline.` : "Rack IDs and locations come from the immutable baseline model snapshot."}</p>
  </div>;
}

/** Engineer-only write controls are also enforced by the server's facility grant. */
export function ScenarioReplayPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedVersion, setSelectedVersion] = useState(() => new URLSearchParams(window.location.search).get("modelVersion") ?? facility.model_version);
  const [selectedDataset, setSelectedDataset] = useState("");
  const [selectedScenario, setSelectedScenario] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("Rack relocation review");
  const [periodStartAt, setPeriodStartAt] = useState(0);
  const [periodEndAt, setPeriodEndAt] = useState(0);
  const [rackId, setRackId] = useState("");
  const [x, setX] = useState(18);
  const [z, setZ] = useState(13);
  const [saveForReview, setSaveForReview] = useState(true);
  const [result, setResult] = useState<HistoricalReplayResult | null>(null);
  const [rawTime, setRawTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    const [history, datasetResponse, scenarioResponse] = await Promise.all([
      api<{ modelVersions: ModelVersion[] }>(`/api/facilities/${facility.id}/history`),
      api<{ items: Dataset[] }>(`/api/facilities/${facility.id}/replay/datasets`),
      api<{ items: Scenario[] }>(`/api/facilities/${facility.id}/replay/scenarios`),
    ]);
    setVersions(history.modelVersions);
    setDatasets(datasetResponse.items);
    setScenarios(scenarioResponse.items);
  };
  useEffect(() => { void load().catch((cause) => setError(describeError(cause))); }, [facility.id]);
  const selectedModel = versions.find((version) => version.id === selectedVersion) ?? (selectedVersion === facility.model_version ? { id: facility.model_version, config: facility.model_config, status: "PUBLISHED" } : undefined);
  const racks = useMemo(() => selectedModel ? supportedReplayRackIds(selectedModel.config) : [], [selectedModel]);
  const dataset = datasets.find((item) => item.id === selectedDataset);
  useEffect(() => {
    if (racks.length && !racks.includes(rackId)) setRackId(racks[0]);
  }, [racks, rackId]);
  useEffect(() => {
    if (!dataset) return;
    setPeriodStartAt(dataset.period_start_at);
    setPeriodEndAt(dataset.period_end_at);
  }, [dataset?.id]);
  const periodTimes = dataset?.validation.timestamps ?? [];
  const canWrite = facility.can_engineer;

  const upload = async (synthetic = false) => {
    if (!canWrite) return;
    if (!selectedModel) return setError("Choose an available historical model version first.");
    if (!synthetic && !file) return setError("Choose a CSV file to upload.");
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await post<Dataset>(`/api/facilities/${facility.id}/replay/datasets`, synthetic
        ? { source: "SYNTHETIC_DEMO", modelVersionId: selectedModel.id }
        : { sourceName: file!.name, csv: await file!.text(), modelVersionId: selectedModel.id });
      await load();
      setSelectedDataset(response.id);
      setMessage(synthetic ? "Synthetic demo data saved separately from uploaded history." : "Historical CSV validated and stored.");
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  };
  const createScenario = async () => {
    if (!dataset || !canWrite) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await post<Scenario>(`/api/facilities/${facility.id}/replay/scenarios`, {
        datasetId: dataset.id, name, periodStartAt, periodEndAt,
        relocation: { rackId, to: { x, z } }, saveForReview,
      });
      await load();
      setSelectedScenario(response.id);
      setMessage(response.status === "SAVED_FOR_REVIEW" ? "Scenario saved for engineering review; baseline remains immutable." : "Isolated draft scenario saved.");
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  };
  const run = async (scenarioId = selectedScenario) => {
    if (!scenarioId || !canWrite) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const replay = await post<HistoricalReplayResult>(`/api/facilities/${facility.id}/replay/scenarios/${scenarioId}/run`, {});
      setResult(replay); setRawTime(replay.baselineRawOutputs[0]?.timestamp ?? 0);
      setMessage("Simulated thermal replay persisted for review.");
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  };
  const selectedRawIndex = Math.max(0, result?.baselineRawOutputs.findIndex((point) => point.timestamp === rawTime) ?? 0);
  const baselineRaw = result?.baselineRawOutputs[selectedRawIndex];
  const candidateRaw = result?.candidateRawOutputs[selectedRawIndex];

  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="SCENARIO REPLAY / HISTORICAL INPUTS" title="Historical Scenario Replay" detail="Fork a historical model, hold validated boundary conditions constant, and evaluate one rack relocation. Results are simulated—not measured telemetry." action={<button type="button" className="button secondary" onClick={() => history.back()}>Back to history</button>}/>
    {!canWrite && <section className="panel mb-4 p-4 text-sm text-amber-200"><Status tone="warn">READ ONLY</Status><p className="mt-2">Your facility grant can inspect historical scenarios, but only the Engineer role can upload inputs, fork a scenario, or run a replay.</p></section>}
    {(error || message) && <p className={`mb-4 rounded-md border p-3 text-sm ${error ? "border-red-400/40 text-red-300" : "border-teal-400/30 text-teal-200"}`} role={error ? "alert" : "status"}>{error || message}</p>}
    <div className="grid gap-4 xl:grid-cols-[minmax(330px,.75fr)_minmax(0,1.25fr)]">
      <section className="space-y-4">
        <section className="panel p-5">
          <div className="flex items-center gap-2"><FileUp size={17} className="text-cyan-300"/><h2 className="font-semibold">1. Historical input dataset</h2></div>
          <p className="mt-2 text-xs leading-5 text-slate-500">CSV requires timestamp, rack_id, workload_kw, rack_power_kw, ambient_c, and cooling_supply_c. Optional cooling_flow_pct and initial_inlet_c are validated when supplied; without complete initial inlet values, both branches disclose the documented 30°C synthetic initial state.</p>
          <label className="field mt-4 block">Historical model version<select className="select mt-2 w-full" value={selectedVersion} disabled={!canWrite} onChange={(event) => setSelectedVersion(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>{version.id} · {version.status}</option>)}</select></label>
          <label className="field mt-3 block">Upload historical CSV<input type="file" accept=".csv,text/csv" className="input mt-2 w-full" disabled={!canWrite || busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)}/></label>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="button primary" disabled={!canWrite || busy || !file} onClick={() => void upload()}><Upload size={14}/>Validate & store CSV</button><button type="button" className="button secondary" disabled={!canWrite || busy} onClick={() => void upload(true)}><FlaskConical size={14}/>Use synthetic demo data</button></div>
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Synthetic demo data is explicitly marked and stored separately. It is never represented as uploaded facility history.</p>
          <label className="field mt-4 block">Stored dataset<select className="select mt-2 w-full" value={selectedDataset} onChange={(event) => setSelectedDataset(event.target.value)}><option value="">Choose validated dataset</option>{datasets.map((item) => <option key={item.id} value={item.id}>{item.source === "SYNTHETIC_DEMO" ? "SYNTHETIC DEMO" : "UPLOADED"} · {item.source_name}</option>)}</select></label>
          {dataset && <div className="mt-3 rounded border border-slate-800 bg-black/10 p-3 text-xs"><div className="flex justify-between gap-2"><b>{dataset.source === "SYNTHETIC_DEMO" ? "Synthetic demo dataset" : "Uploaded historical data"}</b><Status tone={dataset.validation.valid ? "good" : "bad"}>{dataset.validation.valid ? "VALID" : "INVALID"}</Status></div><p className="mt-2 text-slate-500">{formatTime(dataset.period_start_at)} → {formatTime(dataset.period_end_at)}</p><p className={`${mono} mt-2 text-[10px] text-slate-500`}>input checksum {dataset.checksum}</p></div>}
        </section>
        <section className="panel p-5">
          <div className="flex items-center gap-2"><Thermometer size={17} className="text-cyan-300"/><h2 className="font-semibold">Input validation</h2></div>
          {dataset ? <div className="mt-4 grid grid-cols-2 gap-2 text-xs">{Object.entries(dataset.validation.inputStatus).map(([name, state]) => <div key={name} className="subpanel"><span className="text-slate-500">{name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}</span><b className={`mt-1 block ${state === "PRESENT" ? "text-teal-300" : "text-red-300"}`}>{state}</b></div>)}</div> : <p className="mt-3 text-xs text-slate-500">Select a dataset to inspect source, completeness, and missing inputs.</p>}
          {dataset?.validation.errors.map((item) => <p key={item} className="mt-2 text-xs text-red-300">{item}</p>)}
          {dataset?.validation.warnings.map((item) => <p key={item} className="mt-2 text-xs text-amber-200">{item}</p>)}
        </section>
      </section>
      <section className="panel p-5">
        <div className="flex items-center gap-2"><FlaskConical size={17} className="text-cyan-300"/><h2 className="font-semibold">2. Fork historical state</h2></div>
        <p className="mt-2 text-xs leading-5 text-slate-500">The baseline stores an immutable snapshot of the selected historical model. Candidate edits are isolated to one supported rack relocation.</p>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <label className="field">Scenario name<input className="input mt-2 w-full" value={name} disabled={!canWrite} onChange={(event) => setName(event.target.value)}/></label>
          <label className="field">Rack / thermal load<select className="select mt-2 w-full" value={rackId} disabled={!canWrite || !dataset} onChange={(event) => setRackId(event.target.value)}>{racks.map((rack) => <option key={rack} value={rack}>{rack}</option>)}</select></label>
          <label className="field">Period start<select className="select mt-2 w-full" value={periodStartAt} disabled={!canWrite || !dataset} onChange={(event) => setPeriodStartAt(Number(event.target.value))}>{periodTimes.slice(0, -1).map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}</select></label>
          <label className="field">Period end<select className="select mt-2 w-full" value={periodEndAt} disabled={!canWrite || !dataset} onChange={(event) => setPeriodEndAt(Number(event.target.value))}>{periodTimes.filter((time) => time > periodStartAt).map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}</select></label>
          <label className="field">Candidate X<input className="input mt-2 w-full" type="number" value={x} disabled={!canWrite || !dataset} onChange={(event) => setX(Number(event.target.value))}/></label>
          <label className="field">Candidate Z<input className="input mt-2 w-full" type="number" value={z} disabled={!canWrite || !dataset} onChange={(event) => setZ(Number(event.target.value))}/></label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={saveForReview} disabled={!canWrite} onChange={(event) => setSaveForReview(event.target.checked)}/>Save this isolated scenario for engineering review</label>
        <div className="mt-5 flex flex-wrap gap-2"><button type="button" className="button primary" disabled={!canWrite || busy || !dataset || !rackId} onClick={() => void createScenario()}><Save size={14}/>Fork & save scenario</button>{selectedScenario && <button type="button" className="button secondary" disabled={!canWrite || busy} onClick={() => void run()}><Play size={14}/>Run selected scenario</button>}</div>
        <div className="mt-5 border-t border-slate-800 pt-4"><div className="eyebrow">SAVED SCENARIOS</div><div className="mt-3 space-y-2">{scenarios.map((scenario) => <button type="button" key={scenario.id} className={`facility-row w-full text-left ${scenario.id === selectedScenario ? "bg-slate-800/60" : ""}`} onClick={() => { setSelectedScenario(scenario.id); setResult(null); }}><span><b>{scenario.name}</b><small className="mt-1 block text-slate-500">{scenario.relocation.rackId} → ({scenario.relocation.to.x}, {scenario.relocation.to.z}) · model {scenario.historicalModelVersionId}</small></span><Status tone={scenario.source === "SYNTHETIC_DEMO" ? "warn" : "good"}>{scenario.status}</Status></button>)}</div>{!scenarios.length && <p className="mt-3 text-xs text-slate-500">No isolated scenarios saved yet.</p>}</div>
      </section>
    </div>
    {result && <section className="mt-4 space-y-4">
      <section className="panel border-amber-400/40 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><Status tone="warn">SIMULATED</Status><h2 className="mt-3 text-xl font-semibold">Baseline vs candidate thermal comparison</h2><p className="mt-2 text-sm leading-6 text-slate-400">{result.limitation}</p></div><CheckCircle2 className="text-amber-200"/></div><div className="mt-4 grid gap-3 md:grid-cols-3 text-xs"><div><span className="text-slate-500">Source / period</span><b className="mt-1 block">{result.source === "SYNTHETIC_DEMO" ? "SYNTHETIC DEMO" : "UPLOADED HISTORY"}</b><small>{formatTime(result.period.startAt)} → {formatTime(result.period.endAt)}</small></div><div><span className="text-slate-500">Historical version</span><b className={`${mono} mt-1 block`}>{result.model.versionId}</b><small>Input fingerprint {result.inputFingerprint.slice(0, 12)}…</small></div><div><span className="text-slate-500">Validation</span><b className="mt-1 block text-teal-300">{result.validationStatus}</b><small>{result.method.replace(/_/g, " ")}</small></div></div></section>
      <section className="panel overflow-x-auto"><table className="data-table min-w-[720px]"><caption className="sr-only">Simulated baseline and candidate thermal comparison</caption><thead><tr><th>Supported thermal metric</th><th>Baseline</th><th>Candidate</th><th>Difference</th></tr></thead><tbody>{([
        { label: "Peak inlet", value: result.metrics.thermalPeakC, unit: "°C" },
        { label: "Mean inlet", value: result.metrics.meanInletC, unit: "°C" },
        { label: "Thermal headroom", value: result.metrics.thermalHeadroomC, unit: "°C" },
        { label: "Hotspot duration", value: result.metrics.hotspotDurationS, unit: " s" },
        { label: "Thermal-limit violations", value: result.metrics.thermalLimitViolations, unit: "" },
      ] satisfies ComparisonRow[]).map(({ label, value: metric, unit }) => <tr key={label}><td><b>{label}</b></td><td>{metric.baseline.toFixed(2)}{unit}</td><td>{metric.candidate.toFixed(2)}{unit}</td><td className={metric.difference > 0 ? "text-amber-200" : "text-teal-300"}>{delta(metric.difference, unit)}</td></tr>)}</tbody></table><p className="p-4 text-xs text-slate-500">{result.unsupportedMetrics.join(" ")}</p></section>
      <section className="panel p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">SPATIAL COMPARISON</div><h2 className="mt-1 font-semibold">Same historical timestamp, two rack layouts</h2></div><label className="field m-0 text-xs">Timestamp<select className="select ml-2" value={rawTime} onChange={(event) => setRawTime(Number(event.target.value))}>{result.baselineRawOutputs.map((point) => <option key={point.timestamp} value={point.timestamp}>{formatTime(point.timestamp)}</option>)}</select></label></div><div className="mt-4 grid gap-4 2xl:grid-cols-2">{(() => { const all = [...result.spatialLayouts.baselineRacks, ...result.spatialLayouts.candidateRacks]; const minX = Math.min(...all.map((rack) => rack.x)) - 1; const minZ = Math.min(...all.map((rack) => rack.z)) - 1; const bounds = { minX, minZ, width: Math.max(...all.map((rack) => rack.x)) - minX + 2, height: Math.max(...all.map((rack) => rack.z)) - minZ + 2 }; return <><SpatialTwin title="Baseline / historical configuration" positions={result.spatialLayouts.baselineRacks} current={baselineRaw} baseline={baselineRaw} relocatedRackId={result.spatialLayouts.relocatedRackId} candidate={false} bounds={bounds}/><SpatialTwin title="Proposed / relocated configuration" positions={result.spatialLayouts.candidateRacks} current={candidateRaw} baseline={baselineRaw} relocatedRackId={result.spatialLayouts.relocatedRackId} candidate bounds={bounds}/></>; })()}</div><div className="mt-4 overflow-x-auto"><table className="data-table min-w-[620px]"><thead><tr><th>Rack</th><th>Baseline inlet</th><th>Candidate inlet</th><th>Difference</th><th>Candidate local spatial term</th></tr></thead><tbody>{baselineRaw?.racks.map((rack) => { const candidate = candidateRaw?.racks.find((item) => item.rackId === rack.rackId); const difference = (candidate?.inletC ?? rack.inletC) - rack.inletC; return <tr key={rack.rackId}><td><b>{rack.rackId}</b></td><td>{rack.inletC.toFixed(2)}°C</td><td>{candidate?.inletC.toFixed(2)}°C</td><td>{delta(difference, "°C")}</td><td>{candidate?.spatialAdjustmentC.toFixed(3)}°C</td></tr>; })}</tbody></table></div></section>
      <details className="disclosure panel"><summary>Raw simulated outputs and time series <span className="text-xs text-slate-500">{result.baselineSeries.length} timestamps</span></summary><div className="disclosure-content overflow-x-auto"><table className="data-table min-w-[800px]"><thead><tr><th>Time</th><th>Baseline peak</th><th>Candidate peak</th><th>Baseline headroom</th><th>Candidate headroom</th><th>Violations B / C</th></tr></thead><tbody>{result.baselineSeries.map((point, index) => { const proposed = result.candidateSeries[index]; return <tr key={point.timestamp}><td>{formatTime(point.timestamp)}</td><td>{point.peakInletC.toFixed(2)}°C</td><td>{proposed.peakInletC.toFixed(2)}°C</td><td>{point.thermalHeadroomC.toFixed(2)}°C</td><td>{proposed.thermalHeadroomC.toFixed(2)}°C</td><td>{point.violations} / {proposed.violations}</td></tr>; })}</tbody></table><div className="mt-4 grid gap-3 md:grid-cols-2"><div className="subpanel"><span className="eyebrow">ASSUMPTIONS</span>{result.assumptions.map((item) => <p key={item} className="mt-2 text-xs text-slate-400">{item}</p>)}</div><div className="subpanel"><span className="eyebrow">MISSING INPUTS</span><p className="mt-2 text-xs text-slate-400">{result.missingInputs.length ? result.missingInputs.join(", ") : "None reported by validation."}</p></div></div></div></details>
    </section>}
  </Shell>;
}