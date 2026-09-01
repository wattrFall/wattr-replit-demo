import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { CELL, SBX } from "@/lib/sandbox/tokens";
import { GRID_D, GRID_W } from "@/lib/sandbox/catalogue";
import { FLOOR_D, FLOOR_W } from "@/lib/sandbox/geometry";

/**
 * The empty hall: floor slab, tile grid, and a low perimeter kerb that gives
 * the room an edge without boxing the camera in with walls.
 *
 * Geometry is built once and memoised — nothing here changes at runtime, so it
 * must never be part of the per-frame cost.
 */
export function Room() {
  const width = FLOOR_W;
  const depth = FLOOR_D;

  /**
   * Tile lines as a single LineSegments buffer rather than GRID_W * GRID_D
   * meshes: one draw call instead of ~100.
   */
  const gridGeometry = useMemo(() => {
    const points: number[] = [];
    for (let x = 0; x <= GRID_W; x++) {
      points.push(x * CELL, 0, 0, x * CELL, 0, depth);
    }
    for (let z = 0; z <= GRID_D; z++) {
      points.push(0, 0, z * CELL, width, 0, z * CELL);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }, [width, depth]);

  useEffect(() => () => gridGeometry.dispose(), [gridGeometry]);

  return (
    // Centre the floor on the origin so the camera orbits the room's middle.
    <group position={[-width / 2, 0, -depth / 2]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[width / 2, -0.01, depth / 2]} receiveShadow={false}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color={SBX.surface1} roughness={0.95} metalness={0} />
      </mesh>

      <lineSegments geometry={gridGeometry} position={[0, 0.002, 0]}>
        <lineBasicMaterial color={SBX.gridLine} transparent opacity={0.55} />
      </lineSegments>

      {/* Perimeter kerb, drawn brighter than the interior tiling. */}
      <lineSegments position={[width / 2, 0.004, depth / 2]}>
        <edgesGeometry args={[new THREE.BoxGeometry(width, 0.001, depth)]} />
        <lineBasicMaterial color={SBX.gridLineMajor} transparent opacity={0.9} />
      </lineSegments>
    </group>
  );
}
