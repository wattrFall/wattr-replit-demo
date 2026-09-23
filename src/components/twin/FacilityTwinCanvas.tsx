import { Suspense, useEffect, useId, useMemo, useRef, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Body } from "@/components/sandbox/scene/Placeable";
import { PipeRun } from "@/components/sandbox/scene/Pipe";
import { ZoneSlab } from "@/components/sandbox/scene/Room";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { facilityAssets, itemLabel, twinAssetId } from "@/lib/cockpit/facilityAssets";
import type { FacilityLayout } from "@/lib/facility/layout";
import { SFO_01_LAYOUT } from "@/lib/facility/templates";
import { layoutLabels, type LabelInput } from "@/lib/twin/labelLayout";
import { CATALOGUE } from "@/lib/sandbox/catalogue";
import { boundsToWorld, cellToWorld, zoneRect } from "@/lib/sandbox/geometry";
import { rackHeatFraction } from "@/lib/sandbox/model";
import { linkPaths } from "@/lib/sandbox/routing";
import { SBX, heatColour } from "@/lib/sandbox/tokens";
import type { SandboxItem } from "@/lib/sandbox/types";
import type { FacilityTwinProps } from "./types";

type CanvasProps = FacilityTwinProps & {
  floor: 1 | 2;
  cameraMode: "orbit" | "walk";
  onCameraState?: (state: string) => void;
};

/** A footprint the walking camera cannot pass through, centred at x, z. */
type Obstacle = { x: number; z: number; w: number; d: number };

/** Where a floor sits in the world, so the camera can frame a build of any size. */
type Frame = { cx: number; cz: number; halfW: number; halfD: number; span: number };

/** Room to walk around the outside of the floor. */
const WALK_MARGIN = 1.6;

/** Floor 2 of the SFO-01 reference facility: compute racks the replay does not model. */
const REFERENCE_FLOOR_TWO: Array<Obstacle & { id: string; label: string; kind: "rack" | "power"; h: number }> = [
  { id: "rack-f2-a", label: "F2-A", kind: "rack", x: -4, z: -2, w: 1.4, d: 1.2, h: 2.7 },
  { id: "rack-f2-b", label: "F2-B", kind: "rack", x: 0, z: -2, w: 1.4, d: 1.2, h: 2.7 },
  { id: "rack-f2-c", label: "F2-C", kind: "rack", x: 4, z: -2, w: 1.4, d: 1.2, h: 2.7 },
  { id: "pdu-02", label: "PDU-02", kind: "power", x: 0, z: 5, w: 1.4, d: 1, h: 2.1 },
];
const FLOOR_TWO_FRAME: Frame = { cx: 0, cz: 0, halfW: 9, halfD: 6, span: 18 };

/** The extent of a layout's zones, centred on the origin the camera orbits. */
function layoutFrame(layout: FacilityLayout): Frame {
  const rects = layout.zones.map((zone) => boundsToWorld(zoneRect(zone)));
  if (!rects.length) return FLOOR_TWO_FRAME;
  const minX = Math.min(...rects.map((r) => r.x - r.w / 2));
  const maxX = Math.max(...rects.map((r) => r.x + r.w / 2));
  const minZ = Math.min(...rects.map((r) => r.z - r.d / 2));
  const maxZ = Math.max(...rects.map((r) => r.z + r.d / 2));
  const halfW = (maxX - minX) / 2;
  const halfD = (maxZ - minZ) / 2;
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, halfW, halfD, span: Math.max(12, halfW * 2, halfD * 2) };
}

