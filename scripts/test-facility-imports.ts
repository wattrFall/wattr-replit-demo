import assert from "node:assert/strict";
import { CURATED_EQUIPMENT_CATALOGUE, catalogueModel } from "../src/lib/imports/catalogue";
import { parseIfcStep } from "../src/lib/imports/ifc";
import { assertFacilityLayout, normalizeFacilityLayout } from "../src/lib/facility/layout";
import { mapImportToBuilderLayout, registerImportRoutes } from "../server/import-routes";
import { SITE } from "../src/lib/sandbox/geometry";

const sample = `ISO-10303-21;
HEADER; FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1'); ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((10.,20.,0.));
#2=IFCCARTESIANPOINT((12.,4.,3.));
#3=IFCBUILDINGSTOREY('floor-guid','Floor 2',$,$,$,$,$,$,$);
#4=IFCUNITARYEQUIPMENT('cooling-guid','CRAH-07',$,$,#15,$,$,$);
#5=IFCFURNISHINGELEMENT('rack-guid','Rack R17',$,$,$,$,$,$);
#6=IFCSPACE('space-guid','Cooling Zone B',$,$,$,$,$,$,$);
#7=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('Wattr Test Vendor'),$);
#8=IFCPROPERTYSET('set-guid',$,'Pset_Equipment',$,(#7));
#9=IFCRELDEFINESBYPROPERTIES('rel-guid',$,$,$,(#4),#8);
#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('contain-guid',$,$,$,(#4,#5),#3);
#16=IFCPROPERTYSINGLEVALUE('Capacity',$,IFCREAL(80.),$);
#17=IFCPROPERTYSET('capacity-set',$,'Pset_Capacity',$,(#16));
#18=IFCRELDEFINESBYPROPERTIES('capacity-rel',$,$,$,(#4),#17);
#11=IFCAXIS2PLACEMENT3D(#1,$,$);
#12=IFCLOCALPLACEMENT($,#11);
#13=IFCCARTESIANPOINT((5.,3.,0.));
#14=IFCAXIS2PLACEMENT3D(#13,$,$);
#15=IFCLOCALPLACEMENT(#12,#14);
ENDSEC; END-ISO-10303-21;`;

const parsed = parseIfcStep(sample);
assert.equal(parsed.geometry?.bounds?.min.join(","), "10,20,0");
assert.equal(parsed.geometry?.bounds?.max.join(","), "15,23,0", "preview bounds use transformed placement origins");
assert.equal(parsed.objects.find((item) => item.sourceId === "cooling-guid")?.inferredKind, "crac");
assert.equal(parsed.objects.find((item) => item.sourceId === "cooling-guid")?.properties.Manufacturer, "Wattr Test Vendor");
assert.equal(parsed.objects.find((item) => item.sourceId === "cooling-guid")?.properties.Capacity, 80);
assert.equal(parsed.objects.find((item) => item.sourceId === "cooling-guid")?.storey, "Floor 2");
assert.equal(parsed.objects.find((item) => item.sourceId === "cooling-guid")?.geometry?.origin?.join(","), "15,23,0", "root local placement retains positional null before its axis reference");
assert.equal(parsed.objects.find((item) => item.sourceId === "rack-guid")?.confidence, "MEDIUM");
assert.throws(() => parseIfcStep("not an IFC"), /ISO-10303-21/);
assert.equal(catalogueModel("demo-chiller-250")?.properties.capacityKw, 250);
assert.ok(CURATED_EQUIPMENT_CATALOGUE.every((model) => model.provenance.kind === "CURATED_DEMO"));

