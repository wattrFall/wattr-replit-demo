/**
 * Facility import routes. Uploads are intentionally stored in the database:
 * no request writes an arbitrary file to disk, and every read is facility
 * permission checked. IFC STEP parsing is performed before a review session is
 * persisted, then a separate explicit action creates a Builder DRAFT.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type pg from "pg";
import { CATALOGUE, defaultParams } from "../src/lib/sandbox/catalogue";
import { SITE } from "../src/lib/sandbox/geometry";
import { assertFacilityLayout, facilityParamSpec, normalizeFacilityLayout, type FacilityLayout } from "../src/lib/facility/layout";
import { catalogueModel, CURATED_EQUIPMENT_CATALOGUE } from "../src/lib/imports/catalogue";
import { parseIfcStep } from "../src/lib/imports/ifc";
import { mappedWorldCell } from "../src/lib/imports/placement";
import type { ImportMapping, ImportPreview, ImportedObject, PlanReferenceLayer } from "../src/lib/imports/types";
import type { ComponentKind } from "../src/lib/sandbox/types";
import type { FacilityModelConfig } from "../src/lib/cockpit/simulation";
import type { Capability } from "../src/lib/security/rolePolicy";

type AuthedRequest = Request & { userId?: string };
type FacilityPermission = { organization_id?: string; role?: string; is_owner?: boolean };
type PublishedModel = { model_version: string; config: FacilityModelConfig };

export type ImportRouteDependencies = {
  app: {
    get: (path: string, ...handlers: RequestHandler[]) => unknown;
    post: (path: string, ...handlers: RequestHandler[]) => unknown;
  };
  pool: Pick<pg.Pool, "query" | "connect">;
  requireAuth: RequestHandler;
  ensureDemoAccess: (userId: string) => Promise<void>;
  requireFacilityAccess: (userId: string, facilityId: string, response: Response, capability?: Capability) => Promise<FacilityPermission | undefined>;
  /**
   * Existing role policy composed as engineer OR model-admin/owner. It is kept
   * separate from Builder's intentionally broad demo write grant.
   */
  requireImportAccess?: (userId: string, facilityId: string, response: Response) => Promise<FacilityPermission | undefined>;
  publishedModel: (facilityId: string, client?: pg.Pool | pg.PoolClient) => Promise<PublishedModel | undefined>;
};

const PLAN_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/svg+xml"]);
const IFC_MIME = new Set(["application/x-step", "application/ifc"]);
const KINDS: readonly ComponentKind[] = ["rack", "crac", "cdu", "chiller", "sensor"];
const MAX_BY_MIME: Record<string, number> = {
  "application/pdf": 15 * 1024 * 1024,
  "image/png": 15 * 1024 * 1024,
  "image/jpeg": 15 * 1024 * 1024,
  "image/svg+xml": 5 * 1024 * 1024,
  "application/x-step": 20 * 1024 * 1024,
  "application/ifc": 20 * 1024 * 1024,
};
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeName = (value: unknown) => typeof value === "string" ? value.replace(/[^\w .()\-]/g, "_").trim().slice(0, 160) : "";
const safeText = (value: unknown, maximum = 160) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

function decodeUpload(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Upload content is not valid base64 or exceeds the allowed size.");
  }
  const content = Buffer.from(value, "base64");
  if (!content.length || content.length > maximum || content.toString("base64") !== value) throw new Error("Upload content is malformed or exceeds the allowed size.");
  return content;
}