function CameraRig({ mode, floor, frame, obstacles, onCameraState }: {
  mode: "orbit" | "walk";
  floor: 1 | 2;
  frame: Frame;
  obstacles: Obstacle[];
  onCameraState?: (state: string) => void;
}) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>()), yaw = useRef(0), pitch = useRef(0), dragging = useRef(false);
  const active = useRef(false);
  const lastReported = useRef("");
  const report = (capture: string) => {
    const position = camera.position.toArray().map((value) => value.toFixed(2)).join(",");
    const state = `${mode}:${position}:${capture}`;
    if (state !== lastReported.current) {
      lastReported.current = state;
      onCameraState?.(state);
    }
  };
  useEffect(() => {
    if (mode === "walk") camera.position.set(0, 1.65, frame.halfD + WALK_MARGIN);
    // Close enough that the build fills the stage, with room around it to orbit.
    else camera.position.set(frame.span * .6, frame.span * .5, frame.span * .66);
    camera.rotation.set(0, mode === "walk" ? Math.PI : 0, 0);
    report("idle");
  }, [camera, mode, floor, frame]);
  useEffect(() => {
    if (mode !== "walk") return;
    const node = gl.domElement;
    const down = (e: KeyboardEvent) => { if (active.current) keys.current.add(e.code); };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== node && !dragging.current) return;
      yaw.current -= e.movementX * .0025; pitch.current = THREE.MathUtils.clamp(pitch.current - e.movementY * .002, -.9, .9);
    };
    const mouseDown = () => {
      active.current = true;
      dragging.current = true;
      report("requesting");
      try {
        const request = node.requestPointerLock?.();
        if (request && typeof (request as Promise<void>).catch === "function") {
          void (request as Promise<void>).catch(() => report("rejected-drag-fallback"));
        }
      } catch {
        report("rejected-drag-fallback");
      }
    };
    const mouseUp = () => { dragging.current = false; if (document.pointerLockElement !== node) { active.current = false; keys.current.clear(); } };
    const lockChange = () => {
      active.current = document.pointerLockElement === node;
      report(active.current ? "captured" : "released");
      if (!active.current) keys.current.clear();
    };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("mousemove", move);
    node.addEventListener("mousedown", mouseDown); document.addEventListener("pointerlockchange", lockChange); window.addEventListener("mouseup", mouseUp);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("mousemove", move); node.removeEventListener("mousedown", mouseDown); document.removeEventListener("pointerlockchange", lockChange); window.removeEventListener("mouseup", mouseUp); if (document.pointerLockElement === node) document.exitPointerLock(); };
  }, [gl, mode]);
  useFrame((_, delta) => {
    report(mode === "walk"
      ? document.pointerLockElement === gl.domElement ? "captured" : dragging.current ? "drag-fallback" : "idle"
      : "idle");
    if (mode !== "walk") return;
    camera.rotation.set(pitch.current, yaw.current, 0, "YXZ");
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw.current);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw.current);
    const movement = new THREE.Vector3();
    if (keys.current.has("KeyW")) movement.add(forward); if (keys.current.has("KeyS")) movement.sub(forward);
    if (keys.current.has("KeyD")) movement.add(right); if (keys.current.has("KeyA")) movement.sub(right);
    if (!movement.lengthSq()) return;
    movement.normalize().multiplyScalar(delta * (keys.current.has("ShiftLeft") ? 6 : 3));
    const distance = movement.length(), steps = Math.max(1, Math.ceil(distance / .18)), step = movement.multiplyScalar(1 / steps);
    const limitX = frame.halfW + WALK_MARGIN, limitZ = frame.halfD + WALK_MARGIN;
    for (let i = 0; i < steps; i += 1) {
      const next = camera.position.clone().add(step);
      next.x = THREE.MathUtils.clamp(next.x, -limitX, limitX); next.z = THREE.MathUtils.clamp(next.z, -limitZ, limitZ); next.y = 1.65;
      const blocked = obstacles.some((obstacle) => Math.abs(next.x - obstacle.x) < obstacle.w / 2 + .38 && Math.abs(next.z - obstacle.z) < obstacle.d / 2 + .38);
      if (blocked) break;
      camera.position.copy(next);
    }
  });
  return mode === "orbit" ? <OrbitControls
    makeDefault
    target={[0, 1, 0]}
    minDistance={7}
    maxDistance={Math.max(36, frame.span * 2.4)}
    minPolarAngle={.25}
    maxPolarAngle={Math.PI / 2.08}
    enablePan
    onChange={() => report("orbit-input")}
  /> : null;
}

