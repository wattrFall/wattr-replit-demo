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
import { CATALOGUE, GRID_D, GRID_W, defaultParams } from "./catalogue";
import { checkConnection } from "./connections";
import type { Telemetry } from "./model";
import type {
  ComponentKind,
  Connection,
  ControlMode,
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
}

/** True when every cell of the footprint is inside the floor and unoccupied. */
export function canPlaceAt(
  items: SandboxItem[],
  kind: ComponentKind,
  cell: GridCell,
): boolean {
  const { w, d } = CATALOGUE[kind].footprint;
  if (cell.x < 0 || cell.z < 0 || cell.x + w > GRID_W || cell.z + d > GRID_D) return false;

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
    const { items } = get();
    if (!canPlaceAt(items, kind, cell)) {
      const { w, d } = CATALOGUE[kind].footprint;
      const offFloor =
        cell.x < 0 || cell.z < 0 || cell.x + w > GRID_W || cell.z + d > GRID_D;
      set({
        notice: offFloor
          ? `A ${CATALOGUE[kind].label} needs ${w} by ${d} tiles and would hang off the floor here.`
          : `That space is already occupied. A ${CATALOGUE[kind].label} needs ${w} by ${d} clear ${w * d === 1 ? "tile" : "tiles"}.`,
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
