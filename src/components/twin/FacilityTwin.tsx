import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { Box, Footprints, Layers3, MousePointer2 } from "lucide-react";
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

export function FacilityTwin(props: FacilityTwinProps) {
  const [floor, setFloor] = useState<1 | 2>(1);
  const [cameraMode, setCameraMode] = useState<"orbit" | "walk">("orbit");
  const effectiveModel = props.mode === "edit" ? props.snapshot.modelConfig : props.model;
  const summary = useMemo(() => {
    const hot = props.snapshot.racks.filter((rack) => rack.atRisk).map((rack) => rack.id);
    return floor === 1
      ? `Authorized facility model, floor 1. Four GPU racks, CDU-03, Chiller-01, power distribution, and six sensors. Peak inlet ${props.snapshot.peakInletC.toFixed(1)} degrees Celsius. ${hot.length ? `Racks at risk: ${hot.join(", ")}.` : "No racks currently over limit."}`
      : "Authorized facility model, floor 2. Three compute racks and PDU-02. Operational replay state remains unchanged.";
  }, [floor, props.snapshot]);
  const fallback = <div className="twin-fallback" role="img" aria-label={summary}>
    <Layers3 size={28}/><b>3D scene unavailable</b>
    <p>{summary}</p><p>The replay, asset list, incident, recommendation, and operating controls remain available.</p>
  </div>;

  return <div className="facility-twin">
    <div className="twin-toolbar">
      <div className="twin-toolgroup" role="group" aria-label="Facility floor">
        {([1, 2] as const).map((value) => <button key={value} className={floor === value ? "active" : ""} aria-pressed={floor === value} onClick={() => setFloor(value)}>F{value}</button>)}
      </div>
      <div className="twin-toolgroup" role="group" aria-label="Camera mode">
        <button className={cameraMode === "orbit" ? "active" : ""} aria-pressed={cameraMode === "orbit"} onClick={() => setCameraMode("orbit")}><MousePointer2 size={13}/> Orbit</button>
        <button className={cameraMode === "walk" ? "active" : ""} aria-pressed={cameraMode === "walk"} onClick={() => setCameraMode("walk")}><Footprints size={13}/> Walk</button>
      </div>
      <span className="twin-model"><Box size={12}/> {props.mode === "edit" ? `UNPUBLISHED DRAFT · BASED ON ${props.modelVersion}` : `OPERATIONS · ${props.modelVersion}`}</span>
    </div>
    <div className="twin-stage">
      <TwinBoundary fallback={fallback}>
        <Suspense fallback={<div className="twin-fallback"><b>Loading facility twin…</b></div>}>
          <FacilityTwinCanvas {...props} model={effectiveModel} floor={floor} cameraMode={cameraMode}/>
        </Suspense>
      </TwinBoundary>
      <div className="twin-instructions">{cameraMode === "walk" ? "WASD move · drag to look · click for pointer capture · Esc exits capture" : "Drag to orbit · wheel to zoom · right-drag to pan"}</div>
      {props.view === "thermal" && <div className="twin-legend"><span>22°C</span><i/><span>35°C</span></div>}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{summary} Selected asset {props.selectedId}.</p>
    <div className="twin-asset-strip" role="list" aria-label="Keyboard-selectable facility assets">
      {(floor === 1 ? [
        ["gpu-b", "GPU Hall B"], ["A01", "Rack A01"], ["A02", "Rack A02"], ["B01", "Rack B01"], ["B02", "Rack B02"],
        ["cdu-03", "CDU-03"], ["chiller-01", "Chiller-01"], ["pdu-01", "PDU-01"], ["sensor-03", "Sensor-03"],
      ] : [["rack-f2-a", "Rack F2-A"], ["rack-f2-b", "Rack F2-B"], ["rack-f2-c", "Rack F2-C"], ["pdu-02", "PDU-02"]]).map(([id, label]) => <button role="listitem" key={id} className={props.selectedId === id ? "selected" : ""} aria-pressed={props.selectedId === id} onClick={() => props.onSelect(id)}>{label}</button>)}
    </div>
    <div className="twin-layer-summary">{props.overlays.map((item) => overlayLabels[item]).join(" · ") || "No overlays"} · deterministic snapshot at {Math.round(props.snapshot.elapsedS / 60)}m</div>
  </div>;
}