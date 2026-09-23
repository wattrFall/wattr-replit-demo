import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Box, Database, Fan, History, MapPin, Search, Thermometer, Zap } from "lucide-react";
import { api, describeError, navigate } from "@/components/cockpit/api";
import { Shell } from "@/components/cockpit/Shell";
import { PageHead, Status, sentenceCase } from "@/components/cockpit/ui";
import type { Facility, SessionData } from "@/components/cockpit/types";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import type { IntelligenceAsset, IntelligenceHierarchyNode, IntelligenceMetric } from "@/lib/intelligence/facilityModel";

type View = "physical" | "cooling" | "power" | "telemetry";
const intelligenceMetrics = ["rack_power_kw", "rack_inlet_temperature_c", "cooling_fan_percent"] as const;
const isIntelligenceMetric = (value: string | null): value is IntelligenceMetric =>
  Boolean(value && (intelligenceMetrics as readonly string[]).includes(value));
type AssetDetail = {
  modelVersionId: string;
  simulatedAt: number;
  asset: IntelligenceAsset;
  currentTelemetry: Array<{ metric: IntelligenceMetric; label: string; value: number; unit: string; provenance: "SIMULATED"; source: string }>;
  unresolvedLocation: boolean;
};
type Telemetry = {
  metric: IntelligenceMetric;
  label: string;
  simulated: boolean;
  source: string;
  mode?: "asset_series" | "scope_snapshot";
  points: Array<{ assetId: string; assetName: string; simulatedAt: number; value: number; unit: string; provenance: "SIMULATED" }>;
};
type ScopeMetric = {
  label: string;
  scope: { floor: string | null; zone: string | null; assetCount: number };
  aggregate: { value: number | null; unit: string; aggregation: "SUM" | "MAX" | "AVERAGE"; contributingAssetCount: number };
  contributions: Array<{ assetId: string; assetName: string; value: number; unit: string }>;
  source: string;
};

const viewIcons = { physical: Box, cooling: Fan, power: Zap, telemetry: Thermometer };
const readableView: Record<View, string> = {
  physical: "Physical",
  cooling: "Cooling",
  power: "Power",
  telemetry: "Telemetry",
};

function initialQuery() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  const metric = params.get("metric");
  return {
    view: (view === "cooling" || view === "power" || view === "telemetry" ? view : "physical") as View,
    floor: params.get("floor") ?? "",
    zone: params.get("zone") ?? "",
    assetId: params.get("assetId") ?? "",
    search: params.get("search") ?? "",
    at: params.get("at") ?? "",
    metric: isIntelligenceMetric(metric) ? metric : "rack_inlet_temperature_c",
  };
}