function verifyPlan(mime: string, content: Buffer) {
  if (mime === "application/pdf" && content.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The uploaded PDF does not have a valid PDF signature.");
  if (mime === "image/png" && !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("The uploaded image does not have a valid PNG signature.");
  if (mime === "image/jpeg" && !(content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)) throw new Error("The uploaded image does not have a valid JPEG signature.");
  if (mime === "image/svg+xml") {
    const svg = content.toString("utf8");
    if (!/<svg[\s>]/i.test(svg) || /<script|<foreignObject|on\w+\s*=|(?:href|src)\s*=\s*["'](?!#|data:image\/(?:png|jpeg|svg\+xml);base64,)|@import|url\s*\(/i.test(svg)) {
      throw new Error("SVG must be a self-contained drawing without scripts, event handlers, foreign objects, or external resources.");
    }
  }
}

function itemId(object: ImportedObject, index: number) {
  return `ifc-${String(object.expressId ?? index + 1).slice(0, 54)}`;
}

/** Only map source properties that match a supported, bounded model parameter. */
function importedSiteParams(object: ImportedObject, kind: ComponentKind) {
  const aliases: Record<string, string> = {
    capacity: "capacityKw", "itload": "itLoadKw", "rackunits": "rackUnits", "supplyair": "supplyAirC",
    supplywater: "supplyWaterC", "chilledwater": "chilledWaterC", "fanspeed": "fanSpeedPct", "pumpspeed": "pumpSpeedPct",
  };
  const supported = new Map(CATALOGUE[kind].params.map((spec) => [spec.key, facilityParamSpec(kind, spec)]));
  const result: Record<string, number> = {};
  for (const [label, raw] of Object.entries(object.properties)) {
    const key = aliases[label.replace(/[^a-z]/gi, "").toLowerCase()];
    const spec = key ? supported.get(key) : undefined;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (spec && Number.isFinite(value) && value >= spec.min && value <= spec.max) result[key] = value;
  }
  return result;
}

/** Pure conversion used by the route and targeted contract tests. */
export function mapImportToBuilderLayout(base: FacilityLayout, preview: ImportPreview, mappings: ImportMapping[]): FacilityLayout {
  const bySource = new Map(preview.objects.map((object) => [object.sourceId, object]));
  const items = [...base.items];
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index], object = bySource.get(mapping.sourceId);
    if (!object || mapping.decision === "IGNORE" || !mapping.componentKind) continue;
    const curated = catalogueModel(mapping.catalogueModelId);
    if (curated && curated.category !== mapping.componentKind) throw new Error(`Catalogue model ${curated.id} does not match ${mapping.componentKind}.`);
    const rawCell = mapping.cell ?? mappedWorldCell(object, preview, index);
    const cell = { x: Math.max(0, Math.min(SITE.w - 1, Math.round(rawCell.x))), z: Math.max(0, Math.min(SITE.d - 1, Math.round(rawCell.z))) };
    const params = defaultParams(mapping.componentKind);
    for (const [key, value] of Object.entries(curated?.properties ?? {})) if (typeof value === "number" && key in params) params[key] = value;
    // Site values, including parsed IFC properties and explicit review edits,
    // take precedence over catalogue defaults. Unsupported raw properties are
    // still retained in metadata below rather than silently discarded.
    Object.assign(params, importedSiteParams(object, mapping.componentKind));
    for (const [key, value] of Object.entries(mapping.siteParams ?? {})) {
      if (!(key in params)) throw new Error(`Site property ${key} is not supported for ${mapping.componentKind}.`);
      if (!Number.isFinite(value)) throw new Error(`Site property ${key} must be a finite number.`);
      params[key] = value;
    }
    const candidate = itemId(object, index);
    const id = items.some((item) => item.id === candidate) ? `${candidate}-${index + 1}` : candidate;
    items.push({
      id,
      kind: mapping.componentKind,
      cell,
      params,
      metadata: {
        source: preview.sourceName,
        importId: preview.importId,
        sourceId: object.sourceId,
        expressId: object.expressId,
        ifcType: object.ifcType,
        properties: object.properties,
        floor: object.storey,
        locationStatus: object.geometry?.origin ? "RESOLVED" : "UNRESOLVED",
        worldPlacement: object.geometry?.origin ?? null,
        builderCellMapping: {
          basis: object.geometry?.origin ? "IFC local placement transformed to IFC world X/Y bounds" : "No IFC placement; stable provisional cell requires review",
          cell,
          planBounds: preview.geometry?.bounds ?? null,
        },
        manufacturer: curated?.manufacturer ?? object.manufacturer,
        model: curated?.model ?? object.model,
        provenance: "IMPORTED",
        mappingBasis: object.mappingBasis,
        confidence: object.confidence,
        ...(curated ? { catalogueProvenance: curated.provenance } : {}),
      },
    });
  }
  return { ...base, items };
}

async function access(deps: ImportRouteDependencies, req: AuthedRequest, res: Response, write = false) {
  const facilityId = safeText(req.params.facilityId, 80), userId = req.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return undefined; }
  await deps.ensureDemoAccess(userId);
  if (write) {
    if (!deps.requireImportAccess) {
      res.status(503).json({ error: "Import authorization is not configured." });
      return undefined;
    }
    if (!await deps.requireImportAccess(userId, facilityId, res)) return undefined;
  } else if (!await deps.requireFacilityAccess(userId, facilityId, res, "view")) return undefined;
  return { facilityId, userId };
}