/**
 * One unit of the published build, drawn with the Builder's silhouettes.
 * Racks take their heat colour from the replay in the thermal view.
 */
function TwinUnit({ item, props }: { item: SandboxItem; props: CanvasProps }) {
  const id = twinAssetId(item);
  const entry = CATALOGUE[item.kind];
  const rack = item.kind === "rack" ? props.snapshot.racks.find((candidate) => candidate.id === id) : undefined;
  const selected = props.selectedId === id;
  const highlighted = props.highlightedPath?.some((step) => step === id || step === item.id) ?? false;
  const heat = rack && props.view === "thermal" && props.overlays.includes("heat")
    ? heatColour(rackHeatFraction(item, rack.inletC))
    : null;
  const accent = selected ? SBX.primaryBright : highlighted ? "#C4B5FD" : entry.accent;
  const atRisk = Boolean(rack?.atRisk) && props.overlays.includes("incidents");
  const reach = Math.max(entry.footprint.w, entry.footprint.d);
  const click = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); props.onSelect(id); };

  return <group position={cellToWorld(item.cell, item.kind)}>
    <Body item={item} accent={accent} heat={selected ? null : heat}/>
    {(selected || highlighted) && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .012, 0]}>
      <planeGeometry args={[entry.footprint.w * .98, entry.footprint.d * .98]}/>
      <meshBasicMaterial color={selected ? SBX.primaryBright : "#A855F7"} transparent opacity={.24}/>
    </mesh>}
    {atRisk && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .02, 0]}>
      <ringGeometry args={[reach * .62, reach * .78, 32]}/>
      <meshBasicMaterial color="#FB7185" transparent opacity={.9}/>
    </mesh>}
    {/* Invisible material, not visible={false}: an invisible object is skipped by the raycaster. */}
    <mesh position={[0, entry.height / 2, 0]} onClick={click}>
      <boxGeometry args={[entry.footprint.w, entry.height + .2, entry.footprint.d]}/>
      <meshBasicMaterial visible={false}/>
    </mesh>
  </group>;
}

/**
 * Floor 1: the published build's zones, equipment and connections. Pipes leave
 * and enter units at their ports along overhead tray routes, exactly as the
 * Builder draws them, so what was built is what Operations shows.
 */
function LayoutFloor(props: CanvasProps & { layout: FacilityLayout; frame: Frame; reducedMotion: boolean }) {
  const { layout, frame, overlays, reducedMotion } = props;
  const routed = useMemo(
    () => layout.connections.map((link) => ({ link, paths: linkPaths(link, layout.items) })),
    [layout],
  );
  const kinds = useMemo(() => new Map(layout.items.map((item) => [item.id, item.kind])), [layout]);
  const selectedItem = layout.items.find((item) => twinAssetId(item) === props.selectedId);
  const showSensors = overlays.includes("sensors");
  const ignoreClick = (event: ThreeEvent<MouseEvent>) => event.stopPropagation();

  return <group position={[-frame.cx, 0, -frame.cz]}>
    <Suspense fallback={null}>
      {layout.zones.map((zone) => <ZoneSlab key={zone.id} zone={zone} selected={false}/>)}
    </Suspense>
    {routed
      .filter(({ link }) => kinds.get(link.fromId) === "sensor" ? showSensors : overlays.includes("flow"))
      .flatMap(({ link, paths }) => paths.map((path) => <PipeRun
        key={`${link.id}:${path.role}`}
        path={path}
        reducedMotion={reducedMotion}
        dimmed={Boolean(selectedItem) && link.fromId !== selectedItem?.id && link.toId !== selectedItem?.id}
        selected={false}
        onClick={ignoreClick}
      />))}
    {layout.items
      .filter((item) => showSensors || item.kind !== "sensor")
      .map((item) => <TwinUnit key={item.id} item={item} props={props}/>)}
  </group>;
}