const layout = {
  zones: [],
  items: [],
  connections: [],
  referenceLayers: [{
    id: "plan-123", fileId: "file-123", name: "Floor 1", mimeType: "image/png",
    grid: { x: 0, z: 0, w: 40, d: 30 }, provenance: "IMPORTED" as const, source: "floor.png",
  }],
};
assertFacilityLayout(layout);
assert.equal(normalizeFacilityLayout(layout).referenceLayers?.[0].fileId, "file-123");
const importPreview = { importId: "import-123", fileId: "file-123", kind: "IFC" as const, sourceName: "sample.ifc", createdAt: new Date().toISOString(), ...parsed };
const mapped = mapImportToBuilderLayout({ zones: [], items: [], connections: [] }, importPreview, [{
  sourceId: "cooling-guid", decision: "CONFIRM", componentKind: "crac", catalogueModelId: "demo-crac-air-060", cell: { x: 2, z: 3 },
}]);
assert.equal(mapped.items[0].params.capacityKw, 80, "imported site capacity overrides curated demo default");
assert.equal((mapped.items[0].metadata?.catalogueProvenance as { kind?: string })?.kind, "CURATED_DEMO");
const worldMapped = mapImportToBuilderLayout({ zones: [], items: [], connections: [] }, importPreview, [{
  sourceId: "cooling-guid", decision: "CONFIRM", componentKind: "crac",
}]);
assert.deepEqual(worldMapped.items[0].cell, { x: SITE.w - 1, z: SITE.d - 1 }, "IFC world placement is calibrated to Builder X/Y grid bounds");

const routes: string[] = [];
const noop = (() => undefined) as never;
registerImportRoutes({
  app: {
    get: (path) => { routes.push(`GET ${path}`); },
    post: (path) => { routes.push(`POST ${path}`); },
  },
  pool: {} as never,
  requireAuth: noop,
  ensureDemoAccess: async () => undefined,
  requireFacilityAccess: async () => ({}),
  publishedModel: async () => undefined,
});
assert.deepEqual(routes, [
  "GET /api/facilities/:facilityId/imports/catalogue",
  "POST /api/facilities/:facilityId/imports/floorplans",
  "POST /api/facilities/:facilityId/imports/ifc",
  "GET /api/facilities/:facilityId/imports/:importId",
  "GET /api/facilities/:facilityId/imports/files/:fileId",
  "POST /api/facilities/:facilityId/imports/:importId/create-draft",
]);
// A denied import writer must stop before touching the database, including
// create-draft (not just upload). Read-only review remains available.
const handlers = new Map<string, Function>();
let writesChecked = 0;
registerImportRoutes({
  app: { get: (path, ...chain) => { handlers.set(`GET ${path}`, chain.at(-1)!); }, post: (path, ...chain) => { handlers.set(`POST ${path}`, chain.at(-1)!); } },
  pool: { query: () => { throw new Error("denied viewer reached the database"); } } as never,
  requireAuth: noop, ensureDemoAccess: async () => undefined,
  requireFacilityAccess: async () => ({}),
  requireImportAccess: async (_user, _facility, res) => { writesChecked++; res.status(404).json({ error: "Facility unavailable" }); return undefined; },
  publishedModel: async () => undefined,
});
let status = 0;
const response = { status(code: number) { status = code; return this; }, json() { return this; } };
for (const path of ["floorplans", "ifc", ":importId/create-draft"]) {
  await handlers.get(`POST /api/facilities/:facilityId/imports/${path}`)!({ userId: "viewer", params: { facilityId: "sfo-01", importId: "test" } }, response);
  assert.equal(status, 404);
}
assert.equal(writesChecked, 3);
const { mappedWorldCell } = await import("../src/lib/imports/placement");
const uiCell = mappedWorldCell(parsed.objects.find((object) => object.sourceId === "cooling-guid")!, importPreview);
assert.deepEqual(uiCell, worldMapped.items[0].cell, "UI and server share identical placement calibration");
assert.deepEqual(mapImportToBuilderLayout({ zones: [], items: [], connections: [] }, importPreview, [{ sourceId: "cooling-guid", decision: "CONFIRM", componentKind: "crac", cell: uiCell }]).items[0].cell, worldMapped.items[0].cell);
console.log("facility import parser, provenance, reference-layer, viewer-denial, and UI calibration tests passed");