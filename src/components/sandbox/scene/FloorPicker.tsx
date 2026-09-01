import { useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { CATALOGUE } from "@/lib/sandbox/catalogue";
import { FLOOR_D, FLOOR_W, cellToWorld, sameCell, worldToCell } from "@/lib/sandbox/geometry";
import { SBX } from "@/lib/sandbox/tokens";
import { canPlaceAt, useSandboxStore } from "@/lib/sandbox/store";
import type { GridCell } from "@/lib/sandbox/types";

/**
 * The floor's pick target, plus the placement ghost.
 *
 * Hover state is local rather than in the store, and is only updated when the
 * pointer crosses into a NEW cell — a store write on every pointermove would
 * re-render the panels dozens of times a second for no visible benefit.
 */
export function FloorPicker() {
  const [hoverCell, setHoverCell] = useState<GridCell | null>(null);
  const mode = useSandboxStore((s) => s.mode);
  const items = useSandboxStore((s) => s.items);
  const place = useSandboxStore((s) => s.place);

  const placing = mode.type === "placing" ? mode.kind : null;
  const valid = placing && hoverCell ? canPlaceAt(items, placing, hoverCell) : false;

  /**
   * Handlers read the mode from the store at event time rather than from the
   * render closure. Arming a tool and clicking within the same frame — which a
   * keyboard user does routinely — would otherwise place the PREVIOUS tool,
   * because the closure still holds the mode from the last render.
   */
  const handleMove = (event: ThreeEvent<PointerEvent>) => {
    const mode = useSandboxStore.getState().mode;
    if (mode.type !== "placing") return;
    const cell = worldToCell(event.point.x, event.point.z);
    setHoverCell((current) => (sameCell(current, cell) ? current : cell));
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    const mode = useSandboxStore.getState().mode;
    if (mode.type !== "placing") return;
    event.stopPropagation();
    place(mode.kind, worldToCell(event.point.x, event.point.z));
  };

  return (
    <>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onPointerMove={handleMove}
        onPointerOut={() => setHoverCell(null)}
        onClick={handleClick}
      >
        <planeGeometry args={[FLOOR_W, FLOOR_D]} />
        {/* Invisible material so the plane still hit-tests. */}
        <meshBasicMaterial visible={false} />
      </mesh>

      {placing && hoverCell && (
        <Ghost kind={placing} cell={hoverCell} valid={valid} />
      )}
    </>
  );
}

/** Translucent preview of what a click would drop, and whether it would land. */
function Ghost({
  kind,
  cell,
  valid,
}: {
  kind: keyof typeof CATALOGUE;
  cell: GridCell;
  valid: boolean;
}) {
  const entry = CATALOGUE[kind];
  const position = cellToWorld(cell, kind);
  const colour = valid ? entry.accent : SBX.heat;

  return (
    <group position={position}>
      <mesh position={[0, entry.height / 2, 0]}>
        <boxGeometry args={[entry.footprint.w - 0.16, entry.height, entry.footprint.d - 0.16]} />
        <meshBasicMaterial color={colour} transparent opacity={valid ? 0.22 : 0.16} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <planeGeometry args={[entry.footprint.w * 0.98, entry.footprint.d * 0.98]} />
        <meshBasicMaterial color={colour} transparent opacity={valid ? 0.3 : 0.22} depthWrite={false} />
      </mesh>
    </group>
  );
}
