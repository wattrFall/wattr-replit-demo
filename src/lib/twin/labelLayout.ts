/**
 * Where the facility twin's labels go on screen, so none covers another.
 *
 * Labels are placed in priority order (rack IDs first), nearest the camera
 * first within a priority. Each takes the free spot closest to its anchor;
 * one that has to move keeps a leader line back to its equipment. Labels
 * further from the camera shrink and fade a little, so nearby ones win when
 * space is tight.
 */

export interface LabelInput {
  id: string;
  /** Where the label's centre sits when nothing is in the way, in screen pixels. */
  anchorX: number;
  anchorY: number;
  /** The point on the equipment a leader line runs back to. */
  targetX: number;
  targetY: number;
  width: number;
  height: number;
  /** Lower is more important: 0 for rack IDs, 1 for other equipment, 2 for callouts. */
  priority: number;
  /** Distance from the camera, in world units. */
  distance: number;
  /** False when the anchor is behind the camera. */
  inFront: boolean;
  /** False for callouts that belong to the scene rather than to one piece of equipment. */
  leader: boolean;
}

export interface LabelPlacement {
  id: string;
  visible: boolean;
  /** The label's top-left corner, in screen pixels, before scaling from that corner. */
  x: number;
  y: number;
  scale: number;
  opacity: number;
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
}

export interface LabelBounds {
  width: number;
  height: number;
  /** Space kept clear along each edge, such as for the camera instructions. */
  inset: { top: number; right: number; bottom: number; left: number };
}

type Rect = { x: number; y: number; w: number; h: number };

/** The space kept between two labels. */
export const LABEL_GAP = 4;
/** How much the furthest label shrinks and fades, relative to the nearest. */
const DEPTH_SHRINK = 0.15;
const DEPTH_FADE = 0.3;
/** A label moved less than this keeps no leader line. */
const LEADER_MIN = 3;

/** Offsets tried around the anchor, in label widths and heights: up to two widths across and three rows up or down. */
const OFFSETS: ReadonlyArray<readonly [number, number]> = (() => {
  const offsets: Array<[number, number]> = [];
  for (let dx = -2; dx <= 2; dx += 0.5) {
    for (let dy = -3; dy <= 3; dy += 1) offsets.push([dx, dy]);
  }
  return offsets;
})();

const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

const inside = (r: Rect, bounds: LabelBounds) =>
  r.x >= bounds.inset.left && r.y >= bounds.inset.top &&
  r.x + r.w <= bounds.width - bounds.inset.right && r.y + r.h <= bounds.height - bounds.inset.bottom;

/** The point on a rectangle's edge closest to a point outside it. */
function nearestEdge(r: Rect, x: number, y: number) {
  return { x: Math.min(Math.max(x, r.x), r.x + r.w), y: Math.min(Math.max(y, r.y), r.y + r.h) };
}

export function layoutLabels(labels: LabelInput[], bounds: LabelBounds): LabelPlacement[] {
  const hidden = (label: LabelInput): LabelPlacement => ({ id: label.id, visible: false, x: 0, y: 0, scale: 1, opacity: 0, leader: null });
  const onScreen = (label: LabelInput) => label.inFront &&
    label.anchorX >= 0 && label.anchorX <= bounds.width && label.anchorY >= 0 && label.anchorY <= bounds.height;
  const shown = labels.filter(onScreen);
  const distances = shown.map((label) => label.distance);
  const near = Math.min(...distances);
  const far = Math.max(...distances);
  const order = [...shown].sort((a, b) => a.priority - b.priority || a.distance - b.distance);
  const placed: Rect[] = [];
  const result = new Map<string, LabelPlacement>();

  for (const label of order) {
    const depth = far > near ? (label.distance - near) / (far - near) : 0;
    const scale = 1 - DEPTH_SHRINK * depth;
    const w = label.width * scale;
    const h = label.height * scale;
    const stepX = w + LABEL_GAP;
    const stepY = h + LABEL_GAP;
    // Closest spots first; a spot below the anchor would sit on the equipment, so it costs a little more.
    const candidates = OFFSETS
      .map(([dx, dy]) => ({ dx, dy, cost: Math.hypot(dx * stepX, dy * stepY * (dy > 0 ? 1.4 : 1)) }))
      .sort((a, b) => a.cost - b.cost);
    let best: Rect | null = null;
    let bestOverlap = Infinity;
    for (const { dx, dy } of candidates) {
      const rect = { x: label.anchorX + dx * stepX - w / 2, y: label.anchorY + dy * stepY - h / 2, w, h };
      if (!inside(rect, bounds)) continue;
      const covered = placed.reduce((sum, other) => sum + overlap(rect, other), 0);
      if (covered === 0) { best = rect; bestOverlap = 0; break; }
      if (covered < bestOverlap) { best = rect; bestOverlap = covered; }
    }
    // Rack IDs always show, in the least crowded spot; anything else that cannot find clear space steps aside.
    if (!best || (bestOverlap > 0 && label.priority > 0)) {
      result.set(label.id, hidden(label));
      continue;
    }
    placed.push({ x: best.x - LABEL_GAP / 2, y: best.y - LABEL_GAP / 2, w: best.w + LABEL_GAP, h: best.h + LABEL_GAP });
    const moved = Math.hypot(best.x + w / 2 - label.anchorX, best.y + h / 2 - label.anchorY) > LEADER_MIN;
    const end = nearestEdge(best, label.targetX, label.targetY);
    result.set(label.id, {
      id: label.id,
      visible: true,
      x: best.x,
      y: best.y,
      scale,
      opacity: 1 - DEPTH_FADE * depth,
      leader: moved && label.leader ? { x1: label.targetX, y1: label.targetY, x2: end.x, y2: end.y } : null,
    });
  }
  return labels.map((label) => result.get(label.id) ?? hidden(label));
}
