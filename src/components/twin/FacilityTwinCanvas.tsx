import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { FacilityTwinProps } from "./types";

type CanvasProps = FacilityTwinProps & { floor: 1 | 2; cameraMode: "orbit" | "walk" };
type Asset = { id: string; label: string; kind: "rack" | "cooling" | "power" | "sensor"; x: number; z: number; w: number; d: number; h: number; floor: 1 | 2 };

const ASSETS: Asset[] = [
  { id: "A01", label: "A01", kind: "rack", x: -6, z: -3.5, w: 1.4, d: 1.2, h: 2.7, floor: 1 },
  { id: "A02", label: "A02", kind: "rack", x: -2.5, z: -3.5, w: 1.4, d: 1.2, h: 2.7, floor: 1 },
  { id: "B01", label: "B01", kind: "rack", x: 1.5, z: -3.5, w: 1.4, d: 1.2, h: 2.7, floor: 1 },
  { id: "B02", label: "B02", kind: "rack", x: 5, z: -3.5, w: 1.4, d: 1.2, h: 2.7, floor: 1 },
  { id: "cdu-03", label: "CDU-03", kind: "cooling", x: -7.4, z: 4.5, w: 2.2, d: 1.5, h: 2.3, floor: 1 },
  { id: "chiller-01", label: "CHILLER-01", kind: "cooling", x: 6.8, z: 4.5, w: 3.2, d: 2, h: 2, floor: 1 },
  { id: "pdu-01", label: "PDU-01", kind: "power", x: 0, z: 5, w: 1.4, d: 1, h: 2.1, floor: 1 },
  { id: "rack-f2-a", label: "F2-A", kind: "rack", x: -4, z: -2, w: 1.4, d: 1.2, h: 2.7, floor: 2 },
  { id: "rack-f2-b", label: "F2-B", kind: "rack", x: 0, z: -2, w: 1.4, d: 1.2, h: 2.7, floor: 2 },
  { id: "rack-f2-c", label: "F2-C", kind: "rack", x: 4, z: -2, w: 1.4, d: 1.2, h: 2.7, floor: 2 },
  { id: "pdu-02", label: "PDU-02", kind: "power", x: 0, z: 5, w: 1.4, d: 1, h: 2.1, floor: 2 },
];

function CameraRig({ mode, floor }: { mode: "orbit" | "walk"; floor: 1 | 2 }) {
  const { camera, gl } = useThree();
  const keys = useRef(new Set<string>()), yaw = useRef(0), pitch = useRef(0), dragging = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    camera.position.set(mode === "walk" ? 0 : 15, mode === "walk" ? 1.65 : 12, mode === "walk" ? 8 : 16);
    camera.rotation.set(0, mode === "walk" ? Math.PI : 0, 0);
  }, [camera, mode, floor]);
  useEffect(() => {
    if (mode !== "walk") return;
    const node = gl.domElement;
    const down = (e: KeyboardEvent) => { if (active.current) keys.current.add(e.code); };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== node && !dragging.current) return;
      yaw.current -= e.movementX * .0025; pitch.current = THREE.MathUtils.clamp(pitch.current - e.movementY * .002, -.9, .9);
    };
    const mouseDown = () => { active.current = true; dragging.current = true; node.requestPointerLock?.(); };
    const mouseUp = () => { dragging.current = false; if (document.pointerLockElement !== node) { active.current = false; keys.current.clear(); } };
    const lockChange = () => { active.current = document.pointerLockElement === node; if (!active.current) keys.current.clear(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("mousemove", move);
    node.addEventListener("mousedown", mouseDown); document.addEventListener("pointerlockchange", lockChange); window.addEventListener("mouseup", mouseUp);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("mousemove", move); node.removeEventListener("mousedown", mouseDown); document.removeEventListener("pointerlockchange", lockChange); window.removeEventListener("mouseup", mouseUp); if (document.pointerLockElement === node) document.exitPointerLock(); };
  }, [gl, mode]);
  useFrame((_, delta) => {
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
    for (let i = 0; i < steps; i += 1) {
      const next = camera.position.clone().add(step); next.x = THREE.MathUtils.clamp(next.x, -10.6, 10.6); next.z = THREE.MathUtils.clamp(next.z, -7.6, 7.6); next.y = 1.65;
      const blocked = ASSETS.filter((asset) => asset.floor === floor && asset.kind !== "sensor").some((asset) => Math.abs(next.x - asset.x) < asset.w / 2 + .38 && Math.abs(next.z - asset.z) < asset.d / 2 + .38);
      if (blocked) break;
      camera.position.copy(next);
    }
  });
  return mode === "orbit" ? <OrbitControls makeDefault target={[0, 1, 0]} minDistance={7} maxDistance={36} minPolarAngle={.25} maxPolarAngle={Math.PI / 2.08} enablePan/> : null;
}

