import { SITE } from "../sandbox/geometry";
import type { ImportedObject, ImportPreview } from "./types";

/** Shared preview/commit calibration; IFC X/Y is the horizontal plane. */
export function mappedWorldCell(object: ImportedObject, preview: ImportPreview, fallback = 0) {
  const origin = object.geometry?.origin;
  const bounds = preview.geometry?.bounds;
  if (origin && bounds) {
    const scale = (value: number, min: number, max: number, size: number) =>
      max > min ? Math.max(0, Math.min(size - 1, Math.round(((value - min) / (max - min)) * (size - 1)))) : Math.floor(size / 2);
    return { x: scale(origin[0], bounds.min[0], bounds.max[0], SITE.w), z: scale(origin[1], bounds.min[1], bounds.max[1], SITE.d) };
  }
  const hash = [...object.sourceId].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, fallback);
  return { x: hash % SITE.w, z: Math.floor(hash / SITE.w) % SITE.d };
}