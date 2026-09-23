/**
 * Canonical facility-intelligence projection.
 *
 * The active model layout is authoritative. Database inventory rows can enrich
 * this projection, but must never replace its ids: a published layout can be
 * newer than a seeded inventory record.
 */
import { SFO_01_LAYOUT } from "@/lib/facility/templates";
import { itemLabel, twinAssetId } from "@/lib/cockpit/facilityAssets";
import { facilityPlant, type FacilityModelConfig } from "@/lib/cockpit/simulation";
import type { ComponentKind, SandboxItem, ZoneSpec } from "@/lib/sandbox/types";

export type IntelligenceAssetKind = "RACK" | "COOLING_UNIT" | "CHILLER" | "SENSOR";
export type IntelligenceMetric =
  | "rack_power_kw"
  | "rack_inlet_temperature_c"
  | "cooling_fan_percent";

export type IntelligenceProvenance = {
  kind: "SIMULATED" | "IMPORTED" | "CURATED";
  source: string;
  generated: boolean;
};

export type IntelligenceLocation = {
  status: "RESOLVED" | "UNRESOLVED";
  floorId: string | null;
  floorName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  gridCell: { x: number; z: number } | null;
};

export type IntelligenceAsset = {
  /** Stable, unique item id from the active model layout. */
  id: string;
  /** The selection id expected by the currently-rendered digital twin. */
  twinSelectionId: string;
  name: string;
  kind: IntelligenceAssetKind;
  componentKind: ComponentKind;
  manufacturer: string | null;
  model: string | null;
  ratedCapacityKw: number | null;
  dimensions: { widthTiles: number; depthTiles: number } | null;
  location: IntelligenceLocation;
  metrics: IntelligenceMetric[];
  relationships: Array<{ relation: string; assetId: string }>;
  provenance: IntelligenceProvenance;
  /** Import/layout metadata retained for review; never synthesized as a fact. */
  sourceMetadata: Record<string, unknown>;
};

export type IntelligenceHierarchyNode = {
  id: string;
  parentId: string | null;
  kind: "FACILITY" | "FLOOR" | "ZONE" | "ASSET";
  name: string;
  assetId?: string;
};

export type ModelAssetAnnotation = {
  layout_asset_id: string;
  manufacturer: string | null;
  model: string | null;
  location_status: "RESOLVED" | "UNRESOLVED";
  source_metadata: Record<string, unknown>;
  provenance: "SIMULATED" | "IMPORTED" | "CURATED";
};

const FALLBACK_FLOOR_ID = "floor-1";
const FALLBACK_FLOOR_NAME = "Floor 1";

const kindFor = (kind: ComponentKind): IntelligenceAssetKind => {
  if (kind === "rack") return "RACK";
  if (kind === "chiller") return "CHILLER";
  if (kind === "sensor") return "SENSOR";
  return "COOLING_UNIT";
};

const metricsFor = (kind: ComponentKind, layoutAssetId: string, advisedUnitId: string): IntelligenceMetric[] => {
  if (kind === "rack") return ["rack_power_kw", "rack_inlet_temperature_c"];
  // The reduced-order model exposes the command of its advised cooling unit;
  // it does not calculate a per-unit allocation for all cooling equipment.
  if ((kind === "cdu" || kind === "crac") && layoutAssetId === advisedUnitId) return ["cooling_fan_percent"];
  return [];
};

function zoneFor(item: SandboxItem, zones: ZoneSpec[]) {
  return zones.find((zone) =>
    item.cell.x >= zone.x && item.cell.x < zone.x + zone.w &&
    item.cell.z >= zone.z && item.cell.z < zone.z + zone.d,
  );
}

function baseProvenance(config: FacilityModelConfig): IntelligenceProvenance {
  const source = (config as FacilityModelConfig & { importMetadata?: unknown }).importMetadata;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const metadata = source as Record<string, unknown>;
    const label = typeof metadata.source === "string" && metadata.source.trim()
      ? metadata.source.trim().slice(0, 200)
      : "Imported model metadata";
    return { kind: "IMPORTED", source: label, generated: false };
  }
  return { kind: "SIMULATED", source: "Published facility model layout", generated: true };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
const provenanceKind = (value: unknown): IntelligenceProvenance["kind"] | undefined =>
  value === "SIMULATED" || value === "IMPORTED" || value === "CURATED" ? value : undefined;

