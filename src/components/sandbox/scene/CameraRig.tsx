import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { MOUSE, TOUCH } from "three";
import { SITE, boundsToWorld, zoneBounds } from "@/lib/sandbox/geometry";
import { CELL } from "@/lib/sandbox/tokens";
import { useSandboxStore } from "@/lib/sandbox/store";

/** Where the camera sits relative to what it frames. Distance is irrelevant to an ortho camera. */
const HOME_OFFSET: [number, number, number] = [14, 12, 14];

/** Fraction of the shorter canvas axis the framed zones are allowed to fill. */
const FIT_MARGIN = 0.82;

/**
 * How far past the site edge the orbit target may be pushed. Enough to inspect
 * a corner of the site, not enough to lose it off-screen.
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
  const size = useThree((state) => state.size);
  const viewResetNonce = useSandboxStore((s) => s.viewResetNonce);

  /**
   * What to frame: every zone, read when a reframe is requested rather than on
   * each edit. Dragging a zone's size slider should not swing the camera around
   * under the pointer; Recentre, loading a layout and adding a zone reframe.
   */
  const framing = useMemo(
    () => boundsToWorld(zoneBounds(useSandboxStore.getState().zones)),
    [viewResetNonce],
  );

  /**
   * Zoom that fits the framed zones, rather than a constant tuned for one
   * layout. r3f gives an orthographic camera a frustum in canvas pixels, so the
   * visible world span is (canvas axis) / zoom. Fitting the diagonal covers the
   * zones from any orbit angle, so the framing survives the camera turning.
   */
  const { fitZoom, siteZoom } = useMemo(() => {
    const shorterAxis = Math.min(size.width, size.height);
    const diagonal = Math.hypot(framing.w, framing.d);
    const siteDiagonal = Math.hypot(SITE.w * CELL, SITE.d * CELL);
    if (!shorterAxis || !diagonal) return { fitZoom: 58, siteZoom: 20 };
    return {
      fitZoom: (shorterAxis * FIT_MARGIN) / diagonal,
      siteZoom: (shorterAxis * FIT_MARGIN) / siteDiagonal,
    };
  }, [framing, size.width, size.height]);

  // Return to the framing whenever Recentre, Reset, a load or a new zone asks.
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

    camera.position.set(framing.x + HOME_OFFSET[0], HOME_OFFSET[1], framing.z + HOME_OFFSET[2]);
    if ("zoom" in camera) {
      (camera as THREE.OrthographicCamera).zoom = fitZoom;
      camera.updateProjectionMatrix();
    }
    c.target.set(framing.x, 0, framing.z);
    c.update();

    c.enableDamping = damped;
    // Moving a camera does not refresh its world matrix until something
    // renders, and picking reads matrixWorld — without this the next click
    // would still be aimed through the old pose.
    camera.updateMatrixWorld();
  }, [viewResetNonce, camera, fitZoom, framing]);

  /**
   * Keep the orbit target over the site. OrbitControls moves the camera and
   * the target together while panning, so the correction has to be applied to
   * both or the camera lurches.
   */
  const clampTarget = () => {
    const c = controls.current;
    if (!c) return;
    const limitX = (SITE.w * CELL) / 2 + PAN_MARGIN;
    const limitZ = (SITE.d * CELL) / 2 + PAN_MARGIN;
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
      // far corner of a large site mid-build is exactly when it is wanted.
      enablePan
      // Right-drag pans; two-finger drag does the same on a trackpad. Left stays
      // free for orbit so it never competes with click-to-act.
      mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
      // Keep the camera above the floor plane and out of extreme angles.
      minPolarAngle={Math.PI / 6}
      maxPolarAngle={Math.PI / 2.35}
      // Zoom out far enough to see the whole site, so a zone can be moved to
      // any part of it, and in relative to the framed zones.
      minZoom={Math.min(fitZoom * 0.5, siteZoom * 0.9)}
      maxZoom={fitZoom * 2.4}
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