/** Floor 2 of the SFO-01 reference facility, which only that model has. */
function ReferenceFloorTwo(props: CanvasProps) {
  return <>
    <gridHelper args={[20, 20, SBX.gridLineMajor, SBX.gridLine]} position={[0, .01, 0]}/>
    {REFERENCE_FLOOR_TWO.map((asset) => {
      const selected = props.selectedId === asset.id;
      const click = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); props.onSelect(asset.id); };
      return <group key={asset.id} position={[asset.x, 0, asset.z]}>
        <mesh position={[0, asset.h / 2, 0]} onClick={click}>
          <boxGeometry args={[asset.w, asset.h, asset.d]}/>
          <meshStandardMaterial color={SBX.surface3} emissive={selected ? SBX.primaryBright : "#000000"} emissiveIntensity={selected ? .35 : 0} roughness={.7} metalness={.1}/>
          <Edges color={selected ? SBX.primaryBright : asset.kind === "rack" ? CATALOGUE.rack.accent : "#EAB308"}/>
        </mesh>
      </group>;
    })}
  </>;
}

/** One label over the scene: an asset's name, or a callout that belongs to the scene as a whole. */
type SceneLabel = {
  id: string;
  text: string;
  /** A second line, such as the hot rack's forecast. */
  detail?: string;
  tone?: "warn";
  /** Where the label centres when nothing is in the way, and the point its leader line returns to. */
  anchor: [number, number, number];
  target: [number, number, number];
  priority: number;
  /** Asset labels select their asset; scene callouts are not controls. */
  selectable: boolean;
};

/** Everything the scene labels, in world coordinates. */
function sceneLabels(props: CanvasProps): SceneLabel[] {
  const layout = props.model.layout ?? SFO_01_LAYOUT;
  const showNames = props.overlays.includes("labels");
  const labels: SceneLabel[] = [];
  if (props.floor === 2) {
    if (!props.model.layout) {
      if (showNames) for (const asset of REFERENCE_FLOOR_TWO) labels.push({
        id: asset.id, text: asset.label, anchor: [asset.x, asset.h + .45, asset.z], target: [asset.x, asset.h, asset.z],
        priority: asset.kind === "rack" ? 0 : 1, selectable: true,
      });
    } else {
      labels.push({ id: "single-floor", text: "SINGLE-FLOOR BUILD", detail: "No floor 2", anchor: [0, .6, 0], target: [0, .6, 0], priority: 2, selectable: false });
    }
    return labels;
  }
  const frame = layoutFrame(layout);
  const forecast = props.overlays.includes("forecast") ? props.snapshot.forecast : null;
  for (const item of layout.items) {
    if (item.kind === "sensor") continue;
    const id = twinAssetId(item);
    // The forecast rides on its rack's own label rather than floating over the scene.
    const hot = Boolean(forecast) && item.kind === "rack" && id === props.snapshot.incident.rackId;
    if (!showNames && !hot) continue;
    const [x, y, z] = cellToWorld(item.cell, item.kind);
    const top = y + CATALOGUE[item.kind].height;
    labels.push({
      id,
      text: item.kind === "rack" ? id : itemLabel(item).toUpperCase(),
      ...(hot && forecast ? {
        detail: `${forecast.baselinePeakC.toFixed(1)}°C in ${Math.round(forecast.horizonS / 60)} min`,
        tone: forecast.risk === "clear" ? undefined : "warn" as const,
      } : {}),
      anchor: [x - frame.cx, top + .45, z - frame.cz],
      target: [x - frame.cx, top, z - frame.cz],
      priority: item.kind === "rack" ? 0 : 1,
      selectable: true,
    });
  }
  if (props.highlightedPath?.length) labels.push({
    id: "focused-path", text: "FOCUSED THERMAL PATH", detail: props.highlightedPath.join(" → "),
    anchor: [0, 4.2, 0], target: [0, 4.2, 0], priority: 2, selectable: false,
  });
  return labels;
}

