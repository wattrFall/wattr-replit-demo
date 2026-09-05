import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Room } from "./scene/Room";
import { Placeable } from "./scene/Placeable";
import { FloorPicker } from "./scene/FloorPicker";
import { FlowPath } from "./scene/FlowPath";
import { CameraRig } from "./scene/CameraRig";
import { notePointerDown, notePointerMove, wasDragged } from "@/lib/sandbox/pointer";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SBX } from "@/lib/sandbox/tokens";

/**
 * Everything three.js lives at or below this module.
 *
 * SandboxShell imports it with React.lazy, so the whole 3D bundle is a separate
 * chunk that is fetched after first paint rather than blocking it. Nothing
 * above this file may import three, r3f or drei, or that split is defeated.
 */
export default function SandboxCanvas({ reducedMotion }: { reducedMotion: boolean }) {
  const items = useSandboxStore((s) => s.items);
  const connections = useSandboxStore((s) => s.connections);
  const selectedId = useSandboxStore((s) => s.selectedId);
  const select = useSandboxStore((s) => s.select);
  const mode = useSandboxStore((s) => s.mode);

  return (
    <Canvas
      // Measure pointer travel in capture phase, before r3f dispatches its
      // click, so scene handlers can tell a click from a camera drag.
      onPointerDownCapture={notePointerDown}
      onPointerMoveCapture={notePointerMove}
      // Right-drag pans, so suppress the context menu over the canvas only.
      onContextMenu={(event) => event.preventDefault()}
      // A click that hits nothing clears the selection — but a camera drag that
      // ends on empty space is not that click.
      onPointerMissed={() => {
        if (!wasDragged()) select(null);
      }}
      // Isometric-ish: an orthographic camera set back on all three axes reads
      // as a technical drawing rather than a game camera.
      orthographic
      camera={{ position: [14, 12, 14], zoom: 58, near: 0.1, far: 200 }}
      // The sandbox is decorative-with-a-summary; the text equivalent lives in
      // the shell, so the canvas itself is hidden from the a11y tree.
      aria-hidden="true"
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      style={{ background: SBX.surface0 }}
    >
      {/* Flat, even key light. The look comes from colour and line, not shading. */}
      <ambientLight intensity={1.15} />
      <directionalLight position={[8, 14, 6]} intensity={0.85} />
      <directionalLight position={[-10, 8, -6]} intensity={0.3} color={SBX.primary} />

      <Suspense fallback={null}>
        <Room />
        <FloorPicker />
        {connections.map((connection) => (
          <FlowPath
            key={connection.id}
            connection={connection}
            items={items}
            reducedMotion={reducedMotion}
            // Links not touching the selection recede, so a busy floor stays
            // readable once something is selected.
            dimmed={selectedId !== null && connection.fromId !== selectedId && connection.toId !== selectedId}
          />
        ))}

        {items.map((item) => (
          <Placeable
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={select}
          />
        ))}
      </Suspense>

      <CameraRig reducedMotion={reducedMotion} interactive={mode.type === "idle"} />
    </Canvas>
  );
}
