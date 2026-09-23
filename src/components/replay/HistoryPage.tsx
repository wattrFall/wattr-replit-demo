import { useEffect, useState } from "react";
import { ArrowRight, Clock3, History, Layers3 } from "lucide-react";
import { api, describeError, navigate } from "@/components/cockpit/api";
import { Shell } from "@/components/cockpit/Shell";
import type { Facility, SessionData } from "@/components/cockpit/types";
import { PageHead, Status, mono } from "@/components/cockpit/ui";

type ChangeEvent = {
  id: string; asset_id: string | null; model_version_id: string; occurred_at: string; actor_user_id: string | null;
  source: string; change_type: string; before_config: Record<string, unknown>;
  after_config: Record<string, unknown>; metadata: Record<string, unknown>;
};
type ModelVersion = { id: string; status: string; config: Record<string, unknown>; created_at: string; published_at: string | null };

/** Read-only historical model and change timeline. The API is facility-scoped. */
export function FacilityHistoryPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [error, setError] = useState("");
  const assetId = new URLSearchParams(window.location.search).get("assetId");
  useEffect(() => {
    let cancelled = false;
    api<{ events: ChangeEvent[]; modelVersions: ModelVersion[] }>(`/api/facilities/${facility.id}/history${assetId ? `?assetId=${encodeURIComponent(assetId)}` : ""}`)
      .then((response) => {
        if (!cancelled) {
          setEvents(response.events);
          setVersions(response.modelVersions);
          setError("");
        }
      })
      .catch((cause) => { if (!cancelled) setError(describeError(cause)); });
    return () => { cancelled = true; };
  }, [facility.id, assetId]);

  return <Shell data={data} facility={facility}>
    <PageHead
      eyebrow="Facility history / immutable configuration"
      title={assetId ? `Change history: ${assetId}` : "Change history"}
      detail={assetId ? "Filtered to this affected asset. Configuration changes retain before/after snapshots; timeline proximity to telemetry does not establish causality." : "Configuration changes retain before/after snapshots. Timeline proximity to telemetry does not establish causality."}
      action={<button type="button" className="button primary" onClick={() => navigate(`/facilities/${facility.id}/replay`)}>Open Scenario Replay <ArrowRight size={15}/></button>}
    />
    {error && <section className="panel mb-4 p-4 text-sm text-red-300" role="alert">{error}</section>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-800 p-5"><div className="flex items-center gap-2"><History size={16} className="text-slate-500" aria-hidden="true"/><h2 className="font-semibold">Supported configuration events</h2></div><p className="mt-2 text-xs text-slate-500">Append-only events generated when a published model’s supported configuration differs.</p></div>
        {events.map((event) => <details key={event.id} className="disclosure border-x-0 border-t-0">
          <summary><span><b>{event.change_type === "RACK_RELOCATED" ? `Moved ${event.asset_id}` : event.change_type.replace(/_/g, " ")}</b><small className="mt-1 block text-slate-500">{new Date(event.occurred_at).toLocaleString()} · {event.source.replace(/_/g, " ")} · asset {event.asset_id ?? "facility-model"}</small></span><Status tone="warn">{event.model_version_id}</Status></summary>
          <div className="disclosure-content grid gap-3 md:grid-cols-2">
            <ChangeSpecifics event={event}/>
            <div className="subpanel"><span className="eyebrow">Before</span><pre className="mt-2 overflow-x-auto text-xs text-slate-400">{JSON.stringify(event.before_config, null, 2)}</pre></div>
            <div className="subpanel"><span className="eyebrow">After</span><pre className="mt-2 overflow-x-auto text-xs text-slate-400">{JSON.stringify(event.after_config, null, 2)}</pre></div>
            <p className="text-xs text-slate-500">Responsible user: {event.actor_user_id ?? "source unavailable"}. Metadata is retained with the immutable event.</p>
          </div>
        </details>)}
        {!events.length && !error && <p className="p-6 text-sm text-slate-500">No supported configuration differences have been recorded yet. Identical configuration publishes do not create a change event.</p>}
      </section>
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-800 p-5"><div className="flex items-center gap-2"><Layers3 size={16} className="text-slate-500" aria-hidden="true"/><h2 className="font-semibold">Historical model states</h2></div><p className="mt-2 text-xs text-slate-500">Select a version in Scenario Replay to fork its immutable configuration.</p></div>
        {versions.map((version) => <details key={version.id} className="disclosure border-x-0 border-t-0">
          <summary><span><b className={mono}>{version.id}</b><small className="mt-1 block text-slate-500"><Clock3 size={11} className="mr-1 inline"/>{new Date(version.created_at).toLocaleString()}</small></span><Status tone={version.status === "PUBLISHED" ? "good" : "warn"}>{version.status}</Status></summary>
          <div className="disclosure-content"><pre className="overflow-x-auto rounded bg-black/20 p-3 text-xs text-slate-400">{JSON.stringify(version.config, null, 2)}</pre><button type="button" className="button secondary mt-3" onClick={() => navigate(`/facilities/${facility.id}/replay?modelVersion=${encodeURIComponent(version.id)}`)}>Use as replay baseline <ArrowRight size={14}/></button></div>
        </details>)}
        {!versions.length && !error && <p className="p-6 text-sm text-slate-500">Loading model history…</p>}
      </section>
    </div>
  </Shell>;
}

function ChangeSpecifics({ event }: { event: ChangeEvent }) {
  const before = event.before_config as { cell?: { x?: number; z?: number }; params?: Record<string, unknown> } | null;
  const after = event.after_config as { cell?: { x?: number; z?: number }; params?: Record<string, unknown> } | null;
  const moved = before?.cell && after?.cell && (before.cell.x !== after.cell.x || before.cell.z !== after.cell.z);
  const parameters = [...new Set([...Object.keys(before?.params ?? {}), ...Object.keys(after?.params ?? {})])]
    .filter((key) => before?.params?.[key] !== after?.params?.[key]);
  if (!moved && !parameters.length) return null;
  return <div className="subpanel md:col-span-2"><span className="eyebrow">Affected asset detail</span>
    {moved && <p className="mt-2 text-sm text-cyan-100">Position moved: ({before!.cell!.x}, {before!.cell!.z}) → ({after!.cell!.x}, {after!.cell!.z})</p>}
    {parameters.map((key) => <p key={key} className="mt-1 text-xs text-slate-400">{key}: {String(before?.params?.[key] ?? "unset")} → {String(after?.params?.[key] ?? "unset")}</p>)}
  </div>;
}