/**
 * Importers may add structured metadata without widening SandboxItem. Read the
 * known extension points defensively so an old authored layout remains valid
 * and a verified imported draft retains its source facts without a second
 * annotation write.
 */
function layoutEnrichment(item: SandboxItem, zone: ZoneSpec | undefined) {
  const rawItem = item as SandboxItem & Record<string, unknown>;
  const itemMetadata = record(rawItem.metadata) ?? record(rawItem.importMetadata) ?? record(rawItem.sourceMetadata) ?? {};
  // Match the import worker's ImportedObject fields whether it preserves them
  // directly as metadata, under `import`, or under `importedObject`.
  const importedObject = record(itemMetadata.import) ?? record(itemMetadata.importedObject) ??
    record(rawItem.importedObject) ?? {};
  const rawZone = zone as (ZoneSpec & Record<string, unknown>) | undefined;
  const zoneMetadata = record(rawZone?.metadata) ?? record(rawZone?.importMetadata) ?? {};
  const location = record(itemMetadata.location) ?? record(importedObject.location) ?? {};
  const sourceMetadata = {
    ...zoneMetadata,
    ...itemMetadata,
    ...(Object.keys(importedObject).length ? { importedObject } : {}),
  };
  const dimensions = record(itemMetadata.dimensions) ?? {};
  const width = Number(dimensions.widthTiles ?? itemMetadata.widthTiles);
  const depth = Number(dimensions.depthTiles ?? itemMetadata.depthTiles);
  const floorId = text(location.floorId) ?? text(itemMetadata.floorId) ?? text(importedObject.floorId) ??
    text(zoneMetadata.floorId) ?? FALLBACK_FLOOR_ID;
  const floorName = text(location.floorName) ?? text(itemMetadata.floorName) ?? text(importedObject.floorName) ??
    text(location.floor) ?? text(itemMetadata.floor) ?? text(itemMetadata.storey) ?? text(importedObject.storey) ??
    text(zoneMetadata.floor) ?? FALLBACK_FLOOR_NAME;
  const source = text(itemMetadata.source) ?? text(itemMetadata.sourceFile) ?? text(itemMetadata.importId) ??
    text(itemMetadata.fileName) ?? text(itemMetadata.sourceId) ?? text(importedObject.source) ??
    text(importedObject.sourceId) ?? text(zoneMetadata.source);
  const nestedProvenance = record(itemMetadata.provenance) ?? record(importedObject.provenance);
  const imported = provenanceKind(itemMetadata.provenance) ?? provenanceKind(rawItem.provenance) ??
    provenanceKind(nestedProvenance?.kind) ?? (source || Object.keys(importedObject).length ? "IMPORTED" : undefined);
  const curated = Boolean(text(itemMetadata.catalogueModelId) ?? text(rawItem.catalogueModelId));
  return {
    manufacturer: text(itemMetadata.manufacturer) ?? text(itemMetadata.vendor) ?? text(importedObject.manufacturer),
    model: text(itemMetadata.model) ?? text(itemMetadata.modelNumber) ?? text(itemMetadata.equipmentModel) ?? text(importedObject.model),
    floorId,
    floorName,
    zoneId: text(location.zoneId) ?? text(itemMetadata.zoneId) ?? zone?.id,
    zoneName: text(location.zoneName) ?? text(itemMetadata.zoneName) ?? zone?.name,
    locationStatus: itemMetadata.locationStatus === "UNRESOLVED" || rawItem.locationStatus === "UNRESOLVED"
      ? "UNRESOLVED" as const
      : "RESOLVED" as const,
    source,
    provenance: imported ?? (curated ? "CURATED" : undefined),
    sourceMetadata,
    dimensions: Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0
      ? { widthTiles: width, depthTiles: depth }
      : null,
  };
}

