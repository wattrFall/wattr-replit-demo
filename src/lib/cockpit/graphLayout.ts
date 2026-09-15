/**
 * A lineage layout for the thermal graph, in the style of a data-lineage view:
 * each asset is a node, placed in a column by how far heat has travelled from
 * its source, with edges drawn left to right from the workload through racks
 * and cooling to heat rejection.
 *
 * Pure geometry over the graph: no rendering, so it can be tested directly.
 */
import type { ThermalGraphEdge, ThermalGraphNode } from "./workspaces";

export interface LineageMetrics {
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  padding: number;
}

export const LINEAGE_METRICS: LineageMetrics = { nodeWidth: 176, nodeHeight: 62, columnGap: 60, rowGap: 12, padding: 18 };

export interface PlacedNode {
  id: string;
  /** Column: the longest path of heat flow from a source node. */
  layer: number;
  /** Position within the column, top first. */
  row: number;
  x: number;
  y: number;
}

export interface LineageLayout {
  nodes: Map<string, PlacedNode>;
  layers: string[][];
  width: number;
  height: number;
}

/** Order a column by the mean row of each node's neighbours in the adjacent column. */
function byBarycentre(ids: string[], neighbours: Map<string, string[]>, rows: Map<string, number>): string[] {
  const score = (id: string) => {
    const placed = (neighbours.get(id) ?? []).map((other) => rows.get(other)).filter((row): row is number => row !== undefined);
    return placed.length ? placed.reduce((sum, row) => sum + row, 0) / placed.length : rows.get(id) ?? 0;
  };
  return [...ids].sort((a, b) => score(a) - score(b) || (rows.get(a) ?? 0) - (rows.get(b) ?? 0));
}

export function lineageLayout(
  nodes: readonly ThermalGraphNode[],
  edges: readonly ThermalGraphEdge[],
  metrics: LineageMetrics = LINEAGE_METRICS,
): LineageLayout {
  const ids = nodes.map((node) => node.id);
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.get(edge.to)!.push(edge.from);
    outgoing.get(edge.from)!.push(edge.to);
  }

  // Longest path from a source, in topological order. Heat flow has no cycles,
  // but a node left on one is placed after its deepest placed predecessor.
  const layer = new Map(ids.map((id) => [id, 0]));
  const remaining = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  const queue = ids.filter((id) => remaining.get(id) === 0);
  const ordered = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    ordered.add(id);
    for (const next of outgoing.get(id)!) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(id)! + 1));
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  for (const id of ids) {
    if (ordered.has(id)) continue;
    const placed = incoming.get(id)!.filter((other) => ordered.has(other)).map((other) => layer.get(other)! + 1);
    layer.set(id, Math.max(0, ...placed));
  }

  const depth = Math.max(0, ...layer.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of ids) layers[layer.get(id)!].push(id);

  // Two sweeps down and back up reduce edge crossings between columns.
  const rows = () => new Map(layers.flatMap((column) => column.map((id, row) => [id, row] as [string, number])));
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let column = 1; column <= depth; column++) layers[column] = byBarycentre(layers[column], incoming, rows());
    for (let column = depth - 1; column >= 0; column--) layers[column] = byBarycentre(layers[column], outgoing, rows());
  }

  const { nodeWidth, nodeHeight, columnGap, rowGap, padding } = metrics;
  const tallest = Math.max(1, ...layers.map((column) => column.length));
  const columnHeight = (count: number) => count * nodeHeight + Math.max(0, count - 1) * rowGap;
  const height = padding * 2 + columnHeight(tallest);
  const width = padding * 2 + (depth + 1) * nodeWidth + depth * columnGap;
  const placed = new Map<string, PlacedNode>();
  layers.forEach((column, index) => {
    // Shorter columns are centred against the tallest one.
    const top = padding + (columnHeight(tallest) - columnHeight(column.length)) / 2;
    column.forEach((id, row) => {
      placed.set(id, { id, layer: index, row, x: padding + index * (nodeWidth + columnGap), y: top + row * (nodeHeight + rowGap) });
    });
  });
  return { nodes: placed, layers, width, height };
}

/** A smooth left-to-right edge from the right side of one node to the left side of the next. */
export function lineageEdgePath(from: PlacedNode, to: PlacedNode, metrics: LineageMetrics = LINEAGE_METRICS): string {
  const x1 = from.x + metrics.nodeWidth;
  const y1 = from.y + metrics.nodeHeight / 2;
  const x2 = to.x;
  const y2 = to.y + metrics.nodeHeight / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** Blue when cool, through teal and amber, to red at and beyond the limit. */
export const HEAT_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, "#3b82f6"],
  [0.55, "#14b8a6"],
  [0.82, "#f59e0b"],
  [1, "#ef4444"],
];

const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);

/** The colour for a heat reading, where 1 is at the node's limit or capacity. */
export function heatTone(heat: number): string {
  const value = Math.max(0, Math.min(1, heat));
  const upper = HEAT_STOPS.findIndex(([stop]) => stop >= value);
  if (upper <= 0) return HEAT_STOPS[0][1];
  const [lowAt, lowHex] = HEAT_STOPS[upper - 1];
  const [highAt, highHex] = HEAT_STOPS[upper];
  const t = (value - lowAt) / (highAt - lowAt);
  const mixed = [1, 3, 5].map((at) => Math.round(channel(lowHex, at) + (channel(highHex, at) - channel(lowHex, at)) * t));
  return `#${mixed.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** The legend gradient, built from the same stops the nodes use. */
export const HEAT_GRADIENT = `linear-gradient(90deg, ${HEAT_STOPS.map(([stop, hex]) => `${hex} ${Math.round(stop * 100)}%`).join(", ")})`;
