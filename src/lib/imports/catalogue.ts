import type { ComponentKind } from "@/lib/sandbox/types";

export type CuratedEquipmentModel = {
  id: string;
  category: ComponentKind;
  manufacturer: string;
  model: string;
  properties: Record<string, number | string>;
  provenance: {
    kind: "CURATED_DEMO";
    source: string;
    note: string;
  };
};

/**
 * Small, intentionally bounded demo catalogue. These are demonstration
 * configuration values, not manufacturer-certified specifications.
 */
export const CURATED_EQUIPMENT_CATALOGUE: readonly CuratedEquipmentModel[] = [
  {
    id: "demo-rack-gpu-42u",
    category: "rack",
    manufacturer: "Wattr demonstration catalogue",
    model: "GPU Rack 42U",
    properties: { rackUnits: 42, nominalItLoadKw: 18 },
    provenance: { kind: "CURATED_DEMO", source: "Wattr curated demonstration catalogue v1", note: "Illustrative demo data; verify against the site asset record." },
  },
  {
    id: "demo-crac-air-060",
    category: "crac",
    manufacturer: "Wattr demonstration catalogue",
    model: "Air Handler 060",
    properties: { capacityKw: 60, airflowCmh: 9000, supplyAirC: 16 },
    provenance: { kind: "CURATED_DEMO", source: "Wattr curated demonstration catalogue v1", note: "Illustrative demo data; verify against the site asset record." },
  },
  {
    id: "demo-cdu-liquid-100",
    category: "cdu",
    manufacturer: "Wattr demonstration catalogue",
    model: "Liquid CDU 100",
    properties: { capacityKw: 100, supplyWaterC: 21 },
    provenance: { kind: "CURATED_DEMO", source: "Wattr curated demonstration catalogue v1", note: "Illustrative demo data; verify against the site asset record." },
  },
  {
    id: "demo-chiller-250",
    category: "chiller",
    manufacturer: "Wattr demonstration catalogue",
    model: "Chiller 250",
    properties: { capacityKw: 250, chilledWaterC: 9 },
    provenance: { kind: "CURATED_DEMO", source: "Wattr curated demonstration catalogue v1", note: "Illustrative demo data; verify against the site asset record." },
  },
] as const;

export function catalogueModel(id: string | null | undefined) {
  return CURATED_EQUIPMENT_CATALOGUE.find((model) => model.id === id);
}