export function registerImportRoutes(deps: ImportRouteDependencies) {
  const { app, requireAuth, pool } = deps;

  app.get("/api/facilities/:facilityId/imports/catalogue", requireAuth, async (req: AuthedRequest, res: Response) => {
    if (!await access(deps, req, res)) return;
    res.json({ items: CURATED_EQUIPMENT_CATALOGUE });
  });

  app.post("/api/facilities/:facilityId/imports/floorplans", requireAuth, async (req: AuthedRequest, res: Response) => {
    const granted = await access(deps, req, res, true);
    if (!granted) return;
    const name = safeName(req.body?.name), mimeType = safeText(req.body?.mimeType, 80);
    if (!name || !PLAN_MIME.has(mimeType)) return res.status(422).json({ error: "Upload a PDF, PNG, JPEG, or self-contained SVG floor plan." });
    try {
      const content = decodeUpload(req.body?.contentBase64, MAX_BY_MIME[mimeType]);
      verifyPlan(mimeType, content);
      const fileId = randomUUID(), importId = randomUUID(), sha256 = createHash("sha256").update(content).digest("hex");
      const layer: PlanReferenceLayer = {
        id: `plan-${fileId.slice(0, 8)}`, fileId, name, mimeType: mimeType as PlanReferenceLayer["mimeType"],
        grid: { x: 0, z: 0, w: SITE.w, d: SITE.d }, provenance: "IMPORTED", source: name,
      };
      const preview: ImportPreview = { importId, fileId, kind: "FLOORPLAN", sourceName: name, createdAt: new Date().toISOString(), geometry: null, objects: [], limitations: ["Floor plans are visual reference layers. Wattr does not infer assets from drawings; position and verify assets explicitly."] };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO facility_import_files (id, facility_id, uploaded_by, kind, original_name, mime_type, byte_size, sha256, content)
          VALUES ($1,$2,$3,'FLOORPLAN',$4,$5,$6,$7,$8)`, [fileId, granted.facilityId, granted.userId, name, mimeType, content.length, sha256, content]);
        await client.query(`INSERT INTO facility_import_sessions (id, facility_id, file_id, kind, preview, created_by)
          VALUES ($1,$2,$3,'FLOORPLAN',$4::jsonb,$5)`, [importId, granted.facilityId, fileId, JSON.stringify(preview), granted.userId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      res.status(201).json({ preview, referenceLayer: layer });
    } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Unable to accept floor plan." }); }
  });

  app.post("/api/facilities/:facilityId/imports/ifc", requireAuth, async (req: AuthedRequest, res: Response) => {
    const granted = await access(deps, req, res, true);
    if (!granted) return;
    const name = safeName(req.body?.name), mimeType = safeText(req.body?.mimeType, 80);
    if (!name || !IFC_MIME.has(mimeType)) return res.status(422).json({ error: "Upload an IFC ISO-10303-21 STEP file (.ifc)." });
    try {
      const content = decodeUpload(req.body?.contentBase64, MAX_BY_MIME[mimeType]);
      const parsed = parseIfcStep(content.toString("utf8"));
      const fileId = randomUUID(), importId = randomUUID(), sha256 = createHash("sha256").update(content).digest("hex");
      const preview: ImportPreview = { importId, fileId, kind: "IFC", sourceName: name, createdAt: new Date().toISOString(), ...parsed };
      await pool.query(`INSERT INTO facility_import_files (id, facility_id, uploaded_by, kind, original_name, mime_type, byte_size, sha256, content)
        VALUES ($1,$2,$3,'IFC',$4,$5,$6,$7,$8)`, [fileId, granted.facilityId, granted.userId, name, mimeType, content.length, sha256, content]);
      await pool.query(`INSERT INTO facility_import_sessions (id, facility_id, file_id, kind, preview, created_by)
        VALUES ($1,$2,$3,'IFC',$4::jsonb,$5)`, [importId, granted.facilityId, fileId, JSON.stringify(preview), granted.userId]);
      res.status(201).json({ preview });
    } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Unable to parse IFC." }); }
  });

  app.get("/api/facilities/:facilityId/imports/:importId", requireAuth, async (req: AuthedRequest, res: Response) => {
    const granted = await access(deps, req, res);
    if (!granted) return;
    const result = await pool.query("SELECT preview, status, draft_model_version_id FROM facility_import_sessions WHERE id = $1 AND facility_id = $2", [req.params.importId, granted.facilityId]);
    if (!result.rows[0]) return res.status(404).json({ error: "Import review is unavailable." });
    res.json({ preview: result.rows[0].preview, status: result.rows[0].status, draftModelVersionId: result.rows[0].draft_model_version_id });
  });

  app.get("/api/facilities/:facilityId/imports/files/:fileId", requireAuth, async (req: AuthedRequest, res: Response) => {
    const granted = await access(deps, req, res);
    if (!granted) return;
    const result = await pool.query("SELECT original_name, mime_type, content FROM facility_import_files WHERE id = $1 AND facility_id = $2", [req.params.fileId, granted.facilityId]);
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: "Imported file is unavailable." });
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${safeName(file.original_name) || "import"}"`);
    res.type(file.mime_type).send(file.content);
  });

  app.post("/api/facilities/:facilityId/imports/:importId/create-draft", requireAuth, async (req: AuthedRequest, res: Response) => {
    const granted = await access(deps, req, res, true);
    if (!granted) return;
    const result = await pool.query("SELECT s.preview, s.status, s.file_id, f.original_name, f.mime_type FROM facility_import_sessions s JOIN facility_import_files f ON f.id=s.file_id WHERE s.id=$1 AND s.facility_id=$2", [req.params.importId, granted.facilityId]);
    const row = result.rows[0] as { preview: ImportPreview; status: string; file_id: string; original_name: string; mime_type: string } | undefined;
    if (!row) return res.status(404).json({ error: "Import review is unavailable." });
    if (row.status !== "REVIEW") return res.status(409).json({ error: "This import has already created a draft." });
    const mappings = req.body?.mappings;
    if (!Array.isArray(mappings) || mappings.length > 1000 || mappings.some((mapping) =>
      !plainObject(mapping) || typeof mapping.sourceId !== "string" || mapping.sourceId.length > 500 ||
      !["CONFIRM", "MODIFY", "IGNORE"].includes(String(mapping.decision)) ||
      ((mapping.decision === "CONFIRM" || mapping.decision === "MODIFY") && !KINDS.includes(mapping.componentKind as ComponentKind)) ||
      (mapping.componentKind !== null && !KINDS.includes(mapping.componentKind as ComponentKind)) ||
      (mapping.catalogueModelId !== undefined && mapping.catalogueModelId !== null && (typeof mapping.catalogueModelId !== "string" || mapping.catalogueModelId.length > 120)) ||
      (mapping.cell !== undefined && (!plainObject(mapping.cell) || !Number.isFinite(mapping.cell.x) || !Number.isFinite(mapping.cell.z))) ||
      (mapping.siteParams !== undefined && (!plainObject(mapping.siteParams) || Object.keys(mapping.siteParams).length > 12 || Object.values(mapping.siteParams).some((value) => typeof value !== "number" || !Number.isFinite(value))))
    )) {
      return res.status(422).json({ error: "Provide bounded Confirm, Modify, or Ignore decisions for imported objects." });
    }
    try {
      const preview = row.preview;
      if (preview.kind === "IFC") {
        const expected = new Set(preview.objects.map((object) => object.sourceId));
        const supplied = new Set(mappings.map((mapping) => String(mapping.sourceId)));
        if (expected.size !== preview.objects.length || supplied.size !== mappings.length || supplied.size !== expected.size || [...expected].some((sourceId) => !supplied.has(sourceId))) {
          return res.status(422).json({ error: "Every IFC object must receive exactly one Confirm, Modify, or Ignore decision before a draft is created." });
        }
      }
      const published = await deps.publishedModel(granted.facilityId);
      if (!published) return res.status(409).json({ error: "Published facility model is unavailable." });
      let layout: FacilityLayout;
      if (preview.kind === "FLOORPLAN") {
        const layer: PlanReferenceLayer = { id: `plan-${row.file_id.slice(0, 8)}`, fileId: row.file_id, name: row.original_name, mimeType: row.mime_type as PlanReferenceLayer["mimeType"], grid: { x: 0, z: 0, w: SITE.w, d: SITE.d }, provenance: "IMPORTED", source: row.original_name };
        layout = { ...(published.config.layout ?? { zones: [], items: [], connections: [] }), referenceLayers: [...(published.config.layout?.referenceLayers ?? []), layer] };
      } else {
        layout = mapImportToBuilderLayout(published.config.layout ?? { zones: [], items: [], connections: [] }, preview, mappings as ImportMapping[]);
      }
      assertFacilityLayout(layout);
      const id = `build-import-${randomUUID().slice(0, 8)}`;
      const config = { ...published.config, layout: normalizeFacilityLayout(layout), buildName: `Import: ${row.original_name}`, importMetadata: { source: row.original_name, importId: preview.importId, kind: preview.kind, provenance: "IMPORTED" } };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT status FROM facility_import_sessions WHERE id=$1 AND facility_id=$2 FOR UPDATE", [preview.importId, granted.facilityId]);
        if (locked.rows[0]?.status !== "REVIEW") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This import has already created a draft." });
        }
        await client.query("INSERT INTO model_versions (id, facility_id, status, config, created_by) VALUES ($1,$2,'DRAFT',$3::jsonb,$4)", [id, granted.facilityId, JSON.stringify(config), granted.userId]);
        await client.query("UPDATE facility_import_sessions SET status='DRAFT_CREATED', draft_model_version_id=$3 WHERE id=$1 AND facility_id=$2", [preview.importId, granted.facilityId, id]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      res.status(201).json({ id, status: "DRAFT", layout, importId: preview.importId, message: "Import created a Builder draft. Validate and publish it separately to change Operations." });
    } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "The import could not create a valid builder draft." }); }
  });
}