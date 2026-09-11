import { useEffect, useMemo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { ZONE_CATALOGUE } from "@/lib/sandbox/catalogue";
import { CELL, SBX } from "@/lib/sandbox/tokens";
import { SITE, boundsToWorld, zoneRect } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";
import type { ZoneSpec } from "@/lib/sandbox/types";

/**
 * Tile lines as a single LineSegments buffer rather than one mesh per tile:
 * one draw call instead of hundreds, and it stays that way as zones grow.
 * Drawn from the rectangle's top-left corner.
 */
function useTileGrid(cols: number, rows: number, every = 1) {
  const grid = useMemo(() => {
    const w = cols * CELL;
    const d = rows * CELL;
    const points: number[] = [];
    for (let i = 0; i <= cols; i += every) points.push(i * CELL, 0, 0, i * CELL, 0, d);
    for (let j = 0; j <= rows; j += every) points.push(0, 0, j * CELL, w, 0, j * CELL);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }, [cols, rows, every]);
  useEffect(() => () => grid.dispose(), [grid]);
  return grid;
}

/**
 * The open site around the zones: a darker ground with a coarse grid, so there
 * is visibly somewhere to move a zone or add another.
 */
function SiteGround() {
  const grid = useTileGrid(SITE.w, SITE.d, 4);
  const w = SITE.w * CELL;
  const d = SITE.d * CELL;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]}>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={SBX.surface0} roughness={1} metalness={0} />
      </mesh>
      <lineSegments geometry={grid} position={[-w / 2, -0.02, -d / 2]}>
        <lineBasicMaterial color={SBX.gridLine} transparent opacity={0.2} />
      </lineSegments>
    </group>
  );
}

/** One zone: its slab, tile grid, kerb in the zone kind's colour, and label. */
function ZoneSlab({ zone, selected }: { zone: ZoneSpec; selected: boolean }) {
  const { x, z, w, d } = boundsToWorld(zoneRect(zone));
  const meta = ZONE_CATALOGUE[zone.kind];
  const grid = useTileGrid(zone.w, zone.d);
  const kerb = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.001, d)), [w, d]);
  useEffect(() => () => kerb.dispose(), [kerb]);
  // A faint wash of the kind's colour, so a plant area never reads as a hall.
  const slabColour = useMemo(
    () => `#${new THREE.Color(SBX.surface1).lerp(new THREE.Color(meta.accent), 0.07).getHexString()}`,
    [meta.accent],
  );

  return (
    <group position={[x, 0, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={slabColour} roughness={0.95} metalness={0} />
      </mesh>

      <lineSegments geometry={grid} position={[-w / 2, 0.002, -d / 2]}>
        <lineBasicMaterial color={SBX.gridLine} transparent opacity={0.55} />
      </lineSegments>

      {/* Kerb, brighter than the interior tiling, so each zone reads as its own slab. */}
      <lineSegments geometry={kerb} position={[0, 0.004, 0]}>
        <lineBasicMaterial color={selected ? SBX.primaryBright : meta.accent} transparent opacity={selected ? 1 : 0.5} />
      </lineSegments>

      {/* Corner marks on the zone being edited. */}
      {selected &&
        [
          [-w / 2, -d / 2],
          [w / 2, -d / 2],
          [-w / 2, d / 2],
          [w / 2, d / 2],
        ].map(([cx, cz]) => (
          <mesh key={`${cx}:${cz}`} rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.006, cz]}>
            <planeGeometry args={[0.28, 0.28]} />
            <meshBasicMaterial color={SBX.primaryBright} />
          </mesh>
        ))}

      <Text
        position={[0, 0.02, -d / 2 - 0.45]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.34}
        color={meta.accent}
        anchorX="center"
        anchorY="middle"
        fillOpacity={selected ? 0.95 : 0.6}
        letterSpacing={0.18}
        maxWidth={Math.max(2, w)}
      >
        {zone.name.toUpperCase()}
      </Text>
    </group>
  );
}

/**
 * The site: its open ground, and every zone on it — compute halls, cooling
 * rooms and plant areas.
 *
 * Drawing each zone as its own tinted slab is what makes the placement rules
 * visible before they are enforced: you can see where a chiller is meant to go.
 */
export function Room() {
  const zones = useSandboxStore((s) => s.zones);
  const selectedZoneId = useSandboxStore((s) => s.selectedZoneId);

  return (
    <group>
      <SiteGround />
      {zones.map((zone) => (
        <ZoneSlab key={zone.id} zone={zone} selected={zone.id === selectedZoneId} />
      ))}
    </group>
  );
}
