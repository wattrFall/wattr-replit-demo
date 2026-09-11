import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { wasDragged } from "@/lib/sandbox/pointer";
import { linkPaths, type LinkPath } from "@/lib/sandbox/routing";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SBX } from "@/lib/sandbox/tokens";
import type { Connection, SandboxItem } from "@/lib/sandbox/types";

const PIPE_RADIUS = 0.035;
/** A fat invisible tube around every run, so a thin pipe is still easy to click. */
const HIT_RADIUS = 0.14;
/** World units per second the flow markers travel. */
const FLOW_SPEED = 1.4;
/** Roughly one marker per this many world units of run. */
const MARKER_SPACING = 1.6;

function toCurve(points: LinkPath["points"]): THREE.CurvePath<THREE.Vector3> {
  const curve = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 1; i < points.length; i++) {
    curve.add(new THREE.LineCurve3(new THREE.Vector3(...points[i - 1]), new THREE.Vector3(...points[i])));
  }
  return curve;
}

/**
 * One connection as it would be installed: port to port along overhead trays.
 *
 * A fluid loop is a supply and a return pipe; cooling air and sensor readings
 * are dashed runs. Each run carries an arrowhead showing flow direction, and
 * markers travelling along it unless reduced motion is requested. Clicking any
 * run selects the connection.
 */
export function Pipe({
  connection,
  items,
  reducedMotion,
  dimmed,
  selected,
  onSelect,
}: {
  connection: Connection;
  items: SandboxItem[];
  reducedMotion: boolean;
  dimmed: boolean;
  selected: boolean;
  onSelect: (connectionId: string) => void;
}) {
  const paths = useMemo(() => linkPaths(connection, items), [connection, items]);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    // A camera drag that ends over a pipe is not a click on it.
    if (wasDragged()) return;
    // An armed tool owns the click, so a pipe over a tile never blocks placing
    // or connecting there. Read at event time, not from the render closure.
    if (useSandboxStore.getState().mode.type !== "idle") return;
    event.stopPropagation();
    onSelect(connection.id);
  };

  return (
    <group>
      {paths.map((path) => (
        <Run
          key={path.role}
          path={path}
          reducedMotion={reducedMotion}
          dimmed={dimmed}
          selected={selected}
          onClick={handleClick}
        />
      ))}
    </group>
  );
}

function Run({
  path,
  reducedMotion,
  dimmed,
  selected,
  onClick,
}: {
  path: LinkPath;
  reducedMotion: boolean;
  dimmed: boolean;
  selected: boolean;
  onClick: (event: ThreeEvent<MouseEvent>) => void;
}) {
  const fluid = path.role === "supply" || path.role === "return";
  const curve = useMemo(() => toCurve(path.points), [path]);
  const length = useMemo(() => Math.max(0.001, curve.getLength()), [curve]);

  const tube = useMemo(
    () => (fluid ? new THREE.TubeGeometry(curve, Math.max(12, Math.ceil(length * 8)), PIPE_RADIUS, 8, false) : null),
    [curve, length, fluid],
  );
  const hit = useMemo(
    () => new THREE.TubeGeometry(curve, Math.max(6, Math.ceil(length * 3)), HIT_RADIUS, 6, false),
    [curve, length],
  );
  // Rebuilt whenever the route changes; release the old buffers from the GPU.
  useEffect(() => () => tube?.dispose(), [tube]);
  useEffect(() => () => hit.dispose(), [hit]);

  /** Direction arrowhead at the middle of the run, so flow still reads with motion reduced. */
  const arrow = useMemo(() => {
    const at = curve.getPointAt(0.5);
    const tangent = curve.getTangentAt(0.5).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    return { at, quaternion };
  }, [curve]);

  const markerColour = useMemo(
    () => `#${new THREE.Color(path.colour).lerp(new THREE.Color("#ffffff"), 0.45).getHexString()}`,
    [path.colour],
  );
  const markerCount = Math.max(1, Math.floor(length / MARKER_SPACING));
  const markers = useRef<Array<THREE.Mesh | null>>([]);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const offset = (clock.getElapsedTime() * FLOW_SPEED) / length;
    for (let i = 0; i < markerCount; i++) {
      const marker = markers.current[i];
      if (marker) marker.position.copy(curve.getPointAt((offset + i / markerCount) % 1));
    }
  });

  const colour = selected ? SBX.primaryBright : path.colour;

  return (
    <group>
      {fluid && tube ? (
        <mesh geometry={tube}>
          <meshStandardMaterial
            color={path.colour}
            emissive={path.colour}
            emissiveIntensity={selected ? 0.7 : 0.2}
            roughness={0.45}
            metalness={0.25}
            transparent
            opacity={dimmed ? 0.28 : 0.95}
          />
        </mesh>
      ) : (
        <Line
          points={path.points}
          color={colour}
          lineWidth={path.role === "air" ? 2.2 : 1.4}
          dashed
          dashSize={path.role === "air" ? 0.32 : 0.12}
          gapSize={path.role === "air" ? 0.18 : 0.12}
          transparent
          opacity={dimmed ? 0.25 : selected ? 1 : 0.8}
        />
      )}

      {/* Elbows, so square corners read as joined pipe rather than a gap. */}
      {fluid &&
        path.points.slice(1, -1).map((point) => (
          <mesh key={point.join(":")} position={point}>
            <sphereGeometry args={[PIPE_RADIUS * 1.3, 10, 10]} />
            <meshStandardMaterial color={path.colour} roughness={0.45} metalness={0.25} transparent opacity={dimmed ? 0.28 : 0.95} />
          </mesh>
        ))}

      <mesh position={arrow.at} quaternion={arrow.quaternion}>
        <coneGeometry args={[fluid ? 0.08 : 0.07, 0.2, 10]} />
        <meshBasicMaterial color={colour} transparent opacity={dimmed ? 0.3 : 1} />
      </mesh>

      {!reducedMotion &&
        Array.from({ length: markerCount }, (_, i) => (
          <mesh
            key={i}
            ref={(node) => {
              markers.current[i] = node;
            }}
            position={curve.getPointAt(i / markerCount)}
          >
            <sphereGeometry args={[fluid ? 0.052 : 0.04, 8, 8]} />
            <meshBasicMaterial color={markerColour} transparent opacity={dimmed ? 0.3 : 0.9} />
          </mesh>
        ))}

      <mesh geometry={hit} onClick={onClick}>
        {/* Invisible material, not visible={false}: an invisible OBJECT is
            skipped by the raycaster, an invisible material still hit-tests. */}
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
