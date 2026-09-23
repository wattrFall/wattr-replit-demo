/**
 * The thermal graph as a lineage view.
 *
 * Every asset is a node and every edge a path heat travels, left to right from
 * the workload through racks and cooling to heat rejection. Nodes are tinted
 * from blue to red by the heat they hold, so an operator can see where the heat
 * is at a glance. Clicking a node expands it to show its readings, what feeds
 * it, where its heat goes, and what would be lost if it failed.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowDown, ArrowUp, Flame, ShieldAlert, X } from "lucide-react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  HEAT_GRADIENT,
  LINEAGE_METRICS,
  heatTone,
  lineageEdgePath,
  lineageLayout,
} from "@/lib/cockpit/graphLayout";
import { recordLearningEvent } from "@/lib/cockpit/learning";
import { formatSimulatedAt, useScenarioSession } from "@/lib/cockpit/session";
import type { CockpitSnapshot } from "@/lib/cockpit/simulation";
import { graphSelection, thermalGraph, type GraphView, type ThermalGraphNode } from "@/lib/cockpit/workspaces";
import { navigate } from "./api";
import { ReplayBar, Shell } from "./Shell";
import type { Facility, SessionData } from "./types";
import { PageHead, Segmented, Status } from "./ui";

const VIEWS: ReadonlyArray<readonly [GraphView, string]> = [
  ["current", "Current heat"],
  ["forecast", "Forecast heat"],
  ["topology", "Topology only"],
];

/** The expanded card's width beside a node. */
const DETAIL_WIDTH = 300;
/** Below this panel width the expanded card opens beneath the graph instead of beside the node. */
const SHEET_BELOW = 760;
/** A wide graph shrinks to fit its panel down to this scale, then scrolls sideways. */
const MIN_SCALE = 0.72;

const heatState = (heat: number) => heat >= 1 ? "At or over limit" : heat >= 0.82 ? "Hot" : heat >= 0.55 ? "Warm" : "Cool";
const heatStatus = (heat: number): "good" | "warn" | "bad" => heat >= 1 ? "bad" : heat >= 0.82 ? "warn" : "good";
const percent = (heat: number) => `${Math.round(heat * 100)}%`;
const kw = (value: number) => `${Math.round(value).toLocaleString()} kW`;
const toned = (heat: number | undefined) => (heat === undefined ? {} : { "--node-heat": heatTone(heat) }) as CSSProperties;

type Selection = ReturnType<typeof graphSelection>;

/** What would be lost if a node failed, in plain terms. */
function contingency(node: ThermalGraphNode, impact: ThermalGraphNode[], snapshot: CockpitSnapshot): string {
  if (node.kind === "workload") {
    return `Shedding this workload would take ${kw(snapshot.itPowerKw)} of heat off ${snapshot.rackCount} racks.`;
  }
  if (node.kind === "rack") {
    const rack = snapshot.racks.find((item) => item.id === node.id);
    return `If ${node.label} trips, its ${kw(rack?.heatKw ?? 0)} of IT load is lost; the cooling it shares keeps serving the other racks.`;
  }
  if (!impact.length) return `No racks depend on ${node.label} in the modeled graph.`;
  const heatKw = impact.reduce((sum, rack) => sum + (snapshot.racks.find((item) => item.id === rack.id)?.heatKw ?? 0), 0);
  return `If ${node.label} fails, ${impact.length} ${impact.length === 1 ? "rack" : "racks"} carrying ${kw(heatKw)} lose cooling: ${impact.map((rack) => rack.id).join(", ")}.`;
}

