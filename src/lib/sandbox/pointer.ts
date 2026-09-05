/**
 * Click-versus-drag discrimination for the 3D canvas.
 *
 * The canvas has to serve three gestures on one pointer: orbit, pan, and
 * click-to-act. Without a movement threshold the third is unreliable — an orbit
 * moves the camera *under* the cursor, so the raycast at pointer-up lands on
 * something the user never aimed at. A drag that ends over a rack would select
 * it; a drag that ends over open floor would drop a unit there.
 *
 * So the canvas records where the pointer went down, and every scene click
 * handler asks whether the pointer travelled before acting.
 *
 * Module state rather than React state on purpose: this is read inside pointer
 * handlers, where a re-render would be both wasteful and too late.
 */

/** Pixels of travel above which a press is a drag, not a click. */
const DRAG_THRESHOLD_PX = 4;

let downX = 0;
let downY = 0;
let travelled = false;

export function notePointerDown(event: { clientX: number; clientY: number }): void {
  downX = event.clientX;
  downY = event.clientY;
  travelled = false;
}

export function notePointerMove(event: { clientX: number; clientY: number }): void {
  if (travelled) return;
  const dx = event.clientX - downX;
  const dy = event.clientY - downY;
  if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) travelled = true;
}

/** True when the gesture that just ended moved far enough to be a drag. */
export function wasDragged(): boolean {
  return travelled;
}
