/**
 * The screens people see before, or instead of, a signed-in workspace: the
 * landing page and designed loading, error and signed-out states. They sit in
 * the cockpit's theme tokens and open in the appearance remembered in this
 * browser, light or dark.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Boxes, Gauge, Lock, ShieldCheck, type LucideIcon } from "lucide-react";
import { LINEAGE_METRICS, heatTone, lineageEdgePath, lineageLayout } from "@/lib/cockpit/graphLayout";
import { SCENARIO_START_S, replayCockpitSnapshot } from "@/lib/cockpit/simulation";
import { thermalGraph } from "@/lib/cockpit/workspaces";
import { navigate } from "./api";
import { applyTheme, Brand, storedTheme } from "./ui";

/** Clerk's sign-in card in the light appearance; the provider's defaults are the dark one. */
export const CLERK_LIGHT_APPEARANCE = {
  variables: {
    colorPrimary: "#087d88",
    colorForeground: "#142430",
    colorMutedForeground: "#526b79",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#142430",
    colorNeutral: "#8da4b3",
    colorDanger: "#a52d26",
  },
};

/** A frame in the cockpit's theme tokens, in the appearance remembered in this browser. */
export function PublicFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  useEffect(() => {
    // A signed-in workspace applies the account's own preference instead.
    if (!document.documentElement.dataset.theme) applyTheme(storedTheme());
  }, []);
  return <div className={`cockpit public-screen min-h-[100dvh] ${className}`}>{children}</div>;
}

type StateKind = "loading" | "error" | "signed-out";

/** A full-page state: what is happening, or what went wrong and what to do next. */
export function StateScreen({ kind, title, body, actions }: { kind: StateKind; title: string; body: string; actions?: ReactNode }) {
  return <PublicFrame className="grid place-items-center p-5">
    <main className="panel state-card" aria-busy={kind === "loading"}>
      <Brand/>
      <div className={`state-icon ${kind}`} aria-hidden="true">
        {kind === "loading" ? <span className="state-spinner"/> : kind === "error" ? <AlertTriangle size={20}/> : <Lock size={20}/>}
      </div>
      <h1 className="mt-4 text-xl font-semibold text-slate-100">{title}</h1>
      <p className="copy" role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}>{body}</p>
      {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
    </main>
  </PublicFrame>;
}

/**
 * The thermal graph at the forecast checkpoint of the synthetic scenario, drawn
 * statically: real product output rather than an illustration.
 */
function GraphPreview() {
  const { graph, layout } = useMemo(() => {
    const graph = thermalGraph(replayCockpitSnapshot(SCENARIO_START_S + 900), "current");
    return { graph, layout: lineageLayout(graph.nodes, graph.edges) };
  }, []);
  const { nodeWidth, nodeHeight } = LINEAGE_METRICS;
  return <svg
    className="landing-preview"
    viewBox={`0 0 ${layout.width} ${layout.height}`}
    role="img"
    aria-label="Preview of the thermal graph: a GPU workload heats four racks, which CDU-03 cools, and Chiller-01 rejects the heat. Each asset is coloured by how close it runs to its limit."
  >
    {graph.edges.map((edge) => {
      const from = layout.nodes.get(edge.from);
      const to = layout.nodes.get(edge.to);
      const heat = graph.nodes.find((node) => node.id === edge.from)?.heat;
      if (!from || !to) return null;
      return <path key={`${edge.from}>${edge.to}`} d={lineageEdgePath(from, to)} className="lineage-edge on-path flowing" style={heat === undefined ? undefined : { stroke: heatTone(heat) }}/>;
    })}
    {graph.nodes.map((node) => {
      const place = layout.nodes.get(node.id);
      if (!place) return null;
      const tone = node.heat === undefined ? undefined : heatTone(node.heat);
      return <g key={node.id} transform={`translate(${place.x} ${place.y})`}>
        <rect className="landing-node" width={nodeWidth} height={nodeHeight} rx={6}/>
        <rect width={4} height={nodeHeight} rx={2} style={tone ? { fill: tone } : undefined}/>
        <text className="landing-node-kind" x={14} y={20}>{node.kind.toUpperCase()}</text>
        <text className="landing-node-label" x={14} y={38}>{node.label}</text>
        <text className="landing-node-value" x={14} y={53}>{node.heat === undefined ? node.value : `${Math.round(node.heat * 100)}% of limit`}</text>
      </g>;
    })}
  </svg>;
}

const FEATURES: ReadonlyArray<readonly [LucideIcon, string, string]> = [
  [Gauge, "See the constraint coming", "A deterministic replay forecasts rack inlet temperatures minutes ahead, so risk shows before any limit is reached."],
  [ShieldCheck, "Act on a checked advisory", "Every recommendation runs through the Safety Shield, against its command envelope, cooling headroom and model domain, before anyone can approve it."],
  [Boxes, "Model the facility you run", "Lay out halls, cooling and plant in the Facility builder and publish it; Operations then simulates that data centre."],
];

export function Landing() {
  return <PublicFrame>
    <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
      <Brand/>
      <nav className="flex items-center gap-2" aria-label="Get started">
        <button type="button" className="button secondary" onClick={() => navigate("/demo/sandbox")}>Cooling sandbox</button>
        <button type="button" className="button primary" onClick={() => navigate("/sign-in")}>Operator sign in</button>
      </nav>
    </header>
    <main className="mx-auto max-w-6xl px-5 py-12 md:py-20">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="eyebrow text-cyan-400">THERMAL OPERATIONS / COMMAND ENVIRONMENT</div>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-.035em] text-slate-100 md:text-6xl">Make the cooling decision before the constraint arrives.</h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">Wattr turns workload intent into power, heat, forecast risk, a safety-checked advisory, and an auditable operator decision.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" className="button primary" onClick={() => navigate("/demo/sandbox")}>Try the cooling sandbox <ArrowRight size={15} aria-hidden="true"/></button>
            <button type="button" className="button secondary" onClick={() => navigate("/sign-in")}>Enter the cockpit</button>
          </div>
          <p className="mt-4 text-xs text-slate-500">The sandbox needs no account. The cockpit is for authorized facility teams.</p>
        </div>
        <figure className="panel p-4">
          <GraphPreview/>
          <figcaption className="mt-3 text-xs leading-5 text-slate-500">The thermal graph at the forecast checkpoint of the synthetic GPU Training Ramp: heat flowing from the workload through racks and cooling, coloured from cool to at-limit.</figcaption>
        </figure>
      </section>
      <section className="mt-14 grid gap-3 md:grid-cols-3" aria-label="What Wattr does">
        {FEATURES.map(([Icon, title, body]) => <article key={title} className="panel p-5">
          <Icon size={18} className="text-cyan-300" aria-hidden="true"/>
          <h2 className="mt-3 font-semibold text-slate-100">{title}</h2>
          <p className="copy">{body}</p>
        </article>)}
      </section>
      <p className="mt-10 text-xs text-slate-500">Synthetic demonstration environment. Values are modeled, not measured, and no command is ever sent to operational technology.</p>
    </main>
  </PublicFrame>;
}
