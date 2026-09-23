import type { ComponentKind } from "@/lib/sandbox/types";
import type { ImportGeometry, ImportedObject } from "./types";

type StepEntity = { id: number; type: string; args: string; strings: string[] };

const EQUIPMENT_TYPES: Record<string, { kind: ComponentKind; basis: string }> = {
  IFCUNITARYEQUIPMENT: { kind: "crac", basis: "IfcUnitaryEquipment maps to cooling equipment." },
  IFCAIRTERMINALBOX: { kind: "crac", basis: "IfcAirTerminalBox maps to cooling equipment." },
  IFCFLOWCONTROLLER: { kind: "cdu", basis: "IfcFlowController maps to a coolant distribution unit." },
  IFCCHILLER: { kind: "chiller", basis: "IfcChiller maps directly to a chiller." },
  IFCENERGYCONVERSIONDEVICE: { kind: "chiller", basis: "IfcEnergyConversionDevice maps to plant equipment; verify subtype." },
  IFCSERVER: { kind: "rack", basis: "IfcServer maps to a rack/load representation." },
  IFCFURNISHINGELEMENT: { kind: "rack", basis: "IfcFurnishingElement may represent a rack; verify before commit." },
};

function unescapeIfc(value: string) {
  return value.replace(/''/g, "'").replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
    try { return String.fromCharCode(...(hex.match(/.{1,4}/g) ?? []).map((code: string) => Number.parseInt(code, 16))); } catch { return value; }
  });
}

/** Parse ISO-10303-21 records, preserving entity ids and quoted IFC values. */
function entitiesFrom(text: string): StepEntity[] {
  const entities: StepEntity[] = [];
  const matcher = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of text.matchAll(matcher)) {
    const args = match[3];
    const strings = [...args.matchAll(/'((?:''|[^'])*)'/g)].map((item) => unescapeIfc(item[1]).slice(0, 500));
    entities.push({ id: Number(match[1]), type: match[2].toUpperCase(), args, strings });
  }
  return entities;
}

function pointsFrom(entities: readonly StepEntity[]) {
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (const entity of entities) {
    if (entity.type !== "IFCCARTESIANPOINT") continue;
    const coordinateList = entity.args.match(/\(([-+\d.Ee,\s]+)\)/)?.[1];
    if (!coordinateList) continue;
    const values = coordinateList.split(",").map(Number);
    if (values.length < 2 || values.some((value) => !Number.isFinite(value))) continue;
    points.push({ x: values[0], y: values[1] ?? 0, z: values[2] ?? 0 });
  }
  return points.slice(0, 4000);
}

function geometryFor(points: Array<{ x: number; y: number; z: number }>, units: string | null): ImportGeometry | null {
  if (!points.length) return null;
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y), zs = points.map((point) => point.z);
  return {
    units,
    points: points.slice(0, 300),
    bounds: { min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] },
  };
}

