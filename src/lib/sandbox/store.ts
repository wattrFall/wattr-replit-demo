/**
 * Sandbox state.
 *
 * zustand rather than context: the simulation writes telemetry on every change
 * and, from Phase 5, on every frame. Context would re-render the whole subtree
 * on each tick; zustand's selector subscriptions let the 3D scene, the
 * inspector and the telemetry readout each re-render only when their own slice
 * moves. That is what makes the 60fps target reachable.
 */
import { create } from "zustand";
import { CATALOGUE, defaultParams } from "./catalogue";
import { checkConnection } from "./connections";
import { DEFAULT_FLOOR, FLOOR_LIMITS, footprintCells, gridD, gridW, zoneAt } from "./geometry";
import type { Telemetry } from "./model";
import type {
  ComponentKind,
  Connection,
  ControlMode,
  FloorSpec,
  GridCell,
  InteractionMode,
  SandboxItem,
  SandboxLayout,
} from "./types";

/**
 * Monotonic id source, rewound whenever the layout is replaced.
 *
 * Without the rewind, ids keep climbing across resets, so the same preset
 * loaded twice in one session produces different ids — which breaks any
 * comparison, snapshot or replay that identifies equipment by id.
 */
let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
const rewindIds = () => {
  idCounter = 0;
};

export interface SandboxState {
  floor: FloorSpec;
  items: SandboxItem[];
  connections: Connection[];
  selectedId: string | null;
  mode: InteractionMode;
  controlMode: ControlMode;
  /** Last refusal message, shown then cleared by the UI. */
  notice: string | null;

  /**
   * Latest published simulation snapshot. The simulation itself runs in a ref
   * at a fixed timestep and publishes here at a lower rate — see
   * useSandboxSimulation. Writing every frame would re-render every panel
   * 60 times a second to move numbers nobody can read that fast.
   */
  inletC: Record<string, number>;
  telemetry: Telemetry | null;

  /**
   * Bumped to ask the camera to return to its framing. A counter rather than a
   * boolean so repeated requests each fire, and so the camera rig can live
   * inside the Canvas while the button lives outside it.
   */
  viewResetNonce: number;

  select: (id: string | null) => void;
  setMode: (mode: InteractionMode) => void;
  setControlMode: (mode: ControlMode) => void;
  beginPlacing: (kind: ComponentKind) => void;
  place: (kind: ComponentKind, cell: GridCell) => void;
  remove: (id: string) => void;
  beginConnecting: (fromId: string) => void;
  connect: (toId: string) => void;
  disconnect: (connectionId: string) => void;
  setParam: (id: string, key: string, value: number) => void;
  loadLayout: (layout: SandboxLayout) => void;
  reset: () => void;
  notify: (message: string | null) => void;
  publishSim: (inletC: Record<string, number>, telemetry: Telemetry) => void;
  resetView: () => void;
  /** Resize one dimension of the site. Refuses if equipment would be stranded. */
  setFloor: (patch: Partial<FloorSpec>) => void;
}

/**
 * True when every cell of the footprint sits in the right zone and is free.
 *
 * Zone is checked per cell, not per origin: a two-tile chiller straddling the
 * walkway has its origin in the plant yard but half of itself outside it.
 */
