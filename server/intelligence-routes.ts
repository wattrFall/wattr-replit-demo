/**
 * Read-only facility intelligence APIs.
 *
 * Route registration is dependency-injected so index.ts remains the sole
 * authentication/bootstrap owner. Every route checks the established facility
 * grant before exposing model-derived inventory or simulated telemetry.
 */
import type { Request, RequestHandler, Response } from "express";
import type pg from "pg";
import {
  findIntelligenceAsset,
  resolveFacilityIntelligence,
  searchableAssetText,
  type IntelligenceAsset,
  type IntelligenceMetric,
  type ModelAssetAnnotation,
} from "../src/lib/intelligence/facilityModel";
import {
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  type CockpitSnapshot,
  type FacilityModelConfig,
} from "../src/lib/cockpit/simulation";
import type { Capability } from "../src/lib/security/rolePolicy";

type IntelligenceRequest = Request & { userId?: string };
type FacilityPermission = { organization_id?: string; role?: string; is_owner?: boolean };
type PublishedModel = { model_version: string; config: FacilityModelConfig };

export type IntelligenceRouteDependencies = {
  app: { get: (path: string, ...handlers: RequestHandler[]) => unknown };
  pool: Pick<pg.Pool, "query">;
  requireAuth: RequestHandler;
  ensureDemoAccess: (userId: string) => Promise<void>;
  requireFacilityAccess: (
    userId: string,
    facilityId: string,
    response: Response,
    capability?: Capability,
  ) => Promise<FacilityPermission | undefined>;
  publishedModel: (facilityId: string, client?: pg.Pool | pg.PoolClient) => Promise<PublishedModel | undefined>;
  replaySnapshot: (simulatedAt: number, config?: FacilityModelConfig) => CockpitSnapshot;
};

type TelemetryPoint = {
  assetId: string;
  assetName: string;
  simulatedAt: number;
  metric: IntelligenceMetric;
  value: number;
  unit: string;
  provenance: "SIMULATED";
  source: string;
};

type MetricContribution = {
  assetId: string;
  assetName: string;
  value: number;
  unit: string;
};

const METRICS: Record<IntelligenceMetric, { unit: string; label: string }> = {
  rack_power_kw: { unit: "kW", label: "Rack power" },
  rack_inlet_temperature_c: { unit: "°C", label: "Rack inlet temperature" },
  cooling_fan_percent: { unit: "%", label: "Cooling fan / pump command" },
};

function queryValue(value: unknown, maximum = 160) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function replayTime(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < SCENARIO_START_S || parsed > SCENARIO_START_S + SCENARIO_DURATION_S) {
    return fallback;
  }
  return parsed;
}

function telemetryValue(asset: IntelligenceAsset, metric: IntelligenceMetric, snapshot: CockpitSnapshot): number | undefined {
  if (metric === "rack_power_kw" || metric === "rack_inlet_temperature_c") {
    const rack = snapshot.racks.find((candidate) => candidate.id === asset.twinSelectionId);
    if (!rack) return undefined;
    return metric === "rack_power_kw" ? rack.heatKw : rack.inletC;
  }
  if (metric === "cooling_fan_percent" && (asset.componentKind === "cdu" || asset.componentKind === "crac")) {
    return snapshot.fanPercent;
  }
  return undefined;
}

function assetsInScope(assets: readonly IntelligenceAsset[], floor: string, zone: string) {
  return assets.filter((asset) => (!floor || asset.location.floorId === floor) && (!zone || asset.location.zoneId === zone));
}

function contributionsFor(
  assets: readonly IntelligenceAsset[],
  metric: IntelligenceMetric,
  snapshot: CockpitSnapshot,
): MetricContribution[] {
  return assets.flatMap((asset) => {
    if (!asset.metrics.includes(metric)) return [];
    const value = telemetryValue(asset, metric, snapshot);
    return value === undefined ? [] : [{
      assetId: asset.id,
      assetName: asset.name,
      value: Math.round(value * 100) / 100,
      unit: METRICS[metric].unit,
    }];
  });
}

export function aggregateMetricContributions(metric: IntelligenceMetric, contributions: readonly MetricContribution[]) {
  const values = contributions.map((item) => item.value);
  const method = metric === "rack_inlet_temperature_c" ? "MAX" : metric === "cooling_fan_percent" ? "AVERAGE" : "SUM";
  const value = !values.length ? null : method === "MAX"
    ? Math.max(...values)
    : method === "AVERAGE"
      ? values.reduce((sum, item) => sum + item, 0) / values.length
      : values.reduce((sum, item) => sum + item, 0);
  return {
    value: value === null ? null : Math.round(value * 100) / 100,
    unit: METRICS[metric].unit,
    aggregation: method,
    contributingAssetCount: contributions.length,
  };
}

