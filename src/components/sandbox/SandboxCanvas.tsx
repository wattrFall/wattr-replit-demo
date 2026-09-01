import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Room } from "./scene/Room";
import { Placeable } from "./scene/Placeable";
import { FloorPicker } from "./scene/FloorPicker";
import { FlowPath } from "./scene/FlowPath";
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
      // A click that hits nothing clears the selection.
      onPointerMissed={() => select(null)}
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

      <OrbitControls
        makeDefault
        enablePan={false}
        // Keep the camera above the floor plane and out of extreme angles.
        minPolarAngle={Math.PI / 6}
        maxPolarAngle={Math.PI / 2.35}
        minZoom={34}
        maxZoom={110}
        // Damping is a continuous animation; reduced-motion users get none.
        // Rotating while armed makes it easy to place a unit by accident.
        enableRotate={mode.type !== "placing"}
        enableDamping={!reducedMotion}
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}