export function canPlaceAt(
  items: SandboxItem[],
  kind: ComponentKind,
  cell: GridCell,
  floor: FloorSpec,
): boolean {
  const { w, d } = CATALOGUE[kind].footprint;
  const wanted = CATALOGUE[kind].zone;
  for (const c of footprintCells(kind, cell)) {
    if (zoneAt(floor, c) !== wanted) return false;
  }

  for (const item of items) {
    const f = CATALOGUE[item.kind].footprint;
    const overlaps =
      cell.x < item.cell.x + f.w &&
      cell.x + w > item.cell.x &&
      cell.z < item.cell.z + f.d &&
      cell.z + d > item.cell.z;
    if (overlaps) return false;
  }
  return true;
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  floor: DEFAULT_FLOOR,
  items: [],
  connections: [],
  selectedId: null,
  mode: { type: "idle" },
  controlMode: "baseline",
  notice: null,
  inletC: {},
  telemetry: null,
  viewResetNonce: 0,

  publishSim: (inletC, telemetry) => set({ inletC, telemetry }),
  resetView: () => set((s) => ({ viewResetNonce: s.viewResetNonce + 1 })),

  setFloor: (patch) => {
    const { floor, items } = get();
    const next: FloorSpec = { ...floor, ...patch };
    (Object.keys(FLOOR_LIMITS) as (keyof FloorSpec)[]).forEach((key) => {
      const { min, max } = FLOOR_LIMITS[key];
      next[key] = Math.round(Math.min(max, Math.max(min, next[key])));
    });

    // The plant yard begins where the hall ends, so widening the hall slides
    // the yard along the grid. Its contents ride with it: resizing one zone
    // must not tear up the other, which is what happens if the cells are left
    // where they were.
    const shift = next.hallW - floor.hallW;
    const moved =
      shift === 0
        ? items
        : items.map((item) =>
            CATALOGUE[item.kind].zone === "plant"
              ? { ...item, cell: { ...item.cell, x: item.cell.x + shift } }
              : item,
          );

    // What is left is genuine: a zone shrunk below what it holds. Refuse and
    // name what is in the way, rather than deleting somebody's layout to
    // satisfy a slider drag.
    const stranded = moved.filter((item) =>
      footprintCells(item.kind, item.cell).some(
        (c) => zoneAt(next, c) !== CATALOGUE[item.kind].zone,
      ),
    );
    if (stranded.length > 0) {
      const labels = [...new Set(stranded.map((i) => CATALOGUE[i.kind].label))];
      set({
        notice: `Cannot resize: ${stranded.length} item${stranded.length > 1 ? "s" : ""} would not fit (${labels.join(", ")}). Move or delete them first.`,
      });
      return;
    }

    set({ floor: next, items: moved, notice: null, viewResetNonce: get().viewResetNonce + 1 });
  },

  // A refusal notice is transient: any further action clears it, so a stale
  // reason never sits under an unrelated interaction.
  select: (id) => set({ selectedId: id, notice: null }),
  setMode: (mode) => set({ mode, notice: null }),
  setControlMode: (controlMode) => set({ controlMode }),
  notify: (notice) => set({ notice }),

  beginPlacing: (kind) =>
    set((s) => ({
      // Clicking the active tool again puts the pointer back to selection.
      mode: s.mode.type === "placing" && s.mode.kind === kind ? { type: "idle" } : { type: "placing", kind },
      selectedId: null,
      notice: null,
    })),

  place: (kind, cell) => {
    const { items, floor } = get();
    if (!canPlaceAt(items, kind, cell, floor)) {
      const entry = CATALOGUE[kind];
      const { w, d } = entry.footprint;
      const cells = footprintCells(kind, cell);
      const zones = cells.map((c) => zoneAt(floor, c));
      const wrongZone = zones.some((z) => z !== null && z !== entry.zone);
      const offSite = zones.some((z) => z === null);

      set({
        notice: wrongZone
          ? entry.zone === "plant"
            ? `A ${entry.label} belongs in the plant yard, not on the raised floor.`
            : `A ${entry.label} belongs on the raised floor, not in the plant yard.`
          : offSite
            ? `A ${entry.label} needs ${w} by ${d} tiles and would hang off the ${entry.zone === "plant" ? "plant yard" : "raised floor"} here.`
            : `That space is already occupied. A ${entry.label} needs ${w} by ${d} clear ${w * d === 1 ? "tile" : "tiles"}.`,
      });
      return;
    }
    const item: SandboxItem = { id: nextId(kind), kind, cell, params: defaultParams(kind) };
    set({ items: [...items, item], selectedId: item.id, notice: null });
  },

  beginConnecting: (fromId) =>
    set((s) => ({
      mode: s.mode.type === "connecting" && s.mode.fromId === fromId ? { type: "idle" } : { type: "connecting", fromId },
      notice: null,
    })),

  connect: (toId) => {
    const { mode, items, connections } = get();
    if (mode.type !== "connecting") return;

    const check = checkConnection(items, connections, mode.fromId, toId);
    if (!check.ok) {
      // Stay in connecting mode so the user can pick a different target
      // without re-arming.
      set({ notice: check.reason });
      return;
    }

    const link: Connection = { id: nextId("link"), fromId: mode.fromId, toId };
    set({
      connections: [...connections, link],
      mode: { type: "idle" },
      selectedId: mode.fromId,
      notice: null,
    });
  },

  disconnect: (connectionId) =>
    set((s) => ({ connections: s.connections.filter((c) => c.id !== connectionId) })),

  remove: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      // Drop any link that pointed at the deleted item.
      connections: s.connections.filter((c) => c.fromId !== id && c.toId !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      // Cancel an in-progress link if its source has just been deleted.
      mode: s.mode.type === "connecting" && s.mode.fromId === id ? { type: "idle" } : s.mode,
    })),

  setParam: (id, key, value) =>
    set((s) => ({
      items: s.items.map((item) => {
        if (item.id !== id) return item;
        const spec = CATALOGUE[item.kind].params.find((p) => p.key === key);
        // Clamp defensively: keyboard entry and presets both land here.
        const clamped = spec ? Math.min(spec.max, Math.max(spec.min, value)) : value;
        return { ...item, params: { ...item.params, [key]: clamped } };
      }),
    })),

  loadLayout: (layout) => {
    // The layout arrives with its own ids; anything placed afterwards numbers
    // from the highest it contains, so nothing can collide with it.
    const highest = layout.items.reduce((max, item) => {
      const n = Number(item.id.split("-").pop());
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    idCounter = highest;
    set({
      floor: { ...layout.floor },
      items: layout.items.map((i) => ({ ...i, params: { ...i.params } })),
      connections: layout.connections.map((c) => ({ ...c })),
      selectedId: null,
      mode: { type: "idle" },
      notice: null,
    });
  },

  reset: () => {
    rewindIds();
    set({
      floor: DEFAULT_FLOOR,
      items: [],
      connections: [],
      selectedId: null,
      mode: { type: "idle" },
      controlMode: "baseline",
      notice: null,
      inletC: {},
      telemetry: null,
      viewResetNonce: get().viewResetNonce + 1,
    });
  },
}));
