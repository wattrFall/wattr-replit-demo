import { useEffect, useMemo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { CELL, SBX } from "@/lib/sandbox/tokens";
import { GAP_COLS, floorD, floorW, gridD, gridW } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";
import type { FloorSpec } from "@/lib/sandbox/types";

/** One zone slab, its tile grid, and its label. */
function ZoneSlab({
  x0,
  cols,
  rows,
  colour,
  label,
  originX,
  originZ,
}: {
  x0: number;
  cols: number;
  rows: number;
  colour: string;
  label: string;
  originX: number;
  originZ: number;
}) {
  const w = cols * CELL;
  const d = rows * CELL;

  /**
   * Tile lines as a single LineSegments buffer rather than one mesh per tile:
   * one draw call instead of hundreds, and it stays that way as the floor grows.
   */
  const grid = useMemo(() => {
    const points: number[] = [];
    for (let i = 0; i <= cols; i++) points.push(i * CELL, 0, 0, i * CELL, 0, d);
    for (let j = 0; j <= rows; j++) points.push(0, 0, j * CELL, w, 0, j * CELL);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return g;
  }, [cols, rows, w, d]);

  useEffect(() => () => grid.dispose(), [grid]);

  return (
    <group position={[originX + x0 * CELL, 0, originZ]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, -0.01, d / 2]}>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={colour} roughness={0.95} metalness={0} />
      </mesh>

      <lineSegments geometry={grid} position={[0, 0.002, 0]}>
        <lineBasicMaterial color={SBX.gridLine} transparent opacity={0.55} />
      </lineSegments>

      {/* Kerb, brighter than the interior tiling, so each zone reads as its own slab. */}
      <lineSegments position={[w / 2, 0.004, d / 2]}>
        <edgesGeometry args={[new THREE.BoxGeometry(w, 0.001, d)]} />
        <lineBasicMaterial color={SBX.gridLineMajor} transparent opacity={0.9} />
      </lineSegments>

      <Text
        position={[w / 2, 0.02, -0.45]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.34}
        color={SBX.primary}
        anchorX="center"
        anchorY="middle"
        fillOpacity={0.55}
        letterSpacing={0.18}
      >
        {label}
      </Text>
    </group>
  );
}

/**
 * The site: a raised floor for racks and the cooling that serves them, and a
 * plant yard for heat rejection, with a walkway between.
 *
 * Drawing them as two separate slabs is what makes the placement rule visible
 * before it is enforced — you can see where a chiller is meant to go.
 */
export function Room() {
  const floor = useSandboxStore((s) => s.floor) as FloorSpec;

  // Both slabs are positioned from the site's top-left corner so the whole
  // site, not the hall alone, is centred on the origin.
  const originX = -floorW(floor) / 2;
  const originZ = -floorD(floor) / 2;

  return (
    <group>
      <ZoneSlab
        x0={0}
        cols={floor.hallW}
        rows={gridD(floor)}
        colour={SBX.surface1}
        label="RAISED FLOOR"
        originX={originX}
        originZ={originZ}
      />
      <ZoneSlab
        x0={floor.hallW + GAP_COLS}
        cols={gridW(floor) - floor.hallW - GAP_COLS}
        rows={gridD(floor)}
        colour={SBX.surface2}
        label="PLANT YARD"
        originX={originX}
        originZ={originZ}
      />
    </group>
  );
}