/** The width available to the graph, so a wide graph can shrink to fit. */
function useAvailableWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Measured straight away as well: resize notifications only arrive once the page renders.
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function NodeDetail({ node, related, snapshot, facilityId, detailId, detailRef, position, onClose }: {
  node: ThermalGraphNode;
  related: Selection;
  snapshot: CockpitSnapshot;
  facilityId: string;
  detailId: string;
  detailRef: RefObject<HTMLDivElement>;
  /** Where the card sits beside its node, or null to open beneath the graph. */
  position: { left: number; top: number; fromRight: boolean } | null;
  onClose: () => void;
}) {
  return <div
    id={detailId}
    ref={detailRef}
    tabIndex={-1}
    role="region"
    aria-label={`${node.label} details`}
    className={`lineage-detail ${position ? (position.fromRight ? "from-right" : "from-left") : "sheet"}`}
    style={{ ...(position ? { left: position.left, top: position.top, width: DETAIL_WIDTH } : {}), ...toned(node.heat) }}
  >
    <div className="lineage-detail-head">
      <div>
        <span className="lineage-node-kind">{node.kind}</span>
        <h2>{node.label}</h2>
        <p>{node.detail}</p>
      </div>
      <button type="button" className="lineage-detail-close" aria-label={`Close ${node.label} details`} onClick={onClose}><X size={15} aria-hidden="true"/></button>
    </div>
    {node.heat !== undefined ? <div className="lineage-detail-heat">
      <div className="flex items-center justify-between gap-2"><Status tone={heatStatus(node.heat)}>{heatState(node.heat)}</Status><b>{percent(node.heat)}</b></div>
      <div className="lineage-detail-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(node.heat * 100))}%` }}/></div>
      <small>{node.heatBasis}</small>
    </div> : <p className="lineage-detail-copy">{node.value}</p>}
    {node.facts?.length ? <dl className="lineage-facts">
      {node.facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
    </dl> : null}
    <div className="lineage-detail-links">
      <div><span><ArrowUp size={12} aria-hidden="true"/>Heat comes from</span><p>{related.upstream.length ? related.upstream.map((item) => item.label).join(", ") : "This is where the heat starts"}</p></div>
      <div><span><ArrowDown size={12} aria-hidden="true"/>Heat goes to</span><p>{related.downstream.length ? related.downstream.map((item) => item.label).join(", ") : "Rejected to atmosphere"}</p></div>
    </div>
    <div className="lineage-contingency"><span><ShieldAlert size={13} aria-hidden="true"/>Contingency</span><p>{contingency(node, related.impact, snapshot)}</p></div>
    <button type="button" className="button secondary mt-3 w-full justify-center" onClick={() => navigate(`/facilities/${facilityId}/operations`)}><Flame size={14} aria-hidden="true"/>Show in the twin</button>
  </div>;
}

export function ThermalGraphPage({ data, facility }: { data: SessionData; facility: Facility }) {
  const reducedMotion = useReducedMotion();
  const snapshot = useScenarioSession((state) => state.simulation.snapshot);
  const selectedId = useScenarioSession((state) => state.selectedAssetId);
  const highlightedPath = useScenarioSession((state) => state.highlightedPath);
  const selectAsset = useScenarioSession((state) => state.selectAsset);
  const [view, setView] = useState<GraphView>("current");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailHeight, setDetailHeight] = useState(520);
  const [scrollRef, availableWidth] = useAvailableWidth();
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const graph = useMemo(() => thermalGraph(snapshot, view), [snapshot, view]);
  // The layout depends on which nodes and edges exist, not on their readings.
  const structure = `${graph.nodes.map((node) => node.id).join("|")}#${graph.edges.map((edge) => `${edge.from}>${edge.to}`).join("|")}`;
  const layout = useMemo(() => lineageLayout(graph.nodes, graph.edges), [structure]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const selected = nodesById.get(selectedId) ?? graph.nodes[0];
  const related = useMemo(() => graphSelection(graph, selected.id), [graph, selected.id]);
  const upstream = new Set(related.upstream.map((node) => node.id));
  const downstream = new Set(related.downstream.map((node) => node.id));
  const expanded = expandedId ? nodesById.get(expandedId) ?? null : null;
  // Loops carry the reading of the equipment they join, so they would only repeat it here.
  const hottest = graph.nodes
    .filter((node) => node.heat !== undefined && node.kind !== "loop")
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, 4);

  const scale = availableWidth ? Math.max(MIN_SCALE, Math.min(1, availableWidth / layout.width)) : 1;
  const sheet = availableWidth > 0 && availableWidth < SHEET_BELOW;
  const expandedPlace = expanded ? layout.nodes.get(expanded.id) : undefined;
  const position = expandedPlace && !sheet ? (() => {
    // Beside the node when there is room, otherwise on its other side.
    const right = (expandedPlace.x + LINEAGE_METRICS.nodeWidth) * scale + 12;
    const fromRight = right + DETAIL_WIDTH > layout.width * scale - 8;
    return {
      left: fromRight ? Math.max(8, expandedPlace.x * scale - DETAIL_WIDTH - 12) : right,
      top: Math.max(8, Math.min(expandedPlace.y * scale - 8, layout.height * scale - 48)),
      fromRight,
    };
  })() : null;
  const frameWidth = layout.width * scale;
  const frameHeight = Math.max(layout.height * scale, position ? position.top + detailHeight + 12 : 0);

  useEffect(() => {
    void recordLearningEvent("ENGINEERING_TOOL_USED", {
      facilityId: facility.id,
      simulatedAt: snapshot.simulatedAt,
    });
  }, [facility.id, view]);

  // The graph grows to fit an expanded card, whose height depends on its readings.
  useLayoutEffect(() => {
    if (expandedId && detailRef.current) setDetailHeight(detailRef.current.offsetHeight);
  }, [expandedId, view, snapshot.simulatedAt, sheet]);

  // Focus moves into an expanded card, and back to its node when it closes.
  const lastExpanded = useRef<string | null>(null);
  useEffect(() => {
    if (expandedId) detailRef.current?.focus();
    else if (lastExpanded.current) nodeRefs.current.get(lastExpanded.current)?.focus();
    lastExpanded.current = expandedId;
  }, [expandedId]);
  useEffect(() => {
    if (!expandedId) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpandedId(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expandedId]);

  const toggle = (node: ThermalGraphNode) => {
    selectAsset(node.id);
    setExpandedId((current) => current === node.id ? null : node.id);
  };

  const detail = expanded && <NodeDetail
    node={expanded}
    related={graphSelection(graph, expanded.id)}
    snapshot={snapshot}
    facilityId={facility.id}
    detailId={detailId}
    detailRef={detailRef}
    position={position}
    onClose={() => setExpandedId(null)}
  />;

  return <Shell data={data} facility={facility}>
    <PageHead eyebrow="Thermal dependency graph" title="Heat-flow topology" detail="Every asset is a node and every edge a path heat travels. Colour shows where the heat is; open a node to see what feeds it, where its heat goes and what depends on it."/>
    <ReplayBar/>
    <section className={`panel lineage${expanded ? " focus-mode" : ""}`} style={{ "--heat-gradient": HEAT_GRADIENT } as CSSProperties}>
      <div className="lineage-toolbar">
        <Segmented label="Graph view" value={view} onChange={setView} options={VIEWS.map(([value, label]) => ({ value, label }))}/>
        {view === "topology"
          ? <span className="lineage-note">Structure only · no heat readings</span>
          : <div className="lineage-legend" role="img" aria-label="Heat scale from blue for cool to red at the limit"><span>Cool</span><i/><span>At limit</span></div>}
        <span className="lineage-note lineage-time">{formatSimulatedAt(snapshot.simulatedAt)}{view === "forecast" ? ` · ${Math.round(snapshot.forecast.horizonS / 60)}-minute forecast` : ""}</span>
      </div>
      {hottest.length > 0 && <div className="lineage-hotspots" role="group" aria-label="Where the heat is">
        <span className="eyebrow">Where the heat is</span>
        {hottest.map((node) => <button key={node.id} type="button" className="lineage-hotspot" style={toned(node.heat)} onClick={() => toggle(node)}>
          <i aria-hidden="true"/>{node.label}<b>{percent(node.heat ?? 0)}</b>
        </button>)}
      </div>}
      <div ref={scrollRef} className="lineage-scroll">
        <div className="lineage-frame" style={{ width: frameWidth, height: frameHeight }}>
          <div className="lineage-canvas" style={{ width: layout.width, height: layout.height, transform: scale === 1 ? undefined : `scale(${scale})` }}>
            <svg className="lineage-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {graph.edges.map((edge) => {
                const from = layout.nodes.get(edge.from);
                const to = layout.nodes.get(edge.to);
                if (!from || !to) return null;
                const onPath = (upstream.has(edge.from) && (upstream.has(edge.to) || edge.to === selected.id))
                  || ((downstream.has(edge.from) || edge.from === selected.id) && downstream.has(edge.to));
                const heat = nodesById.get(edge.from)?.heat;
                return <path
                  key={`${edge.from}>${edge.to}`}
                  d={lineageEdgePath(from, to)}
                  className={`lineage-edge${onPath ? " on-path" : ""}${reducedMotion || view === "topology" ? "" : " flowing"}`}
                  style={heat === undefined ? undefined : { stroke: heatTone(heat) }}
                />;
              })}
            </svg>
            {graph.nodes.map((node) => {
              const place = layout.nodes.get(node.id);
              if (!place) return null;
              const relation = node.id === selected.id ? "selected"
                : upstream.has(node.id) ? "upstream"
                  : downstream.has(node.id) ? "downstream"
                    : highlightedPath.includes(node.id) ? "focused"
                      : "unrelated";
              return <button
                key={node.id}
                ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }}
                type="button"
                className={`lineage-node ${relation}${expandedId === node.id ? " expanded" : ""}`}
                style={{ left: place.x, top: place.y, width: LINEAGE_METRICS.nodeWidth, height: LINEAGE_METRICS.nodeHeight, ...toned(node.heat) }}
                aria-expanded={expandedId === node.id}
                aria-controls={expandedId === node.id ? detailId : undefined}
                aria-label={node.heat === undefined
                  ? `${node.label}, ${node.kind}, ${node.value}`
                  : `${node.label}, ${node.kind}, ${heatState(node.heat).toLowerCase()}: ${percent(node.heat)}, ${node.heatBasis}`}
                onClick={() => toggle(node)}
              >
                <span className="lineage-node-kind">{node.kind}{node.risk ? " · risk" : ""}</span>
                <b className="lineage-node-label">{node.label}</b>
                <span className="lineage-node-value">{node.heat === undefined ? node.value : `${percent(node.heat)} · ${heatState(node.heat)}`}</span>
                {node.heat !== undefined && <i className="lineage-node-meter" style={{ width: `${Math.min(100, Math.round(node.heat * 100))}%` }}/>}
              </button>;
            })}
          </div>
          {position && detail}
        </div>
      </div>
      {!position && detail}
    </section>
  </Shell>;
}