function capacityFor(item: SandboxItem): number | null {
  const params = item.params;
  const value = params.capacityKw ?? params.itLoadKw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Projects an active published model to the facility hierarchy and canonical
 * assets. `annotations` are version-bound enrichment only; missing annotations
 * deliberately leave manufacturer/model null rather than inventing facts.
 */
export function resolveFacilityIntelligence(
  config: FacilityModelConfig,
  annotations: readonly ModelAssetAnnotation[] = [],
): { assets: IntelligenceAsset[]; hierarchy: IntelligenceHierarchyNode[] } {
  const layout = config.layout ?? SFO_01_LAYOUT;
  // This is the only cooling unit whose command the current thermal model
  // computes. Do not infer values for peer units from facility totals.
  let advisedUnitId = "";
  try {
    advisedUnitId = facilityPlant(config).advisedUnit.id;
  } catch {
    // A draft can be spatially incomplete during import review. It can still
    // be inspected, but it has no model-backed cooling telemetry until valid.
  }
  const annotationById = new Map(annotations.map((annotation) => [annotation.layout_asset_id, annotation]));
  const idByLayoutId = new Map(layout.items.map((item) => [item.id, item.id]));
  const provenance = baseProvenance(config);
  const assets = layout.items.map((item): IntelligenceAsset => {
    const annotation = annotationById.get(item.id);
    const zone = zoneFor(item, layout.zones);
    const enriched = layoutEnrichment(item, zone);
    const locationResolved = Boolean(enriched.zoneId) && enriched.locationStatus !== "UNRESOLVED" && annotation?.location_status !== "UNRESOLVED";
    const relationships = layout.connections.flatMap((connection) => {
      if (connection.fromId === item.id && idByLayoutId.has(connection.toId)) {
        return [{ relation: "CONNECTS_TO", assetId: connection.toId }];
      }
      if (connection.toId === item.id && idByLayoutId.has(connection.fromId)) {
        return [{ relation: "CONNECTED_FROM", assetId: connection.fromId }];
      }
      return [];
    });
    return {
      id: item.id,
      twinSelectionId: twinAssetId(item),
      name: itemLabel(item),
      kind: kindFor(item.kind),
      componentKind: item.kind,
      // The layout is the verified import artifact. An annotation is an
      // optional version-bound correction, never a requirement for imported
      // manufacturer/model/source metadata to be visible.
      manufacturer: enriched.manufacturer ?? annotation?.manufacturer ?? null,
      model: enriched.model ?? annotation?.model ?? null,
      ratedCapacityKw: capacityFor(item),
      dimensions: enriched.dimensions,
      location: locationResolved
        ? {
            status: "RESOLVED", floorId: enriched.floorId, floorName: enriched.floorName,
            zoneId: enriched.zoneId ?? null, zoneName: enriched.zoneName ?? null, gridCell: item.cell,
          }
        : { status: "UNRESOLVED", floorId: null, floorName: null, zoneId: null, zoneName: null, gridCell: null },
      metrics: metricsFor(item.kind, item.id, advisedUnitId),
      relationships,
      provenance: enriched.provenance
        ? { kind: enriched.provenance, source: enriched.source ?? "Verified layout import metadata", generated: enriched.provenance === "SIMULATED" }
        : annotation
        ? {
            kind: annotation.provenance,
            source: typeof annotation.source_metadata.source === "string"
              ? annotation.source_metadata.source
              : provenance.source,
            generated: annotation.provenance === "SIMULATED",
          }
        : provenance,
      sourceMetadata: {
        ...(annotation?.source_metadata ?? {}),
        ...enriched.sourceMetadata,
      },
    };
  });
  const floors = [...new Map(assets
    .filter((asset) => asset.location.floorId && asset.location.floorName)
    .map((asset) => [asset.location.floorId!, asset.location.floorName!])).entries()];
  const hierarchy: IntelligenceHierarchyNode[] = [
    { id: "facility", parentId: null, kind: "FACILITY", name: "Facility" },
    ...floors.map(([id, name]) => ({ id, parentId: "facility", kind: "FLOOR" as const, name })),
    ...layout.zones.map((zone) => {
      const asset = assets.find((candidate) => candidate.location.zoneId === zone.id);
      return { id: zone.id, parentId: asset?.location.floorId ?? "facility", kind: "ZONE" as const, name: zone.name };
    }),
    ...assets.map((asset) => ({
      id: `asset:${asset.id}`,
      parentId: asset.location.zoneId ?? "facility",
      kind: "ASSET" as const,
      name: asset.name,
      assetId: asset.id,
    })),
  ];
  return { assets, hierarchy };
}

/** Resolve either the canonical layout id or the current twin selection alias. */
export function findIntelligenceAsset(assets: readonly IntelligenceAsset[], idOrTwinId: string) {
  return assets.find((asset) => asset.id === idOrTwinId || asset.twinSelectionId === idOrTwinId);
}

export function searchableAssetText(asset: IntelligenceAsset) {
  return [
    asset.id, asset.twinSelectionId, asset.name, asset.kind, asset.componentKind,
    asset.manufacturer ?? "", asset.model ?? "", asset.location.zoneName ?? "",
  ].join(" ").toLocaleLowerCase();
}