function simulatedSeries(
  asset: IntelligenceAsset,
  metric: IntelligenceMetric,
  focusAt: number,
  replaySnapshot: IntelligenceRouteDependencies["replaySnapshot"],
  config: FacilityModelConfig,
) {
  const first = Math.max(SCENARIO_START_S, focusAt - 900);
  const last = Math.min(SCENARIO_START_S + SCENARIO_DURATION_S, focusAt + 900);
  const points: TelemetryPoint[] = [];
  for (let at = first; at <= last; at += 120) {
    const value = telemetryValue(asset, metric, replaySnapshot(at, config));
    if (value !== undefined) {
      points.push({
        assetId: asset.id,
        assetName: asset.name,
        simulatedAt: at,
        metric,
        value: Math.round(value * 100) / 100,
        unit: METRICS[metric].unit,
        provenance: "SIMULATED",
        source: "Deterministic published-model replay; not measured telemetry",
      });
    }
  }
  return points;
}

async function annotationsFor(
  pool: IntelligenceRouteDependencies["pool"],
  facilityId: string,
  modelVersionId: string,
): Promise<ModelAssetAnnotation[]> {
  const result = await pool.query(
    `SELECT layout_asset_id, manufacturer, model, location_status, source_metadata, provenance
     FROM intelligence_asset_annotations
     WHERE facility_id = $1 AND model_version_id = $2`,
    [facilityId, modelVersionId],
  );
  return result.rows.flatMap((row): ModelAssetAnnotation[] => {
    if (!row || typeof row !== "object" || typeof row.layout_asset_id !== "string") return [];
    const sourceMetadata = row.source_metadata && typeof row.source_metadata === "object" && !Array.isArray(row.source_metadata)
      ? row.source_metadata as Record<string, unknown>
      : {};
    return [{
      layout_asset_id: row.layout_asset_id,
      manufacturer: typeof row.manufacturer === "string" ? row.manufacturer : null,
      model: typeof row.model === "string" ? row.model : null,
      location_status: row.location_status === "UNRESOLVED" ? "UNRESOLVED" : "RESOLVED",
      source_metadata: sourceMetadata,
      provenance: row.provenance === "SIMULATED" || row.provenance === "CURATED" ? row.provenance : "IMPORTED",
    }];
  });
}

async function modelForAuthorizedRequest(
  deps: IntelligenceRouteDependencies,
  req: IntelligenceRequest,
  res: Response,
) {
  const facilityId = String(req.params.facilityId);
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return undefined;
  }
  await deps.ensureDemoAccess(userId);
  if (!await deps.requireFacilityAccess(userId, facilityId, res, "view")) return undefined;
  const model = await deps.publishedModel(facilityId);
  if (!model) {
    res.status(409).json({ error: "Published facility model is unavailable" });
    return undefined;
  }
  const annotations = await annotationsFor(deps.pool, facilityId, model.model_version);
  return { facilityId, model, projection: resolveFacilityIntelligence(model.config, annotations) };
}