type Matrix = [[number, number, number], [number, number, number], [number, number, number]];
type Transform = { origin: [number, number, number]; axes: Matrix };
const identity: Matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const dot = (matrix: Matrix, vector: [number, number, number]): [number, number, number] => [
  matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
  matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
  matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
];
const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (value: [number, number, number]): [number, number, number] => {
  const length = Math.hypot(...value);
  return length > 0 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1];
};
const ids = (args: string) => [...args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
/** Split a STEP argument list without losing positional `$` nulls. */
function stepArguments(args: string) {
  const parts: string[] = [];
  let start = 0;
  let depth = 0, quoted = false;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === "'") {
      if (quoted && args[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")") depth -= 1;
    else if (!quoted && char === "," && depth === 0) { parts.push(args.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(args.slice(start).trim());
  return parts;
}
const stepRef = (value: string | undefined) => value?.match(/^#(\d+)$/)?.[1] ? Number(value.slice(1)) : undefined;

/**
 * Build world transforms for IfcLocalPlacement chains. This handles the common
 * Axis2Placement3D translation/rotation form; unsupported swept/BRep geometry
 * stays explicitly preview-only rather than being silently shown at its local
 * origin.
 */
function localPlacements(entities: readonly StepEntity[]) {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const points = new Map<number, [number, number, number]>();
  const directions = new Map<number, [number, number, number]>();
  for (const entity of entities) {
    const values = entity.args.match(/\(([-+\d.Ee,\s]+)\)/)?.[1]?.split(",").map(Number);
    if (!values || values.some((value) => !Number.isFinite(value))) continue;
    if (entity.type === "IFCCARTESIANPOINT") points.set(entity.id, [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0]);
    if (entity.type === "IFCDIRECTION") directions.set(entity.id, [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0]);
  }
  const resolveAxis = (axisId: number | undefined): Transform => {
    const axis = axisId === undefined ? undefined : entityById.get(axisId);
    if (!axis || (axis.type !== "IFCAXIS2PLACEMENT3D" && axis.type !== "IFCAXIS2PLACEMENT2D")) return { origin: [0, 0, 0], axes: identity };
    const args = stepArguments(axis.args), origin = points.get(stepRef(args[0]) ?? -1) ?? [0, 0, 0];
    if (axis.type === "IFCAXIS2PLACEMENT2D") return { origin, axes: identity };
    const z = normalize(directions.get(stepRef(args[1]) ?? -1) ?? [0, 0, 1]);
    const x = normalize(directions.get(stepRef(args[2]) ?? -1) ?? [1, 0, 0]);
    const y = normalize(cross(z, x));
    return { origin, axes: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]] };
  };
  const resolved = new Map<number, Transform>();
  const resolving = new Set<number>();
  const resolve = (placementId: number): Transform => {
    if (resolved.has(placementId)) return resolved.get(placementId)!;
    if (resolving.has(placementId)) return { origin: [0, 0, 0], axes: identity };
    resolving.add(placementId);
    const placement = entityById.get(placementId);
    if (!placement || placement.type !== "IFCLOCALPLACEMENT") return { origin: [0, 0, 0], axes: identity };
    const args = stepArguments(placement.args), parentId = stepRef(args[0]), local = resolveAxis(stepRef(args[1]));
    const parent = parentId && entityById.get(parentId)?.type === "IFCLOCALPLACEMENT" ? resolve(parentId) : { origin: [0, 0, 0] as [number, number, number], axes: identity };
    const offset = dot(parent.axes, local.origin);
    const c0 = dot(parent.axes, [local.axes[0][0], local.axes[1][0], local.axes[2][0]]);
    const c1 = dot(parent.axes, [local.axes[0][1], local.axes[1][1], local.axes[2][1]]);
    const c2 = dot(parent.axes, [local.axes[0][2], local.axes[1][2], local.axes[2][2]]);
    const axes: Matrix = [[c0[0], c1[0], c2[0]], [c0[1], c1[1], c2[1]], [c0[2], c1[2], c2[2]]];
    const transform = { origin: [parent.origin[0] + offset[0], parent.origin[1] + offset[1], parent.origin[2] + offset[2]] as [number, number, number], axes };
    resolving.delete(placementId); resolved.set(placementId, transform);
    return transform;
  };
  const placements = new Map<number, Transform>();
  for (const entity of entities) if (entity.type === "IFCLOCALPLACEMENT") placements.set(entity.id, resolve(entity.id));
  return placements;
}

function propertyValues(entities: readonly StepEntity[]) {
  const values = new Map<number, Record<string, string | number | boolean>>();
  for (const entity of entities) {
    if (entity.type !== "IFCPROPERTYSINGLEVALUE" || entity.strings.length < 1) continue;
    const literal = entity.args.match(/IFC(?:LABEL|TEXT|IDENTIFIER|BOOLEAN|REAL|INTEGER)\s*\(\s*'?([^')]+)'?\s*\)/i)?.[1];
    const value: string | number | boolean = literal === "TRUE" ? true : literal === "FALSE" ? false :
      literal !== undefined && Number.isFinite(Number(literal)) && literal.trim() !== "" ? Number(literal) : literal ?? "present";
    values.set(entity.id, { [entity.strings[0]]: value });
  }
  return values;
}

/** Follow the standard property-set relation instead of assuming props are inline. */
function propertiesByObject(entities: readonly StepEntity[], values: ReadonlyMap<number, Record<string, string | number | boolean>>) {
  const setProperties = new Map<number, Record<string, string | number | boolean>>();
  for (const entity of entities) {
    if (entity.type !== "IFCPROPERTYSET") continue;
    const ids = [...entity.args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    setProperties.set(entity.id, Object.assign({}, ...ids.map((id) => values.get(id) ?? {})));
  }
  const result = new Map<number, Record<string, string | number | boolean>>();
  for (const entity of entities) {
    if (entity.type !== "IFCRELDEFINESBYPROPERTIES") continue;
    const ids = [...entity.args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    const propertySet = [...ids].reverse().map((id) => setProperties.get(id)).find(Boolean);
    if (!propertySet) continue;
    for (const id of ids) {
      if (setProperties.has(id)) continue;
      result.set(id, { ...(result.get(id) ?? {}), ...propertySet });
    }
  }
  return result;
}

function storeysByObject(entities: readonly StepEntity[]) {
  const names = new Map(entities.filter((entity) => entity.type === "IFCBUILDINGSTOREY").map((entity) =>
    [entity.id, entity.strings[1]?.trim() || entity.strings[0]?.trim() || `Storey #${entity.id}`],
  ));
  const result = new Map<number, string>();
  for (const entity of entities) {
    if (entity.type !== "IFCRELCONTAINEDINSPATIALSTRUCTURE") continue;
    const ids = [...entity.args.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    const storeyId = [...ids].reverse().find((id) => names.has(id));
    if (!storeyId) continue;
    for (const id of ids) if (id !== storeyId) result.set(id, names.get(storeyId)!);
  }
  return result;
}

function sourceIdentifier(entity: StepEntity) {
  return entity.strings[0]?.trim() || `ifc-${entity.id}`;
}

function inferred(entity: StepEntity) {
  const direct = EQUIPMENT_TYPES[entity.type];
  if (direct) return { ...direct, confidence: entity.type === "IFCFURNISHINGELEMENT" ? "MEDIUM" as const : "HIGH" as const };
  if (/RACK|CABINET/i.test(entity.strings.join(" "))) return { kind: "rack" as const, basis: "Name contains rack/cabinet; verify before commit.", confidence: "MEDIUM" as const };
  return { kind: null, basis: `No safe Wattr mapping is defined for ${entity.type}.`, confidence: "UNRESOLVED" as const };
}

/**
 * Ingest an IFC STEP (ISO-10303-21) exchange file. IFCZIP and binary formats
 * are deliberately rejected: they need an extraction/geometry service, not a
 * silent partial conversion in the browser/API process.
 */
export function parseIfcStep(input: string): { objects: ImportedObject[]; geometry: ImportGeometry | null; limitations: string[] } {
  if (!/ISO-10303-21/i.test(input) || !/DATA\s*;/i.test(input)) {
    throw new Error("This is not an IFC ISO-10303-21 STEP file. IFCZIP and binary IFC are not supported in this MVP.");
  }
  const entities = entitiesFrom(input);
  if (!entities.length) throw new Error("The IFC file contains no readable STEP entities.");
  const lengthUnit = entities.find((entity) => entity.type === "IFCSIUNIT" && /LENGTHUNIT/i.test(entity.args));
  const units = lengthUnit
    ? /MILLI/i.test(lengthUnit.args) ? "millimetre" : /CENTI/i.test(lengthUnit.args) ? "centimetre" : /METRE/i.test(lengthUnit.args) ? "metre" : "SI length unit"
    : entities.find((entity) => entity.type === "IFCCONVERSIONBASEDUNIT" && /LENGTHUNIT/i.test(entity.args))?.strings[1] ?? null;
  const placementMap = localPlacements(entities);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const geometry = geometryFor(
    placementMap.size ? [...placementMap.values()].map((placement) => ({ x: placement.origin[0], y: placement.origin[1], z: placement.origin[2] })) : pointsFrom(entities),
    units,
  );
  const propValues = propertyValues(entities);
  const props = propertiesByObject(entities, propValues);
  const storeysById = storeysByObject(entities);
  const storeys = entities.filter((entity) => entity.type === "IFCBUILDINGSTOREY");
  const storeyName = storeys[0]?.strings[1] ?? storeys[0]?.strings[0] ?? null;
  const objectTypes = new Set([...Object.keys(EQUIPMENT_TYPES), "IFCSPACE", "IFCBUILDINGELEMENTPROXY"]);
  const objects = entities.filter((entity) => objectTypes.has(entity.type)).slice(0, 1000).map((entity): ImportedObject => {
    const mapping = inferred(entity);
    const properties = props.get(entity.id) ?? {};
    const productRefs = ids(entity.args);
    const placementId = productRefs.find((id) => placementMap.has(id));
    const placement = placementId === undefined ? undefined : placementMap.get(placementId);
    const representationId = placementId === undefined ? undefined : productRefs.slice(productRefs.indexOf(placementId) + 1)
      .find((id) => entityById.get(id)?.type.includes("REPRESENTATION"));
    const representation = representationId === undefined ? undefined : entityById.get(representationId);
    const allText = `${entity.strings.join(" ")} ${Object.values(properties).join(" ")}`;
    const manufacturer = /(?:manufacturer|vendor)\s*[:=]\s*([^,;]+)/i.exec(allText)?.[1]?.trim() ?? null;
    const model = /(?:model|type)\s*[:=]\s*([^,;]+)/i.exec(allText)?.[1]?.trim() ?? null;
    return {
      sourceId: sourceIdentifier(entity),
      expressId: entity.id,
      ifcType: entity.type,
      name: entity.strings[1]?.trim() || entity.strings[0]?.trim() || `${entity.type} #${entity.id}`,
      properties,
      manufacturer,
      model,
      storey: storeysById.get(entity.id) ?? storeyName,
      geometry: placement
        ? {
            ...geometryFor([{ x: placement.origin[0], y: placement.origin[1], z: placement.origin[2] }], units)!,
            origin: placement.origin, placementId, representationId, representationType: representation?.type,
          }
        : null,
      inferredKind: mapping.kind,
      confidence: mapping.confidence,
      mappingBasis: mapping.basis,
    };
  });
  return {
    objects,
    geometry,
    limitations: [
      placementMap.size
        ? "Preview derives world-space object origins through IfcLocalPlacement parent transforms; it is not a full IFC mesh renderer."
        : "No IfcLocalPlacement records were found, so preview bounds use unassociated cartesian points and should not be used for placement.",
      "Storey assignment is retained when available, but complex containment relationships may need manual verification.",
      "IFCZIP, binary IFC, native Revit, and geometry that requires BRep/tessellation/swept-solid evaluation are not supported in this preview. Product representation references are retained for a later geometry service; export IFC STEP from the authoring system.",
    ],
  };
}