function AssetMesh({ asset, props }: { asset: Asset; props: CanvasProps }) {
  const rack = props.snapshot.racks.find((item) => item.id === asset.id);
  const selected = props.selectedId === asset.id;
  const heat = rack ? THREE.MathUtils.clamp((rack.inletC - 22) / 13, 0, 1) : 0;
  const color = props.view === "thermal" && props.overlays.includes("heat") ? new THREE.Color().lerpColors(new THREE.Color("#22d3ee"), new THREE.Color("#ef4444"), heat) : new THREE.Color(asset.kind === "rack" ? "#263746" : asset.kind === "cooling" ? "#0e7490" : "#a16207");
  const click = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); props.onSelect(asset.id); };
  return <group position={[asset.x, 0, asset.z]}>
    <mesh position={[0, asset.h / 2, 0]} onClick={click}>
      {asset.kind === "sensor" ? <sphereGeometry args={[.16, 12, 12]}/> : <boxGeometry args={[asset.w, asset.h, asset.d]}/>}
      <meshStandardMaterial color={color} emissive={selected ? "#32d5df" : rack?.atRisk && props.overlays.includes("incidents") ? "#b91c1c" : "#000000"} emissiveIntensity={selected ? .55 : .25} roughness={.64} metalness={.2}/>
      <Edges color={selected ? "#7ff5f7" : "#547080"}/>
    </mesh>
    {asset.kind === "rack" && <mesh position={[0, asset.h / 2, asset.d / 2 + .01]}><planeGeometry args={[asset.w * .7, asset.h * .72]}/><meshBasicMaterial color={color} transparent opacity={.42}/></mesh>}
    {props.overlays.includes("labels") && <Html center position={[0, asset.h + .35, 0]}><button className="scene-label" onClick={() => props.onSelect(asset.id)}>{asset.label}</button></Html>}
    {rack?.atRisk && props.overlays.includes("incidents") && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .02, 0]}><ringGeometry args={[.9, 1.12, 24]}/><meshBasicMaterial color="#fb7185"/></mesh>}
  </group>;
}

function FacilityScene(props: CanvasProps) {
  const assets = ASSETS.filter((asset) => asset.floor === props.floor);
  const sensors = useMemo(() => [-8, -4, 0, 4, 8, 10].map((x, index): Asset => ({ id: `sensor-${String(index + 1).padStart(2, "0")}`, label: `S-${index + 1}`, kind: "sensor", x, z: index % 2 ? 1.2 : -6.2, w: .3, d: .3, h: 1.3, floor: 1 })), []);
  return <>
    <color attach="background" args={[props.view === "thermal" ? "#10151e" : "#9bb5c8"]}/><fog attach="fog" args={["#9bb5c8", 30, 70]}/>
    <ambientLight intensity={.72}/><hemisphereLight args={["#e8f7ff", "#253b32", 1.1]}/><directionalLight position={[12, 18, 8]} intensity={1.2}/>
    <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={() => props.onSelect("gpu-b")}><planeGeometry args={[24, 18]}/><meshStandardMaterial color="#b7c0c7" roughness={.9}/></mesh>
    <gridHelper args={[24, 24, "#477487", "#77909a"]} position={[0, .01, 0]}/>
    {[[-12, 1.7, 0, .25, 3.4, 18], [12, 1.7, 0, .25, 3.4, 18], [0, 1.7, -9, 24, 3.4, .25], [-7, 1.7, 9, 10, 3.4, .25], [7, 1.7, 9, 10, 3.4, .25]].map((v, i) => <mesh key={i} position={[v[0], v[1], v[2]]}><boxGeometry args={[v[3], v[4], v[5]]}/><meshStandardMaterial color="#d4dde3" transparent opacity={.72}/></mesh>)}
    {assets.map((asset) => <AssetMesh key={asset.id} asset={asset} props={props}/>)}
    {props.floor === 1 && props.overlays.includes("sensors") && sensors.map((asset) => <AssetMesh key={asset.id} asset={asset} props={props}/>)}
    {props.overlays.includes("flow") && <><mesh position={[0, 3.1, 3]}><boxGeometry args={[17, .08, .08]}/><meshBasicMaterial color="#22d3ee"/></mesh><mesh position={[0, 3.1, -1]}><boxGeometry args={[14, .08, .08]}/><meshBasicMaterial color="#f59e0b"/></mesh></>}
    {props.overlays.includes("forecast") && <Html position={[4.8, 3.8, -3.5]}><div className="scene-forecast">5 MIN FORECAST<br/><b>{props.snapshot.forecast.baselinePeakC.toFixed(1)}°C</b></div></Html>}
    <CameraRig mode={props.cameraMode} floor={props.floor}/>
  </>;
}

export default function FacilityTwinCanvas(props: CanvasProps) {
  return <Canvas aria-hidden="true" camera={{ position: [15, 12, 16], fov: 48, near: .1, far: 100 }} dpr={[1, 1.7]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={() => props.onSelect("gpu-b")}><FacilityScene {...props}/></Canvas>;
}