export function registerIntelligenceRoutes(deps: IntelligenceRouteDependencies) {
  const { app, requireAuth } = deps;

  app.get("/api/facilities/:facilityId/intelligence/hierarchy", requireAuth, async (req: IntelligenceRequest, res: Response) => {
    const context = await modelForAuthorizedRequest(deps, req, res);
    if (!context) return;
    res.json({
      modelVersionId: context.model.model_version,
      hierarchy: context.projection.hierarchy,
      provenance: { kind: "SIMULATED", source: "Active published model layout" },
    });
  });

  app.get("/api/facilities/:facilityId/intelligence/assets", requireAuth, async (req: IntelligenceRequest, res: Response) => {
    const context = await modelForAuthorizedRequest(deps, req, res);
    if (!context) return;
    const search = queryValue(req.query.search).toLocaleLowerCase();
    const floor = queryValue(req.query.floor);
    const zone = queryValue(req.query.zone);
    const metric = queryValue(req.query.metric) as IntelligenceMetric;
    const assets = assetsInScope(context.projection.assets, floor, zone)
      .filter((asset) => !search || searchableAssetText(asset).includes(search));
    res.json({
      modelVersionId: context.model.model_version,
      simulatedAt: replayTime(req.query.at, SCENARIO_START_S),
      selectedMetric: METRICS[metric] ? metric : null,
      assets,
      count: assets.length,
    });
  });

  app.get("/api/facilities/:facilityId/intelligence/metrics", requireAuth, async (req: IntelligenceRequest, res: Response) => {
    const context = await modelForAuthorizedRequest(deps, req, res);
    if (!context) return;
    const metric = queryValue(req.query.metric) as IntelligenceMetric;
    if (!METRICS[metric]) return res.status(422).json({ error: "A supported metric is required" });
    const floor = queryValue(req.query.floor);
    const zone = queryValue(req.query.zone);
    const simulatedAt = replayTime(req.query.at, SCENARIO_START_S);
    const inScope = assetsInScope(context.projection.assets, floor, zone);
    const contributions = contributionsFor(inScope, metric, deps.replaySnapshot(simulatedAt, context.model.config));
    res.json({
      modelVersionId: context.model.model_version,
      simulatedAt,
      metric,
      label: METRICS[metric].label,
      scope: { floor: floor || null, zone: zone || null, assetCount: inScope.length },
      aggregate: aggregateMetricContributions(metric, contributions),
      contributions,
      source: "Deterministic published-model replay; not measured telemetry",
    });
  });

  app.get("/api/facilities/:facilityId/intelligence/assets/:assetId", requireAuth, async (req: IntelligenceRequest, res: Response) => {
    const context = await modelForAuthorizedRequest(deps, req, res);
    if (!context) return;
    const asset = findIntelligenceAsset(context.projection.assets, String(req.params.assetId));
    if (!asset) return res.status(404).json({ error: "Asset unavailable in the active published model" });
    const at = replayTime(req.query.at, SCENARIO_START_S);
    const requestedMetric = queryValue(req.query.metric) as IntelligenceMetric;
    const snapshot = deps.replaySnapshot(at, context.model.config);
    const current = asset.metrics.flatMap((metric) => {
      const value = telemetryValue(asset, metric, snapshot);
      return value === undefined ? [] : [{
        metric,
        label: METRICS[metric].label,
        value: Math.round(value * 100) / 100,
        unit: METRICS[metric].unit,
        provenance: "SIMULATED" as const,
        source: "Deterministic published-model replay; not measured telemetry",
      }];
    });
    res.json({
      modelVersionId: context.model.model_version,
      simulatedAt: at,
      asset,
      selectedMetric: asset.metrics.includes(requestedMetric) ? requestedMetric : null,
      currentTelemetry: current,
      unresolvedLocation: asset.location.status === "UNRESOLVED",
    });
  });

  app.get("/api/facilities/:facilityId/intelligence/telemetry", requireAuth, async (req: IntelligenceRequest, res: Response) => {
    const context = await modelForAuthorizedRequest(deps, req, res);
    if (!context) return;
    const requestedMetric = queryValue(req.query.metric) as IntelligenceMetric;
    const assetId = queryValue(req.query.assetId);
    const metric = requestedMetric;
    if (!metric || !METRICS[metric]) {
      return res.status(422).json({ error: "A supported metric is required" });
    }
    const asset = assetId ? findIntelligenceAsset(context.projection.assets, assetId) : undefined;
    if (asset && !asset.metrics.includes(metric)) {
      return res.status(422).json({ error: "This metric is not supported by the selected asset model" });
    }
    const simulatedAt = replayTime(req.query.at, SCENARIO_START_S);
    if (!assetId) {
      const floor = queryValue(req.query.floor);
      const zone = queryValue(req.query.zone);
      const contributions = contributionsFor(
        assetsInScope(context.projection.assets, floor, zone),
        metric,
        deps.replaySnapshot(simulatedAt, context.model.config),
      );
      return res.json({
        modelVersionId: context.model.model_version,
        assetId: null,
        metric,
        label: METRICS[metric].label,
        simulated: true,
        mode: "scope_snapshot",
        source: "Deterministic published-model replay; not measured telemetry",
        points: contributions.map((item) => ({
          ...item,
          simulatedAt,
          metric,
          provenance: "SIMULATED" as const,
          source: "Deterministic published-model replay; not measured telemetry",
        })),
      });
    }
    if (!asset) return res.status(404).json({ error: "Asset unavailable in the active published model" });
    res.json({
      modelVersionId: context.model.model_version,
      assetId: asset.id,
      metric,
      label: METRICS[metric].label,
      simulated: true,
      mode: "asset_series",
      source: "Deterministic published-model replay; not measured telemetry",
      points: simulatedSeries(asset, metric, simulatedAt, deps.replaySnapshot, context.model.config),
    });
  });
}