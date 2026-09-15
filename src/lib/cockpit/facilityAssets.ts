/**
 * How Operations names a facility's equipment: the ids the twin, HUD, thermal
 * graph and replay session share, and the labels people read.
 *
 * Racks are identified as the replay snapshot identifies them (A01); every
 * other unit by its layout id (cdu-03). Models saved before the Builder keep
 * the SFO-01 names their seeded incident, topology and assistant records use.
 */
import type { FacilityLayout } from "@/lib/facility/layout";
import { SFO_01_LAYOUT } from "@/lib/facility/templates";
import type { SandboxItem } from "@/lib/sandbox/types";
import { DEFAULT_FACILITY_MODEL, facilityPlant, rackLabel, type FacilityModelConfig } from "./simulation";

export type FacilityAssetKind = "workload" | "rack" | "cooling" | "chiller" | "sensor";

export interface FacilityAsset {
  id: string;
  label: string;
  kind: FacilityAssetKind;
  /** The layout item behind the asset; absent for the workload. */
  item?: SandboxItem;
}

export interface FacilityAssets {
  /** The IT workload the scenario ramps, selected when nothing else is. */
  workload: FacilityAsset;
  /** The hall the asset strip names for the workload. */
  hallLabel: string;
  /** Racks, cooling units, chillers and sensors, in that order. */
  assets: FacilityAsset[];
  /** Every asset by id, the workload included. */
  byId: Map<string, FacilityAsset>;
  /** True for models saved before the Builder, which keep the SFO-01 names. */
  reference: boolean;
}

/** The SFO-01 workload id used by the seeded incident, topology and assistant records. */
export const REFERENCE_WORKLOAD_ID = "gpu-b";
/** The workload id for a published build. */
export const BUILD_WORKLOAD_ID = "it-workload";

const ACRONYMS = new Set(["cdu", "crac", "pdu", "ahu"]);

/** The id the twin, HUD and graph use: A01 for rack-a01, the layout id otherwise. */
export const twinAssetId = (item: Pick<SandboxItem, "id" | "kind">) =>
  item.kind === "rack" ? rackLabel(item.id) : item.id;

/** cdu-03 is CDU-03, chiller-01 is Chiller-01, rack-a01 is Rack A01. */
export function itemLabel(item: Pick<SandboxItem, "id" | "kind">): string {
  if (item.kind === "rack") return `Rack ${rackLabel(item.id)}`;
  return item.id
    .split("-")
    .map((part, index) =>
      ACRONYMS.has(part) || index > 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("-");
}

const KIND_ORDER: Record<SandboxItem["kind"], number> = { rack: 0, cdu: 1, crac: 1, chiller: 2, sensor: 3 };
const ASSET_KIND: Record<SandboxItem["kind"], FacilityAssetKind> = {
  rack: "rack",
  cdu: "cooling",
  crac: "cooling",
  chiller: "chiller",
  sensor: "sensor",
};

const builds = new WeakMap<FacilityLayout, FacilityAssets>();
let referenceAssets: FacilityAssets | undefined;

/** The named equipment of the facility a model runs. */
export function facilityAssets(config: FacilityModelConfig = DEFAULT_FACILITY_MODEL): FacilityAssets {
  const reference = !config.layout;
  const layout = config.layout ?? SFO_01_LAYOUT;
  const cached = reference ? referenceAssets : builds.get(layout);
  if (cached) return cached;

  const plant = facilityPlant(config);
  const computeZones = layout.zones.filter((zone) => zone.kind === "compute");
  const workload: FacilityAsset = reference
    ? { id: REFERENCE_WORKLOAD_ID, label: "GPU Cluster B", kind: "workload" }
    : {
        id: BUILD_WORKLOAD_ID,
        label: computeZones.length === 1 ? `${computeZones[0].name} workload` : "IT workload",
        kind: "workload",
      };
  const assets = layout.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.index - b.index)
    .map(({ item }): FacilityAsset => ({ id: twinAssetId(item), label: itemLabel(item), kind: ASSET_KIND[item.kind], item }));

  const result: FacilityAssets = {
    workload,
    hallLabel: plant.advisedZone,
    assets,
    byId: new Map([workload, ...assets].map((asset) => [asset.id, asset])),
    reference,
  };
  if (reference) referenceAssets = result;
  else builds.set(layout, result);
  return result;
}
