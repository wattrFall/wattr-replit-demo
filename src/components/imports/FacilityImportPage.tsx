import { useMemo, useState } from "react";
import { Check, FileUp, Layers3, LoaderCircle, MapPinned } from "lucide-react";
import { api, describeError, navigate } from "@/components/cockpit/api";
import { Shell } from "@/components/cockpit/Shell";
import { PageHead, Status } from "@/components/cockpit/ui";
import type { Facility, SessionData } from "@/components/cockpit/types";
import { CURATED_EQUIPMENT_CATALOGUE } from "@/lib/imports/catalogue";
import { mappedWorldCell } from "@/lib/imports/placement";
import type { ImportMapping, ImportPreview, PlanReferenceLayer } from "@/lib/imports/types";
import type { ComponentKind } from "@/lib/sandbox/types";

type UploadResult = { preview: ImportPreview; referenceLayer?: PlanReferenceLayer };
type DraftResult = { id: string; status: "DRAFT"; message: string };
const components: ComponentKind[] = ["rack", "crac", "cdu", "chiller", "sensor"];
const readable = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

async function contentBase64(file: File) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Existing-data-first import and explicit verification workspace. */
export function FacilityImportPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const [upload, setUpload] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappings, setMappings] = useState<ImportMapping[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Import writes deliberately have a narrower role boundary than the
  // demonstration Builder's existing view-grant write policy.
  const canImport = facility.can_engineer || facility.can_edit_model;
  // The parser bounds IFC imports at 1,000 objects. Render every persisted
  // object so an automatic mapping is never committed without a visible review
  // control.
  const visible = useMemo(() => preview?.objects ?? [], [preview]);

  const uploadFile = async () => {
    if (!upload) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const lower = upload.name.toLowerCase();
      const ifc = lower.endsWith(".ifc") || upload.type === "application/ifc" || upload.type === "application/x-step";
      const mimeType = ifc ? "application/x-step" : upload.type === "image/jpg" ? "image/jpeg" : upload.type;
      const route = ifc ? "ifc" : "floorplans";
      const result = await api<UploadResult>(`/api/facilities/${facility.id}/imports/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: upload.name, mimeType, contentBase64: await contentBase64(upload) }),
      });
      setPreview(result.preview);
      setMappings(result.preview.objects.map((item, index) => ({
        // Nothing is silently accepted: every persisted IFC object starts
        // pending and the API rejects a draft until each row has a decision.
        sourceId: item.sourceId, decision: "PENDING",
        componentKind: item.inferredKind, cell: mappedWorldCell(item, result.preview, index),
      })));
      setMessage(ifc ? "IFC parsed. Review every mapping before creating a Builder draft." : "Floor plan stored as a secured spatial reference. Create a Builder draft to use it.");
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); }
  };
  const changeMapping = (sourceId: string, patch: Partial<ImportMapping>) => setMappings((current) => current.map((item) => item.sourceId === sourceId ? { ...item, ...patch } : item));
  const createDraft = async () => {
    if (!preview) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<DraftResult>(`/api/facilities/${facility.id}/imports/${preview.importId}/create-draft`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings }),
      });
      setMessage(`${result.message} Draft ${result.id} is listed in Facility builder.`);
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(false); }
  };
  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="Facility creation" title="Import existing engineering data" detail="Store a floor-plan reference or parse IFC STEP data, review every proposed mapping, then create a Builder draft. Imports cannot publish Operations directly."/>
    <div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
      <section className="panel p-5">
        <div className="flex items-start gap-3"><FileUp className="mt-1 text-cyan-300" aria-hidden="true"/><div><h2 className="font-semibold">1. Upload a source</h2><p className="copy">Floor plan: PDF, PNG, JPEG, SVG (max 15 MB; SVG max 5 MB). IFC: ISO-10303-21 STEP .ifc (max 20 MB).</p></div></div>
        <label className="field mt-4 block">Engineering file<input className="input mt-2 block w-full" disabled={!canImport} type="file" accept=".ifc,.pdf,.png,.jpg,.jpeg,.svg,application/pdf,image/png,image/jpeg,image/svg+xml,application/ifc,application/x-step" onChange={(event) => { setUpload(event.target.files?.[0] ?? null); setPreview(null); }}/></label>
        {upload && <p className="mt-2 text-xs text-slate-400">{upload.name} · {(upload.size / 1024 / 1024).toFixed(2)} MB · detected as {upload.name.toLowerCase().endsWith(".ifc") ? "IFC" : "floor plan"}</p>}
        <button className="button primary mt-4" type="button" disabled={!canImport || !upload || busy} onClick={uploadFile}>{busy ? <LoaderCircle className="animate-spin" size={15}/> : <FileUp size={15}/>} Upload and {upload?.name.toLowerCase().endsWith(".ifc") ? "parse IFC" : "store reference"}</button>
        {!canImport && <p className="mt-2 text-xs text-amber-300">Import writes require Engineer, Model admin, or owner authorization. You can still view authorized imported records.</p>}
        <div className="subpanel mt-5">
          <div className="eyebrow">Curated demo catalogue</div>
          <p className="mt-2 text-xs leading-5 text-slate-400">Values are illustrative Wattr demonstration data, not certified manufacturer specifications. Site-entered properties remain editable.</p>
          <ul className="mt-3 space-y-2">{CURATED_EQUIPMENT_CATALOGUE.map((model) => <li key={model.id} className="text-xs"><b>{model.manufacturer} · {model.model}</b><span className="ml-2 text-slate-500">{readable(model.category)}</span></li>)}</ul>
        </div>
      </section>
      <section className="panel p-5" aria-live="polite">
        {!preview ? <div className="flex min-h-64 flex-col items-center justify-center text-center text-slate-500"><Layers3 size={32} aria-hidden="true"/><p className="mt-3 text-sm">Upload a supported source to begin a reviewable import.</p></div> : <>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="eyebrow">2. Verify before build</div><h2 className="mt-1 font-semibold">{preview.sourceName}</h2><p className="mt-1 text-xs text-slate-400">{preview.kind === "IFC" ? `${preview.objects.length} recognised or unresolved IFC objects` : "Floor-plan spatial reference layer"}</p></div><Status tone="warn">{preview.kind}</Status></div>
          {preview.geometry?.bounds && <div className="subpanel mt-4 text-xs"><b>Geometry preview</b><p className="mt-1 text-slate-400">World-space placement bounds: {preview.geometry.bounds.min.join(", ")} → {preview.geometry.bounds.max.join(", ")} {preview.geometry.units ?? "(units not declared)"}. This is a point/bounds preview, not a full mesh renderer.</p></div>}
          {preview.kind === "IFC" && <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-700 text-slate-500"><tr><th className="p-2">Object / source ID</th><th className="p-2">Basis</th><th className="p-2">Decision</th><th className="p-2">Wattr type</th><th className="p-2">Grid cell</th><th className="p-2">Catalogue</th></tr></thead>
              <tbody>{visible.map((object) => {
                const mapping = mappings.find((item) => item.sourceId === object.sourceId);
                const editable = mapping?.decision === "CONFIRM" || mapping?.decision === "MODIFY";
                return <tr key={`${object.sourceId}-${object.expressId}`} className="border-b border-slate-800 align-top">
                  <td className="p-2"><b>{object.name}</b><br/><code className="text-cyan-300">{object.sourceId}</code><br/><span className="text-slate-500">{object.ifcType}{object.storey ? ` · ${object.storey}` : ""}</span></td>
                  <td className="p-2"><Status tone={object.confidence === "HIGH" ? "good" : "warn"}>{object.confidence}</Status><p className="mt-1 text-slate-500">{object.mappingBasis}</p></td>
                  <td className="p-2"><select className="select" value={mapping?.decision ?? "PENDING"} onChange={(event) => changeMapping(object.sourceId, { decision: event.target.value as ImportMapping["decision"] })}><option value="PENDING" disabled>Choose…</option><option value="CONFIRM">Confirm</option><option value="MODIFY">Modify</option><option value="IGNORE">Ignore</option></select></td>
                  <td className="p-2"><select className="select" value={mapping?.componentKind ?? ""} disabled={!editable} onChange={(event) => changeMapping(object.sourceId, { componentKind: (event.target.value || null) as ComponentKind | null })}><option value="">Unresolved</option>{components.map((kind) => <option key={kind} value={kind}>{readable(kind)}</option>)}</select></td>
                  <td className="p-2"><div className="flex gap-1"><input aria-label={`${object.name} grid X`} className="input w-12" type="number" min="0" max="39" disabled={!editable} value={mapping?.cell?.x ?? ""} onChange={(event) => changeMapping(object.sourceId, { cell: { x: Number(event.target.value), z: mapping?.cell?.z ?? 0 } })}/><input aria-label={`${object.name} grid Z`} className="input w-12" type="number" min="0" max="29" disabled={!editable} value={mapping?.cell?.z ?? ""} onChange={(event) => changeMapping(object.sourceId, { cell: { x: mapping?.cell?.x ?? 0, z: Number(event.target.value) } })}/></div><span className="text-slate-500">X / Z</span></td>
                  <td className="p-2"><select className="select" value={mapping?.catalogueModelId ?? ""} disabled={!editable} onChange={(event) => changeMapping(object.sourceId, { catalogueModelId: event.target.value || null })}><option value="">Imported values</option>{CURATED_EQUIPMENT_CATALOGUE.filter((model) => !mapping?.componentKind || model.category === mapping.componentKind).map((model) => <option key={model.id} value={model.id}>{model.model}</option>)}</select></td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-400">{preview.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
          <button className="button primary mt-5" type="button" disabled={!canImport || busy} onClick={createDraft}>{busy ? <LoaderCircle className="animate-spin" size={15}/> : <Check size={15}/>} Create Builder DRAFT only</button>
          <button className="button secondary ml-2 mt-5" type="button" onClick={() => navigate(`/facilities/${facility.id}/builder`)}><MapPinned size={15}/> Open Builder</button>
        </>}
      </section>
    </div>
    {message && <p className="panel mt-4 p-4 text-sm text-teal-300">{message}</p>}
    {error && <p role="alert" className="panel mt-4 p-4 text-sm text-red-300">{error}</p>}
  </Shell>;
}