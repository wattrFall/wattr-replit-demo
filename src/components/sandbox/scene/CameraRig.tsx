import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { MOUSE, TOUCH } from "three";
import { FLOOR_D, FLOOR_W } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";

/** The framing the room opens at, and the one Recenter returns to. */
const HOME_POSITION: [number, number, number] = [14, 12, 14];
const HOME_ZOOM = 58;

/**
 * How far past the floor edge the orbit target may be pushed. Enough to inspect
 * a corner of a large hall, not enough to lose the room off-screen.
 */
const PAN_MARGIN = 3;

/**
 * Camera navigation: orbit, pan, zoom, and a way back.
 *
 * Left-drag orbits, right-drag pans, wheel zooms — the bindings every 3D tool
 * uses. Two-finger drag pans on a trackpad, which is how most people will
 * actually do it.
 *
 * Panning is only safe because the target is clamped: without it the room can
 * be pushed off-screen with no way back, which is why pan was disabled when the
 * scene was first built.
 */
export function CameraRig({
  reducedMotion,
  interactive,
}: {
  reducedMotion: boolean;
  interactive: boolean;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((state) => state.camera);
  const viewResetNonce = useSandboxStore((s) => s.viewResetNonce);

  // Return to the opening framing whenever Recentre (or Reset) asks.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;

    // Damping is what makes this awkward: with it on, update() eases toward the
    // new pose over several frames, so the camera lands part-way there — and
    // never arrives at all in a tab that is not being given frames. Snap with
    // damping off, then restore the user's setting.
    const damped = c.enableDamping;
    c.enableDamping = false;
    // Flush first. With damping on, OrbitControls decays its pending pan and
    // rotate deltas instead of clearing them, so a leftover pan would be
    // re-applied on top of the pose we are about to set — which is exactly how
    // Recentre ended up landing near where it started.
    c.update();

    camera.position.set(...HOME_POSITION);
    if ("zoom" in camera) {
      (camera as THREE.OrthographicCamera).zoom = HOME_ZOOM;
      camera.updateProjectionMatrix();
    }
    c.target.set(0, 0, 0);
    c.update();

    c.enableDamping = damped;
    // Moving a camera does not refresh its world matrix until something
    // renders, and picking reads matrixWorld — without this the next click
    // would still be aimed through the old pose.
    camera.updateMatrixWorld();
  }, [viewResetNonce, camera]);

  /**
   * Keep the orbit target over the floor. OrbitControls moves the camera and
   * the target together while panning, so the correction has to be applied to
   * both or the camera lurches.
   */
  const clampTarget = () => {
    const c = controls.current;
    if (!c) return;
    const limitX = FLOOR_W / 2 + PAN_MARGIN;
    const limitZ = FLOOR_D / 2 + PAN_MARGIN;
    const clampedX = THREE.MathUtils.clamp(c.target.x, -limitX, limitX);
    const clampedZ = THREE.MathUtils.clamp(c.target.z, -limitZ, limitZ);
    const clampedY = THREE.MathUtils.clamp(c.target.y, 0, 4);

    if (clampedX !== c.target.x || clampedZ !== c.target.z || clampedY !== c.target.y) {
      camera.position.x += clampedX - c.target.x;
      camera.position.z += clampedZ - c.target.z;
      camera.position.y += clampedY - c.target.y;
      c.target.set(clampedX, clampedY, clampedZ);
      camera.updateMatrixWorld();
    }
  };

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      onChange={clampTarget}
      // Pan stays available even with a tool armed: it is on a different button
      // from click-to-act, so it cannot be confused with placing, and reaching a
      // far corner of a large floor mid-build is exactly when it is wanted.
      enablePan
      // Right-drag pans; two-finger drag does the same on a trackpad. Left stays
      // free for orbit so it never competes with click-to-act.
      mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
      // Keep the camera above the floor plane and out of extreme angles.
      minPolarAngle={Math.PI / 6}
      maxPolarAngle={Math.PI / 2.35}
      minZoom={34}
      maxZoom={110}
      // Orbit shares the left button with click-to-act, so an armed tool takes
      // it: rotating mid-gesture moves the scene under the cursor and the click
      // lands somewhere the user never aimed.
      enableRotate={interactive}
      // Damping is a continuous animation; reduced-motion users get none.
      enableDamping={!reducedMotion}
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      panSpeed={0.9}
    />
  );
}