/** The label layer's elements, which the scene positions directly each time the view changes. */
type LabelElements = { labels: Map<string, HTMLElement>; leaders: Map<string, SVGLineElement> };

/** Space kept clear at the stage's bottom edge for the camera instructions. */
const INSTRUCTIONS_CLEARANCE = 48;

/**
 * Places the labels whenever the camera, the stage's size or the labels
 * change, writing positions straight to their elements so a moving camera
 * never re-renders React.
 */
function LabelPlacer({ labels, elements }: { labels: SceneLabel[]; elements: RefObject<LabelElements> }) {
  const { camera, size } = useThree();
  const last = useRef({ signature: "", at: 0 });
  const point = useMemo(() => new THREE.Vector3(), []);
  const key = labels.map((label) => `${label.id}:${label.text}:${label.detail ?? ""}`).join("|");
  useFrame(() => {
    const refs = elements.current;
    if (!refs) return;
    const now = performance.now();
    const signature = `${size.width}x${size.height}|${key}|${camera.matrixWorld.elements.map((n) => n.toFixed(4)).join(",")}|${camera.projectionMatrix.elements[0].toFixed(4)}`;
    // Re-check now and then as well, in case a label's size changed when its font arrived.
    if (signature === last.current.signature && now - last.current.at < 500) return;
    last.current = { signature, at: now };
    const project = (at: [number, number, number]) => {
      point.set(...at).project(camera);
      return { x: (point.x + 1) / 2 * size.width, y: (1 - point.y) / 2 * size.height, inFront: point.z > -1 && point.z < 1 };
    };
    const inputs: LabelInput[] = [];
    for (const label of labels) {
      const element = refs.labels.get(label.id);
      if (!element) continue;
      const anchor = project(label.anchor);
      const target = project(label.target);
      inputs.push({
        id: label.id, anchorX: anchor.x, anchorY: anchor.y, targetX: target.x, targetY: target.y,
        width: element.offsetWidth, height: element.offsetHeight, priority: label.priority,
        distance: camera.position.distanceTo(point.set(...label.anchor)), inFront: anchor.inFront,
        leader: label.selectable,
      });
    }
    const placements = layoutLabels(inputs, { width: size.width, height: size.height, inset: { top: 6, right: 6, bottom: INSTRUCTIONS_CLEARANCE, left: 6 } });
    for (const place of placements) {
      const element = refs.labels.get(place.id);
      if (element) {
        element.style.visibility = place.visible ? "visible" : "hidden";
        element.style.opacity = String(place.opacity);
        element.style.transform = `translate3d(${place.x.toFixed(1)}px, ${place.y.toFixed(1)}px, 0) scale(${place.scale.toFixed(3)})`;
      }
      const leader = refs.leaders.get(place.id);
      if (!leader) continue;
      leader.style.visibility = place.visible && place.leader ? "visible" : "hidden";
      if (place.leader) {
        leader.setAttribute("x1", place.leader.x1.toFixed(1));
        leader.setAttribute("y1", place.leader.y1.toFixed(1));
        leader.setAttribute("x2", place.leader.x2.toFixed(1));
        leader.setAttribute("y2", place.leader.y2.toFixed(1));
      }
    }
  });
  return null;
}

