import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { CATALOGUE } from "@/lib/sandbox/catalogue";
import { cellToWorld } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";
import type { Connection, FloorSpec, SandboxItem } from "@/lib/sandbox/types";

/** Where a link attaches to a unit: just below the top face, centred. */
function anchor(floor: FloorSpec, item: SandboxItem): THREE.Vector3 {
  const [x, , z] = cellToWorld(floor, item.cell, item.kind);
  return new THREE.Vector3(x, CATALOGUE[item.kind].height * 0.82, z);
}

/**
 * One directed link, drawn as an arc between two units with a pulse travelling
 * along it in the direction heat moves.
 *
 * The arc rises out of the floor plane so links stay readable when they cross
 * each other or pass over other equipment.
 */
export function FlowPath({
  connection,
  items,
  reducedMotion,
  dimmed,
}: {
  connection: Connection;
  items: SandboxItem[];
  reducedMotion: boolean;
  dimmed: boolean;
}) {
  const pulse = useRef<THREE.Mesh>(null);
  const floor = useSandboxStore((s) => s.floor);

  const from = items.find((i) => i.id === connection.fromId);
  const to = items.find((i) => i.id === connection.toId);

  const { curve, geometry, colour } = useMemo(() => {
    if (!from || !to) return { curve: null, geometry: null, colour: "#ffffff" };

    const start = anchor(floor, from);
    const end = anchor(floor, to);
    // Lift the control point by a fraction of the span so short links stay
    // shallow and long ones bow enough to clear whatever sits between them.
    const lift = 0.4 + start.distanceTo(end) * 0.16;
    const mid = start.clone().add(end).multiplyScalar(0.5).setY(Math.max(start.y, end.y) + lift);

    const path = new THREE.QuadraticBezierCurve3(start, mid, end);
    return {
      curve: path,
      geometry: new THREE.TubeGeometry(path, 28, 0.022, 6, false),
      colour: CATALOGUE[from.kind].accent,
    };
  }, [from, to, floor]);

  // TubeGeometry is rebuilt whenever the endpoints change; release the previous
  // one rather than leaving it on the GPU.
  useEffect(() => {
    if (!geometry) return;
    return () => geometry.dispose();
  }, [geometry]);

  useFrame(({ clock }) => {
    if (!pulse.current || !curve || reducedMotion) return;
    // A 2.6s loop reads as steady circulation rather than urgency.
    const t = (clock.getElapsedTime() / 2.6) % 1;
    pulse.current.position.copy(curve.getPointAt(t));
  });

  if (!from || !to || !geometry || !curve) return null;

  return (
    <group>
      <mesh geometry={geometry}>
        <meshBasicMaterial color={colour} transparent opacity={dimmed ? 0.22 : 0.5} />
      </mesh>

      {!reducedMotion && (
        <mesh ref={pulse} position={curve.getPointAt(0)}>
          <sphereGeometry args={[0.055, 10, 10]} />
          <meshBasicMaterial color={colour} transparent opacity={dimmed ? 0.4 : 0.95} />
        </mesh>
      )}
    </group>
  );
}
