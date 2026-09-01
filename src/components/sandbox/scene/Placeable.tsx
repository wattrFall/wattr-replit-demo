import { useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import { CATALOGUE } from "@/lib/sandbox/catalogue";
import { useSandboxStore } from "@/lib/sandbox/store";
import { checkConnection } from "@/lib/sandbox/connections";
import { cellToWorld } from "@/lib/sandbox/geometry";
import { SBX, heatColour } from "@/lib/sandbox/tokens";
import { rackHeatFraction } from "@/lib/sandbox/model";
import type { SandboxItem } from "@/lib/sandbox/types";

/**
 * Kind-specific silhouettes.
 *
 * Deliberately primitive: boxes and cylinders read clearly at an isometric
 * angle, cost one draw call each, and keep the page feeling like a schematic
 * rather than a game. Detail comes from the accent colour and the edge lines,
 * not from polygon count.
 */
function Body({ item, accent, heat }: { item: SandboxItem; accent: string; heat: string | null }) {
  const { footprint, height } = CATALOGUE[item.kind];
  // Inset slightly so neighbouring units read as separate objects on the grid.
  const w = footprint.w - 0.16;
  const d = footprint.d - 0.16;

  switch (item.kind) {
    case "rack":
      return (
        <>
          <mesh position={[0, height / 2, 0]}>
            <boxGeometry args={[w, height, d]} />
            <meshStandardMaterial color={SBX.surface3} roughness={0.7} metalness={0.1} />
            <Edges threshold={15} color={heat ?? accent} />
          </mesh>
          {/* Front vent strip carries the heat overlay: it is the face whose
              inlet temperature the model is actually reporting. */}
          <mesh position={[0, height / 2, d / 2 + 0.005]}>
            <planeGeometry args={[w * 0.7, height * 0.72]} />
            <meshBasicMaterial color={heat ?? accent} transparent opacity={heat ? 0.34 : 0.16} />
          </mesh>
        </>
      );

    case "crac":
      return (
        <>
          <mesh position={[0, height / 2, 0]}>
            <boxGeometry args={[w, height, d]} />
            <meshStandardMaterial color={SBX.surface3} roughness={0.75} metalness={0.1} />
            <Edges threshold={15} color={accent} />
          </mesh>
          {/* Fan disc on top. */}
          <mesh position={[0, height + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[w * 0.16, w * 0.36, 24]} />
            <meshBasicMaterial color={accent} transparent opacity={0.55} />
          </mesh>
        </>
      );

    case "cdu":
      return (
        <>
          <mesh position={[0, height / 2, 0]}>
            <boxGeometry args={[w, height, d]} />
            <meshStandardMaterial color={SBX.surface3} roughness={0.7} metalness={0.15} />
            <Edges threshold={15} color={accent} />
          </mesh>
          {/* Loop pipe stub, marking this as the liquid path. */}
          <mesh position={[0, height * 0.72, d / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.07, 0.07, 0.3, 12]} />
            <meshStandardMaterial color={accent} roughness={0.4} metalness={0.3} />
          </mesh>
        </>
      );

    case "chiller":
      return (
        <>
          <mesh position={[0, height / 2, 0]}>
            <boxGeometry args={[w, height, d]} />
            <meshStandardMaterial color={SBX.surface2} roughness={0.85} metalness={0.05} />
            <Edges threshold={15} color={accent} />
          </mesh>
          {/* Condenser fans: two discs, marking the wide unit. */}
          {[-w * 0.24, w * 0.24].map((offset) => (
            <mesh key={offset} position={[offset, height + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.1, 0.24, 20]} />
              <meshBasicMaterial color={accent} transparent opacity={0.5} />
            </mesh>
          ))}
        </>
      );

    case "sensor":
      return (
        <>
          <mesh position={[0, height / 2, 0]}>
            <cylinderGeometry args={[0.16, 0.19, height, 14]} />
            <meshStandardMaterial color={SBX.surface3} roughness={0.6} metalness={0.2} />
          </mesh>
          {/* Indicator bead. */}
          <mesh position={[0, height + 0.05, 0]}>
            <sphereGeometry args={[0.055, 12, 12]} />
            <meshBasicMaterial color={accent} />
          </mesh>
        </>
      );
  }
}

/**
 * One placed component: positioning, hit target, and selection affordances.
 *
 * The hit box is a separate invisible mesh spanning the whole footprint, so
 * thin parts (the sensor bead, the CRAC fan ring) are still easy to click.
 */
export function Placeable({
  item,
  selected,
  onSelect,
}: {
  item: SandboxItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // While the palette is armed, placement owns every click on the floor. If a
  // unit intercepted the click it would select itself instead, and dropping
  // onto an occupied tile would silently do nothing rather than refuse.
  const placing = useSandboxStore((s) => s.mode.type === "placing");
  const connect = useSandboxStore((s) => s.connect);

  /**
   * While a link is being drawn, mark the units it could legally reach. Showing
   * the legal targets up front is kinder than letting the user click and be
   * told no, and it uses the same rule function as the refusal path.
   */
  const linkTarget = useSandboxStore((s) => {
    if (s.mode.type !== "connecting") return null;
    if (s.mode.fromId === item.id) return "source" as const;
    return checkConnection(s.items, s.connections, s.mode.fromId, item.id).ok
      ? ("valid" as const)
      : null;
  });

  // Inlet temperature drives the rack's colour. Published at 10Hz, so this
  // re-renders far less often than the frame loop.
  const inletC = useSandboxStore((s) => (item.kind === "rack" ? s.inletC[item.id] : undefined));
  const heat = item.kind === "rack" ? heatColour(rackHeatFraction(item, inletC)) : null;

  const entry = CATALOGUE[item.kind];
  const position = cellToWorld(item.cell, item.kind);
  const accent = linkTarget === "valid" ? SBX.healthy : selected ? SBX.primaryBright : entry.accent;

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    // Read at event time, not from the render closure — see FloorPicker.
    const current = useSandboxStore.getState().mode;
    if (current.type === "placing") return; // fall through to the floor
    // Without this the click also reaches the floor plane behind, which would
    // immediately deselect what we just selected.
    event.stopPropagation();
    if (current.type === "connecting") {
      connect(item.id);
      return;
    }
    onSelect(item.id);
  };

  return (
    <group position={position}>
      <Body item={item} accent={accent} heat={selected || linkTarget !== null ? null : heat} />

      {/* Selection / hover ring on the floor beneath the unit. */}
      {(selected || linkTarget !== null || (hovered && !placing)) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
          <planeGeometry args={[entry.footprint.w * 0.98, entry.footprint.d * 0.98]} />
          <meshBasicMaterial
            color={
              linkTarget === "valid"
                ? SBX.healthy
                : selected || linkTarget === "source"
                  ? SBX.primaryBright
                  : entry.accent
            }
            transparent
            opacity={linkTarget !== null ? 0.28 : selected ? 0.22 : 0.1}
          />
        </mesh>
      )}

      <mesh
        position={[0, entry.height / 2, 0]}
        onClick={handleClick}
        onPointerOver={(event) => {
          if (placing) return;
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[entry.footprint.w, entry.height + 0.2, entry.footprint.d]} />
        {/* Invisible material, not visible={false}: an invisible OBJECT is
            skipped by the raycaster, an invisible material still hit-tests. */}
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
