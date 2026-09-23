import type { ComponentKind } from "@/lib/sandbox/types";

export type ImportKind = "FLOORPLAN" | "IFC";
/** PENDING is client-only; the API refuses it when creating a draft. */
export type ImportDecision = "PENDING" | "CONFIRM" | "MODIFY" | "IGNORE";

export type PlanReferenceLayer = {
  id: string;
  fileId: string;
  name: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg" | "image/svg+xml";
  /** Grid-space reference: item cells retain their normal site coordinates. */
  grid: { x: number; z: number; w: number; d: number };
  provenance: "IMPORTED";
  source: string;
};

export type ImportGeometry = {
  /** IFC project units are retained rather than being assumed to be metres. */
  units: string | null;
  points: Array<{ x: number; y: number; z: number }>;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** World-space object origin derived through IfcLocalPlacement parents. */
  origin?: [number, number, number];
  placementId?: number;
  /** IFC representation reference is retained even when its mesh is unsupported. */
  representationId?: number;
  representationType?: string;
};

export type ImportedObject = {
  sourceId: string;
  expressId: number | null;
  ifcType: string;
  name: string;
  properties: Record<string, string | number | boolean>;
  manufacturer: string | null;
  model: string | null;
  storey: string | null;
  geometry: ImportGeometry | null;
  inferredKind: ComponentKind | null;
  confidence: "HIGH" | "MEDIUM" | "UNRESOLVED";
  mappingBasis: string;
};

export type ImportMapping = {
  sourceId: string;
  decision: ImportDecision;
  componentKind: ComponentKind | null;
  name?: string;
  catalogueModelId?: string | null;
  cell?: { x: number; z: number };
  /** Explicit site values override curated catalogue defaults. */
  siteParams?: Record<string, number>;
};

export type ImportPreview = {
  importId: string;
  fileId: string;
  kind: ImportKind;
  sourceName: string;
  createdAt: string;
  geometry: ImportGeometry | null;
  objects: ImportedObject[];
  limitations: string[];
};