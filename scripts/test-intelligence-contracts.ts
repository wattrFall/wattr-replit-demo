import assert from "node:assert/strict";
import {
  findIntelligenceAsset,
  resolveFacilityIntelligence,
  searchableAssetText,
} from "../src/lib/intelligence/facilityModel";
import { DEFAULT_FACILITY_MODEL } from "../src/lib/cockpit/simulation";
import { SFO_01_LAYOUT } from "../src/lib/facility/templates";
import { aggregateMetricContributions } from "../server/intelligence-routes";

const projection = resolveFacilityIntelligence(DEFAULT_FACILITY_MODEL);
assert.ok(projection.assets.length > 0, "published model layout should project assets");
assert.equal(
  new Set(projection.assets.map((asset) => asset.id)).size,
  projection.assets.length,
  "canonical ids must be unique layout ids",
);
const rack = projection.assets.find((asset) => asset.componentKind === "rack");
assert.ok(rack, "reference layout should include a rack");
assert.equal(rack.location.status, "RESOLVED");
assert.equal(findIntelligenceAsset(projection.assets, rack.id)?.id, rack.id);
assert.equal(findIntelligenceAsset(projection.assets, rack.twinSelectionId)?.id, rack.id);
assert.ok(searchableAssetText(rack).includes(rack.id));
assert.ok(rack.metrics.includes("rack_power_kw"));
assert.equal(rack.dimensions, null, "layout cells are not physical dimensions");

const unresolved = resolveFacilityIntelligence({
  ...DEFAULT_FACILITY_MODEL,
  layout: {
    zones: [],
    items: [{ id: "rack-unplaced", kind: "rack", cell: { x: 0, z: 0 }, params: { itLoadKw: 10, utilisationPct: 50, inletLimitC: 30 } }],
    connections: [],
  },
});
assert.equal(unresolved.assets[0].location.status, "UNRESOLVED");

const importedLayout = {
  ...SFO_01_LAYOUT,
  items: SFO_01_LAYOUT.items.map((item) => item.id === rack.id
    ? {
        ...item,
        metadata: {
          manufacturer: "Example Cooling",
          model: "Verified-42",
          source: "verified.ifc",
          provenance: "IMPORTED",
          dimensions: { widthTiles: 2, depthTiles: 3 },
        },
      }
    : item),
};
const imported = resolveFacilityIntelligence({ ...DEFAULT_FACILITY_MODEL, layout: importedLayout });
const importedRack = imported.assets.find((asset) => asset.id === rack.id)!;
assert.equal(importedRack.manufacturer, "Example Cooling");
assert.equal(importedRack.model, "Verified-42");
assert.equal(importedRack.provenance.source, "verified.ifc");
assert.deepEqual(importedRack.dimensions, { widthTiles: 2, depthTiles: 3 });
assert.deepEqual(
  aggregateMetricContributions("rack_power_kw", [
    { assetId: "rack-a", assetName: "Rack A", value: 12.5, unit: "kW" },
    { assetId: "rack-b", assetName: "Rack B", value: 10, unit: "kW" },
  ]),
  { value: 22.5, unit: "kW", aggregation: "SUM", contributingAssetCount: 2 },
);
assert.deepEqual(
  aggregateMetricContributions("rack_inlet_temperature_c", [
    { assetId: "rack-a", assetName: "Rack A", value: 27.2, unit: "°C" },
    { assetId: "rack-b", assetName: "Rack B", value: 29.4, unit: "°C" },
  ]),
  { value: 29.4, unit: "°C", aggregation: "MAX", contributingAssetCount: 2 },
);
console.log("Facility intelligence canonical layout projection tests passed.");