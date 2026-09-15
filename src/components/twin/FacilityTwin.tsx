import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, CircleHelp, Footprints, Layers3, MousePointer2 } from "lucide-react";
import { facilityAssets, type FacilityAssetKind } from "@/lib/cockpit/facilityAssets";
import type { FacilityTwinProps, TwinOverlay } from "./types";

const FacilityTwinCanvas = lazy(() => import("./FacilityTwinCanvas"));

class TwinBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const overlayLabels: Record<TwinOverlay, string> = {
  heat: "Heat", flow: "Flow", sensors: "Sensors", labels: "Labels",
  incidents: "Incidents", forecast: "Forecast",
};

/** Floor 2 of the SFO-01 reference facility, which only that model has. */
const REFERENCE_FLOOR_TWO: Array<[string, string]> = [
  ["rack-f2-a", "Rack F2-A"], ["rack-f2-b", "Rack F2-B"], ["rack-f2-c", "Rack F2-C"], ["pdu-02", "PDU-02"],
];

const counted = (count: number, noun: string) => `${count === 0 ? "no" : count} ${noun}${count === 1 ? "" : "s"}`;
const listed = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

export function FacilityTwin(props: FacilityTwinProps) {
  const [floor, setFloor] = useState<1 | 2>(1);
  const [cameraMode, setCameraMode] = useState<"orbit" | "walk">("orbit");
  const [cameraState, setCameraState] = useState("orbit:15.00,12.00,16.00:idle");
  const effectiveModel = props.mode === "edit" ? props.snapshot.modelConfig : props.model;
  const assets = useMemo(() => facilityAssets(effectiveModel), [effectiveModel]);
  useEffect(() => {
    if (props.selectedFloor) setFloor(props.selectedFloor);
  }, [props.selectedFloor]);
  const summary = useMemo(() => {
    if (floor === 2) {
      return assets.reference
        ? "Authorized facility model, floor 2. Three compute racks and PDU-02. Operational replay state remains unchanged."
        : "Authorized facility model, floor 2. This build has a single floor, so all of its equipment is on floor 1.";
    }
    const of = (kind: FacilityAssetKind) => assets.assets.filter((asset) => asset.kind === kind);
    const hot = props.snapshot.racks.filter((rack) => rack.atRisk).map((rack) => rack.id);
    const equipment = listed([
      counted(of("rack").length, "rack"),
      ...[...of("cooling"), ...of("chiller")].map((asset) => asset.label),
      counted(of("sensor").length, "sensor"),
    ]);
    return `Authorized facility model, floor 1, ${assets.hallLabel}: ${equipment}. Peak inlet ${props.snapshot.peakInletC.toFixed(1)} degrees Celsius. ${hot.length ? `Racks at risk: ${hot.join(", ")}.` : "No racks currently over limit."}`;
  }, [assets, floor, props.snapshot]);
  const strip: Array<[string, string]> = floor === 1
    ? [[assets.workload.id, assets.hallLabel], ...assets.assets.map((asset): [string, string] => [asset.id, asset.label])]
    : assets.reference ? REFERENCE_FLOOR_TWO : [];
  const fallback = <div className="twin-fallback" role="img" aria-label={summary}>
    <Layers3 size={28}/><b>3D scene unavailable</b>
    <p>{summary}</p><p>The replay, asset list, incident, recommendation, and operating controls remain available.</p>
  </div>;

  return <div className="facility-twin">
    <div className="twin-toolbar">
      <div className="twin-toolgroup" role="group" aria-label="Facility floor" data-guide="floors">
        {([1, 2] as const).map((value) => <button key={value} data-guide={value === 2 ? "floor-change" : undefined} className={floor === value ? "active" : ""} aria-pressed={floor === value} onClick={() => { setFloor(value); props.onGuideAction?.("floor-change"); }}>F{value}</button>)}
      </div>
      <div className="twin-toolgroup" role="group" aria-label="Camera mode" data-guide="camera">
        <button data-guide="camera-orbit" className={cameraMode === "orbit" ? "active" : ""} aria-pressed={cameraMode === "orbit"} onClick={() => { setCameraMode("orbit"); props.onGuideAction?.("camera-orbit"); }}><MousePointer2 size={13}/> Orbit</button>
        <button data-guide="camera-walk" className={cameraMode === "walk" ? "active" : ""} aria-pressed={cameraMode === "walk"} onClick={() => { setCameraMode("walk"); props.onGuideAction?.("camera-walk"); }}><Footprints size={13}/> Walk</button>
      </div>
      <details className="twin-help"><summary aria-label="Camera and floor help"><CircleHelp size={13}/></summary><p>Floors change the visible level. Orbit is best for planning; Walk gives aisle-level movement. Neither changes replay state.</p></details>
      <span className="twin-model"><Box size={12}/> {props.mode === "edit" ? `UNPUBLISHED DRAFT · BASED ON ${props.modelVersion}` : `OPERATIONS · ${props.modelVersion}`}</span>
    </div>
    <div className="twin-stage" data-guide="twin" data-camera-state={cameraState}>
      <TwinBoundary fallback={fallback}>
        <Suspense fallback={<div className="twin-fallback"><b>Loading facility twin…</b></div>}>
          <FacilityTwinCanvas {...props} model={effectiveModel} floor={floor} cameraMode={cameraMode} onCameraState={setCameraState}/>
        </Suspense>
      </TwinBoundary>
      <div className="twin-instructions">{cameraMode === "walk" ? "WASD move · drag to look · click for pointer capture · Esc exits capture" : "Drag to orbit · wheel to zoom · right-drag to pan"}</div>
      {props.view === "thermal" && <div className="twin-legend"><span>Cool</span><i/><span>{props.snapshot.incident.limitC.toFixed(0)}°C limit</span></div>}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{summary} Selected asset {props.selectedId}.</p>
    <div className="twin-asset-strip" role="list" aria-label="Keyboard-selectable facility assets" data-guide="assets">
      {strip.map(([id, label]) => <button role="listitem" key={id} className={props.selectedId === id ? "selected" : ""} aria-pressed={props.selectedId === id} onClick={() => { props.onSelect(id); props.onGuideAction?.("asset-select"); }}>{label}</button>)}
      {!strip.length && <span role="listitem" className="twin-strip-note">No second floor in this build</span>}
    </div>
    <div className="twin-layer-summary">{props.overlays.map((item) => overlayLabels[item]).join(" · ") || "No overlays"} · deterministic snapshot at {Math.round(props.snapshot.elapsedS / 60)}m{props.highlightedPath?.length ? ` · focused path ${props.highlightedPath.join(" → ")}` : ""}</div>
  </div>;
}