/** The labels themselves: one layer over the canvas, positioned by LabelPlacer. */
function SceneLabelLayer({ labels, elements, selectedId, onSelect }: { labels: SceneLabel[]; elements: RefObject<LabelElements>; selectedId: string; onSelect: (id: string) => void }) {
  const register = <T extends Element>(map: Map<string, T> | undefined, id: string) => (element: T | null) => {
    if (!map) return;
    if (element) map.set(id, element);
    else map.delete(id);
  };
  // A dot where each leader meets its equipment, so a leader never reads as a pipe.
  const dot = `scene-leader-dot-${useId().replace(/:/g, "")}`;
  return <div className="scene-labels">
    <svg className="scene-leaders" aria-hidden="true">
      <defs><marker id={dot} viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse"><circle cx="3" cy="3" r="2.5"/></marker></defs>
      {labels.filter((label) => label.selectable).map((label) => <line key={label.id} ref={register(elements.current?.leaders, label.id)} markerStart={`url(#${dot})`}/>)}
    </svg>
    {labels.map((label) => {
      const className = `scene-label${label.tone ? ` ${label.tone}` : ""}${label.selectable ? "" : " callout"}${selectedId === label.id ? " selected" : ""}`;
      const content = <><span>{label.text}</span>{label.detail && <b>{label.detail}</b>}</>;
      return label.selectable
        ? <button key={label.id} ref={register(elements.current?.labels, label.id)} type="button" className={className} onClick={() => onSelect(label.id)}>{content}</button>
        : <div key={label.id} ref={register(elements.current?.labels, label.id)} className={className}>{content}</div>;
    })}
  </div>;
}

function FacilityScene(props: CanvasProps & { labels: SceneLabel[]; labelElements: RefObject<LabelElements> }) {
  const reducedMotion = useReducedMotion();
  const layout = props.model.layout ?? SFO_01_LAYOUT;
  const reference = !props.model.layout;
  const workloadId = facilityAssets(props.model).workload.id;
  const floorOne = useMemo(() => layoutFrame(layout), [layout]);
  const frame = props.floor === 1 ? floorOne : FLOOR_TWO_FRAME;
  const obstacles = useMemo<Obstacle[]>(() => {
    if (props.floor === 2) return reference ? REFERENCE_FLOOR_TWO : [];
    return layout.items
      .filter((item) => item.kind !== "sensor")
      .map((item) => {
        const [x, , z] = cellToWorld(item.cell, item.kind);
        const { footprint } = CATALOGUE[item.kind];
        return { x: x - floorOne.cx, z: z - floorOne.cz, w: footprint.w, d: footprint.d };
      });
  }, [layout, floorOne, props.floor, reference]);

  return <>
    <color attach="background" args={[SBX.surface0]}/>
    <fog attach="fog" args={[SBX.surface0, frame.span * 2.2, frame.span * 5]}/>
    <ambientLight intensity={.55}/><hemisphereLight args={["#dbeafe", "#0b1622", .9]}/><directionalLight position={[12, 18, 8]} intensity={1.1}/>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.04, 0]} onClick={(event) => { event.stopPropagation(); props.onSelect(workloadId); }}>
      <planeGeometry args={[frame.halfW * 2 + 10, frame.halfD * 2 + 10]}/>
      <meshStandardMaterial color={SBX.surface0} roughness={1}/>
    </mesh>
    {props.floor === 1
      ? <LayoutFloor {...props} layout={layout} frame={frame} reducedMotion={reducedMotion}/>
      : reference ? <ReferenceFloorTwo {...props}/> : null}
    <CameraRig mode={props.cameraMode} floor={props.floor} frame={frame} obstacles={obstacles} onCameraState={props.onCameraState}/>
    <LabelPlacer labels={props.labels} elements={props.labelElements}/>
  </>;
}

export default function FacilityTwinCanvas(props: CanvasProps) {
  const workloadId = facilityAssets(props.model).workload.id;
  const labels = sceneLabels(props);
  const labelElements = useRef<LabelElements>({ labels: new Map(), leaders: new Map() });
  return <>
    <Canvas aria-hidden="true" camera={{ position: [15, 12, 16], fov: 48, near: .1, far: 400 }} dpr={[1, 1.7]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => props.onSelect(workloadId)}>
      <FacilityScene {...props} labels={labels} labelElements={labelElements}/>
    </Canvas>
    <SceneLabelLayer labels={labels} elements={labelElements} selectedId={props.selectedId} onSelect={props.onSelect}/>
  </>;
}
