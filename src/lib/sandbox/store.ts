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
import { CATALOGUE, ZONE_CATALOGUE, defaultParams } from "./catalogue";
import { checkConnection } from "./connections";
import {
  MAX_ZONES,
  SITE,
  ZONE_LIMITS,
  footprintsOverlap,
  freeZoneSpot,
  zoneAccepts,
  zoneAt,
  zoneOfFootprint,
  zoneRect,
  zonesOverlap,
} from "./geometry";
import type { Telemetry } from "./model";
import { runEpisode, type RunResult } from "./run";
import { validateLayout, type ValidationResult } from "./validate";
import type {
  ComponentKind,
  Connection,
  ControlMode,
  GridCell,
  InteractionMode,
  SandboxItem,
  SandboxLayout,
  ZoneKind,
  ZoneSpec,
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

/** Where a fresh site starts: a raised floor and a plant yard, side by side. */
export const DEFAULT_ZONES: readonly ZoneSpec[] = [
  { id: "zone-hall", name: "Raised floor", kind: "compute", x: 15, z: 12, w: 12, d: 8 },
  { id: "zone-plant", name: "Plant yard", kind: "plant", x: 28, z: 12, w: 4, d: 8 },
];

export interface SandboxState {
  zones: ZoneSpec[];
  items: SandboxItem[];
  connections: Connection[];
  selectedId: string | null;
  /** The zone being edited. Selecting a zone clears the equipment selection. */
  selectedZoneId: string | null;
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

  /**
   * The build/run lifecycle. Validation is recomputed on demand rather than
   * held as state, so it can never disagree with the layout it describes.
   */
  lastRun: RunResult | null;
  showResults: boolean;
  /** Findings from the most recent run attempt, error or not. */
  runFindings: ValidationResult | null;
  /** Which preset is loaded, or null once the user has edited the hall. */
  activePresetId: string | null;

  select: (id: string | null) => void;
  selectZone: (id: string | null) => void;
  setMode: (mode: InteractionMode) => void;
  setControlMode: (mode: ControlMode) => void;
  beginPlacing: (kind: ComponentKind) => void;
  place: (kind: ComponentKind, cell: GridCell) => void;
  remove: (id: string) => void;
  beginConnecting: (fromId: string) => void;
  connect: (toId: string) => void;
  disconnect: (connectionId: string) => void;
  setParam: (id: string, key: string, value: number) => void;
  /** Add a zone of this kind at its default size, in the first clear space. */
  addZone: (kind: ZoneKind) => void;
  /**
   * Rename, retype, move or resize a zone. Moving carries its equipment along.
   * Refuses, naming what is in the way, rather than overlapping another zone or
   * stranding equipment.
   */
  updateZone: (id: string, patch: Partial<Omit<ZoneSpec, "id">>) => void;
  /** Delete an empty zone. Refuses while it still holds equipment. */
  removeZone: (id: string) => void;
  /** `presetId` marks which preset the layout came from, for the picker. */
  loadLayout: (layout: SandboxLayout, presetId?: string | null) => void;
  reset: () => void;
  notify: (message: string | null) => void;
  publishSim: (inletC: Record<string, number>, telemetry: Telemetry) => void;
  resetView: () => void;
  /** Validate, and run both control modes if the design holds up. */
  runSimulation: () => void;
  closeResults: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/** "4 GPU racks and 1 CDU", for refusals that name what is in the way. */
export function describeItems(items: readonly SandboxItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = CATALOGUE[item.kind].label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${n} ${label}${n > 1 ? "s" : ""}`);
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Equipment belonging to a zone: everything whose origin tile lies in it. */
export function membersOf(items: readonly SandboxItem[], zone: ZoneSpec): SandboxItem[] {
  return items.filter((item) => zoneAt([zone], item.cell) !== null);
}

/** "compute hall or cooling room", for refusals that name the right place. */
function allowedZones(kind: ComponentKind): string {
  const labels = CATALOGUE[kind].zones.map((zone) => ZONE_CATALOGUE[zone].label.toLowerCase());
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}` : labels[0];
}

/**
 * Why equipment cannot go at `cell`, or null if it can: the footprint must sit
 * wholly inside a zone that takes it, on clear tiles.
 */
export function placementRefusal(
  items: readonly SandboxItem[],
  zones: readonly ZoneSpec[],
  kind: ComponentKind,
  cell: GridCell,
): string | null {
  const entry = CATALOGUE[kind];
  const { w, d } = entry.footprint;
  const home = zoneAt(zones, cell);
  if (!home) return `Place a ${entry.label} inside a zone. It belongs in a ${allowedZones(kind)}.`;
  if (!zoneAccepts(home.kind, kind)) {
    return `A ${entry.label} belongs in a ${allowedZones(kind)}, not a ${ZONE_CATALOGUE[home.kind].label.toLowerCase()}.`;
  }
  if (!zoneOfFootprint(zones, kind, cell)) {
    return `A ${entry.label} needs ${w} by ${d} tiles and would hang off ${home.name} here.`;
  }
  if (items.some((item) => footprintsOverlap(item.kind, item.cell, kind, cell))) {
    return `That space is already occupied. A ${entry.label} needs ${w} by ${d} clear ${w * d === 1 ? "tile" : "tiles"}.`;
  }
  return null;
}

/** True when the footprint sits wholly inside a zone that takes it, on clear tiles. */
export function canPlaceAt(
  items: readonly SandboxItem[],
  zones: readonly ZoneSpec[],
  kind: ComponentKind,
  cell: GridCell,
): boolean {
  return placementRefusal(items, zones, kind, cell) === null;
}

/** The highest numeric suffix in use, so new ids never collide with loaded ones. */
function highestId(layout: SandboxLayout): number {
  const ids = [...layout.items, ...layout.connections, ...layout.zones].map((entity) => entity.id);
  return ids.reduce((max, id) => {
    const n = Number(id.split("-").pop());
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  zones: DEFAULT_ZONES.map((zone) => ({ ...zone })),
  items: [],
  connections: [],
  selectedId: null,
  selectedZoneId: null,
  mode: { type: "idle" },
  controlMode: "baseline",
  notice: null,
  inletC: {},
  telemetry: null,
  viewResetNonce: 0,
  lastRun: null,
  showResults: false,
  runFindings: null,
  activePresetId: null,

  publishSim: (inletC, telemetry) => set({ inletC, telemetry }),
  resetView: () => set((s) => ({ viewResetNonce: s.viewResetNonce + 1 })),

  runSimulation: () => {
    const { items, connections, zones } = get();
    const layout = { items, connections, zones };
    const findings = validateLayout(layout);

    // A run on an incoherent hall would produce authoritative-looking numbers
    // that mean nothing, so errors stop it. Warnings do not. Either way the run
    // is a new action, so an earlier refusal no longer applies.
    if (!findings.ok) {
      set({ runFindings: findings, showResults: true, lastRun: null, notice: null });
      return;
    }

    set({ runFindings: findings, lastRun: runEpisode(layout), showResults: true, notice: null });
  },

  closeResults: () => set({ showResults: false }),

  addZone: (kind) => {
    const { zones } = get();
    const label = ZONE_CATALOGUE[kind].label;
    if (zones.length >= MAX_ZONES) {
      set({ notice: `A site can hold up to ${MAX_ZONES} zones.` });
      return;
    }
    const spot = freeZoneSpot(zones, kind);
    if (!spot) {
      set({ notice: `There is no clear space on the site for another ${label.toLowerCase()}. Move or shrink a zone first.` });
      return;
    }
    const count = zones.filter((zone) => zone.kind === kind).length + 1;
    const zone: ZoneSpec = { id: nextId("zone"), name: `${label} ${count}`, kind, ...spot };
    set({
      zones: [...zones, zone],
      selectedZoneId: zone.id,
      selectedId: null,
      mode: { type: "idle" },
      notice: null,
      activePresetId: null,
      viewResetNonce: get().viewResetNonce + 1,
    });
  },

  updateZone: (id, patch) => {
    const { zones, items } = get();
    const current = zones.find((zone) => zone.id === id);
    if (!current) return;

    const next: ZoneSpec = {
      ...current,
      ...patch,
      id,
      name: patch.name !== undefined ? patch.name.slice(0, 40) : current.name,
    };
    // Size first, capped so the zone still fits from where it stands; then
    // position, so a resize never quietly drags the zone somewhere else.
    next.w = clamp(next.w, ZONE_LIMITS.w.min, Math.min(ZONE_LIMITS.w.max, SITE.w - next.x));
    next.d = clamp(next.d, ZONE_LIMITS.d.min, Math.min(ZONE_LIMITS.d.max, SITE.d - next.z));
    next.x = clamp(next.x, 0, SITE.w - next.w);
    next.z = clamp(next.z, 0, SITE.d - next.d);

    const blocker = zones.find((zone) => zone.id !== id && zonesOverlap(zoneRect(zone), zoneRect(next)));
    if (blocker) {
      set({ notice: `Zones cannot overlap. ${next.name || current.name} would run into ${blocker.name}.` });
      return;
    }

    // Equipment rides with its zone, so a move never tears a layout apart.
    const dx = next.x - current.x;
    const dz = next.z - current.z;
    const moved = membersOf(items, current).map((item) => ({
      ...item,
      cell: { x: item.cell.x + dx, z: item.cell.z + dz },
    }));

    const unwelcome = moved.filter((item) => !zoneAccepts(next.kind, item.kind));
    if (unwelcome.length > 0) {
      set({
        notice: `Cannot make ${current.name} a ${ZONE_CATALOGUE[next.kind].label.toLowerCase()}: ${describeItems(unwelcome)} cannot go there. Move or delete them first.`,
      });
      return;
    }

    // A zone shrunk below what it holds. Refuse and name what is in the way,
    // rather than deleting somebody's layout to satisfy a slider drag.
    const stranded = moved.filter((item) => zoneOfFootprint([next], item.kind, item.cell) === null);
    if (stranded.length > 0) {
      set({ notice: `Cannot resize ${current.name}: ${describeItems(stranded)} would not fit. Move or delete them first.` });
      return;
    }

    const movedById = new Map(moved.map((item) => [item.id, item]));
    set({
      zones: zones.map((zone) => (zone.id === id ? next : zone)),
      items: items.map((item) => movedById.get(item.id) ?? item),
      notice: null,
      activePresetId: null,
    });
  },

  removeZone: (id) => {
    const { zones, items } = get();
    const zone = zones.find((candidate) => candidate.id === id);
    if (!zone) return;
    const members = membersOf(items, zone);
    if (members.length > 0) {
      set({ notice: `${zone.name} still holds ${describeItems(members)}. Move or delete them before removing the zone.` });
      return;
    }
    set({
      zones: zones.filter((candidate) => candidate.id !== id),
      selectedZoneId: null,
      notice: null,
      activePresetId: null,
    });
  },

  // A refusal notice is transient: any further action clears it, so a stale
  // reason never sits under an unrelated interaction.
  select: (id) => set({ selectedId: id, selectedZoneId: null, notice: null }),
  selectZone: (id) => set({ selectedZoneId: id, selectedId: null, notice: null }),
  setMode: (mode) => set({ mode, notice: null }),
  setControlMode: (controlMode) => set({ controlMode }),
  notify: (notice) => set({ notice }),

  beginPlacing: (kind) =>
    set((s) => ({
      // Clicking the active tool again puts the pointer back to selection.
      mode: s.mode.type === "placing" && s.mode.kind === kind ? { type: "idle" } : { type: "placing", kind },
      selectedId: null,
      selectedZoneId: null,
      notice: null,
    })),

  place: (kind, cell) => {
    const { items, zones } = get();
    const refusal = placementRefusal(items, zones, kind, cell);
    if (refusal) {
      set({ notice: refusal });
      return;
    }
    const item: SandboxItem = { id: nextId(kind), kind, cell, params: defaultParams(kind) };
    set({ items: [...items, item], selectedId: item.id, notice: null, activePresetId: null });
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
      activePresetId: null,
    });
  },

  disconnect: (connectionId) =>
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== connectionId),
      activePresetId: null,
    })),

  remove: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      // Drop any link that pointed at the deleted item.
      connections: s.connections.filter((c) => c.fromId !== id && c.toId !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      // Cancel an in-progress link if its source has just been deleted.
      mode: s.mode.type === "connecting" && s.mode.fromId === id ? { type: "idle" } : s.mode,
      activePresetId: null,
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

  loadLayout: (layout, presetId = null) => {
    // The layout arrives with its own ids; anything created afterwards numbers
    // from the highest it contains, so nothing can collide with it.
    idCounter = highestId(layout);
    set({
      zones: layout.zones.map((zone) => ({ ...zone })),
      items: layout.items.map((i) => ({ ...i, cell: { ...i.cell }, params: { ...i.params } })),
      connections: layout.connections.map((c) => ({ ...c })),
      selectedId: null,
      selectedZoneId: null,
      mode: { type: "idle" },
      notice: null,
      activePresetId: presetId,
      lastRun: null,
      runFindings: null,
      viewResetNonce: get().viewResetNonce + 1,
    });
  },

  reset: () => {
    rewindIds();
    set({
      zones: DEFAULT_ZONES.map((zone) => ({ ...zone })),
      items: [],
      connections: [],
      selectedId: null,
      selectedZoneId: null,
      mode: { type: "idle" },
      controlMode: "baseline",
      notice: null,
      activePresetId: null,
      inletC: {},
      telemetry: null,
      viewResetNonce: get().viewResetNonce + 1,
      lastRun: null,
      showResults: false,
      runFindings: null,
    });
  },
}));
