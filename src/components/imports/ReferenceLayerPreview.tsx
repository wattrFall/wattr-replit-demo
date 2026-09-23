import { useEffect, useState } from "react";
import { e2eTestUserId } from "@/components/cockpit/api";
import type { FacilityLayout } from "@/lib/facility/layout";
import { SITE } from "@/lib/sandbox/geometry";

/** A secured floor-plan reference with grid-aligned asset markers for Builder. */
export function ReferenceLayerPreview({ facilityId, layout }: { facilityId: string; layout: FacilityLayout }) {
  const layer = layout.referenceLayers?.at(-1);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!layer) return;
    let current: string | null = null, cancelled = false;
    const headers = new Headers();
    const testUser = e2eTestUserId();
    if (testUser) headers.set("x-test-user-id", testUser);
    fetch(`/api/facilities/${encodeURIComponent(facilityId)}/imports/files/${encodeURIComponent(layer.fileId)}`, { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error("The saved floor plan is unavailable.");
        current = URL.createObjectURL(await response.blob());
        if (!cancelled) setUrl(current);
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "The saved floor plan is unavailable."));
    return () => { cancelled = true; if (current) URL.revokeObjectURL(current); };
  }, [facilityId, layer?.fileId]);
  if (!layer) return null;
  return <section className="panel overflow-hidden p-4" aria-labelledby="builder-reference-plan">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div><div className="eyebrow">SPATIAL REFERENCE</div><h2 id="builder-reference-plan" className="mt-1 text-sm font-semibold">{layer.name}</h2></div>
      <span className="status warn">IMPORTED · NOT TO SCALE</span>
    </div>
    <p className="copy">Asset markers use the Builder grid. Move assets in the editor to position them relative to this reference; the plan is not interpreted as authoritative geometry.</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    {url && (layer.mimeType === "application/pdf"
      ? <iframe className="mt-3 h-72 w-full rounded border border-slate-700 bg-white" sandbox="" title={`Floor plan ${layer.name}`} src={url}/>
      : <div className="relative mt-3 h-72 overflow-hidden rounded border border-slate-700 bg-slate-950">
          <img className="h-full w-full object-contain" src={url} alt={`Imported floor plan reference: ${layer.name}`}/>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${SITE.w} ${SITE.d}`} preserveAspectRatio="none" aria-label="Asset positions on builder grid">
            {layout.items.map((item) => <g key={item.id}><circle cx={item.cell.x + .5} cy={item.cell.z + .5} r=".42" fill="#22d3ee" stroke="#082f49" strokeWidth=".14"/><text x={item.cell.x + .5} y={item.cell.z + .65} fill="#082f49" fontSize=".55" textAnchor="middle">{item.id.slice(-2)}</text></g>)}
          </svg>
        </div>)}
  </section>;
}