function metricLabel(metric: IntelligenceMetric) {
  return metric.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function assetRoute(
  facilityId: string,
  values: { view: View; floor: string; zone: string; assetId: string; search: string; at: string; metric: IntelligenceMetric },
) {
  const params = new URLSearchParams();
  params.set("view", values.view);
  if (values.floor) params.set("floor", values.floor);
  if (values.zone) params.set("zone", values.zone);
  if (values.assetId) params.set("assetId", values.assetId);
  if (values.search) params.set("search", values.search);
  if (values.at) params.set("at", values.at);
  params.set("metric", values.metric);
  return `/facilities/${facilityId}/intelligence?${params.toString()}`;
}

/** The operator's canonical-asset explorer. It intentionally accepts session/facility data from Cockpit. */
export function FacilityIntelligencePage({ data, facility }: { data: SessionData; facility: Facility }) {
  const initial = useMemo(initialQuery, []);
  const sessionAt = useScenarioSession((state) => state.simulatedAt);
  const [view, setView] = useState<View>(initial.view);
  const [floor, setFloor] = useState(initial.floor);
  const [zone, setZone] = useState(initial.zone);
  const [assetId, setAssetId] = useState(initial.assetId);
  const [search, setSearch] = useState(initial.search);
  const [at, setAt] = useState(initial.at || String(sessionAt));
  const [assets, setAssets] = useState<IntelligenceAsset[]>([]);
  const [hierarchy, setHierarchy] = useState<IntelligenceHierarchyNode[]>([]);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [scopeTelemetry, setScopeTelemetry] = useState<Telemetry | null>(null);
  const [scopeMetric, setScopeMetric] = useState<IntelligenceMetric>(initial.metric);
  const [scopeMetricData, setScopeMetricData] = useState<ScopeMetric | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const updateRoute = (next: Partial<{ view: View; floor: string; zone: string; assetId: string; search: string; metric: IntelligenceMetric; at: string }>) => {
    const values = { view, floor, zone, assetId, search, at, metric: scopeMetric, ...next };
    navigate(assetRoute(facility.id, values));
  };
  const selectAsset = (asset: IntelligenceAsset) => {
    setAssetId(asset.id);
    setFloor(asset.location.floorId ?? "");
    setZone(asset.location.zoneId ?? "");
    updateRoute({ assetId: asset.id, floor: asset.location.floorId ?? "", zone: asset.location.zoneId ?? "" });
  };

  useEffect(() => {
    const syncFromBrowser = () => {
      const next = initialQuery();
      setView(next.view);
      setFloor(next.floor);
      setZone(next.zone);
      setAssetId(next.assetId);
      setSearch(next.search);
      setAt(next.at || String(sessionAt));
      setScopeMetric(next.metric);
    };
    addEventListener("popstate", syncFromBrowser);
    return () => removeEventListener("popstate", syncFromBrowser);
  }, [sessionAt]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const scope = new URLSearchParams({ at });
    scope.set("metric", scopeMetric);
    if (floor) scope.set("floor", floor);
    if (zone) scope.set("zone", zone);
    if (search.trim()) scope.set("search", search.trim());
    Promise.all([
      api<{ assets: IntelligenceAsset[] }>(`/api/facilities/${facility.id}/intelligence/assets?${scope}`),
      api<{ hierarchy: IntelligenceHierarchyNode[] }>(`/api/facilities/${facility.id}/intelligence/hierarchy`),
    ]).then(([assetResult, hierarchyResult]) => {
      if (!active) return;
      setAssets(assetResult.assets);
      setHierarchy(hierarchyResult.hierarchy);
    }).catch((cause) => active && setError(describeError(cause)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [facility.id, floor, zone, search, at, scopeMetric]);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setTelemetry(null);
    if (!assetId) return () => { active = false; };
    api<AssetDetail>(`/api/facilities/${facility.id}/intelligence/assets/${encodeURIComponent(assetId)}?at=${encodeURIComponent(at)}&metric=${encodeURIComponent(scopeMetric)}`)
      .then((result) => active && setDetail(result))
      .catch((cause) => active && setError(describeError(cause)));
    return () => { active = false; };
  }, [assetId, at, facility.id]);

  useEffect(() => {
    let active = true;
    const asset = detail?.asset;
    const metric = asset?.metrics.includes(scopeMetric) ? scopeMetric : undefined;
    if (view !== "telemetry" || !asset || !metric) return () => { active = false; };
    api<Telemetry>(`/api/facilities/${facility.id}/intelligence/telemetry?assetId=${encodeURIComponent(asset.id)}&metric=${metric}&at=${encodeURIComponent(at)}`)
      .then((result) => active && setTelemetry(result))
      .catch((cause) => active && setError(describeError(cause)));
    return () => { active = false; };
  }, [at, detail?.asset.id, detail?.asset.metrics, facility.id, scopeMetric, view]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ metric: scopeMetric, at });
    if (floor) params.set("floor", floor);
    if (zone) params.set("zone", zone);
    api<ScopeMetric>(`/api/facilities/${facility.id}/intelligence/metrics?${params}`)
      .then((result) => active && setScopeMetricData(result))
      .catch((cause) => active && setError(describeError(cause)));
    return () => { active = false; };
  }, [at, facility.id, floor, scopeMetric, zone]);

  useEffect(() => {
    let active = true;
    if (view !== "telemetry") return () => { active = false; };
    const params = new URLSearchParams({ metric: scopeMetric, at });
    if (floor) params.set("floor", floor);
    if (zone) params.set("zone", zone);
    api<Telemetry>(`/api/facilities/${facility.id}/intelligence/telemetry?${params}`)
      .then((result) => active && setScopeTelemetry(result))
      .catch((cause) => active && setError(describeError(cause)));
    return () => { active = false; };
  }, [at, facility.id, floor, scopeMetric, view, zone]);

  const zones = hierarchy.filter((node) => node.kind === "ZONE");
  const selectedZone = zones.find((node) => node.id === zone);
  const selectedFloor = hierarchy.find((node) => node.id === floor);
  const visibleAssets = assets.filter((asset) => {
    if (view === "cooling") return asset.kind === "COOLING_UNIT" || asset.kind === "CHILLER";
    if (view === "power") return asset.metrics.includes("rack_power_kw");
    return true;
  });
  const selectedAsset = detail?.asset;
  const breadcrumb = [
    facility.name,
    selectedFloor?.name ?? (floor ? "Floor" : ""),
    selectedZone?.name ?? "",
    selectedAsset?.name ?? "",
  ].filter(Boolean);
  const twinLink = selectedAsset
    ? `/facilities/${facility.id}/operations?assetId=${encodeURIComponent(selectedAsset.twinSelectionId)}&canonicalAssetId=${encodeURIComponent(selectedAsset.id)}&at=${encodeURIComponent(at)}`
    : "";
  const supportedScopeMetrics = intelligenceMetrics;

  return <Shell data={data}>
    <PageHead
      eyebrow="Facility intelligence / model-bound"
      title={`${readableView[view]} explorer`}
      detail={`Scope at ${formatSimulatedAt(Number(at))}. Asset identity comes from the active published model layout.`}
      action={<Status tone="warn">SIMULATED REPLAY DATA</Status>}
    />
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400" aria-label="Facility breadcrumb">
        {breadcrumb.map((part, index) => <span key={`${part}-${index}`} className="flex items-center gap-2">
          {index > 0 && <ArrowRight size={13} className="text-slate-600" aria-hidden="true"/>}
          <button type="button" className="hover:text-cyan-300" onClick={() => {
            if (index === 0) { setFloor(""); setZone(""); setAssetId(""); updateRoute({ floor: "", zone: "", assetId: "" }); }
            if (index === 1) { setZone(""); setAssetId(""); updateRoute({ zone: "", assetId: "" }); }
            if (index === 2) { setAssetId(""); updateRoute({ assetId: "" }); }
          }}>{part}</button>
        </span>)}
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Facility operational view">
        {(Object.keys(readableView) as View[]).map((candidate) => {
          const Icon = viewIcons[candidate];
          return <button type="button" role="tab" aria-selected={view === candidate} key={candidate}
            className={`button ${view === candidate ? "primary" : "secondary"}`}
            onClick={() => {
              setView(candidate);
              const nextMetric = candidate === "power" ? "rack_power_kw"
                : candidate === "cooling" ? "cooling_fan_percent"
                  : candidate === "physical" ? "rack_inlet_temperature_c"
                    : selectedAsset?.metrics.includes(scopeMetric) ? scopeMetric : selectedAsset?.metrics[0] ?? scopeMetric;
              setScopeMetric(nextMetric);
              updateRoute({ view: candidate, metric: nextMetric });
            }}>
            <Icon size={14}/>{readableView[candidate]}
          </button>;
        })}
        <button type="button" className="button secondary" onClick={() => navigate(`/facilities/${facility.id}/history${assetId ? `?assetId=${encodeURIComponent(assetId)}&at=${encodeURIComponent(at)}` : `?at=${encodeURIComponent(at)}`}`)}>
          <History size={14}/>History
        </button>
      </div>
    </section>

    <section className="panel mt-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">Scope KPI / contributing dimensions</div><h2 className="mt-1 text-xl font-semibold">{scopeMetricData?.label ?? metricLabel(scopeMetric)}</h2><p className="mt-1 text-xs text-slate-500">{scopeMetricData?.source ?? "Loading model-backed aggregate…"}</p></div>
        <label className="field">Metric<select className="select mt-2" value={scopeMetric} onChange={(event) => { const metric = event.target.value as IntelligenceMetric; setScopeMetric(metric); updateRoute({ metric }); }}>{supportedScopeMetrics.map((metric) => <option key={metric} value={metric}>{metricLabel(metric)}</option>)}</select></label>
      </div>
      {scopeMetricData ? <><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="subpanel"><div className="eyebrow">{sentenceCase(scopeMetricData.aggregate.aggregation)}</div><p className="mt-1 text-2xl font-semibold">{scopeMetricData.aggregate.value ?? "—"} <small className="text-sm text-slate-500">{scopeMetricData.aggregate.unit}</small></p><p className="mt-1 text-xs text-slate-500">{scopeMetricData.aggregate.contributingAssetCount} contributing asset{scopeMetricData.aggregate.contributingAssetCount === 1 ? "" : "s"}</p></div><div className="subpanel"><div className="eyebrow">Scope</div><p className="mt-1 text-sm text-slate-200">{selectedFloor?.name ?? "All floors"} / {selectedZone?.name ?? "All zones"}</p><p className="mt-1 text-xs text-slate-500">{scopeMetricData.scope.assetCount} active-model asset{scopeMetricData.scope.assetCount === 1 ? "" : "s"} in scope</p></div><div className="subpanel"><div className="eyebrow">Provenance</div><p className="mt-1 text-sm text-amber-300">SIMULATED</p><p className="mt-1 text-xs text-slate-500">No per-unit cooling-energy allocation is modeled.</p></div></div>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[460px] text-left text-xs"><thead className="border-b border-slate-800 text-slate-500"><tr><th className="p-2">Contributing asset</th><th className="p-2">Canonical ID</th><th className="p-2">Value</th></tr></thead><tbody>{scopeMetricData.contributions.map((contribution) => {
        const inspect = () => {
          const asset = assets.find((item) => item.id === contribution.assetId);
          if (asset) selectAsset(asset);
          else updateRoute({ assetId: contribution.assetId });
        };
        return <tr key={contribution.assetId} className="border-b border-slate-900"><td className="p-2 text-cyan-300"><button type="button" className="hover:underline" onClick={inspect}>{contribution.assetName}</button></td><td className="p-2 font-mono"><button type="button" className="hover:underline" onClick={inspect}>{contribution.assetId}</button></td><td className="p-2 font-mono">{contribution.value} {contribution.unit}</td></tr>;
      })}</tbody></table></div></> : <p className="mt-4 text-sm text-slate-500">Loading scope contribution totals…</p>}
    </section>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
      <section className="panel p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="field min-w-[220px] flex-1">Find an asset
            <span className="relative mt-2 block"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true"/><input className="input w-full pl-9" value={search} onChange={(event) => { setSearch(event.target.value); updateRoute({ search: event.target.value }); }} placeholder="Name, ID, rack, type, manufacturer, model"/></span>
          </label>
          <label className="field">Floor<select className="select mt-2" value={floor} onChange={(event) => { setFloor(event.target.value); setZone(""); setAssetId(""); updateRoute({ floor: event.target.value, zone: "", assetId: "" }); }}><option value="">All floors</option>{hierarchy.filter((node) => node.kind === "FLOOR").map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
          <label className="field">Zone<select className="select mt-2" value={zone} onChange={(event) => { setZone(event.target.value); setAssetId(""); updateRoute({ zone: event.target.value, assetId: "" }); }}><option value="">All zones</option>{zones.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {visibleAssets.map((asset) => <button type="button" key={asset.id} onClick={() => selectAsset(asset)} className={`subpanel text-left transition hover:border-cyan-400/50 ${asset.id === assetId ? "border-cyan-400/70" : ""}`}>
            <div className="flex items-start justify-between gap-3"><div><div className="eyebrow">{sentenceCase(asset.kind)}</div><h2 className="mt-1 font-semibold text-slate-100">{asset.name}</h2></div><Status tone={asset.location.status === "RESOLVED" ? "good" : "warn"}>{asset.location.status}</Status></div>
            <p className="mt-2 text-xs text-slate-400">{asset.id} · {asset.location.zoneName ?? "No mapped physical location"}</p>
            <p className="mt-2 text-xs text-slate-500">{asset.manufacturer || asset.model ? `${asset.manufacturer ?? "Unknown manufacturer"} ${asset.model ?? ""}` : "No manufacturer/model source supplied"}</p>
          </button>)}
        </div>
        {!loading && !visibleAssets.length && <p className="mt-5 text-sm text-slate-500">No active-model assets match this scope. Search is limited to canonical records you are authorized to view.</p>}
        {loading && <p className="mt-5 text-sm text-slate-500">Loading active published model assets…</p>}
      </section>

      <aside className="panel p-5">
        {!selectedAsset ? <><div className="eyebrow">Canonical record</div><h2 className="mt-2 text-xl font-semibold">Select an asset</h2><p className="mt-2 text-sm leading-6 text-slate-400">Search or choose a physical, cooling, power, or telemetry-supported asset. Every result is resolved from the active published model, not an old seeded inventory row.</p></> : <>
          <div className="flex items-center justify-between gap-2"><div className="eyebrow">Canonical record</div><Status tone={selectedAsset.provenance.kind === "IMPORTED" ? "good" : "warn"}>{selectedAsset.provenance.kind}</Status></div>
          <h2 className="mt-2 text-xl font-semibold">{selectedAsset.name}</h2><p className="mt-1 font-mono text-xs text-cyan-300">{selectedAsset.id}</p>
          <div className="mt-4 space-y-2 text-xs text-slate-400"><p><MapPin size={13} className="mr-1 inline text-cyan-300"/>{selectedAsset.location.status === "RESOLVED" ? `${selectedAsset.location.floorName} / ${selectedAsset.location.zoneName} / (${selectedAsset.location.gridCell?.x}, ${selectedAsset.location.gridCell?.z})` : "Unresolved location — correct the imported model before relying on spatial context."}</p><p><b className="text-slate-300">Manufacturer/model:</b> {selectedAsset.manufacturer ?? "Not supplied"} {selectedAsset.model ? ` / ${selectedAsset.model}` : ""}</p><p><b className="text-slate-300">Source:</b> {selectedAsset.provenance.source}</p></div>
          <div className="mt-4 border-t border-slate-800 pt-4"><div className="eyebrow">Current replay metrics</div>{detail?.currentTelemetry.map((reading) => <div className="mt-2 flex justify-between gap-3 text-sm" key={reading.metric}><button type="button" className="text-left text-cyan-300 hover:underline" onClick={() => { setScopeMetric(reading.metric); setView("telemetry"); updateRoute({ view: "telemetry", metric: reading.metric }); }}>{reading.label}</button><span className="font-mono">{reading.value} {reading.unit}</span></div>)}{!detail?.currentTelemetry.length && <p className="mt-2 text-xs text-slate-500">No metric is supported by this model for this asset.</p>}</div>
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="button primary" onClick={() => navigate(twinLink)}>Open in twin <ArrowRight size={14}/></button><button type="button" className="button secondary" onClick={() => navigate(`/facilities/${facility.id}/history?assetId=${encodeURIComponent(selectedAsset.id)}&at=${encodeURIComponent(at)}`)}><History size={14}/>Asset history</button></div>
        </>}
      </aside>
    </div>

    {view === "telemetry" && <section className="panel mt-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">Raw underlying values</div><h2 className="mt-1 text-xl font-semibold">{telemetry?.label ?? (selectedAsset ? metricLabel(selectedAsset.metrics[0]) : "Select an asset")}</h2><p className="mt-1 text-xs text-slate-500">{telemetry?.source ?? "Only metrics that the active model can calculate are shown."}</p></div><Status tone="warn">SIMULATED</Status></div>
      {scopeTelemetry && <><h3 className="mt-5 text-sm font-semibold">All supported assets in this scope at this replay instant</h3><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead className="border-b border-slate-800 text-slate-500"><tr><th className="p-2">Asset</th><th className="p-2">Canonical ID</th><th className="p-2">Replay time</th><th className="p-2">Value</th><th className="p-2">Provenance</th></tr></thead><tbody>{scopeTelemetry.points.map((point) => <tr key={point.assetId} className="border-b border-slate-900"><td className="p-2 text-cyan-300">{point.assetName}</td><td className="p-2 font-mono">{point.assetId}</td><td className="p-2 font-mono">{formatSimulatedAt(point.simulatedAt)}</td><td className="p-2 font-mono text-slate-200">{point.value} {point.unit}</td><td className="p-2 text-amber-300">{point.provenance}</td></tr>)}</tbody></table></div></>}
      {telemetry && <><h3 className="mt-5 text-sm font-semibold">Selected asset time series</h3><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-xs"><thead className="border-b border-slate-800 text-slate-500"><tr><th className="p-2">Replay time</th><th className="p-2">Value</th><th className="p-2">Provenance</th></tr></thead><tbody>{telemetry.points.map((point) => <tr key={`${point.assetId}-${point.simulatedAt}`} className="border-b border-slate-900"><td className="p-2 font-mono">{formatSimulatedAt(point.simulatedAt)}</td><td className="p-2 font-mono text-slate-200">{point.value} {point.unit}</td><td className="p-2 text-amber-300">{point.provenance}</td></tr>)}</tbody></table></div></>}
      {selectedAsset && !telemetry && <p className="mt-4 text-sm text-slate-500">Loading deterministic replay samples…</p>}
    </section>}
  </Shell>;
}